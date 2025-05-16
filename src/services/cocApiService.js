const axios = require('axios');
require('dotenv').config(); // .env 파일에서 환경 변수를 불러오기 위해

const logPrefix = '[CocApiService]';

const cocApiToken = process.env.COC_API_TOKEN;
const clanTag = process.env.CLAN_TAG; // #을 제외하고 입력하거나, 여기서 인코딩 처리 필요

if (cocApiToken) {
    console.info(`${logPrefix} COC_API_TOKEN 로드 성공.`);
} else {
    console.warn(`${logPrefix} COC_API_TOKEN이 .env 파일에 설정되지 않았습니다. CoC API 호출이 실패합니다.`);
}
if (clanTag) {
    console.info(`${logPrefix} CLAN_TAG 로드 성공: ${clanTag}`);
} else {
    console.warn(`${logPrefix} CLAN_TAG가 .env 파일에 설정되지 않았습니다. CoC API 호출 시 클랜 태그를 알 수 없습니다.`);
}

const cocApiClient = axios.create({
    baseURL: 'https://api.clashofclans.com/v1',
    headers: {
        'Authorization': `Bearer ${cocApiToken}`,
        'Accept': 'application/json'
    }
});

/**
 * 클랜의 현재 진행 중인 전쟁 정보를 가져옵니다.
 * @returns {Promise<object|null>} 현재 전쟁 정보 또는 null
 */
async function getCurrentWar() {
    console.info(`${logPrefix} getCurrentWar 함수 호출됨.`);
    if (!cocApiToken || !clanTag) {
        console.error(`${logPrefix} CoC API 토큰 또는 클랜 태그가 설정되지 않아 현재 전쟁 정보를 가져올 수 없습니다.`);
        return null;
    }
    // 클랜 태그에서 #을 URL 인코딩 (%23)으로 변경
    const encodedClanTag = clanTag.startsWith('#') ? `%23${clanTag.substring(1)}` : clanTag;
    const requestUrl = `/clans/${encodedClanTag}/currentwar`;

    try {
        console.info(`${logPrefix} CoC API 요청 시작: GET ${requestUrl}`);
        const response = await cocApiClient.get(requestUrl);
        console.info(`${logPrefix} CoC API 응답 수신: ${response.status} ${response.statusText}`);
        console.debug(`${logPrefix} CoC API 응답 데이터 (일부):`, { state: response.data.state, teamSize: response.data.teamSize }); // 민감한 전체 데이터 로깅 지양

        if (response.data && response.data.state === 'notInWar') {
            console.info(`${logPrefix} 클랜 ${clanTag}(${encodedClanTag})은(는) 현재 전쟁 중이 아닙니다 (state: notInWar).`);
            return { state: 'notInWar' }; // null 대신 명시적 상태 반환
        }
        console.info(`${logPrefix} 현재 전쟁 정보 확인됨 (state: ${response.data.state}).`);
        return response.data; // 전쟁 정보 객체 반환
    } catch (error) {
        console.error(`${logPrefix} CoC API 호출 중 오류 발생 (GET ${requestUrl}):`);
        if (error.response) {
            console.error(`${logPrefix}  - API 응답 오류: ${error.response.status} ${error.response.statusText}`);
            console.error(`${logPrefix}  - 응답 데이터: ${JSON.stringify(error.response.data)}`);
            if (error.response.status === 403) {
                console.error(`${logPrefix}  - 상세: CoC API 접근 거부(403). IP 주소가 허용 목록에 없거나 토큰이 유효하지 않을 수 있습니다.`);
            } else if (error.response.status === 404) {
                console.error(`${logPrefix}  - 상세: CoC API 리소스 없음(404). 클랜 ${clanTag}(${encodedClanTag})을(를) 찾을 수 없거나, API 경로(${requestUrl})가 잘못되었을 수 있습니다.`);
            } else if (error.response.status === 503) {
                console.error(`${logPrefix}  - 상세: CoC API 서버 점검 중(503). API가 일시적으로 유지보수 중일 수 있습니다.`);
            }
        } else if (error.request) {
            console.error(`${logPrefix}  - API 요청 오류: 응답을 받지 못했습니다. 네트워크 연결 또는 API 서버 문제를 확인하세요.`);
            // console.debug(`${logPrefix}  - 요청 정보:`, error.request); // 상세 요청 정보 (필요시 활성화)
        } else {
            console.error(`${logPrefix}  - 요청 설정 오류: ${error.message}`);
        }
        return null;
    }
}

module.exports = {
    getCurrentWar,
    // 향후 다른 CoC API 함수들 추가 예정
}; 