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

            if (currentWarApiData && currentWarApiData.state !== 'notInWar' && currentWarApiData.state !== 'accessDenied' && currentWarApiData.state !== 'error') {
                if (currentWarApiData.clan && currentWarApiData.clan.attacks && Array.isArray(currentWarApiData.clan.attacks) && currentWarApiData.opponent && currentWarApiData.opponent.members) {
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
                    console.warn(`${execLogPrefix} CoC API data for attacks is incomplete or not an array. Clan attacks:`, currentWarApiData.clan?.attacks);
                }
            } else {
                console.warn(`${execLogPrefix} Could not fetch or process CoC API war data. State: ${currentWarApiData?.state}, Reason: ${currentWarApiData?.reason}`);
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
                // API 응답에 attacks가 없을 수도 있으므로, 확인 후 참조
                const apiAttacks = (currentWarApiData.clan.attacks && Array.isArray(currentWarApiData.clan.attacks)) ? currentWarApiData.clan.attacks : [];
                totalAttacksUsedApi = apiAttacks.length;

                for (const apiMember of currentWarApiData.clan.members) {
                    const attacksMadeByThisMember = apiAttacks.filter(att => att.attackerTag === apiMember.tag).length;
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

            let fieldsAddedCount = 0;
            const MAX_FIELDS = 25;

            // Helper function to add fields if space allows
            const addFieldsSafely = (fields) => {
                const fieldsToAdd = Array.isArray(fields) ? fields : [fields];
                if (fieldsAddedCount + fieldsToAdd.length <= MAX_FIELDS) {
                    statusEmbed.addFields(...fieldsToAdd);
                    fieldsAddedCount += fieldsToAdd.length;
                    return true;
                }
                return false;
            };
            
            // Helper function to add a single field if space allows
            const addFieldSafely = (name, value, inline = false) => {
                if (fieldsAddedCount < MAX_FIELDS) {
                    statusEmbed.addFields({ name, value, inline });
                    fieldsAddedCount++;
                    return true;
                }
                return false;
            }

            // 전쟁 개요
            // 섹션 제목 필드 + 팀 크기, 공격권/인, 생성일 필드 = 4개
            // 공격 사용률, 남은 총 공격 필드 (조건부) = 2개
            // 미공격 타겟 필드 = 1개
            // 최대 7개 필드
            if (fieldsAddedCount < MAX_FIELDS) {
                const overviewFields = [];
                overviewFields.push({ name: '\u200B', value: '**📊 전쟁 개요 (API 기준)**' });
                overviewFields.push({ name: '팀 크기', value: `${currentWarApiData?.clan?.members?.length || warData.teamSize} vs ${currentWarApiData?.opponent?.members?.length || warData.teamSize}`, inline: true });
                overviewFields.push({ name: '공격권/인', value: `${attacksPerMemberSetting}회`, inline: true });
                overviewFields.push({ name: '생성일', value: `<t:${Math.floor(new Date(warData.createdAt).getTime() / 1000)}:f>`, inline: true });
                
                if (currentWarApiData && currentWarApiData.clan && currentWarApiData.clan.members) {
                    overviewFields.push({ name: '공격 사용률', value: `${totalAttacksUsedApi} / ${totalPossibleAttacksApi} (${attackUsageRateApi.toFixed(1)}%)`, inline: true });
                    overviewFields.push({ name: '남은 총 공격', value: `${totalPossibleAttacksApi - totalAttacksUsedApi}회`, inline: true });
                }
                overviewFields.push({ name: '미공격 타겟(DB)', value: `${unattackedTargets.length}개`, inline: true });
                
                addFieldsSafely(overviewFields);
            }


            // CoC API 실시간 정보
            // 섹션 제목 필드 + 우리팀, 상대팀 필드 = 3개
            // 종료까지 필드 (조건부) = 1개
            // 최대 4개 필드
            if (currentWarApiData && currentWarApiData.state !== 'notInWar') {
                const cocApiScoreboardFields = [];
                if (fieldsAddedCount + 1 <= MAX_FIELDS) { // 섹션 타이틀 공간 확인
                    cocApiScoreboardFields.push({ name: '\u200B', value: '**📡 CoC API 점수판**' });
                    cocApiScoreboardFields.push({ name: `우리팀: ${currentWarApiData.clan.name || '클랜'}`, value: `${currentWarApiData.clan.stars || 0}⭐ (${(currentWarApiData.clan.destructionPercentage || 0).toFixed(2)}%)`, inline: true });
                    cocApiScoreboardFields.push({ name: `상대팀: ${currentWarApiData.opponent.name || '상대클랜'}`, value: `${currentWarApiData.opponent.stars || 0}⭐ (${(currentWarApiData.opponent.destructionPercentage || 0).toFixed(2)}%)`, inline: true });
                    
                    if (currentWarApiData.endTime && fieldsAddedCount + cocApiScoreboardFields.length < MAX_FIELDS) {
                         cocApiScoreboardFields.push({ name: '종료까지', value: `<t:${Math.floor(new Date(currentWarApiData.endTime).getTime() / 1000)}:R>`, inline: true });
                    }
                    addFieldsSafely(cocApiScoreboardFields);
                }
            }

            // 클랜원 활동 현황 (API 기반)
            // 섹션 제목 필드 = 1개
            // 멤버당 필드 = 1개
            // 공격권 남은 인원 필드 = 1개
            // 요약 필드 = 1개
            if (clanMembersInfo.length > 0 && fieldsAddedCount < MAX_FIELDS) {
                if (addFieldSafely('\u200B', '**👤 클랜원 현황 (API 기준)**')) {
                    let memberFieldsAddedInternally = 0;
                    const maxMemberFieldsToShow = MAX_FIELDS - fieldsAddedCount - (unattackedClanMembersApi.length > 0 ? 1 : 0) - 1; // 남은 필드 슬롯 (공격권 남은 인원, 요약 필드 고려)

                    for (const member of clanMembersInfo) {
                        if (memberFieldsAddedInternally < maxMemberFieldsToShow && memberFieldsAddedInternally < 6) { // 최대 6명 또는 남은 공간까지
                           if (addFieldSafely(
                                `${member.mapPosition}. ${member.cocName.substring(0,15)} ${member.townhallLevel ? `TH${member.townhallLevel}` : ''}`,
                                `> 공격: ${member.attacksMade}/${attacksPerMemberSetting} (남음: ${member.attacksLeft})\n> Discord: ${member.discordMention}`,
                                true
                            )) {
                                memberFieldsAddedInternally++;
                            } else {
                                break; // 더 이상 필드 추가 불가
                            }
                        } else {
                            break; // 표시 제한 도달
                        }
                    }

                    if (unattackedClanMembersApi.length > 0) {
                         addFieldSafely('공격권 남은 인원', unattackedClanMembersApi.slice(0, Math.max(0, MAX_FIELDS - fieldsAddedCount)).join(', ') || '없음', false);
                    }
                    if (clanMembersInfo.length > memberFieldsAddedInternally) {
                        addFieldSafely('더 많은 클랜원 정보...', `총 ${clanMembersInfo.length}명 중 ${memberFieldsAddedInternally}명 표시됨.`, false);
                    }
                }
            } else if (fieldsAddedCount < MAX_FIELDS) {
                addFieldsSafely([
                    { name: '\u200B', value: '**👤 클랜원 현황**' }, 
                    { name: '정보 없음', value: 'CoC API에서 클랜원 정보를 가져오거나 전쟁 참여자가 없습니다.', inline: false }
                ]);
            }
            
            // 목표별 상세 현황 (DB 기준)
            // 섹션 제목 필드 = 1개
            // 타겟당 필드 = 1개
            // 요약 필드 = 1개
            if (targets && targets.length > 0 && fieldsAddedCount < MAX_FIELDS) {
                if (addFieldSafely('\u200B', '**🎯 타겟 상세 (DB 기준)**')) {
                    let targetFieldsAddedInternally = 0;
                    // 타겟 표시는 일반적으로 한 줄에 3개씩 들어가므로, 1개의 필드가 1개의 타겟 정보를 의미.
                    // 남은 필드 수 - 요약 필드(1) 만큼 타겟 표시 가능
                    const maxTargetFieldsToShow = MAX_FIELDS - fieldsAddedCount - 1; 

                    for (const target of targets) {
                        if (targetFieldsAddedInternally < maxTargetFieldsToShow && targetFieldsAddedInternally < 9) { // 최대 9개 또는 남은 공간까지
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
                                if (target.result.attackerDiscordId) {
                                    attackerDisplay = `<@${target.result.attackerDiscordId}>`;
                                } else if (target.result.attackerCocTag) {
                                    const attackerClanMember = clanMembersInfo.find(m => m.cocTag === target.result.attackerCocTag);
                                    attackerDisplay = attackerClanMember ? `${attackerClanMember.cocName} (${attackerClanMember.cocTag.slice(-4)})` : target.result.attackerCocTag;
                                } else {
                                    attackerDisplay = '`API 기록`'; // 자동 업데이트 되었으나 매칭 안된 경우
                                }
                                resultDisplay = `${target.result.stars}⭐ ${target.result.destruction}% (${attackerDisplay})`;
                            }

                            if (addFieldSafely(
                                `#${target.targetNumber} (${target.townhallLevel || 'TH?'}) ${target.nickname ? `- ${target.nickname.substring(0,10)}` : ''}`,
                                `> 예약: ${reservedByDisplay}\n> 예상: ${confidenceDisplay}\n> 결과: ${resultDisplay}`,
                                true
                            )) {
                                targetFieldsAddedInternally++;
                            } else {
                                break; // 더 이상 필드 추가 불가
                            }
                        } else {
                            break; // 표시 제한 도달
                        }
                    }
                    if (targets.length > targetFieldsAddedInternally) {
                        addFieldSafely('더 많은 타겟 정보...', `총 ${targets.length}개 중 ${targetFieldsAddedInternally}개 표시됨.`, false);
                    }
                }
            } else if (fieldsAddedCount < MAX_FIELDS && (!targets || targets.length === 0)) {
                 addFieldSafely('\u200B', '**🎯 타겟 상세 (DB 기준)**');
                 addFieldSafely('타겟 정보 없음', 'DB에 저장된 타겟 정보가 없습니다.', false);
            }


            if (updatedResultsCount > 0 && fieldsAddedCount < MAX_FIELDS) {
                 addFieldSafely('🔄 API 결과 반영', `${updatedResultsCount}개의 공격 결과가 API로부터 자동 업데이트 되었습니다.`, false);
            }
            
            // 최종적으로 필드 수가 0개면 (아무 정보도 추가 못했으면) 기본 메시지
            if (fieldsAddedCount === 0) {
                statusEmbed.setDescription("표시할 정보가 없거나, 필드 제한으로 인해 정보를 표시할 수 없습니다. 나중에 다시 시도해주세요.");
            }

            console.info(`${execLogPrefix} Total fields added to embed: ${fieldsAddedCount}`);
            return interaction.editReply({ embeds: [statusEmbed], flags: [MessageFlags.Ephemeral] });

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