const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const { db, firebaseInitialized } = require('../services/firestoreHandler'); // Firestore 핸들러 가져오기
const { getCurrentWar } = require('../services/cocApiService'); // CoC API 서비스 추가
const { createInitialTargetEmbed, createTargetActionRow } = require('../utils/embedRenderer'); // Embed 및 버튼 생성 함수
// const clashApi = require('../services/clashApiHandler');
const admin = require('firebase-admin');
require('dotenv').config(); // .env 파일 로드

const COMMAND_NAME = 'startwar';
const logPrefix = `[COMMAND:${COMMAND_NAME}]`;

module.exports = {
    data: new SlashCommandBuilder()
        .setName(COMMAND_NAME)
        .setDescription('클랜의 현재 CoC 전쟁 정보를 기반으로 협업 채널을 생성합니다.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels) // '채널 관리' 권한이 있는 사용자만 사용 가능 (기획서상 Leader 역할)
        .setDMPermission(false), // DM에서 사용 불가
    async execute(interaction) {
        const { user, guild } = interaction;
        const execLogPrefix = `${logPrefix}[${user.tag}(${user.id})][Guild:${guild.id}]`;
        console.info(`${execLogPrefix} Command execution started.`);

        if (!guild) {
            console.warn(`${execLogPrefix} Command used outside of a guild. Replying and exiting.`);
            return interaction.reply({ content: '이 명령어는 서버 채널에서만 사용할 수 있습니다.', ephemeral: true });
        }

        if (!firebaseInitialized) {
            console.error(`${execLogPrefix} Firestore is not initialized. Replying and exiting.`);
            return interaction.reply({ content: '봇의 데이터베이스 연결에 문제가 발생했습니다. 관리자에게 문의하세요.', ephemeral: true });
        }

        console.debug(`${execLogPrefix} Deferring reply.`);
        await interaction.deferReply({ ephemeral: true }); // 초기 응답 지연

        try {
            console.info(`${execLogPrefix} Fetching current war data from CoC API.`);
            const currentWarData = await getCurrentWar();

            if (!currentWarData) {
                console.warn(`${execLogPrefix} No current war data received from CoC API or API call failed.`);
                return interaction.editReply({ content: 'CoC API에서 전쟁 정보를 가져올 수 없습니다. 😥 API 토큰, 클랜 태그, IP 허용 목록을 확인하거나, 현재 전쟁이 진행 중인지 확인해주세요.', ephemeral: true });
            }
            console.info(`${execLogPrefix} CoC API current war data received. State: ${currentWarData.state}`);
            
            if (currentWarData.state === 'notInWar') {
                console.info(`${execLogPrefix} Clan is not in war (state: notInWar). Replying and exiting.`);
                return interaction.editReply({ content: '클랜이 현재 전쟁 중이 아닙니다.  전쟁 시작 후 다시 시도해주세요. ⚔️', ephemeral: true });
            }

            // 'warEnded' 상태도 일단 허용 (지난 전쟁 정보로 채널 만들고 싶을 수도 있으니)
            if (!['inWar', 'preparation', 'warEnded'].includes(currentWarData.state)) {
                console.warn(`${execLogPrefix} Invalid war state from CoC API: ${currentWarData.state}. Replying and exiting.`);
                return interaction.editReply({ content: `현재 클랜의 전쟁 상태(${currentWarData.state})가 유효하지 않아 전쟁 채널을 시작할 수 없습니다.`, ephemeral: true });
            }

            const clanTag = process.env.CLAN_TAG;
            if (!clanTag) {
                console.error(`${execLogPrefix} CLAN_TAG is not set in .env file. Replying and exiting.`);
                return interaction.editReply({ content: '봇 환경설정에 CLAN_TAG가 설정되지 않았습니다. 관리자에게 문의하세요.', ephemeral: true });
            }
            console.debug(`${execLogPrefix} Using CLAN_TAG: ${clanTag}`);
            const teamSize = currentWarData.teamSize || parseInt(process.env.DEFAULT_TEAM_SIZE) || 10;
            console.debug(`${execLogPrefix} Team size determined: ${teamSize} (API: ${currentWarData.teamSize}, Default: ${process.env.DEFAULT_TEAM_SIZE})`);
            
            const warStartTimeISO = currentWarData.startTime !== '0001-01-01T00:00:00.000Z' ? currentWarData.startTime : currentWarData.preparationStartTime;
            let warId;
            console.debug(`${execLogPrefix} War start time from API (ISO): ${warStartTimeISO}`);

            if (warStartTimeISO && warStartTimeISO !== '0001-01-01T00:00:00.000Z') {
                const warStartDate = new Date(warStartTimeISO);
                warId = `${clanTag.replace('#', '')}-${warStartDate.getUTCFullYear()}${(warStartDate.getUTCMonth() + 1).toString().padStart(2, '0')}${warStartDate.getUTCDate().toString().padStart(2, '0')}${warStartDate.getUTCHours().toString().padStart(2, '0')}${warStartDate.getUTCMinutes().toString().padStart(2, '0')}`;
                console.info(`${execLogPrefix} Generated War ID: ${warId}`);
            } else {
                console.error(`${execLogPrefix} Failed to get valid war start time from CoC API. Data:`, currentWarData);
                return interaction.editReply({ content: 'CoC API에서 전쟁 시작 시간을 가져오는 데 실패했습니다. 잠시 후 다시 시도하거나 관리자에게 문의하세요.', ephemeral: true });
            }

            console.info(`${execLogPrefix} Checking for existing war session in Firestore with warId: ${warId}`);
            const existingWarSnapshot = await db.collection('wars').doc(warId).get();
            if (existingWarSnapshot.exists && existingWarSnapshot.data().ended === false) {
                const existingChannelId = existingWarSnapshot.data().channelId;
                console.warn(`${execLogPrefix} War session ${warId} already exists and is ongoing in channel ${existingChannelId}. Replying and exiting.`);
                return interaction.editReply({ content: `이미 해당 전쟁 세션(\`${warId}\`)이 <#${existingChannelId}> 채널에서 진행 중입니다. 🏁`, ephemeral: true });
            }
            console.info(`${execLogPrefix} No active existing war session found for ${warId}. Proceeding.`);

            const warChannelCategoryName = process.env.WAR_CHANNEL_CATEGORY_NAME || 'Clash of Clans Wars';
            console.debug(`${execLogPrefix} Target war channel category name: ${warChannelCategoryName}`);
            let category = guild.channels.cache.find(c => c.name.toLowerCase() === warChannelCategoryName.toLowerCase() && c.type === ChannelType.GuildCategory);
            
            if (!category && process.env.CREATE_WAR_CATEGORY_IF_NOT_EXISTS === 'true') {
                console.info(`${execLogPrefix} War category \'${warChannelCategoryName}\' not found. Attempting to create it (CREATE_WAR_CATEGORY_IF_NOT_EXISTS=true).`);
                try {
                    category = await guild.channels.create({
                        name: warChannelCategoryName,
                        type: ChannelType.GuildCategory,
                    });
                    console.info(`${execLogPrefix} War category \'${warChannelCategoryName}\' (ID: ${category.id}) created successfully.`);
                } catch (catError) {
                    console.warn(`${execLogPrefix} Failed to create war category \'${warChannelCategoryName}\':`, catError);
                    // 카테고리 생성 실패는 치명적이지 않으므로, null로 두고 진행
                    category = null;
                }
            } else if (!category) {
                console.info(`${execLogPrefix} War category \'${warChannelCategoryName}\' not found. Not creating (CREATE_WAR_CATEGORY_IF_NOT_EXISTS is not \'true\'). Channel will be created without parent.`);
            } else {
                console.info(`${execLogPrefix} Found existing war category: ${category.name} (ID: ${category.id})`);
            }
            
            const warStartDateForChannel = new Date(warStartTimeISO);
            const channelName = `war-${warStartDateForChannel.getUTCFullYear()}${(warStartDateForChannel.getUTCMonth() + 1).toString().padStart(2, '0')}${warStartDateForChannel.getUTCDate().toString().padStart(2, '0')}-${currentWarData.opponent?.tag?.replace('#', '') || 'unknown'}`;
            console.info(`${execLogPrefix} Attempting to create war channel with name: ${channelName} (Category ID: ${category?.id})`);

            const warChannel = await guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                parent: category ? category.id : null,
                topic: `클랜 전쟁 [${warId}] (${currentWarData.opponent?.name || 'Unknown Opponent'}) 협업 채널. 시작: <t:${Math.floor(warStartDateForChannel.getTime() / 1000)}:R>`,
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone,
                        deny: [PermissionFlagsBits.SendMessages],
                        allow: [PermissionFlagsBits.ViewChannel]
                    },
                    {
                        id: user.id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels],
                    },
                    // LEADER_ROLE_ID가 설정되어 있고, 해당 역할이 존재하면 권한 부여
                    ...(process.env.LEADER_ROLE_ID && guild.roles.cache.has(process.env.LEADER_ROLE_ID) ? [{
                        id: process.env.LEADER_ROLE_ID,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels]
                    }] : [])
                ],
            });
            console.info(`${execLogPrefix} War channel <#${warChannel.id}> (${warChannel.name}) created successfully.`);

            await interaction.editReply({ content: `전쟁 채널 <#${warChannel.id}> (\`${warId}\`)이(가) 생성되었습니다. API 정보를 바탕으로 설정되었습니다.` });
            console.debug(`${execLogPrefix} Initial reply sent to user regarding channel creation.`);

            console.info(`${execLogPrefix} Sending initial target embeds and buttons to channel <#${warChannel.id}> for ${teamSize} targets.`);
            const messageIds = {};
            for (let i = 1; i <= teamSize; i++) {
                console.debug(`${execLogPrefix} Creating embed and row for target #${i}, warId: ${warId}`);
                const embed = createInitialTargetEmbed(i, warId);
                const row = createTargetActionRow(i, warId);
                try {
                    const sentMessage = await warChannel.send({ embeds: [embed], components: [row] });
                    messageIds[i] = sentMessage.id;
                    console.debug(`${execLogPrefix} Sent message for target #${i}, messageId: ${sentMessage.id}`);
                } catch (msgError) {
                    console.error(`${execLogPrefix} Failed to send message for target #${i} in channel <#${warChannel.id}>:`, msgError);
                    // 개별 메시지 실패 시 일단 계속 진행, 추후 오류 리포팅 고려
                }
            }
            console.info(`${execLogPrefix} Finished sending ${Object.keys(messageIds).length} (expected ${teamSize}) initial messages.`);

            console.info(`${execLogPrefix} Preparing war session data for Firestore (warId: ${warId}).`);
            const warSessionData = {
                warId: warId,
                clanTag: clanTag,
                opponentClanTag: currentWarData.opponent?.tag,
                opponentClanName: currentWarData.opponent?.name,
                opponentClanLevel: currentWarData.opponent?.clanLevel,
                teamSize: teamSize,
                attacksPerMember: currentWarData.attacksPerMember || parseInt(process.env.MAX_ATTACKS_PER_MEMBER) || 2, // API에 있으면 쓰고 없으면 환경변수, 그것도 없으면 2
                preparationStartTime: currentWarData.preparationStartTime !== '0001-01-01T00:00:00.000Z' ? admin.firestore.Timestamp.fromDate(new Date(currentWarData.preparationStartTime)) : null,
                startTime: currentWarData.startTime !== '0001-01-01T00:00:00.000Z' ? admin.firestore.Timestamp.fromDate(new Date(currentWarData.startTime)) : null,
                endTime: currentWarData.endTime !== '0001-01-01T00:00:00.000Z' ? admin.firestore.Timestamp.fromDate(new Date(currentWarData.endTime)) : null,
                state: currentWarData.state, // API에서 가져온 전쟁 상태 ('preparation', 'inWar', 'warEnded')
                channelId: warChannel.id,
                messageIds: messageIds,
                createdBy: user.id,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                ended: currentWarData.state === 'warEnded' ? true : false, // API 상태에 따라 초기 종료 상태 설정
                // endedAt, endedBy는 /endwar 명령어에서 설정
            };
            console.debug(`${execLogPrefix} War session data prepared:`, { warId, clanTag, opponentClanTag: warSessionData.opponentClanTag, teamSize, channelId: warSessionData.channelId, state: warSessionData.state, messageIdsCount: Object.keys(messageIds).length });

            await db.collection('wars').doc(warId).set(warSessionData);
            console.info(`${execLogPrefix} War session ${warId} data saved to Firestore for channel <#${warChannel.name}>.`);

            console.info(`${execLogPrefix} Sending opponent clan info embed to <#${warChannel.id}>.`);
            const opponentEmbed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle(`⚔️ 상대 클랜 정보: ${currentWarData.opponent?.name || '알 수 없음'}`)
                .addFields(
                    { name: '클랜 태그', value: currentWarData.opponent?.tag || 'N/A', inline: true },
                    { name: '클랜 레벨', value: String(currentWarData.opponent?.clanLevel || 'N/A'), inline: true },
                    { name: '전쟁 승리', value: String(currentWarData.opponent?.warWins || 'N/A'), inline: true }
                )
                .setThumbnail(currentWarData.opponent?.badgeUrls?.medium || null)
                .setFooter({ text: `War ID: ${warId}`});
            await warChannel.send({ embeds: [opponentEmbed] });
            console.info(`${execLogPrefix} Opponent clan info embed sent.`);
            console.info(`${execLogPrefix} Command execution finished successfully.`);

        } catch (error) {
            console.error(`${execLogPrefix} Error during command execution:`, error);
            let errorMessage = '전쟁 시작 중 오류가 발생했습니다. 😥 로그를 확인해주세요.';
            if (error.isAxiosError && error.response) { // Axios 에러 (CoC API 관련)
                console.error(`${execLogPrefix} CoC API Error Details: Status ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
                if (error.response.status === 403) {
                    errorMessage = 'CoC API 접근 권한 오류 (403): IP 주소가 허용 목록에 없거나 API 토큰이 유효하지 않습니다. 봇 관리자에게 문의하세요.';
                } else if (error.response.status === 404) {
                    errorMessage = 'CoC API 오류 (404): 클랜 정보를 찾을 수 없거나 현재 전쟁 중이 아닐 수 있습니다. 클랜 태그를 확인하거나 잠시 후 다시 시도해주세요.';
                } else if (error.response.status === 503) {
                    errorMessage = 'CoC API 서버 점검 중 (503): 현재 CoC API 서버가 점검 중일 수 있습니다. 잠시 후 다시 시도해주세요.';
                } else {
                    errorMessage = `CoC API 서버 오류 (${error.response.status}): ${error.response.data?.reason || error.message}`;
                }
            } else if (error.code) { // Discord API 에러 또는 Node.js 에러
                console.error(`${execLogPrefix} Discord/Node.js Error Code: ${error.code}, Message: ${error.message}`);
                errorMessage = `Discord API 또는 내부 오류 발생: ${error.message} (코드: ${error.code || 'N/A'}). 봇 관리자에게 문의하세요.`;
                if (error.code === 50001) { // Missing Access
                    errorMessage = '봇이 채널 또는 역할을 생성/관리할 권한이 없습니다. 서버 설정을 확인해주세요. (오류 코드: 50001)';
                } else if (error.code === 50013) { // Missing Permissions
                    errorMessage = '봇이 특정 작업을 수행할 권한이 없습니다. (오류 코드: 50013)';
                }
            } else if (error.message) { // 일반 JavaScript 에러
                errorMessage = error.message;
            }

            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.editReply({ content: errorMessage, ephemeral: true });
                } else {
                    await interaction.reply({ content: errorMessage, ephemeral: true });
                }
                console.info(`${execLogPrefix} Sent error message to user: ${errorMessage}`);
            } catch (replyError) {
                console.error(`${execLogPrefix} Failed to send error reply to user:`, replyError);
            }
            console.info(`${execLogPrefix} Command execution finished with errors.`);
        }
    },
}; 