const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { db } = require('../services/firestoreHandler.js');
const admin = require('firebase-admin'); // FieldValue.serverTimestamp() 사용을 위해

module.exports = {
    data: new SlashCommandBuilder()
        .setName('endwar')
        .setDescription('현재 전쟁 세션을 종료하고 채널을 읽기 전용으로 설정합니다.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels) // 기본 권한 (추가로 역할 ID 검사 필요)
        .setDMPermission(false),
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const leaderRoleId = process.env.LEADER_ROLE_ID;
        if (!leaderRoleId || !interaction.member.roles.cache.has(leaderRoleId)) {
            return interaction.editReply({ content: '이 명령어를 사용할 권한이 없습니다. 🚫 (리더 역할 필요)' });
        }

        const channel = interaction.channel;

        try {
            // 1. 채널 ID로 Firestore에서 전쟁 세션 정보 조회
            const warsQuery = db.collection('wars').where('channelId', '==', channel.id).where('ended', '==', false).limit(1);
            const warsSnapshot = await warsQuery.get();

            if (warsSnapshot.empty) {
                return interaction.editReply({ content: '이 채널에서 진행 중인 유효한 전쟁 세션을 찾을 수 없습니다.  전쟁 채널이 맞는지 확인해주세요. 🤔' });
            }

            const warDoc = warsSnapshot.docs[0];
            const warId = warDoc.id;
            const warData = warDoc.data();

            // 2. Firestore에서 전쟁 세션 상태 업데이트
            await db.collection('wars').doc(warId).update({
                state: 'warEnded',
                ended: true,
                endedAt: admin.firestore.FieldValue.serverTimestamp(), // 종료 시각 기록
                endedBy: interaction.user.id
            });

            // 3. Discord 채널 권한 수정 (읽기 전용으로)
            // @everyone 역할에 대한 권한 수정
            const everyoneRole = interaction.guild.roles.everyone;
            await channel.permissionOverwrites.edit(everyoneRole, {
                SendMessages: false,
                CreatePublicThreads: false,
                CreatePrivateThreads: false,
                SendMessagesInThreads: false,
            });

            // 리더 역할은 계속 메시지 작성 가능하도록 (선택적, 이미 채널 관리 권한이 있을 수 있음)
            // 만약 리더 역할이 명시적으로 메시지 권한을 가져야 한다면 아래 코드 추가
            // if (leaderRoleId) {
            //     await channel.permissionOverwrites.edit(leaderRoleId, {
            //         SendMessages: true
            //     });
            // }

            // 봇 자신에게도 권한 확인 (필요시)
            // const botMember = await interaction.guild.members.fetch(interaction.client.user.id);
            // await channel.permissionOverwrites.edit(botMember, { SendMessages: true }); 

            let newChannelName = channel.name;
            if (!channel.name.startsWith('[종료됨]')) {
                newChannelName = `[종료됨] ${channel.name}`.substring(0, 100); // 채널명 길이 제한 고려
            }
            await channel.edit({
                name: newChannelName,
                topic: `${warData.topic || '클랜 전쟁'} (종료됨)`
            });

            await interaction.editReply({ content: `✅ 전쟁 세션 [${warId}]이(가) 성공적으로 종료되었습니다. 채널은 읽기 전용으로 설정되었으며, 이름이 변경되었습니다.` });
            await channel.send(`**📢 이 전쟁 세션은 ${interaction.user.tag}에 의해 종료되었습니다.** 채널은 이제 보관용으로 읽기 전용 상태입니다.`);

            console.log(`전쟁 세션 ${warId} 종료됨. 채널: #${channel.name}`);

            // TODO: PDF 리포트 생성 옵션 (예: 버튼으로 물어보기)

        } catch (error) {
            console.error(`Error ending war session in channel ${channel.id}:`, error);
            await interaction.editReply({ content: `전쟁 세션 종료 중 오류가 발생했습니다: ${error.message}` });
        }
    },
}; 