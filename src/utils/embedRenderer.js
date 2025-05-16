const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/**
 * 주어진 목표 번호에 대한 초기 Embed 메시지를 생성합니다.
 * @param {number} targetNumber - 목표 번호 (1부터 시작)
 * @param {string} warId - 현재 전쟁 ID (버튼 customId 등에 사용될 수 있음)
 * @returns {EmbedBuilder} 생성된 EmbedBuilder 객체
 */
function createInitialTargetEmbed(targetNumber, warId) {
    const initialFields = [
        { name: '👤 예약자 1', value: '`미지정`', inline: true },
        { name: '👤 예약자 2', value: '`미지정`', inline: true },
        { name: '\u200B', value: '\u200B' },
        { name: '📊 예상 파괴율 (예약자 1)', value: '`- %`', inline: true },
        { name: '📊 예상 파괴율 (예약자 2)', value: '`- %`', inline: true },
        { name: '\u200B', value: '\u200B' },
        { name: '⭐ 실제 결과', value: '`미입력`', inline: false },
    ];

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`🎯 목표 #${targetNumber}`)
        .setDescription('아래 버튼을 사용하여 목표를 예약하거나 파괴율을 입력하세요.')
        .addFields(initialFields)
        .setFooter({ text: `War ID: ${warId} | 목표 ${targetNumber}` })
        .setTimestamp();
    return embed;
}

/**
 * 주어진 목표 번호에 대한 Action Row(버튼 그룹)를 생성합니다.
 * Custom ID 형식: action_targetNumber_warId (예: reserve_1_war-12345)
 * @param {number} targetNumber - 목표 번호
 * @param {string} warId - 현재 전쟁 ID
 * @returns {ActionRowBuilder<ButtonBuilder>} 생성된 ActionRowBuilder 객체
 */
function createTargetActionRow(targetNumber, warId) {
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`reserve_${targetNumber}_${warId}`)
                .setLabel('🔒 예약')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`cancel_${targetNumber}_${warId}`)
                .setLabel('❌ 해제')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`destruction_${targetNumber}_${warId}`)
                .setLabel('📊 파괴율 입력')
                .setStyle(ButtonStyle.Secondary),
        );
    return row;
}

/**
 * 목표 Embed 메시지를 업데이트합니다.
 * @param {import('discord.js').Message} message - 업데이트할 메시지 객체
 * @param {object} targetData - 업데이트할 목표 데이터 (targetSchema 기반)
 * @param {string} warId - 현재 전쟁 ID
 * @returns {Promise<void>}
 */
async function updateTargetEmbed(message, targetData, warId) {
    const { targetNumber, reservedBy, confidence, result } = targetData;

    const updatedFields = [
        { name: '👤 예약자 1', value: reservedBy && reservedBy[0] ? `<@${reservedBy[0]}>` : '`미지정`', inline: true },
        { name: '👤 예약자 2', value: reservedBy && reservedBy[1] ? `<@${reservedBy[1]}>` : '`미지정`', inline: true },
        { name: '\u200B', value: '\u200B' },
        { 
            name: '📊 예상 파괴율 (예약자 1)', 
            value: reservedBy && reservedBy[0] && confidence && confidence[reservedBy[0]] !== undefined ? `\`${confidence[reservedBy[0]]} %\`` : '`- %`', 
            inline: true 
        },
        { 
            name: '📊 예상 파괴율 (예약자 2)', 
            value: reservedBy && reservedBy[1] && confidence && confidence[reservedBy[1]] !== undefined ? `\`${confidence[reservedBy[1]]} %\`` : '`- %`', 
            inline: true 
        },
        { name: '\u200B', value: '\u200B' },
        { 
            name: '⭐ 실제 결과', 
            value: result ? `별: ${result.stars}개, 파괴율: ${result.destruction}%` : '`미입력`', 
            inline: false 
        },
    ];

    const updatedEmbed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`🎯 목표 #${targetNumber}`)
        .setDescription('아래 버튼을 사용하여 목표를 예약하거나 파괴율을 입력하세요.')
        .addFields(updatedFields)
        .setFooter({ text: `War ID: ${warId} | 목표 ${targetNumber}` })
        .setTimestamp();

    const actionRow = createTargetActionRow(targetNumber, warId);

    await message.edit({ embeds: [updatedEmbed], components: [actionRow] });
}

module.exports = {
    createInitialTargetEmbed,
    createTargetActionRow,
    updateTargetEmbed,
}; 