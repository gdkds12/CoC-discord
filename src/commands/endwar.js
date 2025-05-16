const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { getWar, endWar } = require('../utils/databaseHandler');

const COMMAND_NAME = 'endwar';
const logPrefix = `[COMMAND:${COMMAND_NAME}]`;

module.exports = {
    data: new SlashCommandBuilder()
        .setName(COMMAND_NAME)
        .setDescription('현재 전쟁 세션을 종료하고 채널을 읽기 전용으로 설정합니다.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .setDMPermission(false),
    async execute(interaction) {
        const { user, guild, channel } = interaction;
        const execLogPrefix = `${logPrefix}[${user.tag}(${user.id})][Guild:${guild.id}][Channel:${channel.id}]`;
        console.info(`${execLogPrefix} Command execution started.`);

        try {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            // 현재 채널 ID로 전쟁 세션 찾기
            const currentChannelId = channel.id;
            console.info(`${execLogPrefix} Looking for war session in channel ${currentChannelId}`);

            // SQLite에서 전쟁 정보 조회
            const warData = await getWar(currentChannelId);
            if (!warData) {
                console.warn(`${execLogPrefix} No war session found for channel ${currentChannelId}`);
                return interaction.editReply({ 
                    content: '이 채널에서 진행 중인 전쟁 세션을 찾을 수 없습니다. 😥', 
                    flags: [MessageFlags.Ephemeral] 
                });
            }

            if (warData.state === 'ended') {
                console.warn(`${execLogPrefix} War session ${warData.warId} is already ended.`);
                return interaction.editReply({ 
                    content: '이 전쟁 세션은 이미 종료되었습니다. 🏁', 
                    flags: [MessageFlags.Ephemeral] 
                });
            }

            // 전쟁 상태를 'ended'로 업데이트
            await endWar(warData.warId);
            console.info(`${execLogPrefix} War session ${warData.warId} marked as ended in database.`);

            // 채널을 읽기 전용으로 설정
            await channel.permissionOverwrites.edit(guild.roles.everyone, {
                SendMessages: false,
                AddReactions: false,
                CreatePublicThreads: false,
                CreatePrivateThreads: false,
                SendMessagesInThreads: false
            });
            console.info(`${execLogPrefix} Channel ${channel.id} set to read-only.`);

            // 채널 이름에 [종료됨] 추가
            if (!channel.name.startsWith('[종료됨]')) {
                const newName = `[종료됨] ${channel.name}`.substring(0, 100);
                await channel.setName(newName);
                console.info(`${execLogPrefix} Channel name updated to ${newName}`);
            }

            // 종료 메시지 전송
            await channel.send(`**📢 이 전쟁 세션은 ${user.tag}에 의해 종료되었습니다.** 채널은 이제 보관용으로 읽기 전용 상태입니다.`);

            await interaction.editReply({ 
                content: '전쟁 세션이 성공적으로 종료되었습니다. 채널이 읽기 전용으로 설정되었습니다. 🏁', 
                flags: [MessageFlags.Ephemeral] 
            });
            console.info(`${execLogPrefix} Command execution completed successfully.`);

        } catch (error) {
            console.error(`${execLogPrefix} Error in endwar command:`, error);
            await interaction.editReply({ 
                content: '전쟁 세션을 종료하는 중 오류가 발생했습니다. 😥', 
                flags: [MessageFlags.Ephemeral] 
            });
        }
    }
}; 