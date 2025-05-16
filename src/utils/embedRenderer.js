const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/**
 * 주어진 목표 데이터에 대한 초기 Embed 메시지를 생성합니다.
 * @param {object} targetData - 초기 목표 데이터 ({ targetNumber, opponentName, opponentTownhallLevel })
 * @param {string} warId - 현재 전쟁 ID
 * @returns {EmbedBuilder} 생성된 EmbedBuilder 객체
 */
function createInitialTargetEmbed(targetData, warId) {
    const { targetNumber, opponentName, opponentTownhallLevel } = targetData;
    const title = `🎯 ${opponentName || '알 수 없는 상대'} ${opponentTownhallLevel ? '(TH' + opponentTownhallLevel + ')' : ''} (#${targetNumber})`;

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
        .setTitle(title)
        .setDescription('아래 버튼을 사용하여 목표를 예약하거나 파괴율을 입력하세요.')
        .addFields(initialFields)
        .setFooter({ text: `War ID: ${warId} | 목표 ${targetNumber} (${opponentName || 'N/A'})` })
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
 * 목표 데이터를 기반으로 임베드 생성 (updateTargetEmbed 및 기타 상황에서 사용)
 * @param {object} targetData - 목표 데이터 (DB에서 조회한 전체 target row)
 * @param {string} warId - 전쟁 ID
 * @returns {EmbedBuilder} 생성된 임베드
 */
function createTargetEmbed(targetData, warId) {
    const { targetNumber, opponentName, opponentTownhallLevel, reservedBy = [], confidence = {}, result } = targetData;
    const title = `🎯 ${opponentName || '알 수 없는 상대'} ${opponentTownhallLevel ? '(TH' + opponentTownhallLevel + ')' : ''} (#${targetNumber})`;

    let attackerDisplay = '';
    if (result && result.attackerDiscordId) {
        attackerDisplay = `(<@${result.attackerDiscordId}>)`;
    } else if (result && result.attackerCocTag) {
        attackerDisplay = `(Tag: ${result.attackerCocTag})`;
    }

    const fields = [
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
            value: result && result.stars !== undefined ? `별: ${result.stars}개, 파괴율: ${result.destruction}% ${attackerDisplay.trim()}` : '`미입력`', 
            inline: false 
        },
    ];

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(title)
        .setDescription('아래 버튼을 사용하여 목표를 예약하거나 파괴율을 입력하세요.')
        .addFields(fields)
        .setFooter({ text: `War ID: ${warId} | 목표 ${targetNumber} (${opponentName || 'N/A'})` })
        .setTimestamp();
    return embed;
}

/**
 * 목표 Embed 메시지를 업데이트합니다.
 * 이 함수는 이제 createTargetEmbed를 호출하여 최신 targetData로 Embed를 생성합니다.
 * @param {import('discord.js').Message} message - 업데이트할 메시지 객체 (실제로는 사용 안 함, 시그니처 유지를 위해 둠)
 * @param {object} targetData - 업데이트할 목표 데이터 (DB에서 조회한 전체 target row)
 * @param {string} warId - 현재 전쟁 ID
 * @returns {Promise<EmbedBuilder>} 생성된 EmbedBuilder 객체
 */
async function updateTargetEmbed(message, targetData, warId) {
    try {
        // message 파라미터는 이제 직접 사용되지 않지만, 호출하는 쪽과의 호환성을 위해 유지합니다.
        // targetData에 이미 opponentName 등이 포함되어 있다고 가정합니다.
        const embed = createTargetEmbed(targetData, warId);
        return embed;
    } catch (error) {
        console.error('[embedRenderer] Error updating target embed:', error);
        throw error;
    }
}

module.exports = {
    createInitialTargetEmbed,
    createTargetActionRow,
    updateTargetEmbed,
    createTargetEmbed
}; 