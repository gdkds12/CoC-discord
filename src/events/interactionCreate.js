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
const { updateTargetEmbed, createTargetActionRow } = require('../utils/embedRenderer');

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
            
            // 인터랙션 응답 전에 중복 응답 방지를 위한 체크
            if (interaction.replied || interaction.deferred) {
                console.warn(`${buttonLogPrefix} Interaction already replied or deferred.`);
                return;
            }
            
            await interaction.deferReply({ ephemeral: true });
            console.debug(`${buttonLogPrefix} Reply deferred.`);

            try {
                console.debug(`${buttonLogPrefix} Processing action: ${action}`);
                if (action === 'reserve') {
                    console.info(`${logPrefix} Reserve action started.`);
                    
                    try {
                        // 전쟁 세션 확인
                        const warSession = await getWar(warId);
                        if (!warSession) {
                            return interaction.editReply({ 
                                content: '전쟁 세션을 찾을 수 없습니다. 전쟁이 종료되었거나 데이터베이스 오류가 발생했습니다. 😥', 
                                flags: [MessageFlags.Ephemeral] 
                            });
                        }
                        
                        // 타겟 정보 확인
                        const targetInfo = await getTarget(warId, targetNumber);
                        if (!targetInfo) {
                            return interaction.editReply({ 
                                content: `목표 #${targetNumber}를 찾을 수 없습니다. 데이터베이스 오류가 발생했습니다. 😥`, 
                                flags: [MessageFlags.Ephemeral] 
                            });
                        }
                        
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
                        try {
                            const warChannel = interaction.guild.channels.cache.get(warSession.channelId);
                            if (warChannel && warSession.messageIds[targetNumber]) {
                                const messageToUpdate = await warChannel.messages.fetch(warSession.messageIds[targetNumber]);
                                if (messageToUpdate) {
                                    const updatedEmbed = await updateTargetEmbed(messageToUpdate, updatedTarget, warId);
                                    const actionRow = createTargetActionRow(targetNumber, warId);
                                    await messageToUpdate.edit({ embeds: [updatedEmbed], components: [actionRow] });
                                }
                            }
                        } catch (embedError) {
                            console.error(`${logPrefix} Error updating embed:`, embedError);
                            // 임베드 업데이트 실패해도 예약은 완료된 상태이므로 진행
                        }

                        await interaction.editReply({ 
                            content: `목표 #${targetNumber}를 예약했습니다! 🎯`, 
                            flags: [MessageFlags.Ephemeral] 
                        });
                    } catch (error) {
                        console.error(`${logPrefix} Button interaction error:`, error);
                        await interaction.editReply({ 
                            content: '예약 처리 중 오류가 발생했습니다. 😥 ' + (error.message || ''),
                            flags: [MessageFlags.Ephemeral] 
                        });
                    }
                } else if (action === 'cancel') {
                    console.debug(`${buttonLogPrefix} Cancel action started.`);
                    try {
                        // 전쟁 세션 확인
                        const warSession = await getWar(warId);
                        if (!warSession) {
                            return interaction.editReply({ 
                                content: '전쟁 세션을 찾을 수 없습니다. 전쟁이 종료되었거나 데이터베이스 오류가 발생했습니다. 😥', 
                                flags: [MessageFlags.Ephemeral] 
                            });
                        }
                        
                        // 타겟 정보 확인
                        const targetInfo = await getTarget(warId, targetNumber);
                        if (!targetInfo) {
                            return interaction.editReply({ 
                                content: `목표 #${targetNumber}를 찾을 수 없습니다. 데이터베이스 오류가 발생했습니다. 😥`, 
                                flags: [MessageFlags.Ephemeral] 
                            });
                        }
                        
                        // 멤버 프로필 조회
                        const memberProfile = await getOrCreateMember(warId, userId);
                        console.debug(`${buttonLogPrefix} Fetched/created member profile for cancel:`, memberProfile ? `Exists (reservedTargets: ${memberProfile.reservedTargets})` : 'Not found/created');
                        
                        // 여러 타겟 예약 가능하도록 배열로 처리
                        const currentReservedTargets = Array.isArray(memberProfile.reservedTargets)
                            ? memberProfile.reservedTargets
                            : (typeof memberProfile.reservedTargets === 'string' && memberProfile.reservedTargets
                                ? JSON.parse(memberProfile.reservedTargets)
                                : []);
                        
                        if (!currentReservedTargets.includes(targetNumber)) {
                            console.info(`${buttonLogPrefix} User has not reserved this target.`);
                            return interaction.editReply({ 
                                content: '이 목표를 예약하지 않았습니다. 🤷', 
                                flags: [MessageFlags.Ephemeral]
                            });
                        }

                        // 예약 취소 처리
                        const updatedTarget = await updateTargetReservation(warId, targetNumber, userId, false);
                        if (!updatedTarget) {
                            return interaction.editReply({ 
                                content: '예약 해제에 실패했습니다. 😥', 
                                flags: [MessageFlags.Ephemeral] 
                            });
                        }

                        // 멤버 프로필 업데이트 (공격권 반환 및 예약 목록에서 제거)
                        const newReservedTargets = currentReservedTargets.filter(tNum => tNum !== targetNumber);
                        const maxAttacks = parseInt(process.env.MAX_ATTACKS_PER_MEMBER) || 2;
                        const newAttacksLeft = Math.min(maxAttacks, (memberProfile.attacksLeft || 0) + 1);
                        
                        // 자신감 정보도 제거
                        let currentMemberConfidence = {};
                        if (memberProfile.confidence) {
                            currentMemberConfidence = typeof memberProfile.confidence === 'string'
                                ? JSON.parse(memberProfile.confidence)
                                : memberProfile.confidence;
                            
                            if (currentMemberConfidence[targetNumber]) {
                                delete currentMemberConfidence[targetNumber];
                                console.debug(`${buttonLogPrefix} Confidence for target ${targetNumber} removed from member profile.`);
                            }
                        }
                        
                        await updateMemberProfile(warId, userId, { 
                            reservedTargets: newReservedTargets, 
                            attacksLeft: newAttacksLeft, 
                            confidence: currentMemberConfidence 
                        });
                        
                        // 임베드 업데이트
                        try {
                            const warChannel = interaction.guild.channels.cache.get(warSession.channelId);
                            if (warChannel && warSession.messageIds[targetNumber]) {
                                const messageToUpdate = await warChannel.messages.fetch(warSession.messageIds[targetNumber]);
                                if (messageToUpdate) {
                                    const updatedEmbed = await updateTargetEmbed(messageToUpdate, updatedTarget, warId);
                                    const actionRow = createTargetActionRow(targetNumber, warId);
                                    await messageToUpdate.edit({ embeds: [updatedEmbed], components: [actionRow] });
                                }
                            }
                        } catch (embedError) {
                            console.error(`${logPrefix} Error updating embed:`, embedError);
                            // 임베드 업데이트 실패해도 예약 취소는 완료된 상태이므로 진행
                        }

                        await interaction.editReply({ 
                            content: `🚫 목표 #${targetNumber} 예약 해제 완료. 남은 공격권: ${newAttacksLeft}개`, 
                            flags: [MessageFlags.Ephemeral] 
                        });
                        console.info(`${buttonLogPrefix} Cancel action completed.`);
                    } catch (error) {
                        console.error(`${buttonLogPrefix} Button interaction error:`, error);
                        await interaction.editReply({ 
                            content: '예약 취소 중 오류가 발생했습니다. 😥 ' + (error.message || ''),
                            flags: [MessageFlags.Ephemeral] 
                        });
                    }
                } else if (action === 'destruction') {
                    console.debug(`${buttonLogPrefix} Destruction action started (showing modal).`);
                    
                    // 전쟁 세션 확인
                    const warSession = await getWar(warId);
                    if (!warSession) {
                        return interaction.editReply({ 
                            content: '전쟁 세션을 찾을 수 없습니다. 전쟁이 종료되었거나 데이터베이스 오류가 발생했습니다. 😥', 
                            flags: [MessageFlags.Ephemeral] 
                        });
                    }
                    
                    // 타겟 정보 확인
                    const targetInfo = await getTarget(warId, targetNumber);
                    if (!targetInfo) {
                        return interaction.editReply({ 
                            content: `목표 #${targetNumber}를 찾을 수 없습니다. 데이터베이스 오류가 발생했습니다. 😥`, 
                            flags: [MessageFlags.Ephemeral] 
                        });
                    }
                    
                    try {
                        // 모달 생성 및 표시
                        const modal = new ModalBuilder()
                            .setCustomId(`destructionModal_${targetNumber}_${warId}`)
                            .setTitle(`목표 #${targetNumber} 예상 파괴율`);
                        const destructionInput = new TextInputBuilder()
                            .setCustomId('destructionPercentage')
                            .setLabel('예상 파괴율 (10-100%)')
                            .setStyle(TextInputStyle.Short)
                            .setPlaceholder('95')
                            .setMinLength(2)
                            .setMaxLength(3)
                            .setRequired(true);
                        const firstActionRow = new ActionRowBuilder().addComponents(destructionInput);
                        modal.addComponents(firstActionRow);
                        
                        // 이미 응답된 인터랙션인지 확인
                        if (interaction.replied || interaction.deferred) {
                            // 응답이 이미 된 경우 followUp으로 메시지 보내기
                            await interaction.editReply({
                                content: '이미 다른 동작이 진행 중입니다. 잠시 후 다시 시도해주세요.',
                                flags: [MessageFlags.Ephemeral]
                            });
                        } else {
                            // 모달 표시
                            await interaction.showModal(modal);
                            console.info(`${buttonLogPrefix} Destruction modal shown.`);
                        }
                    } catch (error) {
                        console.error(`${buttonLogPrefix} Error showing modal:`, error);
                        
                        // 이미 응답된 인터랙션인지 확인
                        if (interaction.replied || interaction.deferred) {
                            await interaction.editReply({
                                content: '동작 수행 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
                                flags: [MessageFlags.Ephemeral]
                            });
                        } else {
                            await interaction.reply({
                                content: '동작 수행 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
                                flags: [MessageFlags.Ephemeral],
                                ephemeral: true
                            });
                        }
                    }
                    return; 
                }
            } catch (error) {
                console.error(`${buttonLogPrefix} Button interaction error:`, error);
                try {
                    if (interaction.replied || interaction.deferred) {
                        await interaction.editReply({ 
                            content: `처리 중 오류 발생: ${error.message || '알 수 없는 오류가 발생했습니다.'}` 
                        });
                    } else {
                        await interaction.reply({ 
                            content: `처리 중 오류 발생: ${error.message || '알 수 없는 오류가 발생했습니다.'}`,
                            ephemeral: true 
                        });
                    }
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
                                const updatedEmbed = await updateTargetEmbed(messageToUpdate, targetUpdateResult, warId);
                                const actionRow = createTargetActionRow(targetNumber, warId);
                                await messageToUpdate.edit({ embeds: [updatedEmbed], components: [actionRow] });
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