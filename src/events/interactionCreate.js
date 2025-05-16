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
            
            try {
                console.debug(`${buttonLogPrefix} Processing action: ${action}`);
                if (action === 'reserve') {
                    await interaction.deferReply({ ephemeral: true }); // 예약 액션 시작 시 응답 지연
                    console.info(`${logPrefix} Reserve action started.`);
                    
                    try {
                        const warSession = await getWar(warId);
                        if (!warSession) {
                            return interaction.editReply({ 
                                content: '전쟁 세션을 찾을 수 없습니다. 전쟁이 종료되었거나 데이터베이스 오류가 발생했습니다. 😥', 
                                flags: [MessageFlags.Ephemeral] 
                            });
                        }
                        
                        const targetInfo = await getTarget(warId, targetNumber);
                        if (!targetInfo) {
                            return interaction.editReply({ 
                                content: `목표 #${targetNumber}를 찾을 수 없습니다. 데이터베이스 오류가 발생했습니다. 😥`, 
                                flags: [MessageFlags.Ephemeral] 
                            });
                        }
                        
                        let memberProfile = await getOrCreateMember(warId, userId);
                        console.info(`${logPrefix} Fetched/created member profile: ${memberProfile ? 'Exists' : 'Created'} (attacksLeft: ${memberProfile?.attacksLeft})`);

                        if (!memberProfile || memberProfile.attacksLeft <= 0) {
                            return interaction.editReply({ 
                                content: '남은 공격 횟수가 없습니다. 😥', 
                                flags: [MessageFlags.Ephemeral] 
                            });
                        }
                        
                        // 예약자 목록 확인 및 중복 예약 방지
                        let currentTargetReservations = Array.isArray(targetInfo.reservedBy) ? targetInfo.reservedBy : (targetInfo.reservedBy ? JSON.parse(targetInfo.reservedBy) : []);
                        if (currentTargetReservations.includes(userId)) {
                             return interaction.editReply({ content: '이미 이 목표를 예약했습니다. 🤔', flags: [MessageFlags.Ephemeral] });
                        }
                        if (currentTargetReservations.length >= 2) {
                            return interaction.editReply({ content: '이 목표는 이미 다른 유저들이 모두 예약했습니다. 🧐', flags: [MessageFlags.Ephemeral] });
                        }

                        const updatedTarget = await updateTargetReservation(warId, targetNumber, userId, true);
                        if (!updatedTarget || !updatedTarget.updated) {
                             return interaction.editReply({ content: '목표 예약에 실패했습니다. 다시 시도해주세요. 🤔', flags: [MessageFlags.Ephemeral] });
                        }

                        // 멤버 프로필 업데이트 (공격권 감소 및 예약 목록 추가)
                        let currentMemberReservedTargets = Array.isArray(memberProfile.reservedTargets)
                            ? memberProfile.reservedTargets
                            : (typeof memberProfile.reservedTargets === 'string' && memberProfile.reservedTargets
                                ? JSON.parse(memberProfile.reservedTargets)
                                : []);
                        
                        if (!currentMemberReservedTargets.includes(targetNumber)) {
                            currentMemberReservedTargets.push(targetNumber);
                        }
                        const newAttacksLeft = Math.max(0, (memberProfile.attacksLeft || 0) - 1);
                        
                        await updateMemberProfile(warId, userId, {
                            reservedTargets: currentMemberReservedTargets,
                            attacksLeft: newAttacksLeft
                        });
                        console.info(`${logPrefix} Member profile updated after reservation. Attacks left: ${newAttacksLeft}, Reserved: ${JSON.stringify(currentMemberReservedTargets)}`);


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
                        }

                        await interaction.editReply({ 
                            content: `목표 #${targetNumber}를 예약했습니다! 🎯 남은 공격권: ${newAttacksLeft}회`, 
                            flags: [MessageFlags.Ephemeral] 
                        });
                    } catch (error) {
                        console.error(`${logPrefix} Button interaction error (reserve):`, error);
                        if (!interaction.replied) { // deferReply 후 editReply 전에 에러 발생 시
                           try { await interaction.editReply({ content: '예약 처리 중 오류가 발생했습니다. 😥', flags: [MessageFlags.Ephemeral] }); } catch (e) {}
                        }
                    }
                } else if (action === 'cancel') {
                    await interaction.deferReply({ ephemeral: true }); // 예약 취소 액션 시작 시 응답 지연
                    console.debug(`${buttonLogPrefix} Cancel action started.`);
                    try {
                        const warSession = await getWar(warId);
                        if (!warSession) {
                            return interaction.editReply({ 
                                content: '전쟁 세션을 찾을 수 없습니다. 😥', flags: [MessageFlags.Ephemeral] 
                            });
                        }
                        
                        const targetInfo = await getTarget(warId, targetNumber);
                        if (!targetInfo) {
                            return interaction.editReply({ 
                                content: `목표 #${targetNumber}를 찾을 수 없습니다. 😥`, flags: [MessageFlags.Ephemeral] 
                            });
                        }
                        
                        const memberProfile = await getOrCreateMember(warId, userId);
                        console.debug(`${buttonLogPrefix} Fetched member profile for cancel: attacksLeft=${memberProfile.attacksLeft}, reservedTargets=${memberProfile.reservedTargets}`);
                        
                        const currentMemberReservedTargets = Array.isArray(memberProfile.reservedTargets)
                            ? memberProfile.reservedTargets
                            : (typeof memberProfile.reservedTargets === 'string' && memberProfile.reservedTargets
                                ? JSON.parse(memberProfile.reservedTargets)
                                : []);
                        
                        if (!currentMemberReservedTargets.includes(targetNumber)) {
                            console.info(`${buttonLogPrefix} User ${userId} has not reserved target ${targetNumber}. Current reservations: ${JSON.stringify(currentMemberReservedTargets)}`);
                            return interaction.editReply({ 
                                content: '이 목표를 본인이 예약하지 않았습니다. 🤷', flags: [MessageFlags.Ephemeral]
                            });
                        }

                        const updatedTarget = await updateTargetReservation(warId, targetNumber, userId, false);
                        if (!updatedTarget || !updatedTarget.updated) {
                             return interaction.editReply({ content: '예약 해제에 실패했습니다. 이미 다른 유저가 없거나, DB 오류일 수 있습니다. 🤔', flags: [MessageFlags.Ephemeral] });
                        }

                        const newReservedTargets = currentMemberReservedTargets.filter(tNum => tNum !== targetNumber);
                        const warDetails = await getWar(warId); // To get attacksPerMember if needed, or use env
                        const attacksPerMember = warDetails?.attacksPerMember || parseInt(process.env.MAX_ATTACKS_PER_MEMBER) || 2;
                        const newAttacksLeft = Math.min(attacksPerMember, (memberProfile.attacksLeft || 0) + 1);
                        
                        let currentMemberConfidence = {};
                        if (memberProfile.confidence) {
                            currentMemberConfidence = typeof memberProfile.confidence === 'string'
                                ? JSON.parse(memberProfile.confidence)
                                : memberProfile.confidence;
                            if (currentMemberConfidence[targetNumber.toString()]) { // Ensure key is string if stored as string
                                delete currentMemberConfidence[targetNumber.toString()];
                            }
                        }
                        
                        await updateMemberProfile(warId, userId, { 
                            reservedTargets: newReservedTargets, 
                            attacksLeft: newAttacksLeft, 
                            confidence: currentMemberConfidence 
                        });
                        console.info(`${logPrefix} Member profile updated after cancellation. Attacks left: ${newAttacksLeft}, Reserved: ${JSON.stringify(newReservedTargets)}`);
                        
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
                            console.error(`${logPrefix} Error updating embed (cancel):`, embedError);
                        }

                        await interaction.editReply({ 
                            content: `🚫 목표 #${targetNumber} 예약 해제 완료. 남은 공격권: ${newAttacksLeft}개`, 
                            flags: [MessageFlags.Ephemeral] 
                        });
                        console.info(`${buttonLogPrefix} Cancel action completed.`);
                    } catch (error) {
                        console.error(`${buttonLogPrefix} Button interaction error (cancel):`, error);
                         if (!interaction.replied) {
                           try { await interaction.editReply({ content: '예약 취소 중 오류가 발생했습니다. 😥', flags: [MessageFlags.Ephemeral] }); } catch (e) {}
                        }
                    }
                } else if (action === 'destruction') {
                    // For modal, do not defer here. showModal is the reply.
                    console.debug(`${buttonLogPrefix} Destruction action started (showing modal).`);
                    
                    const warSession = await getWar(warId); // Fetch war session for validation
                    if (!warSession) {
                        // Need to reply if war session not found, cannot show modal
                        await interaction.reply({ content: '전쟁 세션을 찾을 수 없어 파괴율을 입력할 수 없습니다. 😥', ephemeral: true });
                        return;
                    }
                    const targetInfo = await getTarget(warId, targetNumber);
                     if (!targetInfo) {
                        await interaction.reply({ content: `목표 #${targetNumber}를 찾을 수 없어 파괴율을 입력할 수 없습니다. 😥`, ephemeral: true });
                        return;
                    }

                    try {
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
                        
                        // showModal is the first reply for this interaction path
                        await interaction.showModal(modal);
                        console.info(`${buttonLogPrefix} Destruction modal shown.`);
                        
                    } catch (error) {
                        console.error(`${buttonLogPrefix} Error showing modal:`, error);
                        // If showModal fails, try to send an ephemeral message
                        if (!interaction.replied && !interaction.deferred) {
                            try {
                                await interaction.reply({
                                    content: '파괴율 입력 창을 여는 중 오류가 발생했습니다. 😥',
                                    ephemeral: true
                                });
                            } catch (replyError) {
                                console.error(`${buttonLogPrefix} Failed to send error reply for modal show failure:`, replyError);
                            }
                        } else if (interaction.deferred && !interaction.replied) { // Should not happen if defer is removed for destruction
                             try {
                                await interaction.editReply({
                                    content: '파괴율 입력 창을 여는 중 오류가 발생했습니다. 😥',
                                });
                            } catch (replyError) {
                                 console.error(`${buttonLogPrefix} Failed to send error editReply for modal show failure:`, replyError);
                            }
                        }
                    }
                    // No return here, interaction continues with modal submission
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