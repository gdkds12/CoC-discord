const { Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const {
    db, // 직접 사용은 줄이고 함수 사용 권장
    getTarget,
    updateTargetReservation,
    getMemberProfile,
    updateMemberProfile,
    getWarSession
} = require('../services/firestoreHandler');
const { updateTargetEmbed } = require('../utils/embedRenderer');

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        // Slash Command 처리
        if (interaction.isChatInputCommand()) {
            const command = interaction.client.commands.get(interaction.commandName);
            if (!command) {
                console.error(`${interaction.commandName} 명령어를 찾을 수 없습니다.`);
                // deferReply는 이미 커맨드 핸들러에서 할 수 있으므로 여기서는 즉시 응답
                try { await interaction.reply({ content: '명령어를 처리하는 중 오류가 발생했습니다.', ephemeral: true }); } catch (e) { console.warn('Reply failed in command error handling'); }
                return;
            }
            try {
                await command.execute(interaction); // command.execute 내부에서 deferReply 또는 reply 처리
            } catch (error) {
                console.error(`${interaction.commandName} 명령어 실행 중 오류:`, error);
                // 이미 응답(defer 포함) 되었는지 확인 후 followUp 또는 reply
                if (interaction.replied || interaction.deferred) {
                    try { await interaction.followUp({ content: '명령어를 실행하는 중 오류가 발생했습니다.', ephemeral: true }); } catch (e) { console.warn('FollowUp failed in command error handling'); }
                } else {
                    try { await interaction.reply({ content: '명령어를 실행하는 중 오류가 발생했습니다.', ephemeral: true }); } catch (e) { console.warn('Reply failed in command error handling'); }
                }
            }
            return;
        }

        // Button Interaction 처리
        if (interaction.isButton()) {
            await interaction.deferReply({ ephemeral: true });
            
            const [action, targetNumberStr, warId] = interaction.customId.split('_');
            const targetNumber = parseInt(targetNumberStr, 10);
            const userId = interaction.user.id;

            console.log(`Button clicked: action=${action}, targetNumber=${targetNumber}, warId=${warId}, user=${userId}`);

            try {
                if (action === 'reserve') {
                    let memberProfile = await getMemberProfile(userId);
                    if (!memberProfile) {
                        memberProfile = { uid: userId, targets: [], attacksLeft: 2, confidence: {} };
                        // 첫 예약 시 프로필 생성 및 저장
                        await updateMemberProfile(userId, memberProfile); 
                    }

                    if (memberProfile.attacksLeft <= 0) {
                        return interaction.editReply({ content: '더 이상 공격권이 없습니다. 😢' });
                    }
                    if (memberProfile.targets && memberProfile.targets.length >= 2) {
                        return interaction.editReply({ content: '이미 2개의 목표를 예약했습니다. 기존 예약을 해제 후 다시 시도해주세요. 🛡️🛡️' });
                    }
                    if (memberProfile.targets && memberProfile.targets.includes(targetNumber)) {
                         return interaction.editReply({ content: '이미 이 목표를 예약했습니다. 🤔'});
                    }

                    const reservationResult = await updateTargetReservation(warId, targetNumber, userId, 'reserve');

                    if (reservationResult.alreadyReserved) {
                        return interaction.editReply({ content: '이미 예약된 목표이거나, 본인이 예약한 상태입니다. 확인해주세요. 🧐' });
                    } // updateTargetReservation에서 인원 초과 시 Error를 throw하므로 여기서 별도 처리

                    memberProfile.targets = Array.isArray(memberProfile.targets) ? memberProfile.targets : [];
                    memberProfile.targets.push(targetNumber);
                    memberProfile.attacksLeft = Math.max(0, (memberProfile.attacksLeft || 0) - 1);
                    await updateMemberProfile(userId, memberProfile);

                    const warSessionData = await getWarSession(warId);
                    if (!warSessionData || !warSessionData.messageIds || !warSessionData.messageIds[targetNumber]) {
                        console.error(`메시지 ID를 찾을 수 없습니다: warId=${warId}, targetNumber=${targetNumber}`);
                        return interaction.editReply({ content: '예약은 되었으나, 전쟁 채널의 메시지를 업데이트할 수 없습니다. 관리자에게 문의하세요.' });
                    }
                    
                    // 전쟁 채널 가져오기
                    const warChannel = interaction.guild.channels.cache.get(warSessionData.channelId);
                    if (!warChannel) {
                        console.error(`전쟁 채널을 찾을 수 없습니다: ${warSessionData.channelId}`);
                        return interaction.editReply({ content: '예약은 되었으나, 전쟁 채널을 찾을 수 없어 메시지를 업데이트할 수 없습니다.' });
                    }
                    const messageToUpdate = await warChannel.messages.fetch(warSessionData.messageIds[targetNumber]);
                    await updateTargetEmbed(messageToUpdate, reservationResult, warId);

                    await interaction.editReply({ content: `⚔️ 목표 #${targetNumber} 예약 완료! 남은 공격권: ${memberProfile.attacksLeft}개` });

                } else if (action === 'cancel') {
                    let memberProfile = await getMemberProfile(userId);
                    if (!memberProfile || !memberProfile.targets || !memberProfile.targets.includes(targetNumber)) {
                        // 프로필이 없거나, 해당 목표를 예약한 적이 없으면 해제할 수 없음
                        return interaction.editReply({ content: '이 목표를 예약하지 않았거나 프로필 정보가 없습니다. 🤷' });
                    }

                    // 1. 목표 예약 해제 시도
                    const cancelResult = await updateTargetReservation(warId, targetNumber, userId, 'cancel');
                    // updateTargetReservation은 해제 시 별도 반환값으로 성공 여부를 알리지 않으므로, 에러가 없으면 성공 간주

                    // 2. 사용자 프로필 업데이트
                    memberProfile.targets = memberProfile.targets.filter(tNum => tNum !== targetNumber);
                    // 환경변수나 설정에서 최대 공격권 가져오기 (예: MAX_ATTACKS_PER_MEMBER)
                    const maxAttacks = parseInt(process.env.MAX_ATTACKS_PER_MEMBER) || 2;
                    memberProfile.attacksLeft = Math.min(maxAttacks, (memberProfile.attacksLeft || 0) + 1);
                    
                    // 사용자 프로필의 confidence 맵에서 해당 목표 정보 제거
                    if (memberProfile.confidence && memberProfile.confidence[targetNumber]) {
                        delete memberProfile.confidence[targetNumber];
                    }
                    await updateMemberProfile(userId, memberProfile);

                    // 3. Embed 메시지 업데이트
                    const warSessionData = await getWarSession(warId);
                    if (!warSessionData || !warSessionData.messageIds || !warSessionData.messageIds[targetNumber]) {
                        console.error(`메시지 ID를 찾을 수 없습니다 (cancel): warId=${warId}, targetNumber=${targetNumber}`);
                        return interaction.editReply({ content: '예약 해제는 되었으나, 전쟁 채널의 메시지를 업데이트할 수 없습니다.' });
                    }
                    const warChannel = interaction.guild.channels.cache.get(warSessionData.channelId);
                    if (!warChannel) {
                        console.error(`전쟁 채널을 찾을 수 없습니다 (cancel): ${warSessionData.channelId}`);
                        return interaction.editReply({ content: '예약 해제는 되었으나, 전쟁 채널을 찾을 수 없어 메시지를 업데이트할 수 없습니다.' });
                    }
                    const messageToUpdate = await warChannel.messages.fetch(warSessionData.messageIds[targetNumber]);
                    // updateTargetReservation의 결과(cancelResult)는 해제 후의 목표 상태를 반영함
                    await updateTargetEmbed(messageToUpdate, cancelResult, warId);

                    await interaction.editReply({ content: `🚫 목표 #${targetNumber} 예약 해제 완료. 남은 공격권: ${memberProfile.attacksLeft}개` });
                
                } else if (action === 'destruction') {
                    // 파괴율 입력 모달 표시는 deferReply 후에 수행되어야 함
                    const modal = new ModalBuilder()
                        .setCustomId(`destructionModal_${targetNumber}_${warId}`)
                        .setTitle(`목표 #${targetNumber} 예상 파괴율`);
                    const destructionInput = new TextInputBuilder()
                        .setCustomId('destructionPercentage')
                        .setLabel('예상 파괴율 (10-100%)')
                        .setStyle(TextInputStyle.Short).setPlaceholder('95').setMinLength(2).setMaxLength(3).setRequired(true);
                    const firstActionRow = new ActionRowBuilder().addComponents(destructionInput);
                    modal.addComponents(firstActionRow);
                    await interaction.showModal(modal);
                    // showModal()은 자체적으로 응답을 처리하므로, editReply를 호출하면 안됨.
                    // deferReply된 상태는 showModal로 인해 응답된 것으로 간주됨.
                    return; 
                }
            } catch (error) {
                console.error(`Button interaction error (action: ${action}, warId: ${warId}, target: ${targetNumber}):`, error);
                await interaction.editReply({ content: `처리 중 오류 발생: ${error.message || '알 수 없는 오류가 발생했습니다.'}` });
            }
            return; 
        }

        // Modal Submit Interaction 처리
        if (interaction.isModalSubmit()) {
            await interaction.deferReply({ ephemeral: true }); // 모달 제출도 응답 지연

            const [modalAction, targetNumberStr, warId] = interaction.customId.split('_');
            const targetNumber = parseInt(targetNumberStr, 10);
            const userId = interaction.user.id;

            try {
                if (modalAction === 'destructionModal') {
                    const destructionPercentage = interaction.fields.getTextInputValue('destructionPercentage');
                    const percentage = parseInt(destructionPercentage, 10);

                    if (isNaN(percentage) || percentage < 10 || percentage > 100) {
                        return interaction.editReply({ content: '파괴율은 10에서 100 사이의 숫자여야 합니다. 🔢' });
                    }
                    
                    let targetData = await getTarget(warId, targetNumber);
                    if (!targetData) { 
                        // 이 경우는 거의 없어야 함. 버튼이 있는 메시지가 있다는 것은 target 문서가 생성될 여지가 있었다는 것.
                        // 다만, /startwar에서 targets 서브콜렉션 문서를 미리 만들지 않았다면 발생 가능.
                        // firestoreHandler.updateTargetReservation에서 문서가 없으면 생성하므로, 여기서는 일단 에러 간주.
                        console.error(`[ModalSubmit] Target data not found for war ${warId}, target ${targetNumber}. This shouldn't happen if reserve was used.`);
                        return interaction.editReply({ content: '목표 데이터를 찾을 수 없어 파괴율을 저장할 수 없습니다.'});
                    }
                    targetData.confidence = targetData.confidence || {};
                    targetData.confidence[userId] = percentage;
                    // targetData 자체를 업데이트 (set merge 대신)
                    await db.collection('wars').doc(warId).collection('targets').doc(String(targetNumber)).set(targetData);

                    let memberProfile = await getMemberProfile(userId);
                    if (!memberProfile) { // 멤버 프로필이 없을 경우 (예약 없이 파괴율만 입력 시도 등)
                        memberProfile = { uid: userId, targets: [], attacksLeft: 2, confidence: {} };
                    }
                    memberProfile.confidence = memberProfile.confidence || {};
                    memberProfile.confidence[targetNumber] = percentage;
                    await updateMemberProfile(userId, memberProfile);

                    const warSessionData = await getWarSession(warId);
                    if (warSessionData && warSessionData.messageIds && warSessionData.messageIds[targetNumber]) {
                        const warChannel = interaction.guild.channels.cache.get(warSessionData.channelId);
                         if (!warChannel) {
                            console.error(`전쟁 채널을 찾을 수 없습니다: ${warSessionData.channelId}`);
                            return interaction.editReply({ content: '파괴율은 저장되었으나, 전쟁 채널을 찾을 수 없어 메시지를 업데이트할 수 없습니다.' });
                        }
                        const messageToUpdate = await warChannel.messages.fetch(warSessionData.messageIds[targetNumber]);
                        await updateTargetEmbed(messageToUpdate, targetData, warId);
                        await interaction.editReply({ content: `📊 목표 #${targetNumber} 예상 파괴율 ${percentage}% 입력 완료!` });
                    } else {
                        console.error(`[ModalSubmit] Message ID or war session not found for war ${warId}, target ${targetNumber}`);
                        await interaction.editReply({ content: '파괴율은 저장되었으나, 메시지 업데이트에 실패했습니다.' });
                    }
                }
            } catch (error) {
                 console.error(`Modal submission error (action: ${modalAction}, warId: ${warId}, target: ${targetNumber}):`, error);
                 await interaction.editReply({ content: `처리 중 오류 발생: ${error.message || '알 수 없는 오류가 발생했습니다.'}` });
            }
        }
    },
}; 