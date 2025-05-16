const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getWarByChannelId, getTargetsByWarId, updateTargetResult, getTarget, getMembersByWarId } = require('../utils/databaseHandler');
const { getCurrentWar } = require('../services/cocApiService.js');
require('dotenv').config();

const COMMAND_NAME = 'status';
const logPrefix = `[COMMAND:${COMMAND_NAME}]`;

// Map to store active auto-refresh intervals for channels
// Key: channelId, Value: { timerId: NodeJS.Timeout, messageIds: string[], interaction: Interaction }
const activeRefreshes = new Map();

// Helper function to get Discord user mention if available
async function getDiscordMention(guild, cocName, cocTag, dbMembers) {
    if (!guild || !cocTag) return cocName; 

    try {
        // Attempt to find by exact CoC tag match in DB members if possible in future
        // const dbMemberByTag = dbMembers.find(m => m.cocTag === cocTag);
        // if (dbMemberByTag) return `<@${dbMemberByTag.userId}>`;

        // Fallback to fetching by name (less accurate)
        const fetchedMembers = await guild.members.fetch({ query: cocName, limit: 10 });
        const matchedMember = fetchedMembers.find(m => m.displayName.toLowerCase().includes(cocName.toLowerCase()));
        if (matchedMember) return `<@${matchedMember.id}>`;
    } catch (e) {
        // console.warn(`${logPrefix} Error fetching member by query ${cocName}:`, e);
    }
    return `${cocName} (${cocTag.slice(-4)})`;
}

