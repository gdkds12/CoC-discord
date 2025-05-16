const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { db, getWarSession } = require('../services/firestoreHandler.js');
const { getCurrentWar } = require('../services/cocApiService.js');
require('dotenv').config();

// 모든 목표 정보를 가져오는 함수 (추후 firestoreHandler로 이전 고려)
async function getAllTargetsForWar(warId) {
    const targets = [];
    try {
        const targetsSnapshot = await db.collection('wars').doc(warId).collection('targets').orderBy('targetNumber').get();
        targetsSnapshot.forEach(doc => {
            targets.push(doc.data());
        });
    } catch (error) {
        console.error(`Error fetching all targets for war ${warId}:`, error);
        // 에러 발생 시 빈 배열 반환 또는 throw error 처리
    }
    return targets;
}

// 시간 변환 함수 (초 -> HH:MM:SS 또는 DD HH:MM:SS)
function formatDuration(seconds) {
    if (seconds < 0) seconds = 0;
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor(seconds % (3600 * 24) / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);
    let str = '';
    if (d > 0) str += `${d}일 `;
    if (h > 0 || d > 0) str += `${h.toString().padStart(2, '0')}:`;
    str += `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return str || '00:00';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('status')
        .setDescription('현재 또는 지정된 전쟁의 진행 상황과 CoC API 실시간 정보를 함께 보여줍니다.')
        .addStringOption(option =>
            option.setName('warid')
                .setDescription('정보를 조회할 특정 전쟁의 ID (생략 시 현재 채널의 전쟁 정보 조회)')
                .setRequired(false))
        .setDMPermission(true),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: false }); 

        const specifiedWarId = interaction.options.getString('warid');
        let warIdToQuery = specifiedWarId;
        let warData;
        let cocWarData;

        try {
            // 1. Firestore에서 전쟁 데이터 가져오기
            if (!warIdToQuery) {
                const currentChannelId = interaction.channelId;
                if (!currentChannelId && interaction.guildId) {
                    return interaction.editReply({ content: '채널 정보를 가져올 수 없습니다. `warid`를 명시해주세요.', ephemeral: true });
                }
                const warsQuery = db.collection('wars').where('channelId', '==', currentChannelId).where('ended', '==', false).limit(1);
                const warsSnapshot = await warsQuery.get();
                if (warsSnapshot.empty) {
                    // 현재 채널에서 진행중인 전쟁이 없을 경우, API로 현재 전쟁을 시도해볼 수 있음
                    cocWarData = await getCurrentWar();
                    if (cocWarData && cocWarData.state !== 'notInWar') {
                        const warStartTimeISO = cocWarData.startTime !== '0001-01-01T00:00:00.000Z' ? cocWarData.startTime : cocWarData.preparationStartTime;
                        const warStartDate = new Date(warStartTimeISO);
                        warIdToQuery = `${process.env.CLAN_TAG.replace('#', '')}-${warStartDate.getUTCFullYear()}${(warStartDate.getUTCMonth() + 1).toString().padStart(2, '0')}${warStartDate.getUTCDate().toString().padStart(2, '0')}${warStartDate.getUTCHours().toString().padStart(2, '0')}${warStartDate.getUTCMinutes().toString().padStart(2, '0')}`;
                        warData = await getWarSession(warIdToQuery);
                        if (!warData) {
                            // API에는 전쟁이 있지만 Firestore에 없는 경우 (봇이 중간에 추가되었거나 /startwar 안함)
                            // 이 경우 API 데이터만으로 표시하거나, 제한적인 정보를 표시할 수 있음
                            // 여기서는 Firestore에 없으면 그냥 API 데이터만으로 진행하도록 함
                            console.log(`API에서는 전쟁(${warIdToQuery})이 있지만 Firestore에는 없습니다. API 정보만으로 표시합니다.`);
                        }
                    } else {
                        return interaction.editReply({ content: '현재 채널 또는 API에서 진행 중인 전쟁 정보를 찾을 수 없습니다. 😢 `warid`를 지정하거나 전쟁 채널에서 사용해주세요.', ephemeral: true });
                    }
                } else {
                    warIdToQuery = warsSnapshot.docs[0].id;
                    warData = warsSnapshot.docs[0].data();
                }
            } else {
                warData = await getWarSession(warIdToQuery);
                // 지정된 warId로 Firestore에서 못찾았더라도 API로 현재 전쟁을 확인해볼 수 있음 (옵션)
                // 여기서는 Firestore에 없으면 오류로 처리
                if (!warData) {
                    return interaction.editReply({ content: `\`${warIdToQuery}\` ID에 해당하는 전쟁 정보를 Firestore에서 찾을 수 없습니다. 🔍 API로 현재 전쟁을 확인하려면 warid 없이 사용해보세요.`, ephemeral: true });
                }
            }

            // 2. CoC API에서 현재 전쟁 정보 가져오기 (Firestore에 진행 중인 전쟁 데이터가 있거나, warid 없이 현재 전쟁 조회 시)
            // warData가 있고, 아직 안 끝났을때만 cocWarData를 가져오도록 수정
            if ((warData && !warData.ended) || (!specifiedWarId && cocWarData)) { // cocWarData는 위에서 이미 가져왔을 수 있음
                if (!cocWarData) cocWarData = await getCurrentWar(); // 아직 안가져왔으면 가져옴
                
                // API 데이터와 Firestore 데이터의 전쟁이 동일한지 간단히 확인 (시작 시간 비교)
                if (warData && cocWarData && cocWarData.state !== 'notInWar') {
                    const fsWarStartTime = warData.startTime?.seconds ? new Date(warData.startTime.seconds * 1000).toISOString().slice(0, 16) : null;
                    const apiWarStartTime = cocWarData.startTime !== '0001-01-01T00:00:00.000Z' ? cocWarData.startTime.slice(0, 16) : (cocWarData.preparationStartTime !== '0001-01-01T00:00:00.000Z' ? cocWarData.preparationStartTime.slice(0,16) : null);
                    
                    if (fsWarStartTime && apiWarStartTime && !fsWarStartTime.startsWith(apiWarStartTime.substring(0, fsWarStartTime.lastIndexOf(':')))) {
                        // 분 단위까지만 비교 (초단위 오차 가능성)
                        console.log(`[Status] Firestore 전쟁(${warIdToQuery}, 시작: ${fsWarStartTime})과 API 현재 전쟁(시작: ${apiWarStartTime})이 다른 것으로 보입니다. API 정보를 표시하지 않습니다.`);
                        cocWarData = null; // 다른 전쟁이면 API 데이터 사용 안 함
                    }
                }
            }

            const statusEmbed = new EmbedBuilder();
            let title = '🛡️ 전쟁 현황';
            if (warIdToQuery) title += `: ${warIdToQuery}`;
            else if (cocWarData?.opponent?.name) title += `: ${cocWarData.clan.name} vs ${cocWarData.opponent.name}`;

            statusEmbed.setTitle(title);

            if (warData) {
                statusEmbed.setColor(warData.ended ? 0x808080 : (cocWarData && cocWarData.state === 'inWar' ? 0xFF0000 : 0x00FF00))
                    .setDescription(`**클랜 태그:** ${warData.clanTag || 'N/A'}\n**DB 상태:** ${warData.state || 'N/A'} (${warData.ended ? '종료됨 (DB)' : '진행중 (DB)'})`)
                    .addFields({ name: '팀 규모 (DB)', value: String(warData.teamSize || 'N/A'), inline: true });
                if (warData.createdAt && warData.createdAt.seconds) {
                    statusEmbed.addFields({ name: 'DB 생성일', value: `<t:${Math.floor(warData.createdAt.seconds)}:D>`, inline: true });
                }
                if (warData.endedAt && warData.endedAt.seconds) {
                    statusEmbed.addFields({ name: 'DB 종료일', value: `<t:${Math.floor(warData.endedAt.seconds)}:D>`, inline: true });
                }
                if (warData.opponentClanName) {
                    statusEmbed.addFields({ name: '상대 (DB)', value: `${warData.opponentClanName} (${warData.opponentClanTag || 'N/A'})`, inline: true });
                }
            } else if (cocWarData) { // Firestore 데이터는 없지만 API 데이터만 있는 경우
                statusEmbed.setColor(cocWarData.state === 'inWar' ? 0xFF0000 : (cocWarData.state === 'preparation' ? 0x00FF00 : 0x808080));
                statusEmbed.setDescription(`**클랜 태그:** ${cocWarData.clan.tag}\n**API 상태:** ${cocWarData.state}`);
                statusEmbed.addFields(
                    { name: '팀 규모 (API)', value: String(cocWarData.teamSize), inline: true },
                    { name: '상대 (API)', value: `${cocWarData.opponent.name} (${cocWarData.opponent.tag})`, inline: true }
                );
            } else {
                return interaction.editReply({ content: '전쟁 정보를 찾을 수 없습니다.', ephemeral: true });
            }
            
            // CoC API 실시간 정보 추가
            if (cocWarData && cocWarData.state !== 'notInWar') {
                statusEmbed.addFields({ name: '\u200B', value: '**📡 CoC API 실시간 정보**' });
                statusEmbed.addFields(
                    { name: 'API 상태', value: `\`${cocWarData.state}\``, inline: true },
                );

                let timeFieldName = '남은 시간';
                let timeValue = 'N/A';
                const now = Math.floor(Date.now() / 1000);

                if (cocWarData.state === 'preparation') {
                    const prepEndTime = Math.floor(new Date(cocWarData.preparationStartTime).getTime() / 1000) + (24*60*60); // 준비 시간은 보통 24시간, API에 prepEndTime이 없음...
                    // CoC API에는 preparationEndTime 필드가 명시적으로 없습니다.
                    // startTime - now 로 계산해야할듯. startTime이 미래면 준비중.
                    const startTimeEpoch = Math.floor(new Date(cocWarData.startTime).getTime() / 1000);
                    if (startTimeEpoch > now) {
                        timeFieldName = '전쟁 시작까지';
                        timeValue = formatDuration(startTimeEpoch - now) + ` (<t:${startTimeEpoch}:R>)`;
                    } else { // startTime이 과거인데 state가 preparation이면 뭔가 이상하지만...
                        timeFieldName = '전쟁 준비 중';
                        timeValue = '시간 정보 오류';
                    }
                } else if (cocWarData.state === 'inWar') {
                    const endTimeEpoch = Math.floor(new Date(cocWarData.endTime).getTime() / 1000);
                    timeFieldName = '전쟁 종료까지';
                    timeValue = formatDuration(endTimeEpoch - now) + ` (<t:${endTimeEpoch}:R>)`;
                } else if (cocWarData.state === 'warEnded') {
                    timeFieldName = '전쟁 종료됨 (API)';
                    const endTimeEpoch = Math.floor(new Date(cocWarData.endTime).getTime() / 1000);
                    timeValue = `<t:${endTimeEpoch}:F>`;
                }
                statusEmbed.addFields({ name: timeFieldName, value: timeValue, inline: true });
                statusEmbed.addFields(
                    { name: `${cocWarData.clan.name} (우리팀)`, value: `⭐ ${cocWarData.clan.stars} | ⚔️ ${cocWarData.clan.attacks}/${cocWarData.teamSize * (cocWarData.attacksPerMember || 2)} | 📊 ${cocWarData.clan.destructionPercentage.toFixed(2)}%`, inline: false },
                    { name: `${cocWarData.opponent.name} (상대팀)`, value: `⭐ ${cocWarData.opponent.stars} | ⚔️ ${cocWarData.opponent.attacks}/${cocWarData.teamSize * (cocWarData.attacksPerMember || 2)} | 📊 ${cocWarData.opponent.destructionPercentage.toFixed(2)}%`, inline: false }
                );

                // 아군 멤버 공격 정보 (너무 길어질 수 있으니 요약)
                let clanMemberAttacks = '';
                let hasClanAttackInfo = false; // 공격 정보가 있는지 여부를 판단하는 플래그

                if (cocWarData.clan.members && cocWarData.clan.members.length > 0) {
                    for (const member of cocWarData.clan.members.slice(0, 10)) {
                        clanMemberAttacks += `**${member.name}** (#${member.mapPosition + 1}): `;
                        if (member.attacks && member.attacks.length > 0) {
                            clanMemberAttacks += member.attacks.map(atk => `⭐${atk.stars} (${atk.destructionPercentage}%) vs #${atk.defenderTag.slice(atk.defenderTag.lastIndexOf('-') + 1)}`).join(', ');
                            hasClanAttackInfo = true; // 실제 공격 정보가 있음을 표시
                        } else {
                            clanMemberAttacks += '공격 안함';
                        }
                        clanMemberAttacks += '\n';
                    }
                    if (cocWarData.clan.members.length > 10) {
                        clanMemberAttacks += '...등\n';
                        if (!hasClanAttackInfo && cocWarData.clan.members.slice(0,10).some(m => m.attacks && m.attacks.length > 0)) {
                            // slice(0,10) 내에 공격이 있었는데 ...등 때문에 hasClanAttackInfo가 false로 남는 경우 방지
                            hasClanAttackInfo = true;
                        }
                    }

                    if (clanMemberAttacks.length > 1020) {
                        clanMemberAttacks = clanMemberAttacks.substring(0, 1020) + '...';
                    }

                    let attackSummaryFieldName = '⚔️ 아군 공격 요약 (API)';
                    let attackSummaryFieldValue;

                    if (hasClanAttackInfo) { // 실제 공격 정보가 하나라도 있다면
                        attackSummaryFieldValue = clanMemberAttacks.trim();
                    } else if (clanMemberAttacks.trim() !== '') { // 공격은 없지만 "공격 안함" 등의 메시지가 있다면
                        attackSummaryFieldValue = clanMemberAttacks.trim();
                    } else { // 멤버는 있지만 모든 정보가 비어있다면 (이 경우는 거의 없어야 함)
                        attackSummaryFieldValue = '`집계된 공격 정보 없음`';
                    }

                    // 필드 객체 미리 생성
                    const attackSummaryField = { name: attackSummaryFieldName, value: attackSummaryFieldValue };
                    statusEmbed.addFields(attackSummaryField); // 미리 생성된 객체 전달
                }
            }

            // Firestore 기반 목표 예약 현황 (warData가 있을 때만)
            if (warData) {
                statusEmbed.addFields({ name: '\u200B', value: '**🎯 목표 예약 현황 (DB)**' });
                const targetsData = await getAllTargetsForWar(warIdToQuery);
                if (targetsData.length > 0) {
                    let 예약자_정보 = '';
                    targetsData.sort((a, b) => (a.targetNumber || 0) - (b.targetNumber || 0));
                    for (const target of targetsData) {
                        예약자_정보 += `**#${target.targetNumber}:** `;
                        if (target.reservedBy && target.reservedBy.length > 0) {
                            const reservists = target.reservedBy.map(uid => `<@${uid}>`).join(', ');
                            const confidences = target.reservedBy.map(uid => target.confidence && target.confidence[uid] ? `(${target.confidence[uid]}%)` : '(?%)').join(', ');
                            예약자_정보 += `${reservists} ${confidences}`;
                        } else {
                            예약자_정보 += '`미예약`';
                        }
                        if (target.result && target.result.stars !== undefined) {
                            예약자_정보 += ` | ⭐${target.result.stars} ${target.result.destruction}%`;
                        }
                        예약자_정보 += '\n';
                    }
                    if (예약자_정보.length > 1020) 예약자_정보 = 예약자_정보.substring(0, 1020) + '...';
                    statusEmbed.addFields({ name: '목표별 정보 (DB)', value: 예약자_정보 || '`정보 없음`'});
                } else {
                    statusEmbed.addFields({ name: '목표별 정보 (DB)', value: '`예약된 목표가 없습니다.`'});
                }
            }
            
            statusEmbed.setTimestamp()
                       .setFooter({ text: `요청자: ${interaction.user.tag}${warIdToQuery ? ` | War ID: ${warIdToQuery}` : ''}` });

            await interaction.editReply({ embeds: [statusEmbed] });

        } catch (error) {
            console.error(`Error executing /status for warId '${specifiedWarId || 'current channel'}'}:`, error);
            let errorMessage = `상태 조회 중 오류가 발생했습니다: ${error.message || '알 수 없는 오류'}`;
            if (error.isAxiosError && error.response) {
                if (error.response.status === 403) {
                    errorMessage = 'CoC API 접근 권한 오류 (403): IP 주소가 허용 목록에 없거나 API 토큰이 유효하지 않습니다.';
                } else if (error.response.status === 404) {
                    errorMessage = 'CoC API 오류 (404): 클랜 정보를 찾을 수 없습니다.';
                } else {
                    errorMessage = `CoC API 서버 오류 (${error.response.status}): ${error.response.data?.reason || error.message}`;
                }
            }
            await interaction.editReply({ content: errorMessage, ephemeral: true });
        }
    },
};
 