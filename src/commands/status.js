const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getWarByChannelId, getTargetsByWarId, updateTargetResult, getTarget, getMembersByWarId } = require('../utils/databaseHandler');
const { getCurrentWar } = require('../services/cocApiService.js');
require('dotenv').config();

const COMMAND_NAME = 'status';
const logPrefix = `[COMMAND:${COMMAND_NAME}]`;

// Helper function to get Discord user mention if available
async function getDiscordMention(guild, cocName, cocTag, dbMembers) {
    if (!guild || !cocTag) return cocName; // cocTag가 없으면 이름만 반환

    // 1. DB members에서 cocTag 또는 cocName으로 userId 찾기 (members 테이블에 cocTag, cocName 필드가 있다는 가정하에)
    // 현재 members 스키마에는 userId만 있으므로, 이 부분은 이상적으로 동작하지 않음.
    // 만약 members 테이블에 cocTag가 있다면: const dbMember = dbMembers.find(m => m.cocTag === cocTag);
    // 만약 members 테이블에 cocName이 있다면: const dbMember = dbMembers.find(m => m.cocName === cocName);
    // 지금은 일단 userId를 직접 매칭할 방법이 없으므로, dbMembers 활용은 예약 정보 등에만 사용.
    // 추후 members 테이블 스키마 변경 및 정보 수집 로직 개선 필요.

    // 임시 방편: dbMembers에 있는 userId들을 대상으로 길드 멤버 캐시에서 찾아보기 (활발한 유저일 가능성)
    // 이 방법은 정확하지 않음. cocName으로 길드 멤버 검색 시도
    try {
        const fetchedMembers = await guild.members.fetch({ query: cocName, limit: 10 });
        const matchedMember = fetchedMembers.find(m => m.displayName.toLowerCase().includes(cocName.toLowerCase()));
        if (matchedMember) return `<@${matchedMember.id}>`;
    } catch (e) {
        // console.warn(`Error fetching member by query ${cocName}:`, e);
    }

    // Discord ID를 찾지 못한 경우 CoC 이름과 태그 일부 표시
    return `${cocName} (${cocTag.slice(-4)})`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName(COMMAND_NAME)
        .setDescription('현재 전쟁 세션의 상태를 확인하고, API로 최신 공격 결과를 반영합니다.')
        .setDMPermission(false),
    async execute(interaction) {
        const { user, guild, channel } = interaction;
        const execLogPrefix = `${logPrefix}[${user.tag}(${user.id})][Guild:${guild.id}][Channel:${channel.id}]`;
        console.info(`${execLogPrefix} Command execution started.`);

        try {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const currentChannelId = channel.id;
            console.info(`${execLogPrefix} Looking for war session in channel ${currentChannelId}`);
            const warData = await getWarByChannelId(currentChannelId);
            if (!warData) {
                console.warn(`${execLogPrefix} No war session found for channel ${currentChannelId}`);
                return interaction.editReply({ 
                    content: '이 채널에서 진행 중인 전쟁 세션을 찾을 수 없습니다. 😥', 
                    flags: [MessageFlags.Ephemeral] 
                });
            }
            const warId = warData.warId;
            const attacksPerMemberSetting = warData.attacksPerMember || parseInt(process.env.MAX_ATTACKS_PER_MEMBER) || 2;

            console.info(`${execLogPrefix} Fetching current war data from CoC API for warId: ${warId}`);
            const currentWarApiData = await getCurrentWar(warData.clanTag);
            let updatedResultsCount = 0;

            if (currentWarApiData && currentWarApiData.state !== 'notInWar' && currentWarApiData.state !== 'accessDenied' && currentWarApiData.state !== 'error' && currentWarApiData.clan && currentWarApiData.clan.attacks && currentWarApiData.opponent && currentWarApiData.opponent.members) {
                console.info(`${execLogPrefix} CoC API data received. Processing ${currentWarApiData.clan.attacks.length} attacks by our clan.`);
                const opponentMembersApi = currentWarApiData.opponent.members;
                const ourAttacksApi = currentWarApiData.clan.attacks;

                for (const opponentMemberApi of opponentMembersApi) {
                    const targetNumber = opponentMemberApi.mapPosition;
                    const defenderTag = opponentMemberApi.tag;

                    const attacksOnThisTarget = ourAttacksApi.filter(attack => attack.defenderTag === defenderTag);
                    if (attacksOnThisTarget.length === 0) continue;

                    let bestAttackOnThisTarget = attacksOnThisTarget.reduce((best, current) => {
                        if (!best) return current;
                        if (current.stars > best.stars) return current;
                        if (current.stars === best.stars && current.destructionPercentage > best.destructionPercentage) return current;
                        return best;
                    }, null);

                    if (bestAttackOnThisTarget) {
                        const existingTargetData = await getTarget(warId, targetNumber);
                        const existingResult = existingTargetData?.result || { stars: -1, destruction: -1 };

                        const shouldUpdate = 
                            (bestAttackOnThisTarget.stars > existingResult.stars) ||
                            (bestAttackOnThisTarget.stars === existingResult.stars && bestAttackOnThisTarget.destructionPercentage > existingResult.destruction) ||
                            (!existingResult.attackerCocTag && !existingResult.attackerDiscordId) ||
                            (existingResult.attackerCocTag && existingResult.attackerCocTag !== bestAttackOnThisTarget.attackerTag && !existingResult.attackerDiscordId);
                        
                        if (existingResult.attackerDiscordId) {
                             console.debug(`${execLogPrefix} Target #${targetNumber} has manual result by ${existingResult.attackerDiscordId}. Skipping API update.`);
                        } else if (shouldUpdate) {
                            console.info(`${execLogPrefix} Updating target #${targetNumber} (Def: ${defenderTag}) with API result: ${bestAttackOnThisTarget.stars}⭐ ${bestAttackOnThisTarget.destructionPercentage}% by ${bestAttackOnThisTarget.attackerTag}`);
                            await updateTargetResult(
                                warId, 
                                targetNumber, 
                                bestAttackOnThisTarget.stars, 
                                bestAttackOnThisTarget.destructionPercentage, 
                                bestAttackOnThisTarget.attackerTag,
                                null
                            );
                            updatedResultsCount++;
                        } else {
                            console.debug(`${execLogPrefix} No better API result for target #${targetNumber}. DB: ${existingResult.stars}⭐, API: ${bestAttackOnThisTarget.stars}⭐`);
                        }
                    }
                }
                if (updatedResultsCount > 0) {
                    console.info(`${execLogPrefix} Updated ${updatedResultsCount} target results from CoC API.`);
                }
            } else {
                console.warn(`${execLogPrefix} Could not fetch or process CoC API war data for attacks. State: ${currentWarApiData?.state}`);
            }

            const targets = await getTargetsByWarId(warId);
            const dbMembers = await getMembersByWarId(warId);

            // --- API 데이터 기반 정보 계산 시작 ---
            let clanMembersInfo = [];
            let totalAttacksUsedApi = 0;
            let totalPossibleAttacksApi = 0;
            let unattackedClanMembersApi = []; // CoC 이름 저장

            if (currentWarApiData && currentWarApiData.clan && currentWarApiData.clan.members) {
                totalPossibleAttacksApi = currentWarApiData.clan.members.length * attacksPerMemberSetting;
                totalAttacksUsedApi = currentWarApiData.clan.attacks?.length || 0;

                for (const apiMember of currentWarApiData.clan.members) {
                    const attacksMadeByThisMember = currentWarApiData.clan.attacks?.filter(att => att.attackerTag === apiMember.tag).length || 0;
                    const attacksLeftForThisMember = attacksPerMemberSetting - attacksMadeByThisMember;
                    
                    // DB 정보와 매칭하여 Discord ID 가져오기 시도
                    // 현재 members 테이블에는 cocTag가 없으므로, userId를 직접 매칭할 방법이 제한적.
                    // 임시로 cocName으로 dbMembers에서 찾아보고, 없으면 getDiscordMention 헬퍼 사용.
                    let discordMention = null;
                    const dbMemberMatch = dbMembers.find(dbm => dbm.cocName === apiMember.name); // members 테이블에 cocName이 있다는 가정
                    if (dbMemberMatch) {
                        discordMention = `<@${dbMemberMatch.userId}>`;
                    } else {
                        // getDiscordMention은 길드 멤버 검색을 시도 (부정확할 수 있음)
                        discordMention = await getDiscordMention(guild, apiMember.name, apiMember.tag, dbMembers);
                    }

                    clanMembersInfo.push({
                        cocName: apiMember.name,
                        cocTag: apiMember.tag,
                        townhallLevel: apiMember.townhallLevel,
                        mapPosition: apiMember.mapPosition,
                        attacksMade: attacksMadeByThisMember,
                        attacksLeft: attacksLeftForThisMember,
                        discordMention: discordMention // 찾았으면 Discord 멘션, 아니면 CoC 이름 + 태그
                    });

                    if (attacksMadeByThisMember < attacksPerMemberSetting) {
                        unattackedClanMembersApi.push(discordMention); // 아직 공격권 다 안 쓴 멤버
                    }
                }
                clanMembersInfo.sort((a, b) => a.mapPosition - b.mapPosition); // 맵 순서대로 정렬
            }
            
            const attackUsageRateApi = totalPossibleAttacksApi > 0 ? (totalAttacksUsedApi / totalPossibleAttacksApi) * 100 : 0;
            const unattackedTargets = targets.filter(t => !t.result || t.result.stars === undefined || t.result.stars === -1 || (t.result.stars === 0 && t.result.destruction === 0));
            // --- API 데이터 기반 정보 계산 끝 ---

            const isWarActive = currentWarApiData && currentWarApiData.state !== 'notInWar' && currentWarApiData.state !== 'warEnded';
            const statusEmbed = new EmbedBuilder()
                .setColor(isWarActive ? 0xFF0000 : (currentWarApiData?.state === 'warEnded' ? 0x00FF00 : 0x0099FF))
                .setTitle(`⚔️ 전쟁 현황판 (War ID: ${warId})`)
                .setDescription(warData.state === 'ended' ? '종료된 전쟁입니다.' : `**상태**: ${currentWarApiData?.state || warData.state}`)
                .setFooter({ text: '최대한 CoC API 실시간 데이터를 우선으로 표시합니다.' });

            // 전쟁 개요
            statusEmbed.addFields(
                { name: '\u200B', value: '**📊 전쟁 개요 (API 기준)**' },
                { name: '팀 크기', value: `${currentWarApiData?.clan?.members?.length || warData.teamSize} vs ${currentWarApiData?.opponent?.members?.length || warData.teamSize}`, inline: true },
                { name: '공격권/인', value: `${attacksPerMemberSetting}회`, inline: true },
                { name: '생성일', value: `<t:${Math.floor(new Date(warData.createdAt).getTime() / 1000)}:f>`, inline: true }
            );
            if (currentWarApiData && currentWarApiData.clan && currentWarApiData.clan.members) {
                statusEmbed.addFields(
                    { name: '공격 사용률', value: `${totalAttacksUsedApi} / ${totalPossibleAttacksApi} (${attackUsageRateApi.toFixed(1)}%)`, inline: true },
                    { name: '남은 총 공격', value: `${totalPossibleAttacksApi - totalAttacksUsedApi}회`, inline: true }
                );
            }
            statusEmbed.addFields({ name: '미공격 타겟(DB)', value: `${unattackedTargets.length}개`, inline: true });

            // CoC API 실시간 정보
            if (currentWarApiData && currentWarApiData.state !== 'notInWar') {
                statusEmbed.addFields(
                    { name: '\u200B', value: '**📡 CoC API 점수판**' },
                    { name: `우리팀: ${currentWarApiData.clan.name || '클랜'}`, value: `${currentWarApiData.clan.stars || 0}⭐ (${(currentWarApiData.clan.destructionPercentage || 0).toFixed(2)}%)`, inline: true },
                    { name: `상대팀: ${currentWarApiData.opponent.name || '상대클랜'}`, value: `${currentWarApiData.opponent.stars || 0}⭐ (${(currentWarApiData.opponent.destructionPercentage || 0).toFixed(2)}%)`, inline: true }
                );
                if (currentWarApiData.endTime) {
                    statusEmbed.addFields({ name: '종료까지', value: `<t:${Math.floor(new Date(currentWarApiData.endTime).getTime() / 1000)}:R>`, inline: true });
                }
            }

            // 클랜원 활동 현황 (API 기반)
            if (clanMembersInfo.length > 0) {
                statusEmbed.addFields({ name: '\u200B', value: '**�� 클랜원 현황 (API 기준)**' });
                let memberFieldsCount = 0;
                for (const member of clanMembersInfo) {
                    if (memberFieldsCount < 6) { // 너무 많으면 잘릴 수 있으니 일부만 표시 (예시)
                        statusEmbed.addFields({
                            name: `${member.mapPosition}. ${member.cocName.substring(0,15)} ${member.townhallLevel ? `TH${member.townhallLevel}` : ''}`,
                            value: `> 공격: ${member.attacksMade}/${attacksPerMemberSetting} (남음: ${member.attacksLeft})\n> Discord: ${member.discordMention}`,
                            inline: true
                        });
                        memberFieldsCount++;
                    }
                }
                if (unattackedClanMembersApi.length > 0) {
                     statusEmbed.addFields({ name: '공격권 남은 인원', value: unattackedClanMembersApi.join(', ') || '없음', inline: false });
                }
                 if(clanMembersInfo.length > memberFieldsCount) {
                    statusEmbed.addFields({ name: '더 많은 클랜원 정보...', value: `총 ${clanMembersInfo.length}명 중 ${memberFieldsCount}명 표시됨.`, inline: false });
                }

            } else {
                statusEmbed.addFields({ name: '\u200B', value: '**👤 클랜원 현황**' }, { name: '정보 없음', value: 'CoC API에서 클랜원 정보를 가져올 수 없거나 전쟁 참여자가 없습니다.', inline: false });
            }
            
            // 목표별 상세 현황 (기존과 유사)
            if (targets && targets.length > 0) {
                statusEmbed.addFields({ name: '\u200B', value: '**🎯 타겟 상세 (DB 기준)**' });
                let targetFieldsCount = 0;
                targets.slice(0, 9).forEach(target => { // 최대 9개 타겟 정보 표시 (임베드 필드 제한 고려)
                    if (targetFieldsCount < 9) {
                        const reservedByDisplay = target.reservedBy && target.reservedBy.length > 0 ? target.reservedBy.map(id => `<@${id}>`).join(', ') : '-';
                        const confidenceEntries = target.confidence ? Object.entries(target.confidence) : [];
                        const confidenceDisplay = confidenceEntries.length > 0 
                            ? confidenceEntries.map(([userId, perc]) => {
                                const dbUser = dbMembers.find(m => m.userId === userId);
                                return `${dbUser ? `<@${dbUser.userId}>` : userId.slice(0,4)}:${perc}%`;
                              }).join(' ') 
                            : '-';
                        
                        let resultDisplay = '- (`미입력`)';
                        if (target.result && target.result.stars !== undefined && target.result.stars > -1) {
                            let attackerDisplay = '';
                            if (target.result.attackerDiscordId) {
                                attackerDisplay = `(<@${target.result.attackerDiscordId}>)`;
                            } else if (target.result.attackerCocTag) {
                                // API 클랜 멤버 정보에서 해당 COC 태그의 멤버 이름 찾기
                                const apiAttacker = clanMembersInfo.find(m => m.cocTag === target.result.attackerCocTag);
                                attackerDisplay = apiAttacker ? `(${apiAttacker.cocName.substring(0,10)}...)` : `(COC:${target.result.attackerCocTag.slice(-4)})`;
                            }
                            resultDisplay = `${target.result.stars}⭐ ${target.result.destruction}% ${attackerDisplay}`.trim();
                        }

                        const title = `🎯#${target.targetNumber} ${target.opponentName || '상대'} ${target.opponentTownhallLevel ? '(TH' + target.opponentTownhallLevel + ')' : ''}`;
                        statusEmbed.addFields({
                            name: title,
                            value: `> 예약: ${reservedByDisplay}\n> 예상: ${confidenceDisplay}\n> 결과: ${resultDisplay}`,
                            inline: true
                        });
                        targetFieldsCount++;
                    }
                });
                 if (targets.length > targetFieldsCount) {
                    statusEmbed.addFields({ name: '더 많은 타겟 정보...', value: `총 ${targets.length}개 타겟 중 ${targetFieldsCount}개 표시됨.`, inline: false });
                }
            }

            await interaction.editReply({ 
                embeds: [statusEmbed],
                flags: [MessageFlags.Ephemeral]
            });
            console.info(`${execLogPrefix} Status command completed successfully.${updatedResultsCount > 0 ? ` ${updatedResultsCount} results updated from API.` : ''}`);

        } catch (error) {
            console.error(`${execLogPrefix} Error in status command:`, error);
            if (!interaction.replied && !interaction.deferred) {
                 await interaction.reply({ content: '전쟁 상태를 확인하는 중 오류가 발생했습니다. 😥', flags: [MessageFlags.Ephemeral], ephemeral: true });
            } else {
                 await interaction.editReply({ 
                    content: '전쟁 상태를 확인하는 중 오류가 발생했습니다. 😥', 
                    flags: [MessageFlags.Ephemeral] 
                });
            }
        }
    }
}; 