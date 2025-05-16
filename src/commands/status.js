const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { db, getWarSession, firebaseInitialized } = require('../services/firestoreHandler.js');
const { getCurrentWar } = require('../services/cocApiService.js');
require('dotenv').config();

const COMMAND_NAME = 'status';
const logPrefix = `[COMMAND:${COMMAND_NAME}]`;

// 모든 목표 정보를 가져오는 함수
async function getAllTargetsForWar(warId) {
    const funcLogPrefix = `${logPrefix}[getAllTargetsForWar][warId:${warId}]`;
    console.debug(`${funcLogPrefix} Function called.`);
    if (!firebaseInitialized || !db) {
        console.error(`${funcLogPrefix} Firestore not initialized. Cannot fetch targets.`);
        return []; // Firestore 문제 시 빈 배열 반환
    }
    const targets = [];
    try {
        console.debug(`${funcLogPrefix} Fetching targets from Firestore.`);
        const targetsSnapshot = await db.collection('wars').doc(warId).collection('targets').orderBy('targetNumber').get();
        targetsSnapshot.forEach(doc => {
            targets.push(doc.data());
        });
        console.info(`${funcLogPrefix} Successfully fetched ${targets.length} targets.`);
    } catch (error) {
        console.error(`${funcLogPrefix} Error fetching targets:`, error);
        // 에러 발생 시 빈 배열 반환 또는 throw error 처리 (여기서는 빈 배열 반환 유지)
    }
    return targets;
}

