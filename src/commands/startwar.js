const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { db } = require('../services/firestoreHandler'); // Firestore 핸들러 가져오기
const { getCurrentWar } = require('../services/cocApiService'); // CoC API 서비스 추가
const { createInitialTargetEmbed, createTargetActionRow } = require('../utils/embedRenderer'); // Embed 및 버튼 생성 함수
// const clashApi = require('../services/clashApiHandler');
const admin = require('firebase-admin');
require('dotenv').config(); // .env 파일 로드

module.exports = {
    data: new SlashCommandBuilder()
        .setName('startwar')
        .setDescription('클랜의 현재 CoC 전쟁 정보를 기반으로 협업 채널을 생성합니다.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels) // '채널 관리' 권한이 있는 사용자만 사용 가능 (기획서상 Leader 역할)
        .setDMPermission(false), // DM에서 사용 불가
    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: '이 명령어는 서버 채널에서만 사용할 수 있습니다.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true }); // 초기 응답 지연

        try {
            // 1. CoC API에서 현재 전쟁 정보 가져오기
            const currentWarData = await getCurrentWar();

            if (!currentWarData || !['inWar', 'preparation', 'warEnded'].includes(currentWarData.state)) { // warEnded도 일단 허용 (지난 전쟁 정보로 채널 만들고 싶을 수도 있으니)
                return interaction.editReply({ content: '클랜이 현재 전쟁 중이 아니거나 CoC API에서 전쟁 정보를 가져올 수 없습니다. 😥 API 토큰, 클랜 태그, IP 허용 목록을 확인해주세요.', ephemeral: true });
            }
            
            if (currentWarData.state === 'notInWar') {
                 return interaction.editReply({ content: '클랜이 현재 전쟁 중이 아닙니다.  전쟁 시작 후 다시 시도해주세요. ⚔️', ephemeral: true });
            }

            // 2. 환경 변수 및 API 데이터에서 정보 추출
            const clanTag = process.env.CLAN_TAG;
            if (!clanTag) {
                return interaction.editReply({ content: '봇 환경설정에 CLAN_TAG가 설정되지 않았습니다. 관리자에게 문의하세요.', ephemeral: true });
            }
            const teamSize = currentWarData.teamSize || parseInt(process.env.DEFAULT_TEAM_SIZE) || 10;
            
            // 전쟁 ID 생성 (클랜태그-전쟁시작시간(YYYYMMDDHHMM UTC))
            const warStartTimeISO = currentWarData.startTime !== '0001-01-01T00:00:00.000Z' ? currentWarData.startTime : currentWarData.preparationStartTime;
            let warId;

            if (warStartTimeISO && warStartTimeISO !== '0001-01-01T00:00:00.000Z') {
                const warStartDate = new Date(warStartTimeISO);
                warId = `${clanTag.replace('#', '')}-${warStartDate.getUTCFullYear()}${(warStartDate.getUTCMonth() + 1).toString().padStart(2, '0')}${warStartDate.getUTCDate().toString().padStart(2, '0')}${warStartDate.getUTCHours().toString().padStart(2, '0')}${warStartDate.getUTCMinutes().toString().padStart(2, '0')}`;
            } else {
                // API에서 유효한 시작 시간을 못 가져오면 에러 처리 (이런 경우는 거의 없어야 함)
                console.error('CoC API에서 유효한 전쟁 시작 시간을 가져오지 못했습니다. currentWarData:', currentWarData);
                return interaction.editReply({ content: 'CoC API에서 전쟁 시작 시간을 가져오는 데 실패했습니다. 잠시 후 다시 시도하거나 관리자에게 문의하세요.', ephemeral: true });
            }

            // 3. Firestore에서 동일 warId & 미종료 전쟁 확인
            const existingWarSnapshot = await db.collection('wars').doc(warId).get();
            if (existingWarSnapshot.exists && existingWarSnapshot.data().ended === false) {
                const existingChannelId = existingWarSnapshot.data().channelId;
                return interaction.editReply({ content: `이미 해당 전쟁 세션(\`${warId}\`)이 <#${existingChannelId}> 채널에서 진행 중입니다. 🏁`, ephemeral: true });
            }

            // 4. 전용 채널 생성
            const warChannelCategoryName = process.env.WAR_CHANNEL_CATEGORY_NAME || 'Clash of Clans Wars';
            let category = interaction.guild.channels.cache.find(c => c.name.toLowerCase() === warChannelCategoryName.toLowerCase() && c.type === ChannelType.GuildCategory);
            // 카테고리가 없다면 생성 (선택적)
            if (!category && process.env.CREATE_WAR_CATEGORY_IF_NOT_EXISTS === 'true') {
                 try {
                     category = await interaction.guild.channels.create({
                         name: warChannelCategoryName,
                         type: ChannelType.GuildCategory,
                     });
                     console.log(`카테고리 \'${warChannelCategoryName}\'이(가) 생성되었습니다.`);
                 } catch (catError) {
                     console.warn(`\'${warChannelCategoryName}\' 카테고리 생성 실패:`, catError);
                 }
            }
            
            const warStartDateForChannel = new Date(warStartTimeISO);
            const channelName = `war-${warStartDateForChannel.getUTCFullYear()}${(warStartDateForChannel.getUTCMonth() + 1).toString().padStart(2, '0')}${warStartDateForChannel.getUTCDate().toString().padStart(2, '0')}-${currentWarData.opponent?.tag?.replace('#', '') || 'unknown'}`;

            const warChannel = await interaction.guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                parent: category ? category.id : null,
                topic: `클랜 전쟁 [${warId}] (${currentWarData.opponent?.name || 'Unknown Opponent'}) 협업 채널. 시작: <t:${Math.floor(warStartDateForChannel.getTime() / 1000)}:R>`,
                permissionOverwrites: [
                    {
                        id: interaction.guild.roles.everyone,
                        deny: [PermissionFlagsBits.SendMessages],
                        allow: [PermissionFlagsBits.ViewChannel]
                    },
                    {
                        id: interaction.user.id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels],
                    },
                    // LEADER_ROLE_ID가 설정되어 있고, 해당 역할이 존재하면 권한 부여
                    ...(process.env.LEADER_ROLE_ID && interaction.guild.roles.cache.has(process.env.LEADER_ROLE_ID) ? [{
                        id: process.env.LEADER_ROLE_ID,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels]
                    }] : [])
                ],
            });

            await interaction.editReply({ content: `전쟁 채널 <#${warChannel.id}> (\`${warId}\`)이(가) 생성되었습니다. API 정보를 바탕으로 설정되었습니다.` });

            // 5. Embed 및 버튼 전송, 메시지 ID 저장
            const messageIds = {};
            for (let i = 1; i <= teamSize; i++) {
                const embed = createInitialTargetEmbed(i, warId); // warId를 전달
                const row = createTargetActionRow(i, warId);   // warId를 전달
                const sentMessage = await warChannel.send({ embeds: [embed], components: [row] });
                messageIds[i] = sentMessage.id;
            }

            // 6. Firestore에 전쟁 세션 데이터 저장
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
                createdBy: interaction.user.id,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                ended: currentWarData.state === 'warEnded' ? true : false, // API 상태에 따라 초기 종료 상태 설정
                // endedAt, endedBy는 /endwar 명령어에서 설정
            };

            await db.collection('wars').doc(warId).set(warSessionData);
            console.log(`전쟁 세션 ${warId} (API 기반) Firestore에 저장됨. 채널: #${warChannel.name}`);

            // 상대 클랜 정보 Embed (선택적)
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

        } catch (error) {
            console.error(`Error executing /startwar for guild ${interaction.guild?.id} by user ${interaction.user.id}:`, error);
            // API 에러 메시지를 좀 더 친절하게 표시 (403, 404 등)
            let errorMessage = '전쟁 시작 중 오류가 발생했습니다. 😥';
            if (error.isAxiosError && error.response) {
                if (error.response.status === 403) {
                    errorMessage = 'CoC API 접근 권한 오류 (403): IP 주소가 허용 목록에 없거나 API 토큰이 유효하지 않습니다. 봇 관리자에게 문의하세요.';
                } else if (error.response.status === 404) {
                    errorMessage = 'CoC API 오류 (404): 클랜 정보를 찾을 수 없거나 현재 전쟁 중이 아닐 수 있습니다. 클랜 태그를 확인하거나 잠시 후 다시 시도해주세요.';
                } else {
                    errorMessage = `CoC API 서버 오류 (${error.response.status}): ${error.response.data?.reason || error.message}`;
                }
            } else if (error.message) {
                errorMessage = error.message;
            }

            if (interaction.replied || interaction.deferred) {
                await interaction.editReply({ content: errorMessage, ephemeral: true });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    },
}; 