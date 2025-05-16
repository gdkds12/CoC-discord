const admin = require('firebase-admin');

// TODO: .env 파일에서 Firebase 설정 값들을 제대로 불러오는지 확인 필요
// process.env.FIREBASE_PROJECT_ID, process.env.FIREBASE_CLIENT_EMAIL, process.env.FIREBASE_PRIVATE_KEY

// Firebase Admin SDK 초기화 (한 번만 실행되도록)
if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PROJECT_ID) {
            const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey: privateKey,
                }),
            });
            console.log('Firebase Admin SDK 초기화 성공 (firestoreHandler)');
        } else {
            console.warn('Firebase Admin SDK 초기화 실패 (firestoreHandler): 필요한 환경 변수가 설정되지 않았습니다. (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY)');
        }
    } catch (error) {
        console.error('Firebase Admin SDK 초기화 중 심각한 오류 발생 (firestoreHandler):', error);
    }
} else {
    // console.log('Firebase Admin SDK 이미 초기화됨 (firestoreHandler)');
}

const db = admin.firestore();

/**
 * 특정 전쟁의 특정 목표 정보를 가져옵니다.
 * @param {string} warId - 전쟁 ID
 * @param {number} targetNumber - 목표 번호
 * @returns {Promise<object | null>} 목표 데이터 또는 null
 */
async function getTarget(warId, targetNumber) {
    try {
        const targetRef = db.collection('wars').doc(warId).collection('targets').doc(String(targetNumber));
        const targetSnap = await targetRef.get();
        return targetSnap.exists ? targetSnap.data() : null;
    } catch (error) {
        console.error(`Error getting target ${targetNumber} for war ${warId}:`, error);
        throw error;
    }
}

/**
 * 특정 전쟁의 특정 목표 예약 정보를 업데이트합니다. (트랜잭션 사용)
 * @param {string} warId - 전쟁 ID
 * @param {number} targetNumber - 목표 번호
 * @param {string} userId - 예약/해제 요청한 사용자 ID
 * @param {'reserve' | 'cancel'} actionType - 수행할 액션 타입
 * @returns {Promise<object | null>} 업데이트된 목표 데이터 또는 실패 시 null 또는 에러 throw
 */
async function updateTargetReservation(warId, targetNumber, userId, actionType) {
    const targetDocRef = db.collection('wars').doc(warId).collection('targets').doc(String(targetNumber));
    try {
        const updatedTargetData = await db.runTransaction(async (transaction) => {
            const targetDoc = await transaction.get(targetDocRef);
            // 문서가 없으면 기본 구조로 초기화, targetNumber는 숫자로 저장
            let currentData = targetDoc.exists ? targetDoc.data() : { targetNumber: Number(targetNumber), reservedBy: [], confidence: {}, result: null };
            // reservedBy가 배열이 아니거나 없으면 빈 배열로 초기화
            currentData.reservedBy = Array.isArray(currentData.reservedBy) ? currentData.reservedBy : [];

            if (actionType === 'reserve') {
                if (currentData.reservedBy.includes(userId)) {
                    // 이미 예약한 경우, 아무 작업도 하지 않거나 특정 값을 반환하여 알릴 수 있음
                    // throw new Error('이미 이 목표를 예약했습니다.'); // 또는 사용자에게 알릴 메시지 반환
                    return { ...currentData, alreadyReserved: true }; 
                }
                if (currentData.reservedBy.length >= 2) {
                    throw new Error('이미 두 명의 사용자가 이 목표를 예약했습니다.');
                }
                currentData.reservedBy.push(userId);
            } else if (actionType === 'cancel') {
                const initialLength = currentData.reservedBy.length;
                currentData.reservedBy = currentData.reservedBy.filter(uid => uid !== userId);
                if (initialLength === currentData.reservedBy.length && initialLength > 0) {
                     // 예약 목록에 없는데 취소 시도 (아무것도 안하거나 알림)
                    // return { ...currentData, notReserved: true };
                }
                if (currentData.confidence && currentData.confidence[userId]) {
                    delete currentData.confidence[userId];
                }
            }
            transaction.set(targetDocRef, currentData); // 문서 전체를 덮어쓰므로 merge 옵션 불필요
            return currentData;
        });
        return updatedTargetData;
    } catch (error) {
        console.error(`Error in transaction for target ${targetNumber} of war ${warId} by user ${userId}:`, error.message);
        throw error; // 에러를 다시 던져서 호출 측에서 상세히 처리하도록 함
    }
}


/**
 * 특정 사용자 프로필 정보를 가져옵니다.
 * @param {string} userId - 사용자 ID
 * @returns {Promise<object | null>} 사용자 데이터 또는 null
 */
async function getMemberProfile(userId) {
    try {
        const memberRef = db.collection('members').doc(userId);
        const memberSnap = await memberRef.get();
        return memberSnap.exists ? memberSnap.data() : null;
    } catch (error) {
        console.error(`Error getting member profile for ${userId}:`, error);
        throw error;
    }
}

/**
 * 특정 사용자 프로필 정보를 업데이트하거나 생성합니다.
 * @param {string} userId - 사용자 ID
 * @param {object} dataToUpdate - 업데이트할 데이터
 * @returns {Promise<void>}
 */
async function updateMemberProfile(userId, dataToUpdate) {
    try {
        const memberRef = db.collection('members').doc(userId);
        await memberRef.set(dataToUpdate, { merge: true }); // 문서가 없으면 생성, 있으면 지정된 필드만 병합/업데이트
    } catch (error) {
        console.error(`Error updating member profile for ${userId}:`, error);
        throw error;
    }
}

/**
 * 특정 전쟁 세션 정보를 가져옵니다.
 * @param {string} warId - 전쟁 ID
 * @returns {Promise<object | null>} 전쟁 데이터 또는 null
 */
async function getWarSession(warId) {
    try {
        const warRef = db.collection('wars').doc(warId);
        const warSnap = await warRef.get();
        return warSnap.exists ? warSnap.data() : null;
    } catch (error) {
        console.error(`Error getting war session ${warId}:`, error);
        throw error;
    }
}

module.exports = {
    db,
    getTarget,
    updateTargetReservation,
    getMemberProfile,
    updateMemberProfile,
    getWarSession,
}; 