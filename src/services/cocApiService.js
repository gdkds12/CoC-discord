const axios = require('axios');
require('dotenv').config(); // .env 파일에서 환경 변수를 불러오기 위해

const logPrefix = '[CocApiService]';

const CLAN_TAG = process.env.CLAN_TAG;
const API_TOKEN = process.env.COC_API_TOKEN;
const BASE_URL = 'https://api.clashofclans.com/v1';

if (API_TOKEN) {
    console.info(`${logPrefix} COC_API_TOKEN 로드 성공.`);
} else {
    console.warn(`${logPrefix} COC_API_TOKEN이 .env 파일에 설정되지 않았습니다. CoC API 호출이 실패합니다.`);
}
if (CLAN_TAG) {
    console.info(`${logPrefix} CLAN_TAG 로드 성공: ${CLAN_TAG}`);
} else {
    console.warn(`${logPrefix} CLAN_TAG가 .env 파일에 설정되지 않았습니다. CoC API 호출 시 클랜 태그를 알 수 없습니다.`);
}

// API 요청 헤더 설정
const headers = {
    'Authorization': `Bearer ${API_TOKEN}`,
    'Accept': 'application/json'
};

/**
 * 클랜의 현재 진행 중인 전쟁 정보를 가져옵니다.
 * @param {string} clanTagToFetch - 조회할 클랜의 태그 (예: #2J22V08JC)
 * @returns {Promise<object|null>} 현재 전쟁 정보 또는 null
 */
async function getCurrentWar(clanTagToFetch) {
    console.log(`${logPrefix} getCurrentWar 함수 호출됨 (요청된 클랜: ${clanTagToFetch}).`);
    if (!clanTagToFetch) {
        console.error(`${logPrefix} getCurrentWar 호출 시 클랜 태그가 제공되지 않았습니다.`);
        return {
            state: 'error',
            reason: 'missing_clan_tag',
            message: '클랜 태그가 필요합니다.'
        };
    }
    try {
        // 클랜 태그에서 # 제거
        const sanitizedClanTag = clanTagToFetch.replace('#', '');
        const url = `${BASE_URL}/clans/%23${sanitizedClanTag}/currentwar`;
        
        console.log(`${logPrefix} CoC API 요청 시작 (클랜: ${clanTagToFetch}):`, url);
        const response = await axios.get(url, { headers });
        console.log(`${logPrefix} CoC API 응답 수신:`, response.status, response.statusText);
        
        if (response.status === 200) {
            const warData = response.data;
            console.log(`${logPrefix} CoC API 응답 데이터 (일부):`, { 
                state: warData.state, 
                teamSize: warData.teamSize,
                startTime: warData.startTime,
                endTime: warData.endTime
            });
            
            // 날짜 형식 검증 및 수정
            if (warData.startTime) {
                try {
                    const startDate = new Date(warData.startTime);
                    if (isNaN(startDate.getTime())) {
                        console.error(`${logPrefix} 잘못된 시작 시간 형식:`, warData.startTime);
                        warData.startTime = new Date().toISOString(); // 현재 시간으로 대체
                    } else {
                        warData.startTime = startDate.toISOString();
                    }
                } catch (error) {
                    console.error(`${logPrefix} 시작 시간 파싱 오류:`, error);
                    warData.startTime = new Date().toISOString();
                }
            }

            if (warData.endTime) {
                try {
                    const endDate = new Date(warData.endTime);
                    if (isNaN(endDate.getTime())) {
                        console.error(`${logPrefix} 잘못된 종료 시간 형식:`, warData.endTime);
                        warData.endTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24시간 후로 설정
                    } else {
                        warData.endTime = endDate.toISOString();
                    }
                } catch (error) {
                    console.error(`${logPrefix} 종료 시간 파싱 오류:`, error);
                    warData.endTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
                }
            }

            console.log(`${logPrefix} 현재 전쟁 정보 확인됨 (state: ${warData.state}).`);
            return warData;
        }
        
        console.error(`${logPrefix} CoC API 응답 오류:`, response.status, response.statusText);
        return null;
    } catch (error) {
        console.error(`${logPrefix} CoC API 요청 오류:`, error.message);
        if (error.response) {
            console.error(`${logPrefix} API 응답 상세:`, {
                status: error.response.status,
                data: error.response.data
            });
            
            // 404 에러일 경우 클랜이 전쟁 중이 아님을 나타내는 객체 반환
            if (error.response.status === 404) {
                console.log(`${logPrefix} 클랜이 현재 전쟁 중이 아닙니다. (404 응답)`);
                return { 
                    state: 'notInWar', 
                    reason: 'clan_not_in_war',
                    message: '클랜이 현재 전쟁 중이 아닙니다.'
                };
            }
            
            // 403 에러일 경우 권한 없음을 나타내는 객체 반환
            if (error.response.status === 403) {
                console.log(`${logPrefix} 클랜 전쟁 정보에 접근할 권한이 없습니다. (403 응답)`);
                return { 
                    state: 'accessDenied', 
                    reason: 'access_denied',
                    message: '클랜 전쟁 정보에 접근할 권한이 없습니다. 클랜 전쟁 로그가 비공개로 설정되어 있거나, 신규 클랜(일주일 이내)은 API 접근이 제한될 수 있습니다.'
                };
            }
        }
        return null;
    }
}

