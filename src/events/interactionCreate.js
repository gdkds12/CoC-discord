const { Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } = require('discord.js');
const {
    getWar,
    getTarget,
    updateTargetReservation,
    getOrCreateMember,
    updateMemberProfile,
    updateTargetConfidence,
    updateTargetResult
} = require('../utils/databaseHandler');
const { updateTargetEmbed } = require('../utils/embedRenderer');

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        const { user, guild } = interaction;
        const userId = user.id;
        const logPrefix = `[InteractionCreate][${user.tag}(${userId})]`;

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
            const buttonLogPrefix = `${logPrefix}[Button][${interaction.customId}][warId:${warId || 'N/A'}, target:${targetNumberStr || 'N/A'}]`;
            
            console.info(`${buttonLogPrefix} Button interaction received.`);
            
            await interaction.deferReply({ ephemeral: true });
            console.debug(`${buttonLogPrefix} Reply deferred.`);

            try {
                console.debug(`${buttonLogPrefix} Processing action: ${action}`);
                if (action === 'reserve') {
                    console.info(`${logPrefix} Reserve action started.`);
                    
                    try {
                        // 멤버 프로필 조회 또는 생성
                        const memberProfile = await getOrCreateMember(warId, userId);
                        console.info(`${logPrefix} Fetched/created member profile: ${memberProfile ? 'Exists' : 'Created'} (attacksLeft: ${memberProfile?.attacksLeft})`);

                        // 예약 가능 여부 확인
                        if (!memberProfile || memberProfile.attacksLeft <= 0) {
                            return interaction.editReply({ 
                                content: '남은 공격 횟수가 없습니다. 😥', 
                                flags: [MessageFlags.Ephemeral] 
                            });
                        }

                        // 예약 처리
                        const updatedTarget = await updateTargetReservation(warId, targetNumber, userId, true);
                        if (!updatedTarget) {
                            return interaction.editReply({ 
                                content: '목표 예약에 실패했습니다. 😥', 
                                flags: [MessageFlags.Ephemeral] 
                            });
                        }

                        // 임베드 업데이트
                        const updatedEmbed = await updateTargetEmbed(updatedTarget, warId);
                        await interaction.message.edit({ embeds: [updatedEmbed] });

                        await interaction.editReply({ 
                            content: `목표 #${targetNumber}를 예약했습니다! 🎯`, 
                            flags: [MessageFlags.Ephemeral] 
                        });
                    } catch (error) {
                        console.error(`${logPrefix} Button interaction error:`, error);
                        await interaction.editReply({ 
                            content: '예약 처리 중 오류가 발생했습니다. 😥', 
                            flags: [MessageFlags.Ephemeral] 
                        });
                    }
                } else if (action === 'cancel') {
                    console.debug(`${buttonLogPrefix} Cancel action started.`);
                    let memberProfile = await getOrCreateMember(warId, userId);
                    console.debug(`${buttonLogPrefix} Fetched/created member profile for cancel:`, memberProfile ? `Exists (reservedTargets: ${memberProfile.reservedTargets})` : 'Not found/created');
                    
                    const currentReservedTargets = JSON.parse(memberProfile.reservedTargets || '[]');
                    if (!memberProfile || !currentReservedTargets.includes(targetNumber)) {
                        console.info(`${buttonLogPrefix} User has not reserved this target or profile not found/created.`);
                        return interaction.editReply({ content: '이 목표를 예약하지 않았거나 프로필 정보가 없습니다. 🤷' });
                    }

                    console.debug(`${buttonLogPrefix} Calling updateTargetReservation for cancel.`);
                    const cancelResult = await updateTargetReservation(warId, targetNumber, userId, false);
                    console.debug(`${buttonLogPrefix} updateTargetReservation (cancel) result:`, cancelResult);

                    if (!cancelResult.updated) {
                        console.warn(`${buttonLogPrefix} Target cancellation failed in DB or target was not reserved by user. Message: ${cancelResult.message}`);
                        return interaction.editReply({ content: `예약 해제에 실패했습니다. ${cancelResult.message ? cancelResult.message : '다시 시도해주세요.'} 🤔` });
                    }

                    const newReservedTargets = currentReservedTargets.filter(tNum => tNum !== targetNumber);
                    const maxAttacks = parseInt(process.env.MAX_ATTACKS_PER_MEMBER) || 2;
                    const newAttacksLeft = Math.min(maxAttacks, (memberProfile.attacksLeft || 0) + 1);
                    const currentMemberConfidence = JSON.parse(memberProfile.confidence || '{}');
                    if (currentMemberConfidence[targetNumber]) {
                        delete currentMemberConfidence[targetNumber];
                        console.debug(`${buttonLogPrefix} Confidence for target ${targetNumber} removed from member profile.`);
                    }
                    await updateMemberProfile(warId, userId, { reservedTargets: newReservedTargets, attacksLeft: newAttacksLeft, confidence: currentMemberConfidence });
                    memberProfile.attacksLeft = newAttacksLeft;
                    memberProfile.reservedTargets = JSON.stringify(newReservedTargets);
                    memberProfile.confidence = JSON.stringify(currentMemberConfidence);
                    console.info(`${buttonLogPrefix} Member profile updated after cancellation. Attacks left: ${memberProfile.attacksLeft}`);

                    const warSessionData = await getWar(warId);
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
                    
                    console.debug(`${modalLogPrefix} Updating target confidence in DB for war ${warId}, target ${targetNumber}, user ${userId} with ${percentage}%.`);
                    const targetUpdateResult = await updateTargetConfidence(warId, targetNumber, userId, percentage);

                    if (!targetUpdateResult || !targetUpdateResult.updated) {
                        console.error(`${modalLogPrefix} Failed to update target confidence in DB for war ${warId}, target ${targetNumber}. Result:`, targetUpdateResult);
                        let errorMessage = '목표 파괴율 업데이트에 실패했습니다.';
                        if (targetUpdateResult && targetUpdateResult.message) {
                            errorMessage += ` 이유: ${targetUpdateResult.message}`;
                        } else if (!targetUpdateResult) {
                             errorMessage = '목표를 찾을 수 없습니다.'; // updateTargetConfidence에서 target 못 찾으면 Error 발생시키므로, 실제로는 catch 블록으로 갈 것임
                        }
                        return interaction.editReply({ content: errorMessage });
                    }
                    console.info(`${modalLogPrefix} Target confidence updated in DB. Target data:`, targetUpdateResult);

                    console.debug(`${modalLogPrefix} Fetching/updating member profile for confidence update.`);
                    let memberProfile = await getOrCreateMember(warId, userId);
                    let memberConfidenceMap = JSON.parse(memberProfile.confidence || '{}');
                    memberConfidenceMap[targetNumberStr] = percentage; // targetNumber를 문자열 키로 사용 (일관성 유지)
                    await updateMemberProfile(warId, userId, { confidence: memberConfidenceMap });
                    console.info(`${modalLogPrefix} Member profile confidence updated for target ${targetNumberStr} to ${percentage}%.`);

                    const warSessionData = await getWar(warId);
                    if (warSessionData && warSessionData.messageIds && warSessionData.messageIds[targetNumberStr]) {
                        const warChannel = interaction.guild.channels.cache.get(warSessionData.channelId);
                        if (warChannel) {
                            try {
                                const messageToUpdate = await warChannel.messages.fetch(warSessionData.messageIds[targetNumberStr]);
                                // targetUpdateResult가 업데이트된 target 객체를 포함하므로 이를 사용
                                await updateTargetEmbed(messageToUpdate, targetUpdateResult, warId);
                                console.info(`${modalLogPrefix} Target embed updated with new confidence.`);
                            } catch (embedUpdateError) {
                                console.error(`${modalLogPrefix} Error updating target embed after confidence input:`, embedUpdateError);
                            }
                        }
                    }

                    await interaction.editReply({ content: `🎯 목표 #${targetNumberStr}에 대한 예상 파괴율 ${percentage}% (으)로 업데이트 완료!` });
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