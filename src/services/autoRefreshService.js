const { getAllActiveWars, getTarget, updateTargetResult } = require('../utils/databaseHandler');
const { getCurrentWar } = require('./cocApiService');
require('dotenv').config();

const logPrefix = '[AutoRefreshService]';
let autoRefreshIntervalId = null;

const ENABLE_AUTO_REFRESH = process.env.ENABLE_AUTO_REFRESH === 'true';
const AUTO_REFRESH_INTERVAL_MINUTES = parseInt(process.env.AUTO_REFRESH_INTERVAL_MINUTES, 10) || 5;

async function refreshWarStates() {
    if (!ENABLE_AUTO_REFRESH) {
        // console.log(`${logPrefix} 자동 새로고침이 비활성화되어 있습니다.`);
        return;
    }

    console.log(`${logPrefix} 활성 전쟁 상태 자동 새로고침 시작...`);
    try {
        const activeWars = await getAllActiveWars();
        if (!activeWars || activeWars.length === 0) {
            // console.log(`${logPrefix} 현재 활성 중인 전쟁이 없습니다.`);
            return;
        }

        console.log(`${logPrefix} ${activeWars.length}개의 활성 전쟁 감지.`);

        for (const war of activeWars) {
            const { warId, clanTag } = war;
            console.log(`${logPrefix} 전쟁 ${warId} (클랜: ${clanTag}) 상태 업데이트 시도 중...`);

            const currentWarApiData = await getCurrentWar(clanTag);
            let updatedResultsCount = 0;

            if (currentWarApiData && currentWarApiData.state !== 'notInWar' && currentWarApiData.state !== 'accessDenied' && currentWarApiData.state !== 'error' && currentWarApiData.clan && currentWarApiData.clan.attacks && currentWarApiData.opponent && currentWarApiData.opponent.members) {
                console.log(`${logPrefix} [${warId}] CoC API 데이터 수신 완료. ${currentWarApiData.clan.attacks.length}개의 아군 공격 처리 중.`);
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
                        // API 결과가 있고, 기존 결과가 없거나 API 결과가 더 좋을 때, 또는 수동 입력이 아닐 때 업데이트
                        const existingResult = existingTargetData?.result || { stars: -1, destruction: -1 }; // 기본값 설정

                        const shouldUpdate = 
                            (bestAttackOnThisTarget.stars > existingResult.stars) ||
                            (bestAttackOnThisTarget.stars === existingResult.stars && bestAttackOnThisTarget.destructionPercentage > existingResult.destruction) ||
                            (!existingResult.attackerCocTag && !existingResult.attackerDiscordId) || // 기존 공격자 정보가 전혀 없을 때
                            (existingResult.attackerCocTag && existingResult.attackerCocTag !== bestAttackOnThisTarget.attackerTag && !existingResult.attackerDiscordId); // API로 기록된 다른 공격자일때 (수동입력 제외)
                        
                        if (existingResult.attackerDiscordId) {
                            // console.debug(`${logPrefix} [${warId}] Target #${targetNumber} has manual result by ${existingResult.attackerDiscordId}. Skipping API update.`);
                        } else if (shouldUpdate) {
                            console.log(`${logPrefix} [${warId}] Target #${targetNumber} (상대: ${defenderTag}) 업데이트: ${bestAttackOnThisTarget.stars}⭐ ${bestAttackOnThisTarget.destructionPercentage}% (공격자: ${bestAttackOnThisTarget.attackerTag})`);
                            await updateTargetResult(
                                warId,
                                targetNumber,
                                bestAttackOnThisTarget.stars,
                                bestAttackOnThisTarget.destructionPercentage,
                                bestAttackOnThisTarget.attackerTag, // CoC 태그로 기록
                                null // Discord ID는 null (API 자동 업데이트이므로)
                            );
                            updatedResultsCount++;
                        }
                    }
                }
                if (updatedResultsCount > 0) {
                    console.log(`${logPrefix} [${warId}] ${updatedResultsCount}개의 목표 결과가 CoC API로부터 업데이트되었습니다.`);
                }
            } else {
                console.warn(`${logPrefix} [${warId}] CoC API로부터 전쟁 데이터를 가져오거나 처리하는데 실패했습니다. 상태: ${currentWarApiData?.state}, 이유: ${currentWarApiData?.reason}`);
            }
        }
    } catch (error) {
        console.error(`${logPrefix} 활성 전쟁 상태 자동 새로고침 중 오류 발생:`, error);
    }
    console.log(`${logPrefix} 활성 전쟁 상태 자동 새로고침 완료.`);
}

function startAutoRefresh() {
    if (!ENABLE_AUTO_REFRESH) {
        console.info(`${logPrefix} 자동 새로고침 기능이 .env 설정에 의해 비활성화되어 있습니다.`);
        return;
    }
    if (autoRefreshIntervalId) {
        console.warn(`${logPrefix} 자동 새로고침이 이미 실행 중입니다.`);
        return;
    }
    const intervalMs = AUTO_REFRESH_INTERVAL_MINUTES * 60 * 1000;
    console.info(`${logPrefix} 자동 새로고침 서비스를 ${AUTO_REFRESH_INTERVAL_MINUTES}분 간격으로 시작합니다.`);
    // 즉시 1회 실행 후 setInterval 등록
    refreshWarStates(); 
    autoRefreshIntervalId = setInterval(refreshWarStates, intervalMs);
}

function stopAutoRefresh() {
    if (autoRefreshIntervalId) {
        clearInterval(autoRefreshIntervalId);
        autoRefreshIntervalId = null;
        console.info(`${logPrefix} 자동 새로고침 서비스를 중지했습니다.`);
    }
}

module.exports = {
    startAutoRefresh,
    stopAutoRefresh,
    refreshWarStates // 테스트 또는 수동 실행용
}; 