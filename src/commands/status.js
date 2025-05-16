const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getWar, getTargetsByWarId, updateTargetResult, getTarget } = require('../utils/databaseHandler');
const { getCurrentWar } = require('../services/cocApiService.js');
require('dotenv').config();

const COMMAND_NAME = 'status';
const logPrefix = `[COMMAND:${COMMAND_NAME}]`;

module.exports = {
    data: new SlashCommandBuilder()
        .setName(COMMAND_NAME)
        .setDescription('현재 전쟁 세션의 상태를 확인하고, API로 최신 공격 결과를 반영합니다.')
        .setDMPermission(false),
    async execute(interaction) {
        const { user, guild, channel } = interaction;
        const execLogPrefix = `${logPrefix}[${user.tag}(${user.id})][Guild:${guild.id}][Channel:${channel.id}]`;
        console.info(`${execLogPrefix} Command execution started.`);

        try {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const currentChannelId = channel.id;
            console.info(`${execLogPrefix} Looking for war session in channel ${currentChannelId}`);
            const warData = await getWar(currentChannelId);
            if (!warData) {
                console.warn(`${execLogPrefix} No war session found for channel ${currentChannelId}`);
                return interaction.editReply({ 
                    content: '이 채널에서 진행 중인 전쟁 세션을 찾을 수 없습니다. 😥', 
                    flags: [MessageFlags.Ephemeral] 
                });
            }
            const warId = warData.warId;

            console.info(`${execLogPrefix} Fetching current war data from CoC API for warId: ${warId}`);
            const currentWarApiData = await getCurrentWar();
            let updatedResultsCount = 0;

            if (currentWarApiData && currentWarApiData.state !== 'notInWar' && currentWarApiData.clan && currentWarApiData.clan.attacks && currentWarApiData.opponent && currentWarApiData.opponent.members) {
                console.info(`${execLogPrefix} CoC API data received. Processing ${currentWarApiData.clan.attacks.length} attacks by our clan.`);
                const opponentMembers = currentWarApiData.opponent.members;
                const ourAttacks = currentWarApiData.clan.attacks;

                for (const opponentMember of opponentMembers) {
                    const targetNumber = opponentMember.mapPosition;
                    const defenderTag = opponentMember.tag;

                    const attacksOnThisTarget = ourAttacks.filter(attack => attack.defenderTag === defenderTag);
                    if (attacksOnThisTarget.length === 0) continue;

                    let bestAttackOnThisTarget = attacksOnThisTarget.reduce((best, current) => {
                        if (!best) return current;
                        if (current.stars > best.stars) return current;
                        if (current.stars === best.stars && current.destructionPercentage > best.destructionPercentage) return current;
                        return best;
                    }, null);

                    if (bestAttackOnThisTarget) {
                        const existingTargetData = await getTarget(warId, targetNumber);
                        const existingResult = existingTargetData?.result || { stars: -1, destruction: -1 };

                        const shouldUpdate = 
                            (bestAttackOnThisTarget.stars > existingResult.stars) ||
                            (bestAttackOnThisTarget.stars === existingResult.stars && bestAttackOnThisTarget.destructionPercentage > existingResult.destruction) ||
                            (!existingResult.attackerCocTag && !existingResult.attackerDiscordId) ||
                            (existingResult.attackerCocTag && existingResult.attackerCocTag !== bestAttackOnThisTarget.attackerTag && !existingResult.attackerDiscordId);
                        
                        if (existingResult.attackerDiscordId) {
                             console.debug(`${execLogPrefix} Target #${targetNumber} has manual result by ${existingResult.attackerDiscordId}. Skipping API update.`);
                        } else if (shouldUpdate) {
                            console.info(`${execLogPrefix} Updating target #${targetNumber} (Def: ${defenderTag}) with API result: ${bestAttackOnThisTarget.stars}⭐ ${bestAttackOnThisTarget.destructionPercentage}% by ${bestAttackOnThisTarget.attackerTag}`);
                            await updateTargetResult(
                                warId, 
                                targetNumber, 
                                bestAttackOnThisTarget.stars, 
                                bestAttackOnThisTarget.destructionPercentage, 
                                bestAttackOnThisTarget.attackerTag,
                                null
                            );
                            updatedResultsCount++;
                        } else {
                            console.debug(`${execLogPrefix} No better API result for target #${targetNumber}. DB: ${existingResult.stars}⭐, API: ${bestAttackOnThisTarget.stars}⭐`);
                        }
                    }
                }
                if (updatedResultsCount > 0) {
                    console.info(`${execLogPrefix} Updated ${updatedResultsCount} target results from CoC API.`);
                }
            } else {
                console.warn(`${execLogPrefix} Could not fetch or process CoC API war data for attacks. State: ${currentWarApiData?.state}`);
            }

            const targets = await getTargetsByWarId(warId);
            if (!targets || targets.length === 0) {
                console.warn(`${execLogPrefix} No targets found for war ${warId} after API update attempt.`);
            }

            const isWarActive = currentWarApiData && currentWarApiData.state !== 'notInWar' && currentWarApiData.state !== 'warEnded';

            const statusEmbed = new EmbedBuilder()
                .setColor(isWarActive ? 0xFF0000 : (currentWarApiData?.state === 'warEnded' ? 0x00FF00 : 0x0099FF) )
                .setTitle(`⚔️ 전쟁 상태 (War ID: ${warId})`)
                .setDescription(warData.state === 'ended' ? '종료된 전쟁입니다.' : `현재 전쟁 상태: ${currentWarApiData?.state || warData.state}`)
                .addFields(
                    { name: '팀 크기', value: String(warData.teamSize), inline: true },
                    { name: '생성일', value: new Date(warData.createdAt).toLocaleString(), inline: true }
                );
            
            if (currentWarApiData && currentWarApiData.state !== 'notInWar') {
                statusEmbed.addFields(
                    { name: '\u200B', value: '**📡 CoC API 실시간 정보**' },
                    { name: 'API 상태', value: currentWarApiData.state, inline: true },
                    { name: '우리팀', value: `${currentWarApiData.clan.name}: ${currentWarApiData.clan.stars}⭐ (${currentWarApiData.clan.destructionPercentage.toFixed(2)}%)`, inline: true },
                    { name: '상대팀', value: `${currentWarApiData.opponent.name}: ${currentWarApiData.opponent.stars}⭐ (${currentWarApiData.opponent.destructionPercentage.toFixed(2)}%)`, inline: true }
                );
                if (currentWarApiData.endTime) {
                    const endTime = new Date(currentWarApiData.endTime);
                    statusEmbed.addFields({ name: '종료까지', value: `<t:${Math.floor(endTime.getTime() / 1000)}:R>`, inline: true });
                }
            }

            if (targets && targets.length > 0) {
                 statusEmbed.addFields({ name: '\u200B', value: '**🎯 목표별 상세 현황**' });
                 targets.forEach(target => {
                    const reservedByDisplay = target.reservedBy && target.reservedBy.length > 0 ? target.reservedBy.map(id => `<@${id}>`).join(', ') : '없음';
                    const confidenceEntries = target.confidence ? Object.entries(target.confidence) : [];
                    const confidenceDisplay = confidenceEntries.length > 0 
                        ? confidenceEntries.map(([userId, perc]) => `<@${userId}>: ${perc}%`).join('\n') 
                        : '없음';
                    
                    let resultDisplay = '`미입력`';
                    if (target.result && target.result.stars !== undefined) {
                        let attackerInfo = '';
                        if (target.result.attackerDiscordId) {
                            attackerInfo = `(<@${target.result.attackerDiscordId}>)`;
                        } else if (target.result.attackerCocTag) {
                            attackerInfo = `(Tag: ${target.result.attackerCocTag})`;
                        }
                        resultDisplay = `${target.result.stars}⭐ (${target.result.destruction}%) ${attackerInfo}`.trim();
                    }

                    const title = `🎯 ${target.opponentName || '알 수 없는 상대'} ${target.opponentTownhallLevel ? '(TH' + target.opponentTownhallLevel + ')' : ''} (#${target.targetNumber})`;
                    statusEmbed.addFields({
                        name: title,
                        value: `예약: ${reservedByDisplay}\n예상: ${confidenceDisplay}\n결과: ${resultDisplay}`,
                        inline: true
                    });
                });
            }

            await interaction.editReply({ 
                embeds: [statusEmbed], 
                flags: [MessageFlags.Ephemeral] 
            });
            console.info(`${execLogPrefix} Status command completed successfully.${updatedResultsCount > 0 ? ` ${updatedResultsCount} results updated from API.` : ''}`);

        } catch (error) {
            console.error(`${execLogPrefix} Error in status command:`, error);
            if (!interaction.replied && !interaction.deferred) {
                 await interaction.reply({ content: '전쟁 상태를 확인하는 중 오류가 발생했습니다. 😥', flags: [MessageFlags.Ephemeral], ephemeral: true });
            } else {
                 await interaction.editReply({ 
                    content: '전쟁 상태를 확인하는 중 오류가 발생했습니다. 😥', 
                    flags: [MessageFlags.Ephemeral] 
                });
            }
        }
    }
}; 