async function generateWarEmbeds(warData, currentWarApiData, targets, dbMembers, guild, attacksPerMemberSetting, updatedResultsCount, execLogPrefix) {
    const embeds = [];
    const MAX_FIELDS_PER_EMBED = 25;

    // --- API 데이터 기반 정보 계산 시작 (중복 계산 방지 위해 함수 외부에서 한번만 수행) ---
    let clanMembersInfo = [];
    let totalAttacksUsedApi = 0;
    let totalPossibleAttacksApi = 0;
    let unattackedClanMembersApi = [];

    if (currentWarApiData && currentWarApiData.clan && currentWarApiData.clan.members) {
        totalPossibleAttacksApi = currentWarApiData.clan.members.length * attacksPerMemberSetting;
        const apiAttacks = (currentWarApiData.clan.attacks && Array.isArray(currentWarApiData.clan.attacks)) ? currentWarApiData.clan.attacks : [];
        totalAttacksUsedApi = apiAttacks.length;

        for (const apiMember of currentWarApiData.clan.members) {
            const attacksMadeByThisMember = apiAttacks.filter(att => att.attackerTag === apiMember.tag).length;
            const attacksLeftForThisMember = attacksPerMemberSetting - attacksMadeByThisMember;
            let discordMention = await getDiscordMention(guild, apiMember.name, apiMember.tag, dbMembers);
            
            clanMembersInfo.push({
                cocName: apiMember.name, cocTag: apiMember.tag, townhallLevel: apiMember.townhallLevel,
                mapPosition: apiMember.mapPosition, attacksMade: attacksMadeByThisMember,
                attacksLeft: attacksLeftForThisMember, discordMention: discordMention
            });
            if (attacksMadeByThisMember < attacksPerMemberSetting) {
                unattackedClanMembersApi.push(discordMention);
            }
        }
        clanMembersInfo.sort((a, b) => a.mapPosition - b.mapPosition);
    }
    const attackUsageRateApi = totalPossibleAttacksApi > 0 ? (totalAttacksUsedApi / totalPossibleAttacksApi) * 100 : 0;
    const unattackedTargets = targets.filter(t => !t.result || t.result.stars === undefined || t.result.stars === -1 || (t.result.stars === 0 && t.result.destruction === 0));
    // --- API 데이터 기반 정보 계산 끝 ---


    const warId = warData.warId;
    const isWarActive = currentWarApiData && currentWarApiData.state !== 'notInWar' && currentWarApiData.state !== 'warEnded';
    const baseEmbed = () => new EmbedBuilder()
        .setColor(isWarActive ? 0xFF0000 : (currentWarApiData?.state === 'warEnded' ? 0x00FF00 : 0x0099FF))
        .setFooter({ text: '최대한 CoC API 실시간 데이터를 우선으로 표시합니다.' });

    // Embed 1: 전쟁 개요 및 CoC API 점수판
    const embed1 = baseEmbed().setTitle(`⚔️ 전쟁 개요 및 점수판 (ID: ${warId.slice(0,7)})`);
    let fieldsCount1 = 0;
    const addField1 = (name, value, inline = false) => {
        if (fieldsCount1 < MAX_FIELDS_PER_EMBED) {
            embed1.addFields({ name, value, inline });
            fieldsCount1++;
        }
    };

    addField1('\u200B', '**📊 전쟁 개요 (API 기준)**');
    addField1('팀 크기', `${currentWarApiData?.clan?.members?.length || warData.teamSize} vs ${currentWarApiData?.opponent?.members?.length || warData.teamSize}`, true);
    addField1('공격권/인', `${attacksPerMemberSetting}회`, true);
    addField1('생성일', `<t:${Math.floor(new Date(warData.createdAt).getTime() / 1000)}:f>`, true);
    if (currentWarApiData && currentWarApiData.clan && currentWarApiData.clan.members) {
        addField1('공격 사용률', `${totalAttacksUsedApi} / ${totalPossibleAttacksApi} (${attackUsageRateApi.toFixed(1)}%)`, true);
        addField1('남은 총 공격', `${totalPossibleAttacksApi - totalAttacksUsedApi}회`, true);
    }
    addField1('미공격 타겟(DB)', `${unattackedTargets.length}개`, true);
    
    if (currentWarApiData && currentWarApiData.state !== 'notInWar') {
        addField1('\u200B', '**📡 CoC API 점수판**');
        addField1(`우리팀: ${currentWarApiData.clan.name || '클랜'}`, `${currentWarApiData.clan.stars || 0}⭐ (${(currentWarApiData.clan.destructionPercentage || 0).toFixed(2)}%)`, true);
        addField1(`상대팀: ${currentWarApiData.opponent.name || '상대클랜'}`, `${currentWarApiData.opponent.stars || 0}⭐ (${(currentWarApiData.opponent.destructionPercentage || 0).toFixed(2)}%)`, true);
        if (currentWarApiData.endTime) {
            addField1('종료까지', `<t:${Math.floor(new Date(currentWarApiData.endTime).getTime() / 1000)}:R>`, true);
        }
    }
    if (embed1.data.fields && embed1.data.fields.length > 0) embeds.push(embed1);


    // Embed 2: 클랜원 현황 (API 기반)
    if (clanMembersInfo.length > 0) {
        const embed2 = baseEmbed().setTitle('👤 클랜원 현황 (API 기준)');
        let fieldsCount2 = 0;
        const addField2 = (name, value, inline = false) => {
            if (fieldsCount2 < MAX_FIELDS_PER_EMBED) {
                embed2.addFields({ name, value, inline });
                fieldsCount2++;
            }
        };
        
        let membersShown = 0;
        for (const member of clanMembersInfo) {
            if (fieldsCount2 < MAX_FIELDS_PER_EMBED -2) { // 요약 및 남은인원 필드 공간 확보
                 addField2(
                    `${member.mapPosition}. ${member.cocName.substring(0,15)} ${member.townhallLevel ? `TH${member.townhallLevel}` : ''}`,
                    `> 공격: ${member.attacksMade}/${attacksPerMemberSetting} (남음: ${member.attacksLeft})\n> Discord: ${member.discordMention}`,
                    true);
                membersShown++;
            } else break;
        }
        if (unattackedClanMembersApi.length > 0) {
            const unattackedText = unattackedClanMembersApi.join(', ');
            addField2('공격권 남은 인원', unattackedText.length > 1020 ? unattackedText.substring(0,1020) + '...' : (unattackedText || '없음'), false);
        }
        if (clanMembersInfo.length > membersShown) {
            addField2('더 많은 클랜원 정보...', `총 ${clanMembersInfo.length}명 중 ${membersShown}명 표시됨.`, false);
        }
        if (embed2.data.fields && embed2.data.fields.length > 0) embeds.push(embed2);
    }


    // Embed 3: 타겟 상세 (DB 기준)
    if (targets && targets.length > 0) {
        const embed3 = baseEmbed().setTitle('🎯 타겟 상세 (DB 기준)');
        let fieldsCount3 = 0;
        const addField3 = (name, value, inline = false) => {
            if (fieldsCount3 < MAX_FIELDS_PER_EMBED) {
                embed3.addFields({ name, value, inline });
                fieldsCount3++;
            }
        };

        let targetsShown = 0;
        for (const target of targets) {
             if (fieldsCount3 < MAX_FIELDS_PER_EMBED -1) { // 요약 필드 공간 확보
                const reservedByDisplay = target.reservedBy && target.reservedBy.length > 0 ? target.reservedBy.map(id => `<@${id}>`).join(', ') : '-';
                const confidenceEntries = target.confidence ? Object.entries(target.confidence) : [];
                const confidenceDisplay = confidenceEntries.length > 0 
                    ? confidenceEntries.map(([userId, perc]) => {
                        const dbUser = dbMembers.find(m => m.userId === userId);
                        return `${dbUser ? `<@${dbUser.userId}>` : userId.slice(0,4)}:${perc}%`;
                      }).join(' ') 
                    : '-';
                
                let resultDisplay = '- (`미입력`)';
                let attackerDisplay = '';
                if (target.result && target.result.stars !== undefined && target.result.stars > -1) {
                    if (target.result.attackerDiscordId) attackerDisplay = `<@${target.result.attackerDiscordId}>`;
                    else if (target.result.attackerCocTag) {
                        const attackerClanMember = clanMembersInfo.find(m => m.cocTag === target.result.attackerCocTag);
                        attackerDisplay = attackerClanMember ? `${attackerClanMember.cocName} (${attackerClanMember.cocTag.slice(-4)})` : target.result.attackerCocTag;
                    } else attackerDisplay = '`API 기록`';
                    resultDisplay = `${target.result.stars}⭐ ${target.result.destruction}% (${attackerDisplay})`;
                }
                addField3(
                    `#${target.targetNumber} (${target.townhallLevel || 'TH?'}) ${target.nickname ? `- ${target.nickname.substring(0,10)}` : ''}`,
                    `> 예약: ${reservedByDisplay}\n> 예상: ${confidenceDisplay}\n> 결과: ${resultDisplay}`,
                    true);
                targetsShown++;
            } else break;
        }
        if (targets.length > targetsShown) {
            addField3('더 많은 타겟 정보...', `총 ${targets.length}개 중 ${targetsShown}개 표시됨.`, false);
        }
        if (embed3.data.fields && embed3.data.fields.length > 0) embeds.push(embed3);
    }
    
    // Embed 4: 업데이트 요약
    if (updatedResultsCount > 0) {
        const embed4 = baseEmbed().setTitle('🔄 API 결과 반영');
        embed4.addFields({ name: '자동 업데이트', value: `${updatedResultsCount}개의 공격 결과가 CoC API로부터 자동 반영되었습니다.`, inline: false });
        embeds.push(embed4);
    }
    
    return embeds;
}


