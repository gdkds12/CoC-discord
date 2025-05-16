const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { db } = require('../services/firestoreHandler'); // Firestore 핸들러 가져오기
const { createInitialTargetEmbed, createTargetActionRow } = require('../utils/embedRenderer'); // Embed 및 버튼 생성 함수
// const clashApi = require('../services/clashApiHandler');
const admin = require('firebase-admin');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('startwar')
        .setDescription('새로운 클랜 전쟁 세션을 시작하고 전용 채널을 생성합니다.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels) // '채널 관리' 권한이 있는 사용자만 사용 가능 (기획서상 Leader 역할)
        .setDMPermission(false), // DM에서 사용 불가
    async execute(interaction) {
        // TODO: Leader 역할 확인 (환경 변수나 DB에서 설정된 역할 ID와 비교)
        // const leaderRoleId = process.env.LEADER_ROLE_ID;
        // if (!interaction.member.roles.cache.has(leaderRoleId)) {
        // return interaction.reply({ content: '이 명령어를 사용할 권한이 없습니다.', ephemeral: true });
        // }

        await interaction.deferReply({ ephemeral: true }); // 초기 응답 지연

        try {
            // 1. 현재 전쟁 ID 가져오기 (Clash API 연동 필요 - 추후 구현)
            // const warData = await clashApi.getCurrentWar(process.env.CLAN_TAG);
            // if (!warData || warData.state === 'notInWar') {
            // return interaction.editReply({ content: '현재 진행 중인 전쟁이 없거나 정보를 가져올 수 없습니다.' });
            // }
            // const warId = `${new Date().toISOString().slice(0,10)}-${warData.opponent.tag}`; // 예시 warId 생성 (상대 클랜 태그 사용)
            const warId = `war-${Date.now()}`; // 임시 전쟁 ID
            const teamSize = parseInt(process.env.DEFAULT_TEAM_SIZE) || 10; // .env 에서 팀 사이즈 가져오거나 기본값 10
            const clanTag = process.env.CLAN_TAG || '#ABC123'; // .env 에서 클랜 태그 가져오거나 기본값

            // 2. 전용 채널 생성 (예: war-YYYYMMDD-xxxx)
            const channelName = `war-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${warId.slice(-4)}`;
            
            // 'Clan Wars' 카테고리가 있는지 확인하고, 없으면 생성 시도 또는 최상위에 생성
            let category = interaction.guild.channels.cache.find(c => c.name.toLowerCase() === (process.env.WAR_CATEGORY_NAME || 'clan wars').toLowerCase() && c.type === ChannelType.GuildCategory);
            // if (!category) { // 카테고리가 없으면 생성하는 로직 (선택적)
            //     try {
            //         category = await interaction.guild.channels.create({
            //             name: 'Clan Wars',
            //             type: ChannelType.GuildCategory,
            //         });
            //     } catch (catError) {
            //         console.warn('Clan Wars 카테고리 생성 실패:', catError);
            //         // 카테고리 생성 실패 시 parent 없이 진행
            //     }
            // }

            const warChannel = await interaction.guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                parent: category ? category.id : null,
                topic: `클랜 전쟁 [${warId}] 협업 채널. 목표 예약/파괴율 공유.`,
                permissionOverwrites: [
                    {
                        id: interaction.guild.roles.everyone, // @everyone 역할
                        // 기본적으로 읽기만 가능하도록 설정하거나, 특정 역할만 쓰기 가능하게 할 수 있음
                        deny: [PermissionFlagsBits.SendMessages],
                        allow: [PermissionFlagsBits.ViewChannel]
                    },
                    {
                        id: interaction.user.id, // 명령어 사용자 (세션 생성자)
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels], // 채널 관리 권한 부여
                    },
                    // TODO: LEADER_ROLE_ID에 해당하는 역할에게도 관리 권한 부여
                    // { 
                    //     id: process.env.LEADER_ROLE_ID, 
                    //     allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels]
                    // }
                ],
            });

            await interaction.editReply({ content: `전쟁 세션 채널 <#${warChannel.id}>이(가) 생성되었습니다.` });

            // 3. Embed 10개 + 버튼 전송 및 메시지 ID 저장
            const messageIds = {}; // Firestore에 저장할 메시지 ID 맵 (targetNumber: messageId)
            for (let i = 1; i <= teamSize; i++) {
                const embed = createInitialTargetEmbed(i, warId);
                const row = createTargetActionRow(i, warId);
                const sentMessage = await warChannel.send({ embeds: [embed], components: [row] });
                messageIds[i] = sentMessage.id; // 메시지 ID 저장
            }

            // 4. Firestore에 전쟁 세션 데이터 저장
            const warDocData = {
                warId: warId,
                clanTag: clanTag,
                state: 'preparation', // 초기 상태는 'preparation' 또는 API에서 가져온 'inWar' 등
                teamSize: teamSize,
                channelId: warChannel.id,
                messageIds: messageIds, // 각 목표 Embed 메시지 ID 맵
                createdBy: interaction.user.id,
                createdAt: admin.firestore.FieldValue.serverTimestamp(), // Firestore 서버 타임스탬프 사용
                ended: false
            };

            await db.collection('wars').doc(warId).set(warDocData);
            console.log(`전쟁 세션 ${warId} Firestore에 저장됨. 채널: #${warChannel.name}`);

        } catch (error) {
            console.error('Error starting war session:', error);
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply({ content: '전쟁 세션 시작 중 오류가 발생했습니다.', ephemeral: true });
            } else {
                await interaction.reply({ content: '전쟁 세션 시작 중 오류가 발생했습니다.', ephemeral: true });
            }
        }
    },
}; 