const { Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const {
    // db, // 직접 사용은 줄이고 함수 사용 권장. firestoreHandler.firebaseInitialized로 상태 확인
    firebaseInitialized, // 초기화 상태 플래그 직접 임포트
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
        const { user, guild } = interaction;
        const logPrefix = `[InteractionCreate][${user.tag}(${user.id})]`;

        // Firestore 초기화 상태 확인
        if (!firebaseInitialized) {
            console.warn(`${logPrefix} Firestore is not initialized. Interaction may not work as expected.`);
            // 사용자에게 알릴 필요가 있다면, 특정 인터랙션 타입에 따라 응답 처리
        }

        // Slash Command 처리
        if (interaction.isChatInputCommand()) {
            console.info(`${logPrefix} ChatInputCommand received: /${interaction.commandName}`);
            const command = interaction.client.commands.get(interaction.commandName);
            if (!command) {
                console.error(`${logPrefix} Command /${interaction.commandName} not found.`);
                try { await interaction.reply({ content: '명령어를 처리하는 중 오류가 발생했습니다.', ephemeral: true }); } catch (e) { console.warn(`${logPrefix} Reply failed in command error handling for /${interaction.commandName}:`, e); }
                return;
            }
            try {
                console.debug(`${logPrefix} Executing command: /${interaction.commandName}`);
                await command.execute(interaction);
                console.info(`${logPrefix} Command /${interaction.commandName} executed successfully.`);
            } catch (error) {
                console.error(`${logPrefix} Error executing command /${interaction.commandName}:`, error);
                if (interaction.replied || interaction.deferred) {
                    try { await interaction.followUp({ content: '명령어를 실행하는 중 오류가 발생했습니다.', ephemeral: true }); } catch (e) { console.warn(`${logPrefix} FollowUp failed in command error handling for /${interaction.commandName}:`, e); }
                } else {
                    try { await interaction.reply({ content: '명령어를 실행하는 중 오류가 발생했습니다.', ephemeral: true }); } catch (e) { console.warn(`${logPrefix} Reply failed in command error handling for /${interaction.commandName}:`, e); }
                }
            }
            return;
        }

        // Button Interaction 처리
        if (interaction.isButton()) {
            const [action, targetNumberStr, warId] = interaction.customId.split('_');
            const targetNumber = parseInt(targetNumberStr, 10);
            // warId가 없을 수도 있는 customId 형식 (예: 단순 확인 버튼)에 대비
            const buttonLogPrefix = `${logPrefix}[Button][${interaction.customId}][warId:${warId || 'N/A'}, target:${targetNumberStr || 'N/A'}]`;
            
            console.info(`${buttonLogPrefix} Button interaction received.`);
            
            // 버튼 인터랙션은 대부분 DB 작업이 필요하므로 Firestore 초기화 여부 재확인 및 경고
            if (!firebaseInitialized) {
                console.error(`${buttonLogPrefix} Firestore not initialized. Aborting button action.`);
                try { await interaction.reply({ content: '데이터베이스 연결 문제로 작업을 처리할 수 없습니다. 관리자에게 문의하세요.', ephemeral: true }); } catch(e) { console.warn(`${buttonLogPrefix} Firestore init check reply failed:`, e);}
                return;
            }

            await interaction.deferReply({ ephemeral: true });
            console.debug(`${buttonLogPrefix} Reply deferred.`);

            try {
                console.debug(`${buttonLogPrefix} Processing action: ${action}`);
                if (action === 'reserve') {
                    console.debug(`${buttonLogPrefix} Reserve action started.`);
                    let memberProfile = await getMemberProfile(userId);
                    console.debug(`${buttonLogPrefix} Fetched member profile:`, memberProfile ? `Exists (attacksLeft: ${memberProfile.attacksLeft})` : 'Not found');
                    if (!memberProfile) {
                        memberProfile = { uid: userId, targets: [], attacksLeft: 2, confidence: {} };
                        await updateMemberProfile(userId, memberProfile);
                        console.info(`${buttonLogPrefix} New member profile created for userId: ${userId}`);
                    }

                    if (memberProfile.attacksLeft <= 0) {
                        console.info(`${buttonLogPrefix} No attacks left for user.`);
                        return interaction.editReply({ content: '더 이상 공격권이 없습니다. 😢' });
                    }
                    if (memberProfile.targets && memberProfile.targets.length >= 2) {
                        console.info(`${buttonLogPrefix} User already has 2 targets reserved.`);
                        return interaction.editReply({ content: '이미 2개의 목표를 예약했습니다. 기존 예약을 해제 후 다시 시도해주세요. 🛡️🛡️' });
                    }
                    if (memberProfile.targets && memberProfile.targets.includes(targetNumber)) {
                        console.info(`${buttonLogPrefix} User already reserved this target.`);
                         return interaction.editReply({ content: '이미 이 목표를 예약했습니다. 🤔'});
                    }
                    console.debug(`${buttonLogPrefix} Calling updateTargetReservation for reserve.`);
                    const reservationResult = await updateTargetReservation(warId, targetNumber, userId, 'reserve');
                    console.debug(`${buttonLogPrefix} updateTargetReservation result:`, reservationResult);

                    if (reservationResult.alreadyReserved) {
                        console.info(`${buttonLogPrefix} Target already reserved by someone else or user themself.`);
                        return interaction.editReply({ content: '이미 예약된 목표이거나, 본인이 예약한 상태입니다. 확인해주세요. 🧐' });
                    }

                    memberProfile.targets = Array.isArray(memberProfile.targets) ? memberProfile.targets : [];
                    memberProfile.targets.push(targetNumber);
                    memberProfile.attacksLeft = Math.max(0, (memberProfile.attacksLeft || 0) - 1);
                    await updateMemberProfile(userId, memberProfile);
                    console.info(`${buttonLogPrefix} Member profile updated after reservation. Attacks left: ${memberProfile.attacksLeft}`);

                    const warSessionData = await getWarSession(warId);
                    if (!warSessionData || !warSessionData.messageIds || !warSessionData.messageIds[targetNumber]) {
                        console.error(`${buttonLogPrefix} Message ID not found for warId=${warId}, targetNumber=${targetNumber}`);
                        return interaction.editReply({ content: '예약은 되었으나, 전쟁 채널의 메시지를 업데이트할 수 없습니다. 관리자에게 문의하세요.' });
                    }
                    console.debug(`${buttonLogPrefix} War session data fetched. Target messageId: ${warSessionData.messageIds[targetNumber]}`);
                    
                    const warChannel = interaction.guild.channels.cache.get(warSessionData.channelId);
                    if (!warChannel) {
                        console.error(`${buttonLogPrefix} War channel not found: ${warSessionData.channelId}`);
                        return interaction.editReply({ content: '예약은 되었으나, 전쟁 채널을 찾을 수 없어 메시지를 업데이트할 수 없습니다.' });
                    }
                    console.debug(`${buttonLogPrefix} War channel fetched: ${warChannel.name}`);
                    const messageToUpdate = await warChannel.messages.fetch(warSessionData.messageIds[targetNumber]);
                    console.debug(`${buttonLogPrefix} Message to update fetched: ${messageToUpdate.id}`);
                    await updateTargetEmbed(messageToUpdate, reservationResult, warId);
                    console.info(`${buttonLogPrefix} Target embed updated successfully.`);

                    await interaction.editReply({ content: `⚔️ 목표 #${targetNumber} 예약 완료! 남은 공격권: ${memberProfile.attacksLeft}개` });
                    console.info(`${buttonLogPrefix} Reserve action completed.`);

                } else if (action === 'cancel') {
                    console.debug(`${buttonLogPrefix} Cancel action started.`);
                    let memberProfile = await getMemberProfile(userId);
                    console.debug(`${buttonLogPrefix} Fetched member profile for cancel:`, memberProfile ? `Exists (targets: ${memberProfile.targets})` : 'Not found');

                    if (!memberProfile || !memberProfile.targets || !memberProfile.targets.includes(targetNumber)) {
                        console.info(`${buttonLogPrefix} User has not reserved this target or profile not found.`);
                        return interaction.editReply({ content: '이 목표를 예약하지 않았거나 프로필 정보가 없습니다. 🤷' });
                    }

                    console.debug(`${buttonLogPrefix} Calling updateTargetReservation for cancel.`);
                    const cancelResult = await updateTargetReservation(warId, targetNumber, userId, 'cancel');
                    console.debug(`${buttonLogPrefix} updateTargetReservation (cancel) result:`, cancelResult);

                    memberProfile.targets = memberProfile.targets.filter(tNum => tNum !== targetNumber);
                    const maxAttacks = parseInt(process.env.MAX_ATTACKS_PER_MEMBER) || 2;
                    memberProfile.attacksLeft = Math.min(maxAttacks, (memberProfile.attacksLeft || 0) + 1);
                    
                    if (memberProfile.confidence && memberProfile.confidence[targetNumber]) {
                        delete memberProfile.confidence[targetNumber];
                        console.debug(`${buttonLogPrefix} Confidence for target ${targetNumber} removed from member profile.`);
                    }
                    await updateMemberProfile(userId, memberProfile);
                    console.info(`${buttonLogPrefix} Member profile updated after cancellation. Attacks left: ${memberProfile.attacksLeft}`);

                    const warSessionData = await getWarSession(warId);
                    if (!warSessionData || !warSessionData.messageIds || !warSessionData.messageIds[targetNumber]) {
                        console.error(`${buttonLogPrefix} Message ID not found for cancel: warId=${warId}, targetNumber=${targetNumber}`);
                        return interaction.editReply({ content: '예약 해제는 되었으나, 전쟁 채널의 메시지를 업데이트할 수 없습니다.' });
                    }
                    console.debug(`${buttonLogPrefix} War session data fetched for cancel. Target messageId: ${warSessionData.messageIds[targetNumber]}`);
                    const warChannel = interaction.guild.channels.cache.get(warSessionData.channelId);
                    if (!warChannel) {
                        console.error(`${buttonLogPrefix} War channel not found for cancel: ${warSessionData.channelId}`);
                        return interaction.editReply({ content: '예약 해제는 되었으나, 전쟁 채널을 찾을 수 없어 메시지를 업데이트할 수 없습니다.' });
                    }
                    console.debug(`${buttonLogPrefix} War channel fetched for cancel: ${warChannel.name}`);
                    const messageToUpdate = await warChannel.messages.fetch(warSessionData.messageIds[targetNumber]);
                    console.debug(`${buttonLogPrefix} Message to update fetched for cancel: ${messageToUpdate.id}`);
                    await updateTargetEmbed(messageToUpdate, cancelResult, warId);
                    console.info(`${buttonLogPrefix} Target embed updated successfully after cancel.`);

                    await interaction.editReply({ content: `🚫 목표 #${targetNumber} 예약 해제 완료. 남은 공격권: ${memberProfile.attacksLeft}개` });
                    console.info(`${buttonLogPrefix} Cancel action completed.`);
                
                } else if (action === 'destruction') {
                    console.debug(`${buttonLogPrefix} Destruction action started (showing modal).`);
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
                    console.info(`${buttonLogPrefix} Destruction modal shown.`);
                    return; 
                }
            } catch (error) {
                console.error(`${buttonLogPrefix} Button interaction error:`, error);
                // deferReply가 이미 호출된 상태이므로 editReply 사용
                try {
                    await interaction.editReply({ content: `처리 중 오류 발생: ${error.message || '알 수 없는 오류가 발생했습니다.'}` });
                } catch (replyError) {
                    console.error(`${buttonLogPrefix} Failed to send error reply for button interaction:`, replyError);
                }
            }
            return; 
        }

        // Modal Submit Interaction 처리
        if (interaction.isModalSubmit()) {
            const [modalAction, targetNumberStr, warId] = interaction.customId.split('_');
            const targetNumber = parseInt(targetNumberStr, 10);
            const modalLogPrefix = `${logPrefix}[ModalSubmit][${interaction.customId}][warId:${warId}, target:${targetNumber}]`;

            console.info(`${modalLogPrefix} Modal submission received.`);

            if (!firebaseInitialized) {
                console.error(`${modalLogPrefix} Firestore not initialized. Aborting modal action.`);
                 try { await interaction.reply({ content: '데이터베이스 연결 문제로 작업을 처리할 수 없습니다. 관리자에게 문의하세요.', ephemeral: true }); } catch(e) { console.warn(`${modalLogPrefix} Firestore init check reply failed:`, e);}
                return;
            }

            await interaction.deferReply({ ephemeral: true });
            console.debug(`${modalLogPrefix} Reply deferred.`);

            try {
                console.debug(`${modalLogPrefix} Processing modal action: ${modalAction}`);
                if (modalAction === 'destructionModal') {
                    const destructionPercentage = interaction.fields.getTextInputValue('destructionPercentage');
                    const percentage = parseInt(destructionPercentage, 10);
                    console.debug(`${modalLogPrefix} Destruction percentage submitted: ${destructionPercentage} (parsed: ${percentage})`);

                    if (isNaN(percentage) || percentage < 10 || percentage > 100) {
                        console.warn(`${modalLogPrefix} Invalid destruction percentage: ${percentage}`);
                        return interaction.editReply({ content: '파괴율은 10에서 100 사이의 숫자여야 합니다. 🔢' });
                    }
                    
                    console.debug(`${modalLogPrefix} Fetching target data for war ${warId}, target ${targetNumber}.`);
                    let targetData = await getTarget(warId, targetNumber);
                    if (!targetData) { 
                        console.error(`${modalLogPrefix} Target data not found for war ${warId}, target ${targetNumber}.`);
                        return interaction.editReply({ content: '목표 데이터를 찾을 수 없어 파괴율을 저장할 수 없습니다.'});
                    }
                    targetData.confidence = targetData.confidence || {};
                    targetData.confidence[userId] = percentage;
                    
                    console.debug(`${modalLogPrefix} Updating target data with new confidence for war ${warId}, target ${targetNumber}.`);
                    // firestoreHandler에 updateTargetData(warId, targetNumber, dataToUpdate) 같은 함수가 있다면 좋겠지만, 일단 직접 set
                    // 직접 db 객체 사용 최소화를 위해 firestoreHandler에 함수 추가 고려
                    if (db) { // db 객체가 null이 아닐 때만 실행 (firebaseInitialized와 별개로)
                       await db.collection('wars').doc(warId).collection('targets').doc(String(targetNumber)).set(targetData, { merge: true });
                       console.info(`${modalLogPrefix} Target confidence updated in Firestore for war ${warId}, target ${targetNumber}, user ${userId} with ${percentage}%.`);
                    } else {
                        console.error(`${modalLogPrefix} Firestore db object is null. Cannot update target confidence.`);
                        throw new Error('Firestore db object is null.'); // 에러를 발생시켜 아래 catch에서 처리하도록
                    }
                    
                    console.debug(`${modalLogPrefix} Fetching/updating member profile for confidence update.`);
                    let memberProfile = await getMemberProfile(userId);
                    if (!memberProfile) { 
                        memberProfile = { uid: userId, targets: [], attacksLeft: 2, confidence: {} };
                         console.info(`${modalLogPrefix} New member profile created for userId: ${userId} during confidence update.`);
                    }
                    memberProfile.confidence = memberProfile.confidence || {};
                    memberProfile.confidence[targetNumber] = percentage;
                    await updateMemberProfile(userId, memberProfile);
                    console.info(`${modalLogPrefix} Member profile confidence updated for target ${targetNumber} with ${percentage}%.`);

                    const warSessionData = await getWarSession(warId);
                    if (warSessionData && warSessionData.messageIds && warSessionData.messageIds[targetNumber]) {
                        console.debug(`${modalLogPrefix} War session data found, attempting to update embed.`);
                        const warChannel = interaction.guild.channels.cache.get(warSessionData.channelId);
                         if (!warChannel) {
                            console.error(`${modalLogPrefix} War channel not found: ${warSessionData.channelId} for embed update.`);
                            // 에러를 반환하지만, 주요 로직은 이미 성공했으므로 사용자에게는 성공 메시지 표시 가능
                            await interaction.editReply({ content: `✅ 목표 #${targetNumber}에 예상 파괴율 ${percentage}%를 저장했습니다. (채널 메시지 업데이트 실패)` });
                         } else {
                            console.debug(`${modalLogPrefix} War channel found: ${warChannel.name}. Fetching message ${warSessionData.messageIds[targetNumber]}.`);
                            const messageToUpdate = await warChannel.messages.fetch(warSessionData.messageIds[targetNumber]);
                            console.debug(`${modalLogPrefix} Message to update embed fetched: ${messageToUpdate.id}.`);
                            // targetData는 위에서 confidence가 추가된 최신 상태
                            await updateTargetEmbed(messageToUpdate, targetData, warId);
                            console.info(`${modalLogPrefix} Target embed updated successfully after confidence input.`);
                            await interaction.editReply({ content: `✅ 목표 #${targetNumber}에 예상 파괴율 ${percentage}%를 저장했습니다!` });
                         }
                    } else {
                        console.warn(`${modalLogPrefix} War session data or messageId not found for war ${warId}, target ${targetNumber}. Cannot update embed.`);
                        await interaction.editReply({ content: `✅ 목표 #${targetNumber}에 예상 파괴율 ${percentage}%를 저장했습니다. (채널 메시지 업데이트 불가)` });
                    }
                    console.info(`${modalLogPrefix} Destruction modal processing completed.`);
                }
            } catch (error) {
                console.error(`${modalLogPrefix} Modal submission error:`, error);
                try {
                     await interaction.editReply({ content: `처리 중 오류 발생: ${error.message || '알 수 없는 오류가 발생했습니다.'}` });
                } catch (replyError) {
                    console.error(`${modalLogPrefix} Failed to send error reply for modal submission:`, replyError);
                }
            }
            return;
        }

        // 다른 유형의 인터랙션 (예: SelectMenu, Autocomplete)이 있다면 여기에 추가
        if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isModalSubmit()){
            console.warn(`${logPrefix} Unhandled interaction type: ${interaction.type}`);
        }
    },
}; 