module.exports = {
    data: new SlashCommandBuilder()
        .setName(COMMAND_NAME)
        .setDescription('현재 전쟁 세션의 상태를 확인하고, API로 최신 공격 결과를 반영합니다. 5분마다 자동 새로고침됩니다.')
        .setDMPermission(false),
    async execute(interaction) {
        const { user, guild, channel } = interaction;
        const execLogPrefix = `${logPrefix}[${user.tag}(${user.id})][Guild:${guild.id}][Channel:${channel.id}]`;
        console.info(`${execLogPrefix} Command execution started.`);

        try {
            await interaction.deferReply({ ephemeral: true });

            const currentChannelId = channel.id;
            const warData = await getWarByChannelId(currentChannelId);
            if (!warData) {
                return interaction.editReply({ content: '이 채널에서 진행 중인 전쟁 세션을 찾을 수 없습니다. 😥', flags: [MessageFlags.Ephemeral] });
            }
            const warId = warData.warId;
            const attacksPerMemberSetting = warData.attacksPerMember || parseInt(process.env.MAX_ATTACKS_PER_MEMBER) || 2;

            // --- 데이터 가져오기 로직 (API 호출 등) ---
            let updatedResultsCount = 0; // 이 변수는 API 업데이트 로직 내에서 설정되어야 함
            const currentWarApiData = await getCurrentWar(warData.clanTag);
            
            // API 공격 결과 DB 반영 로직 (기존 코드 유지 또는 개선)
            if (currentWarApiData && currentWarApiData.state !== 'notInWar' && currentWarApiData.state !== 'accessDenied' && currentWarApiData.state !== 'error') {
                if (currentWarApiData.clan && currentWarApiData.clan.attacks && Array.isArray(currentWarApiData.clan.attacks) && currentWarApiData.opponent && currentWarApiData.opponent.members) {
                    const opponentMembersApi = currentWarApiData.opponent.members;
                    const ourAttacksApi = currentWarApiData.clan.attacks;
                    let localUpdatedCount = 0;
                    for (const opponentMemberApi of opponentMembersApi) {
                        const targetNumber = opponentMemberApi.mapPosition;
                        const defenderTag = opponentMemberApi.tag;
                        const attacksOnThisTarget = ourAttacksApi.filter(attack => attack.defenderTag === defenderTag);
                        if (attacksOnThisTarget.length === 0) continue;
                        let bestAttackOnThisTarget = attacksOnThisTarget.reduce((best, current) => {
                            if (!best || current.stars > best.stars || (current.stars === best.stars && current.destructionPercentage > best.destructionPercentage)) return current;
                            return best;
                        }, null);

                        if (bestAttackOnThisTarget) {
                            const existingTargetData = await getTarget(warId, targetNumber);
                            const existingResult = existingTargetData?.result || { stars: -1, destruction: -1 };
                            const shouldUpdate = (bestAttackOnThisTarget.stars > existingResult.stars) ||
                                (bestAttackOnThisTarget.stars === existingResult.stars && bestAttackOnThisTarget.destructionPercentage > existingResult.destruction) ||
                                (!existingResult.attackerCocTag && !existingResult.attackerDiscordId) ||
                                (existingResult.attackerCocTag && existingResult.attackerCocTag !== bestAttackOnThisTarget.attackerTag && !existingResult.attackerDiscordId);
                            
                            if (existingResult.attackerDiscordId) {
                                // Manual result exists, skip
                            } else if (shouldUpdate) {
                                await updateTargetResult(warId, targetNumber, bestAttackOnThisTarget.stars, bestAttackOnThisTarget.destructionPercentage, bestAttackOnThisTarget.attackerTag, null);
                                localUpdatedCount++;
                            }
                        }
                    }
                    if (localUpdatedCount > 0) {
                         console.info(`${execLogPrefix} Updated ${localUpdatedCount} target results from CoC API during initial load.`);
                         updatedResultsCount = localUpdatedCount; // 함수 스코프 내의 updatedResultsCount에 반영
                    }
                }
            }
            const targets = await getTargetsByWarId(warId);
            const dbMembers = await getMembersByWarId(warId);
            // --- 데이터 가져오기 로직 끝 ---

            const initialEmbeds = await generateWarEmbeds(warData, currentWarApiData, targets, dbMembers, guild, attacksPerMemberSetting, updatedResultsCount, execLogPrefix);

            if (initialEmbeds.length === 0) {
                return interaction.editReply({ content: '표시할 전쟁 정보가 없습니다.', flags: [MessageFlags.Ephemeral] });
            }

            // 이전 새로고침 타이머 정리
            if (activeRefreshes.has(currentChannelId)) {
                const oldRefresh = activeRefreshes.get(currentChannelId);
                clearInterval(oldRefresh.timerId);
                console.info(`${execLogPrefix} Cleared previous auto-refresh timer for channel ${currentChannelId}.`);
            }

            const sentMessages = [];
            const firstReply = await interaction.editReply({ embeds: [initialEmbeds[0]], ephemeral: true, fetchReply: true });
            sentMessages.push(firstReply);

            for (let i = 1; i < initialEmbeds.length && i < 4; i++) { // 최대 4개 메시지
                const followupMessage = await interaction.followUp({ embeds: [initialEmbeds[i]], ephemeral: true, fetchReply: true });
                sentMessages.push(followupMessage);
            }
            
            const REFRESH_INTERVAL = 5 * 60 * 1000; // 5분

            const timerId = setInterval(async () => {
                console.info(`${logPrefix}[Refresh:${currentChannelId}] Starting periodic refresh...`);
                const refreshWarData = await getWarByChannelId(currentChannelId); // 전쟁 존재 여부 재확인
                if (!refreshWarData || refreshWarData.state === 'ended') {
                    console.info(`${logPrefix}[Refresh:${currentChannelId}] War ended or not found. Stopping auto-refresh.`);
                    clearInterval(timerId);
                    activeRefreshes.delete(currentChannelId);
                    // Optionally notify user that refresh has stopped
                    try {
                        const lastMsg = sentMessages[sentMessages.length-1];
                        if (lastMsg) { // 마지막 메시지에 추가 정보 전달 시도
                           await lastMsg.followUp({content: '전쟁이 종료되어 자동 새로고침이 중지되었습니다.', ephemeral: true});
                        } else { // fallback
                           await interaction.followUp({content: '전쟁이 종료되어 자동 새로고침이 중지되었습니다.', ephemeral: true});
                        }
                    } catch (e) { console.warn(`${logPrefix}[Refresh:${currentChannelId}] Could not send refresh stopped message.`, e);}
                    return;
                }

                let refreshUpdatedResultsCount = 0; // 새로고침 시 업데이트 카운트
                const refreshedApiData = await getCurrentWar(refreshWarData.clanTag);
                if (refreshedApiData && refreshedApiData.state !== 'notInWar' && refreshedApiData.state !== 'accessDenied' && refreshedApiData.state !== 'error') {
                     if (refreshedApiData.clan && refreshedApiData.clan.attacks && Array.isArray(refreshedApiData.clan.attacks) && refreshedApiData.opponent && refreshedApiData.opponent.members) {
                        const opponentMembersApi = refreshedApiData.opponent.members;
                        const ourAttacksApi = refreshedApiData.clan.attacks;
                        let localRefreshUpdateCount = 0;
                        for (const opponentMemberApi of opponentMembersApi) {
                            const targetNumber = opponentMemberApi.mapPosition;
                            const defenderTag = opponentMemberApi.tag;
                            const attacksOnThisTarget = ourAttacksApi.filter(attack => attack.defenderTag === defenderTag);
                            if (attacksOnThisTarget.length === 0) continue;
                            let bestAttackOnThisTarget = attacksOnThisTarget.reduce((best, current) => {
                                if (!best || current.stars > best.stars || (current.stars === best.stars && current.destructionPercentage > best.destructionPercentage)) return current;
                                return best;
                            }, null);

                            if (bestAttackOnThisTarget) {
                                const existingTargetData = await getTarget(refreshWarData.warId, targetNumber);
                                const existingResult = existingTargetData?.result || { stars: -1, destruction: -1 };
                                const shouldUpdate = (bestAttackOnThisTarget.stars > existingResult.stars) ||
                                    (bestAttackOnThisTarget.stars === existingResult.stars && bestAttackOnThisTarget.destructionPercentage > existingResult.destruction) ||
                                    (!existingResult.attackerCocTag && !existingResult.attackerDiscordId) ||
                                    (existingResult.attackerCocTag && existingResult.attackerCocTag !== bestAttackOnThisTarget.attackerTag && !existingResult.attackerDiscordId);
                                
                                if (existingResult.attackerDiscordId) {
                                    // Manual result exists, skip
                                } else if (shouldUpdate) {
                                    await updateTargetResult(refreshWarData.warId, targetNumber, bestAttackOnThisTarget.stars, bestAttackOnThisTarget.destructionPercentage, bestAttackOnThisTarget.attackerTag, null);
                                    localRefreshUpdateCount++;
                                }
                            }
                        }
                         if (localRefreshUpdateCount > 0) {
                            console.info(`${logPrefix}[Refresh:${currentChannelId}] Updated ${localRefreshUpdateCount} target results from CoC API during refresh.`);
                            refreshUpdatedResultsCount = localRefreshUpdateCount;
                        }
                    }
                }

                const refreshedTargets = await getTargetsByWarId(refreshWarData.warId);
                const refreshedDbMembers = await getMembersByWarId(refreshWarData.warId);
                const refreshedGuild = interaction.client.guilds.cache.get(guild.id); // Use original interaction's guild id

                if (!refreshedGuild) {
                    console.warn(`${logPrefix}[Refresh:${currentChannelId}] Guild not found for refresh. Stopping.`);
                    clearInterval(timerId);
                    activeRefreshes.delete(currentChannelId);
                    return;
                }

                const newEmbeds = await generateWarEmbeds(refreshWarData, refreshedApiData, refreshedTargets, refreshedDbMembers, refreshedGuild, attacksPerMemberSetting, refreshUpdatedResultsCount, execLogPrefix);

                if (newEmbeds.length === 0) {
                    console.warn(`${logPrefix}[Refresh:${currentChannelId}] No embeds generated on refresh. Skipping update.`);
                    return;
                }

                try {
                    for (let i = 0; i < sentMessages.length; i++) {
                        if (newEmbeds[i]) { // 새 Embed가 해당 인덱스에 존재하면 업데이트
                            await sentMessages[i].edit({ embeds: [newEmbeds[i]] });
                        } else { // 새 Embed가 부족하면 기존 메시지 내용은 유지하거나, 빈 Embed로 지울 수 있음 (여기선 일단 유지)
                            // 또는 메시지를 삭제할 수도 있지만, ephemeral 메시지 삭제는 사용자 경험에 혼란을 줄 수 있음
                            // await sentMessages[i].delete(); 
                        }
                    }
                     // 만약 새로 생성된 Embed 수가 기존보다 적다면, 남은 메시지들은 어떻게 처리할지 결정 필요.
                     // 예를 들어, sentMessages.length > newEmbeds.length 이면, 초과하는 기존 메시지들을 삭제하거나 내용 비우기.
                     // 현재는 있는 만큼만 업데이트.
                    if (newEmbeds.length < sentMessages.length) {
                        for (let i = newEmbeds.length; i < sentMessages.length; i++) {
                            await sentMessages[i].edit({ embeds: [new EmbedBuilder().setTitle("정보 없음").setDescription("이전 정보는 더 이상 유효하지 않거나 업데이트되지 않았습니다.")]}); // 내용 비우기 또는 안내
                        }
                    }


                    console.info(`${logPrefix}[Refresh:${currentChannelId}] Messages updated successfully.`);
                } catch (error) {
                    console.error(`${logPrefix}[Refresh:${currentChannelId}] Error editing messages:`, error);
                    if (error.code === 10008) { // Unknown Message (메시지가 삭제된 경우)
                        console.warn(`${logPrefix}[Refresh:${currentChannelId}] One of the messages was deleted. Stopping auto-refresh.`);
                        clearInterval(timerId);
                        activeRefreshes.delete(currentChannelId);
                    }
                    // 다른 심각한 오류 시 타이머 중지 고려
                }

            }, REFRESH_INTERVAL);

            activeRefreshes.set(currentChannelId, { timerId, messages: sentMessages, interaction: interaction });
            console.info(`${execLogPrefix} Status command completed. Auto-refresh set up for channel ${currentChannelId} with ${sentMessages.length} messages.`);

        } catch (error) {
            console.error(`${execLogPrefix} Error in status command:`, error);
            // 이미 deferReply 상태이므로, 실패 메시지 표시 시도
            if (!interaction.replied && !interaction.deferred) {
                // Should not happen if deferReply was successful
                 await interaction.reply({ content: '전쟁 상태 확인 중 오류가 발생했습니다. 😥', ephemeral: true });
            } else if (interaction.replied || interaction.deferred) { // 이미 응답(defer 포함)한 경우 editReply 사용
                 await interaction.editReply({ content: '전쟁 상태를 확인하는 중 오류가 발생했습니다. 😥', embeds: [] }); // embeds 비워서 이전 내용 안 보이게
            }
        }
    }
};


// Helper function to be called from other commands like /endwar
// or when bot shuts down (if possible)
function clearChannelRefresh(channelId, client) {
    if (activeRefreshes.has(channelId)) {
        const refreshData = activeRefreshes.get(channelId);
        clearInterval(refreshData.timerId);
        activeRefreshes.delete(channelId);
        console.info(`${logPrefix} Auto-refresh timer cleared for channel ${channelId}.`);
        // Optionally send a message to the channel
        // const channel = client.channels.cache.get(channelId);
        // if (channel) {
        //    channel.send("전쟁 상태 자동 새로고침이 중지되었습니다.").catch(e => console.error("Error sending refresh stop message",e));
        // }
    }
}

module.exports.clearChannelRefresh = clearChannelRefresh; // Export for use in other files