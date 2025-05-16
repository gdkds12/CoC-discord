const axios = require('axios');
require('dotenv').config(); // .env 파일에서 환경 변수를 불러오기 위해

const cocApiToken = process.env.COC_API_TOKEN;
const clanTag = process.env.CLAN_TAG; // #을 제외하고 입력하거나, 여기서 인코딩 처리 필요

if (!cocApiToken) {
    console.warn('COC_API_TOKEN이 .env 파일에 설정되지 않았습니다. CoC API 호출이 실패합니다.');
}
if (!clanTag) {
    console.warn('CLAN_TAG가 .env 파일에 설정되지 않았습니다. CoC API 호출 시 클랜 태그를 알 수 없습니다.');
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
    if (!cocApiToken || !clanTag) {
        console.error('CoC API 토큰 또는 클랜 태그가 설정되지 않아 현재 전쟁 정보를 가져올 수 없습니다.');
        return null;
    }
    // 클랜 태그에서 #을 URL 인코딩 (%23)으로 변경
    const encodedClanTag = clanTag.startsWith('#') ? `%23${clanTag.substring(1)}` : clanTag;

    try {
        const response = await cocApiClient.get(`/clans/${encodedClanTag}/currentwar`);
        // 전쟁 상태가 'notInWar'인 경우도 API는 200 OK를 반환하고 특정 구조의 데이터를 줌
        if (response.data && response.data.state === 'notInWar') {
            console.log(`클랜 ${clanTag}은(는) 현재 전쟁 중이 아닙니다.`);
            return null; // 또는 { state: 'notInWar' } 같은 객체를 반환하여 구분
        }
        return response.data; // 전쟁 정보 객체 반환
    } catch (error) {
        if (error.response) {
            // API 서버가 응답했지만, 상태 코드가 2xx가 아님
            console.error(`CoC API 오류 (currentwar): ${error.response.status} - ${JSON.stringify(error.response.data)}`);
            if (error.response.status === 403) {
                console.error("CoC API 접근 거부(403): IP 주소가 허용 목록에 없거나 토큰이 유효하지 않을 수 있습니다.");
            } else if (error.response.status === 404) {
                console.error(`CoC API 오류(404): 클랜 ${clanTag}을(를) 찾을 수 없거나, 해당 클랜이 현재 전쟁 중이 아닐 수 있습니다. (API 경로 확인 필요)`);
            }
        } else if (error.request) {
            // 요청은 이루어졌으나 응답을 받지 못함
            console.error('CoC API 응답 없음 (currentwar):', error.request);
        } else {
            // 요청 설정 중 오류 발생
            console.error('CoC API 요청 설정 오류 (currentwar):', error.message);
        }
        return null;
    }
}

module.exports = {
    getCurrentWar,
    // 향후 다른 CoC API 함수들 추가 예정
}; 