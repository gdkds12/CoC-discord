const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getWar, getTargetsByWarId } = require('../utils/databaseHandler');
const { getCurrentWar } = require('../services/cocApiService.js');
require('dotenv').config();

const COMMAND_NAME = 'status';
const logPrefix = `[COMMAND:${COMMAND_NAME}]`;

module.exports = {
    data: new SlashCommandBuilder()
        .setName(COMMAND_NAME)
        .setDescription('현재 전쟁 세션의 상태를 확인합니다.')
        .setDMPermission(false),
    async execute(interaction) {
        const { user, guild, channel } = interaction;
        const execLogPrefix = `${logPrefix}[${user.tag}(${user.id})][Guild:${guild.id}][Channel:${channel.id}]`;
        console.info(`${execLogPrefix} Command execution started.`);

        console.debug(`${execLogPrefix} Deferring reply.`);
        await interaction.deferReply({ ephemeral: true });

        try {
            // 현재 채널 ID로 전쟁 세션 찾기
            const currentChannelId = channel.id;
            console.info(`${execLogPrefix} Looking for war session in channel ${currentChannelId}`);

            // SQLite에서 전쟁 정보 조회
            const warData = await getWar(currentChannelId);
            if (!warData) {
                console.warn(`${execLogPrefix} No war session found for channel ${currentChannelId}`);
                return interaction.editReply({ content: '이 채널에서 진행 중인 전쟁 세션을 찾을 수 없습니다. 😥', ephemeral: true });
            }

            // 전쟁 목표 정보 조회
            const targets = await getTargetsByWarId(warData.warId);
            if (!targets || targets.length === 0) {
                console.warn(`${execLogPrefix} No targets found for war ${warData.warId}`);
                return interaction.editReply({ content: '전쟁 목표 정보를 찾을 수 없습니다. 😥', ephemeral: true });
            }

            // 상태 임베드 생성
            const statusEmbed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('⚔️ 전쟁 상태')
                .setDescription(`전쟁 ID: ${warData.warId}`)
                .addFields(
                    { name: '상태', value: warData.state, inline: true },
                    { name: '팀 크기', value: String(warData.teamSize), inline: true },
                    { name: '생성일', value: new Date(warData.createdAt).toLocaleString(), inline: true }
                );

            // 목표별 상태 추가
            targets.forEach(target => {
                const reservedBy = target.reservedBy || [];
                const confidence = target.confidence || {};
                const result = target.result || { stars: 0, destruction: 0, attacker: null };

                statusEmbed.addFields({
                    name: `목표 #${target.targetNumber}`,
                    value: `예약: ${reservedBy.length}/2\n자신감: ${Object.values(confidence).join(', ') || '없음'}\n결과: ${result.stars}⭐ (${result.destruction}%)`,
                    inline: true
                });
            });

            await interaction.editReply({ embeds: [statusEmbed], ephemeral: true });
            console.info(`${execLogPrefix} Status command completed successfully.`);

        } catch (error) {
            console.error(`${execLogPrefix} Error in status command:`, error);
            await interaction.editReply({ content: '전쟁 상태를 확인하는 중 오류가 발생했습니다. 😥', ephemeral: true });
        }
    }
}; 