// 클랜 정보 조회 함수 추가
async function getClanInfo() {
    console.log(`${logPrefix} getClanInfo 함수 호출됨.`);
    try {
        // 클랜 태그에서 # 제거
        const clanTag = CLAN_TAG.replace('#', '');
        const url = `${BASE_URL}/clans/%23${clanTag}`;
        
        console.log(`${logPrefix} CoC API 요청 시작:`, url);
        const response = await axios.get(url, { headers });
        console.log(`${logPrefix} CoC API 응답 수신:`, response.status, response.statusText);
        
        if (response.status === 200) {
            console.log(`${logPrefix} 클랜 정보 조회 성공.`);
            return response.data;
        }
        
        console.error(`${logPrefix} CoC API 응답 오류:`, response.status, response.statusText);
        return null;
    } catch (error) {
        console.error(`${logPrefix} CoC API 요청 오류:`, error.message);
        if (error.response) {
            console.error(`${logPrefix} API 응답 상세:`, {
                status: error.response.status,
                data: error.response.data
            });
        }
        return null;
    }
}

// 전쟁 리그 정보 조회 함수 추가
async function getWarLeagueInfo() {
    console.log(`${logPrefix} getWarLeagueInfo 함수 호출됨.`);
    try {
        // 클랜 태그에서 # 제거
        const clanTag = CLAN_TAG.replace('#', '');
        const url = `${BASE_URL}/clans/%23${clanTag}/currentwar/leaguegroup`;
        
        console.log(`${logPrefix} CoC API 요청 시작:`, url);
        const response = await axios.get(url, { headers });
        console.log(`${logPrefix} CoC API 응답 수신:`, response.status, response.statusText);
        
        if (response.status === 200) {
            console.log(`${logPrefix} 전쟁 리그 정보 조회 성공.`);
            return response.data;
        }
        
        console.error(`${logPrefix} CoC API 응답 오류:`, response.status, response.statusText);
        return null;
    } catch (error) {
        console.error(`${logPrefix} CoC API 요청 오류:`, error.message);
        if (error.response) {
            console.error(`${logPrefix} API 응답 상세:`, {
                status: error.response.status,
                data: error.response.data
            });
            
            // 404 에러일 경우 클랜이 전쟁 리그에 참여하지 않음을 나타내는 객체 반환
            if (error.response.status === 404) {
                console.log(`${logPrefix} 클랜이 현재 전쟁 리그에 참여하지 않고 있습니다. (404 응답)`);
                return { 
                    state: 'notInLeague', 
                    reason: 'clan_not_in_league',
                    message: '클랜이 현재 전쟁 리그에 참여하지 않고 있습니다.'
                };
            }
            
            // 403 에러일 경우 권한 없음을 나타내는 객체 반환
            if (error.response.status === 403) {
                console.log(`${logPrefix} 클랜 전쟁 리그 정보에 접근할 권한이 없습니다. (403 응답)`);
                return { 
                    state: 'accessDenied', 
                    reason: 'access_denied',
                    message: '클랜 전쟁 리그 정보에 접근할 권한이 없습니다. 클랜 전쟁 로그가 비공개로 설정되어 있거나, 신규 클랜은 API 접근이 제한될 수 있습니다.'
                };
            }
        }
        return null;
    }
}

module.exports = {
    getCurrentWar,
    getClanInfo,
    getWarLeagueInfo
}; 