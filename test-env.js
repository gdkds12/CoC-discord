require('dotenv').config();
const axios = require('axios');
const admin = require('firebase-admin');

async function testCocApi() {
    console.log('\n--- CoC API 테스트 시작 ---');
    const clanTag = process.env.CLAN_TAG;
    const apiToken = process.env.COC_API_TOKEN;

    if (!clanTag) {
        console.error('[CoC API Test] CLAN_TAG 환경 변수가 설정되지 않았습니다.');
        return;
    }
    if (!apiToken) {
        console.error('[CoC API Test] COC_API_TOKEN 환경 변수가 설정되지 않았습니다.');
        return;
    }

    const encodedClanTag = encodeURIComponent(clanTag);
    const url = `https://api.clashofclans.com/v1/clans/${encodedClanTag}/currentwar`;

    console.log(`[CoC API Test] 요청 URL: ${url}`);
    console.log(`[CoC API Test] 사용 토큰 (앞 10자리): ${apiToken.substring(0, 10)}...`);

    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Accept': 'application/json'
            }
        });
        console.log('[CoC API Test] API 응답 상태 코드:', response.status);
        console.log('[CoC API Test] API 응답 데이터 (일부):', JSON.stringify(response.data, null, 2).substring(0, 500) + '...');
        console.log('[CoC API Test] CoC API 테스트 성공!');
    } catch (error) {
        console.error('[CoC API Test] CoC API 호출 중 오류 발생:');
        if (error.response) {
            console.error(`  - API 응답 오류: ${error.response.status} ${error.response.statusText}`);
            console.error('  - 응답 데이터:', error.response.data);
        } else if (error.request) {
            console.error('  - 요청은 이루어졌으나 응답을 받지 못했습니다.'); // error.request는 내용이 길 수 있어 전체 로깅은 생략
        } else {
            console.error('  - 요청 설정 중 오류:', error.message);
        }
        console.error('[CoC API Test] CoC API 테스트 실패.');
    }
}

async function testFirestore() {
    console.log('\n--- Firestore 연결 테스트 시작 ---');
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKeyEnv = process.env.FIREBASE_PRIVATE_KEY;

    if (!projectId || !clientEmail || !privateKeyEnv) {
        console.error('[Firestore Test] Firebase 환경 변수 (PROJECT_ID, CLIENT_EMAIL, PRIVATE_KEY) 중 하나 이상이 설정되지 않았습니다.');
        return;
    }

    try {
        const privateKey = privateKeyEnv.replace(/\\n/g, '\n'); // .env 파일의 \n을 실제 개행으로 변경
        if (!admin.apps.length) { // 이미 초기화되었는지 확인
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId,
                    clientEmail,
                    privateKey,
                }),
            });
            console.log('[Firestore Test] Firebase Admin SDK 초기화 시도...');
        } else {
            console.log('[Firestore Test] Firebase Admin SDK 이미 초기화됨.');
        }
        
        const db = admin.firestore();
        console.log('[Firestore Test] Firestore DB 인스턴스 가져오기 성공.');
        
        // 간단한 읽기 테스트 (컬렉션이나 문서가 존재하지 않아도 오류가 나지 않도록)
        console.log('[Firestore Test] Firestore \'test_collection/test_doc\' 읽기 시도...');
        const testDocRef = db.collection('test_collection').doc('test_doc');
        const testDoc = await testDocRef.get();
        if (testDoc.exists) {
            console.log('[Firestore Test] test_doc 데이터:', testDoc.data());
        } else {
            console.log('[Firestore Test] test_doc 문서를 찾을 수 없습니다 (정상적인 테스트 결과일 수 있음).');
        }
        console.log('[Firestore Test] Firestore 연결 및 기본 읽기 테스트 성공!');

    } catch (error) {
        console.error('[Firestore Test] Firestore 테스트 중 오류 발생:', error);
        console.error('[Firestore Test] Firestore 연결 테스트 실패.');
    }
}

async function main() {
    await testCocApi();
    await testFirestore();
    console.log('\n--- 모든 테스트 완료 ---');
}

main();