// 시간 변환 함수 (초 -> HH:MM:SS 또는 DD HH:MM:SS)
function formatDuration(seconds) {
    // console.debug(`${logPrefix}[formatDuration] Called with seconds: ${seconds}`); // 너무 빈번할 수 있어 주석 처리
    if (seconds < 0) seconds = 0;
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor(seconds % (3600 * 24) / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);
    let str = '';
    if (d > 0) str += `${d}일 `;
    if (h > 0 || d > 0) str += `${h.toString().padStart(2, '0')}:`;
    str += `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    const result = str || '00:00';
    // console.debug(`${logPrefix}[formatDuration] Result: ${result}`); // 너무 빈번할 수 있어 주석 처리
    return result;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName(COMMAND_NAME)
        .setDescription('현재 또는 지정된 전쟁의 진행 상황과 CoC API 실시간 정보를 함께 보여줍니다.')
        .addStringOption(option =>
            option.setName('warid')
                .setDescription('정보를 조회할 특정 전쟁의 ID (생략 시 현재 채널의 전쟁 정보 조회)')
                .setRequired(false))
        .setDMPermission(true),

    async execute(interaction) {
        const commandName = interaction.commandName;
        const userId = interaction.user.id;
        const username = interaction.user.username;
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;
        const specifiedWarId = interaction.options.getString('warid');

        const execLogPrefix = `[COMMAND:${commandName}][${username}_(${userId})][Guild:${guildId || 'DM'}][Channel:${channelId || 'DM'}][SpecifiedWarId:${specifiedWarId || 'None'}]`;

        console.info(`${execLogPrefix} Command execution started.`);

        if (!firebaseInitialized) {
            console.error(`${execLogPrefix} Firestore is not initialized. Replying and exiting.`);
            await interaction.reply({ content: '데이터베이스 연결에 실패하여 명령을 실행할 수 없습니다. 잠시 후 다시 시도해주세요. 😔', flags: [MessageFlags.Ephemeral] });
            return;
        }

        console.debug(`${execLogPrefix} Deferring reply.`);
        await interaction.deferReply({ ephemeral: false }); 

        let warIdToQuery = specifiedWarId;
        let warData; // Firestore war data
        let cocWarData; // CoC API war data
        let errorOccurred = false; // errorOccurred 변수 선언 및 초기화

        try {
            console.info(`${execLogPrefix} Determining warId to query. Specified: ${specifiedWarId}`);
            if (!warIdToQuery) {
                const currentChannelId = interaction.channelId;
                if (!currentChannelId && interaction.guildId) {
                    console.warn(`${execLogPrefix} Cannot get current channelId in a guild. Replying and exiting.`);
                    return interaction.editReply({ content: '채널 정보를 가져올 수 없습니다. `warid`를 명시해주세요.', flags: [MessageFlags.Ephemeral] });
                }
                console.debug(`${execLogPrefix} No warId specified. Attempting to find active war for current channel: ${currentChannelId}`);
                
                // Firestore 초기화 및 db 객체 유효성 재확인
                if (!firebaseInitialized || !db) {
                    console.error(`${execLogPrefix} Firestore not properly initialized. db is ${db === null ? 'null' : (db === undefined ? 'undefined' : 'valid but firebaseInitialized is false')}. Replying and exiting.`);
                    errorOccurred = true; // 이 변수는 try 블록 바깥에 선언되어 있어야 함
                    return interaction.editReply({ content: '데이터베이스 연결 상태가 불안정하여 현재 채널의 전쟁 정보를 조회할 수 없습니다. 😔', flags: [MessageFlags.Ephemeral] });
                }

                const warsQuery = db.collection('wars').where('channelId', '==', currentChannelId).where('ended', '==', false).limit(1);
                const warsSnapshot = await warsQuery.get();
                
                if (warsSnapshot.empty) {
                    console.info(`${execLogPrefix} No active war found in Firestore for channel ${currentChannelId}. Attempting to get current war from CoC API.`);
                    cocWarData = await getCurrentWar();
                    if (cocWarData && cocWarData.state !== 'notInWar') {
                        console.info(`${execLogPrefix} Current war found via CoC API. State: ${cocWarData.state}. Generating warId.`);
                        const warStartTimeISO = cocWarData.startTime !== '0001-01-01T00:00:00.000Z' ? cocWarData.startTime : cocWarData.preparationStartTime;
                        const warStartDate = new Date(warStartTimeISO);
                        const clanTagForId = (process.env.CLAN_TAG || 'UNKNOWN_CLAN').replace('#', '');
                        warIdToQuery = `${clanTagForId}-${warStartDate.getUTCFullYear()}${(warStartDate.getUTCMonth() + 1).toString().padStart(2, '0')}${warStartDate.getUTCDate().toString().padStart(2, '0')}${warStartDate.getUTCHours().toString().padStart(2, '0')}${warStartDate.getUTCMinutes().toString().padStart(2, '0')}`;
                        console.info(`${execLogPrefix} Generated warId from API data: ${warIdToQuery}. Fetching from Firestore.`);
                        warData = await getWarSession(warIdToQuery);
                        if (!warData) {
                            console.warn(`${execLogPrefix} War ${warIdToQuery} (from API) not found in Firestore. Will display API data only if available.`);
                        } else {
                            console.info(`${execLogPrefix} War ${warIdToQuery} found in Firestore based on API data.`);
                        }
                    } else {
                        console.info(`${execLogPrefix} No active war in current channel (Firestore) and no current war in CoC API (or clan not in war). Replying and exiting.`);
                        return interaction.editReply({ content: '현재 채널 또는 API에서 진행 중인 전쟁 정보를 찾을 수 없습니다. 😢 `warid`를 지정하거나 전쟁 채널에서 사용해주세요.', flags: [MessageFlags.Ephemeral] });
                    }
                } else {
                    warIdToQuery = warsSnapshot.docs[0].id;
                    warData = warsSnapshot.docs[0].data();
                    console.info(`${execLogPrefix} Active war found in Firestore for current channel: ${warIdToQuery}`);
                }
            } else {
                console.info(`${execLogPrefix} WarId ${warIdToQuery} was specified. Fetching from Firestore.`);
                warData = await getWarSession(warIdToQuery);
                if (!warData) {
                    console.warn(`${execLogPrefix} Specified warId ${warIdToQuery} not found in Firestore. Replying and exiting.`);
                    return interaction.editReply({ content: `\`${warIdToQuery}\` ID에 해당하는 전쟁 정보를 Firestore에서 찾을 수 없습니다. 🔍 API로 현재 전쟁을 확인하려면 warid 없이 사용해보세요.`, flags: [MessageFlags.Ephemeral] });
                }
                 console.info(`${execLogPrefix} War ${warIdToQuery} found in Firestore.`);
            }

            console.info(`${execLogPrefix} Attempting to fetch current war data from CoC API for comparison/display (Target War ID for context: ${warIdToQuery || 'None from DB yet'}).`);
            // cocWarData는 위에서 이미 가져왔을 수 있음. warData가 있고 끝나지 않았거나, specifiedWarId 없이 cocWarData가 이미 있는 경우에만 다시 가져오거나 사용.
            if ((warData && !warData.ended) || (!specifiedWarId && cocWarData && cocWarData.state !== 'notInWar')) {
                if (!cocWarData || (cocWarData && cocWarData.state === 'notInWar' && warData && !warData.ended)) { // 만약 위에서 notInWar였는데, DB엔 진행중인 전쟁이 있다면 다시 API 호출 시도
                    console.debug(`${execLogPrefix} Fetching fresh CoC API data. Current cocWarData state: ${cocWarData?.state}`);
                    cocWarData = await getCurrentWar(); 
                    console.info(`${execLogPrefix} Fetched CoC API data. New state: ${cocWarData?.state}`);
                } else {
                    console.debug(`${execLogPrefix} Using existing CoC API data. State: ${cocWarData?.state}`);
                }
                
                if (warData && cocWarData && cocWarData.state !== 'notInWar') {
                    console.debug(`${execLogPrefix} Comparing Firestore war start time with API war start time.`);
                    const fsWarStartTimeISO = warData.startTime?.seconds ? new Date(warData.startTime.seconds * 1000).toISOString() : (warData.preparationStartTime?.seconds ? new Date(warData.preparationStartTime.seconds * 1000).toISOString() : null);
                    const apiWarStartTimeISO = cocWarData.startTime !== '0001-01-01T00:00:00.000Z' ? cocWarData.startTime : (cocWarData.preparationStartTime !== '0001-01-01T00:00:00.000Z' ? cocWarData.preparationStartTime : null);
                    
                    console.debug(`${execLogPrefix} Firestore war start (ISO): ${fsWarStartTimeISO}, API war start (ISO): ${apiWarStartTimeISO}`);
                    // 분 단위 비교를 위해 YYYY-MM-DDTHH:MM 형식으로 통일
                    const fsWarTimePrefix = fsWarStartTimeISO ? fsWarStartTimeISO.slice(0, 16) : null;
                    const apiWarTimePrefix = apiWarStartTimeISO ? apiWarStartTimeISO.slice(0, 16) : null;

                    if (fsWarTimePrefix && apiWarTimePrefix && fsWarTimePrefix !== apiWarTimePrefix) {
                        console.warn(`${execLogPrefix} Firestore war (${warIdToQuery}, Start: ${fsWarTimePrefix}) and API current war (Start: ${apiWarTimePrefix}) seem to be different. API data will not be displayed as primary.`);
                        cocWarData = null; // 다른 전쟁이면 API 데이터 사용 안 함 (또는 경고 메시지와 함께 표시)
                    } else if (fsWarTimePrefix && apiWarTimePrefix) {
                        console.info(`${execLogPrefix} Firestore war and API current war seem to be the same (based on start time prefix: ${fsWarTimePrefix}).`);
                    } else {
                        console.warn(`${execLogPrefix} Could not reliably compare Firestore war time with API war time due to missing data. fsWarTimePrefix: ${fsWarTimePrefix}, apiWarTimePrefix: ${apiWarTimePrefix}`);
                    }
                }
            } else {
                 console.info(`${execLogPrefix} Not fetching/using CoC API data because Firestore war has ended, or no warId identified and API showed notInWar.`);
            }

            const statusEmbed = new EmbedBuilder();
            let title = '🛡️ 전쟁 현황';
            if (warIdToQuery) title += `: ${warIdToQuery}`;
            else if (cocWarData?.clan?.name && cocWarData?.opponent?.name) title += `: ${cocWarData.clan.name} vs ${cocWarData.opponent.name}`; // warIdToQuery가 없는 API 전용 케이스
            console.debug(`${execLogPrefix} Setting embed title: "${title}"`);
            statusEmbed.setTitle(title);

            if (warData) {
                console.info(`${execLogPrefix} Populating embed with Firestore war data (warId: ${warIdToQuery}). Ended: ${warData.ended}`);
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
            } else if (cocWarData && cocWarData.state !== 'notInWar') { // Firestore 데이터는 없지만 API 데이터만 있는 경우 (warIdToQuery가 생성되었을 수 있음)
                console.info(`${execLogPrefix} Populating embed with CoC API data only (warId from API if generated: ${warIdToQuery}). State: ${cocWarData.state}`);
                statusEmbed.setColor(cocWarData.state === 'inWar' ? 0xFF0000 : (cocWarData.state === 'preparation' ? 0x00FF00 : 0x808080));
                statusEmbed.setDescription(`**클랜 태그:** ${cocWarData.clan.tag}\n**API 상태:** ${cocWarData.state}`);
                statusEmbed.addFields(
                    { name: '팀 규모 (API)', value: String(cocWarData.teamSize), inline: true },
                    { name: '상대 (API)', value: `${cocWarData.opponent.name} (${cocWarData.opponent.tag})`, inline: true }
                );
            } else {
                console.warn(`${execLogPrefix} No war data found from Firestore or CoC API. Replying and exiting.`);
                return interaction.editReply({ content: '전쟁 정보를 찾을 수 없습니다. 😥', flags: [MessageFlags.Ephemeral] });
            }
            
            if (cocWarData && cocWarData.state !== 'notInWar') {
                console.info(`${execLogPrefix} Adding CoC API real-time information to embed. API State: ${cocWarData.state}`);
                statusEmbed.addFields({ name: '\u200B', value: '**📡 CoC API 실시간 정보**' });
                statusEmbed.addFields(
                    { name: 'API 상태', value: `\`${cocWarData.state}\``, inline: true },
                );

                let timeFieldName = '남은 시간';
                let timeValue = 'N/A';
                const now = Math.floor(Date.now() / 1000);
                console.debug(`${execLogPrefix} Calculating time remaining. API state: ${cocWarData.state}, StartTime: ${cocWarData.startTime}, EndTime: ${cocWarData.endTime}`);

                if (cocWarData.state === 'preparation') {
                    const startTimeEpoch = Math.floor(new Date(cocWarData.startTime).getTime() / 1000);
                    if (startTimeEpoch > now) {
                        timeFieldName = '전쟁 시작까지';
                        timeValue = formatDuration(startTimeEpoch - now) + ` (<t:${startTimeEpoch}:R>)`;
                    } else { 
                        timeFieldName = '전쟁 준비 중 (시간 오류)';
                        timeValue = 'API 시간 정보 확인 필요';
                        console.warn(`${execLogPrefix} API state is 'preparation' but startTime (${cocWarData.startTime}) is in the past.`);
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
                console.debug(`${execLogPrefix} Time field: '${timeFieldName}', Value: '${timeValue}'`);
                statusEmbed.addFields({ name: timeFieldName, value: timeValue, inline: true });
                statusEmbed.addFields(
                    { name: `${cocWarData.clan.name} (우리팀)`, value: `⭐ ${cocWarData.clan.stars} | ⚔️ ${cocWarData.clan.attacks}/${cocWarData.teamSize * (cocWarData.attacksPerMember || 2)} | 📊 ${cocWarData.clan.destructionPercentage.toFixed(2)}%`, inline: false },
                    { name: `${cocWarData.opponent.name} (상대팀)`, value: `⭐ ${cocWarData.opponent.stars} | ⚔️ ${cocWarData.opponent.attacks}/${cocWarData.teamSize * (cocWarData.attacksPerMember || 2)} | 📊 ${cocWarData.opponent.destructionPercentage.toFixed(2)}%`, inline: false }
                );
                console.debug(`${execLogPrefix} Added clan and opponent scores from API.`);

                // 아군 멤버 공격 정보 요약 추가
                if (cocWarData.clan.members && cocWarData.clan.members.length > 0) {
                    let clanMemberAttacksSummary = '';
                    let attackCount = 0;
                    const maxMembersToShow = 5; // 너무 길어지지 않게 표시할 멤버 수 제한
                    cocWarData.clan.members.slice(0, maxMembersToShow).forEach(member => {
                        if (member.attacks && member.attacks.length > 0) {
                            clanMemberAttacksSummary += `**${member.name}**: ${member.attacks.length}회 공격\n`;
                            attackCount += member.attacks.length;
                        }
                    });
                    if (cocWarData.clan.members.length > maxMembersToShow && attackCount > 0) {
                        clanMemberAttacksSummary += `... 등 (총 ${cocWarData.clan.attacks}회 공격)`;
                    } else if (attackCount === 0) {
                        clanMemberAttacksSummary = '아직 공격 정보 없음';
                    }
                    statusEmbed.addFields({ name: '아군 공격 요약 (API)', value: clanMemberAttacksSummary || '정보 없음', inline: false });
                    console.debug(`${execLogPrefix} Added clan member attack summary from API.`);
                }
            } else {
                console.info(`${execLogPrefix} No CoC API real-time data to add or clan not in war.`);
            }

            // Firestore 기반 목표 현황 (warData가 있을 때)
            if (warData && warIdToQuery) {
                console.info(`${execLogPrefix} Fetching all targets from Firestore for war ${warIdToQuery} to display status.`);
                const targets = await getAllTargetsForWar(warIdToQuery);
                if (targets.length > 0) {
                    statusEmbed.addFields({ name: '\u200B', value: '**🎯 Firestore 목표 예약 현황**' });
                    let reservedCount = 0;
                    let destructionConfidenceSum = 0;
                    let destructionConfidenceUsers = 0;

                    targets.forEach(target => {
                        if (target.reservedBy && target.reservedBy.length > 0) {
                            reservedCount++;
                            target.reservedBy.forEach(userId => {
                                if (target.confidence && target.confidence[userId]) {
                                    destructionConfidenceSum += target.confidence[userId];
                                    destructionConfidenceUsers++;
                                }
                            });
                        }
                    });
                    const avgConfidence = destructionConfidenceUsers > 0 ? (destructionConfidenceSum / destructionConfidenceUsers).toFixed(1) : 'N/A';
                    statusEmbed.addFields(
                        { name: '예약된 목표 수', value: `${reservedCount} / ${targets.length}`, inline: true },
                        { name: '평균 예상 파괴율', value: `${avgConfidence}%`, inline: true }
                    );
                    console.debug(`${execLogPrefix} Added Firestore target summary: Reserved ${reservedCount}/${targets.length}, Avg Confidence ${avgConfidence}%`);
                } else {
                    console.info(`${execLogPrefix} No targets found in Firestore for war ${warIdToQuery}.`);
                }
            }
            console.info(`${execLogPrefix} Sending status embed.`);
            await interaction.editReply({ embeds: [statusEmbed] });
            console.info(`${execLogPrefix} Command execution finished successfully.`);

        } catch (error) {
            errorOccurred = true; // 오류 발생 시 true로 설정
            console.error(`${execLogPrefix} Error during command execution:`, error);
            let errorMessage = '상태 정보 조회 중 오류가 발생했습니다. 😥 로그를 확인해주세요.';
            // 오류 유형에 따른 메시지 분기 (startwar.js와 유사하게)
            if (error.isAxiosError && error.response) { 
                console.error(`${execLogPrefix} CoC API Error Details: Status ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
                if (error.response.status === 403) {
                    errorMessage = 'CoC API 접근 권한 오류 (403).';
                } else if (error.response.status === 404) {
                    errorMessage = 'CoC API 오류 (404): 클랜/전쟁 정보를 찾을 수 없습니다.';
                } else if (error.response.status === 503) {
                    errorMessage = 'CoC API 서버 점검 중 (503).';
                } else {
                    errorMessage = `CoC API 서버 오류 (${error.response.status}).`;
                }
            } else if (error.code) { 
                 console.error(`${execLogPrefix} Discord/Node.js Error Code: ${error.code}, Message: ${error.message}`);
                 errorMessage = `내부 오류 발생 (코드: ${error.code || 'N/A'}).`;
            } else if (error.message) { 
                errorMessage = error.message;
            }

            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.editReply({ content: errorMessage, flags: [MessageFlags.Ephemeral] });
                } else {
                    await interaction.reply({ content: errorMessage, flags: [MessageFlags.Ephemeral] });
                }
                console.info(`${execLogPrefix} Sent error message to user: ${errorMessage}`);
            } catch (replyError) {
                console.error(`${execLogPrefix} Failed to send error reply to user:`, replyError);
            }
            console.info(`${execLogPrefix} Command execution finished with errors.`);
        } finally {
            console.info(`${execLogPrefix} Command execution finished${interaction.replied || interaction.deferred ? (errorOccurred ? ' with errors.' : '.') : ' without explicit reply/deferral.'}`);
        }
    },
}; 