const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { db, firebaseInitialized } = require('../services/firestoreHandler.js');
const admin = require('firebase-admin'); // FieldValue.serverTimestamp() 사용을 위해

const COMMAND_NAME = 'endwar';
const logPrefix = `[COMMAND:${COMMAND_NAME}]`;

module.exports = {
    data: new SlashCommandBuilder()
        .setName(COMMAND_NAME)
        .setDescription('현재 전쟁 세션을 종료하고 채널을 읽기 전용으로 설정합니다.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels) // 기본 권한 (추가로 역할 ID 검사 필요)
        .setDMPermission(false),
    async execute(interaction) {
        const { user, guild, channel } = interaction;
        const execLogPrefix = `${logPrefix}[${user.tag}(${user.id})][Guild:${guild.id}][Channel:${channel.id}]`;
        console.info(`${execLogPrefix} Command execution started.`);

        if (!firebaseInitialized) {
            console.error(`${execLogPrefix} Firestore is not initialized. Replying and exiting.`);
            return interaction.reply({ content: '봇의 데이터베이스 연결에 문제가 발생했습니다. 관리자에게 문의하세요.', ephemeral: true });
        }

        console.debug(`${execLogPrefix} Deferring reply.`);
        await interaction.deferReply({ ephemeral: true });

        const leaderRoleId = process.env.LEADER_ROLE_ID;
        console.debug(`${execLogPrefix} Checking leader role. Required: ${leaderRoleId}, User has: ${interaction.member.roles.cache.has(leaderRoleId || 'undefined')}`);
        if (!leaderRoleId || !interaction.member.roles.cache.has(leaderRoleId)) {
            console.warn(`${execLogPrefix} User does not have the leader role (Required: ${leaderRoleId}). Replying and exiting.`);
            return interaction.editReply({ content: '이 명령어를 사용할 권한이 없습니다. 🚫 (리더 역할 필요)' });
        }
        console.info(`${execLogPrefix} User has the leader role. Proceeding.`);

        try {
            console.info(`${execLogPrefix} Querying Firestore for active war session in channel ${channel.id}.`);
            const warsQuery = db.collection('wars').where('channelId', '==', channel.id).where('ended', '==', false).limit(1);
            const warsSnapshot = await warsQuery.get();

            if (warsSnapshot.empty) {
                console.warn(`${execLogPrefix} No active war session found in Firestore for channel ${channel.id}. Replying and exiting.`);
                return interaction.editReply({ content: '이 채널에서 진행 중인 유효한 전쟁 세션을 찾을 수 없습니다.  전쟁 채널이 맞는지 확인해주세요. 🤔' });
            }

            const warDoc = warsSnapshot.docs[0];
            const warId = warDoc.id;
            const warData = warDoc.data();
            console.info(`${execLogPrefix} Found active war session: ${warId} (Current state: ${warData.state})`);

            const updateData = {
                state: 'warEnded',
                ended: true,
                endedAt: admin.firestore.FieldValue.serverTimestamp(),
                endedBy: user.id
            };
            console.info(`${execLogPrefix} Updating war session ${warId} in Firestore with data:`, updateData);
            await db.collection('wars').doc(warId).update(updateData);
            console.info(`${execLogPrefix} War session ${warId} successfully updated in Firestore.`);

            console.info(`${execLogPrefix} Modifying permissions for channel <#${channel.id}> to read-only for @everyone.`);
            const everyoneRole = guild.roles.everyone;
            await channel.permissionOverwrites.edit(everyoneRole, {
                SendMessages: false,
                CreatePublicThreads: false,
                CreatePrivateThreads: false,
                SendMessagesInThreads: false,
            });
            console.info(`${execLogPrefix} @everyone role permissions updated for channel <#${channel.id}>.`);

            let newChannelName = channel.name;
            if (!channel.name.startsWith('[종료됨]')) {
                newChannelName = `[종료됨] ${channel.name}`.substring(0, 100); // 채널명 길이 제한 고려
            }
            const newTopic = `${warData.topic || '클랜 전쟁'} (종료됨)`;
            console.info(`${execLogPrefix} Editing channel name to "${newChannelName}" and topic to "${newTopic}".`);
            await channel.edit({
                name: newChannelName,
                topic: newTopic
            });
            console.info(`${execLogPrefix} Channel name and topic updated for <#${channel.id}>.`);

            const replyMessage = `✅ 전쟁 세션 [${warId}]이(가) 성공적으로 종료되었습니다. 채널은 읽기 전용으로 설정되었으며, 이름이 변경되었습니다.`;
            console.info(`${execLogPrefix} Sending success reply to user.`);
            await interaction.editReply({ content: replyMessage });

            const announcementMessage = `**📢 이 전쟁 세션은 ${user.tag}에 의해 종료되었습니다.** 채널은 이제 보관용으로 읽기 전용 상태입니다.`;
            console.info(`${execLogPrefix} Sending announcement message to channel <#${channel.id}>.`);
            await channel.send(announcementMessage);
            
            console.info(`${execLogPrefix} War session ${warId} ended successfully. Channel: <#${channel.name}>(${channel.id}).`);
            console.info(`${execLogPrefix} Command execution finished successfully.`);

        } catch (error) {
            console.error(`${execLogPrefix} Error during command execution:`, error);
            let errorMessage = '전쟁 종료 중 오류가 발생했습니다. 😥 로그를 확인해주세요.';
            if (error.code) { // Discord API 에러 또는 Node.js 에러
                 console.error(`${execLogPrefix} Discord/Node.js Error Code: ${error.code}, Message: ${error.message}`);
                 errorMessage = `Discord API 또는 내부 오류 발생: ${error.message} (코드: ${error.code || 'N/A'}).`;
                 if (error.code === 50001) { // Missing Access
                    errorMessage = '봇이 채널 권한 또는 이름을 변경할 권한이 없습니다. 서버 설정을 확인해주세요. (오류 코드: 50001)';
                 } else if (error.code === 10003) { // Unknown Channel (채널이 중간에 삭제된 경우 등)
                    errorMessage = '채널을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다. (오류 코드: 10003)';
                 }
            } else if (error.message) { // 일반 JavaScript 에러 또는 Firestore 에러
                errorMessage = error.message;
            }

            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.editReply({ content: errorMessage, ephemeral: true });
                } else {
                    // deferReply가 실패했을 극히 드문 경우
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