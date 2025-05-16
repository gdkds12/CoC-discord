const admin = require('firebase-admin');

let db = null;
let firebaseInitialized = false;

// TODO: .env 파일에서 Firebase 설정 값들을 제대로 불러오는지 확인 필요
// process.env.FIREBASE_PROJECT_ID, process.env.FIREBASE_CLIENT_EMAIL, process.env.FIREBASE_PRIVATE_KEY

// Firebase Admin SDK 초기화 (한 번만 실행되도록)
if (!admin.apps.length) {
    console.info('[FirestoreHandler] Firebase Admin SDK 초기화 시도...');
    try {
        if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
            const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\\\n/g, '\\n');
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey: privateKey,
                }),
            });
            db = admin.firestore();
            firebaseInitialized = true;
            console.info('[FirestoreHandler] Firebase Admin SDK 초기화 성공.');
        } else {
            firebaseInitialized = false;
            console.warn('[FirestoreHandler] Firebase Admin SDK 초기화 실패: 필요한 환경 변수가 설정되지 않았습니다. (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY)');
        }
    } catch (error) {
        firebaseInitialized = false;
        console.error('[FirestoreHandler] Firebase Admin SDK 초기화 중 심각한 오류 발생:', error);
    }
} else {
    // 이미 초기화된 경우, 기존 앱에서 firestore 인스턴스를 가져올 수 있는지 확인
    const defaultApp = admin.app();
    if (defaultApp) {
        db = defaultApp.firestore();
        firebaseInitialized = true; // 이미 초기화되었으므로 true로 간주
        console.info('[FirestoreHandler] Firebase Admin SDK 이미 초기화됨. 기존 인스턴스 사용.');
    } else {
        // 이론적으로 이 경우는 드물지만, apps.length > 0 이지만 기본 앱을 가져올 수 없는 경우
        firebaseInitialized = false;
        console.warn('[FirestoreHandler] Firebase Admin SDK가 이미 초기화된 것으로 보이나, 기본 앱 인스턴스를 가져올 수 없습니다.');
    }
}

/**
 * 특정 전쟁의 특정 목표 정보를 가져옵니다.
 * @param {string} warId - 전쟁 ID
 * @param {number} targetNumber - 목표 번호
 * @returns {Promise<object | null>} 목표 데이터 또는 null
 */
async function getTarget(warId, targetNumber) {
    console.debug(`[FirestoreHandler] getTarget 호출: warId=${warId}, targetNumber=${targetNumber}`);
    if (!firebaseInitialized || !db) {
        console.error(`[FirestoreHandler] getTarget 실패: Firebase가 초기화되지 않았습니다. warId=${warId}, targetNumber=${targetNumber}`);
        return null;
    }
    try {
        const targetRef = db.collection('wars').doc(warId).collection('targets').doc(String(targetNumber));
        const targetSnap = await targetRef.get();
        if (targetSnap.exists) {
            console.debug(`[FirestoreHandler] getTarget 성공: warId=${warId}, targetNumber=${targetNumber}, data found.`);
            return targetSnap.data();
        } else {
            console.debug(`[FirestoreHandler] getTarget 성공: warId=${warId}, targetNumber=${targetNumber}, no data.`);
            return null;
        }
    } catch (error) {
        console.error(`[FirestoreHandler] getTarget 오류: warId=${warId}, targetNumber=${targetNumber}:`, error);
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
    console.debug(`[FirestoreHandler] updateTargetReservation 호출: warId=${warId}, targetNumber=${targetNumber}, userId=${userId}, actionType=${actionType}`);
    if (!firebaseInitialized || !db) {
        console.error(`[FirestoreHandler] updateTargetReservation 실패: Firebase가 초기화되지 않았습니다. warId=${warId}, targetNumber=${targetNumber}`);
        throw new Error('Firebase not initialized');
    }
    const targetDocRef = db.collection('wars').doc(warId).collection('targets').doc(String(targetNumber));
    try {
        const updatedTargetData = await db.runTransaction(async (transaction) => {
            console.debug(`[FirestoreHandler] updateTargetReservation 트랜잭션 시작: warId=${warId}, targetNumber=${targetNumber}`);
            const targetDoc = await transaction.get(targetDocRef);
            console.debug(`[FirestoreHandler] updateTargetReservation 트랜잭션 데이터 읽기 완료: warId=${warId}, targetNumber=${targetNumber}, exists=${targetDoc.exists}`);
            
            let currentData = targetDoc.exists ? targetDoc.data() : { targetNumber: Number(targetNumber), reservedBy: [], confidence: {}, result: null };
            currentData.reservedBy = Array.isArray(currentData.reservedBy) ? currentData.reservedBy : [];

            if (actionType === 'reserve') {
                console.debug(`[FirestoreHandler] updateTargetReservation 예약 시도: warId=${warId}, targetNumber=${targetNumber}, userId=${userId}`);
                if (currentData.reservedBy.includes(userId)) {
                    console.info(`[FirestoreHandler] updateTargetReservation: 사용자가 이미 예약한 목표입니다. warId=${warId}, targetNumber=${targetNumber}, userId=${userId}`);
                    return { ...currentData, alreadyReserved: true }; 
                }
                if (currentData.reservedBy.length >= 2) {
                    console.warn(`[FirestoreHandler] updateTargetReservation: 목표가 이미 2명에 의해 예약되었습니다. warId=${warId}, targetNumber=${targetNumber}`);
                    throw new Error('이미 두 명의 사용자가 이 목표를 예약했습니다.');
                }
                currentData.reservedBy.push(userId);
                console.debug(`[FirestoreHandler] updateTargetReservation 예약 추가됨: warId=${warId}, targetNumber=${targetNumber}, userId=${userId}`);
            } else if (actionType === 'cancel') {
                console.debug(`[FirestoreHandler] updateTargetReservation 예약 취소 시도: warId=${warId}, targetNumber=${targetNumber}, userId=${userId}`);
                const initialLength = currentData.reservedBy.length;
                currentData.reservedBy = currentData.reservedBy.filter(uid => uid !== userId);
                if (initialLength === currentData.reservedBy.length && initialLength > 0) {
                    console.info(`[FirestoreHandler] updateTargetReservation: 사용자가 예약하지 않은 목표의 취소를 시도했습니다. warId=${warId}, targetNumber=${targetNumber}, userId=${userId}`);
                    // return { ...currentData, notReserved: true }; // 필요시 활성화
                }
                if (currentData.confidence && currentData.confidence[userId]) {
                    delete currentData.confidence[userId];
                    console.debug(`[FirestoreHandler] updateTargetReservation 자신감 정보 삭제됨: warId=${warId}, targetNumber=${targetNumber}, userId=${userId}`);
                }
                console.debug(`[FirestoreHandler] updateTargetReservation 예약 취소됨 (또는 변경 없음): warId=${warId}, targetNumber=${targetNumber}, userId=${userId}`);
            }
            transaction.set(targetDocRef, currentData);
            console.debug(`[FirestoreHandler] updateTargetReservation 트랜잭션 데이터 쓰기 완료: warId=${warId}, targetNumber=${targetNumber}`);
            return currentData;
        });
        console.info(`[FirestoreHandler] updateTargetReservation 트랜잭션 성공: warId=${warId}, targetNumber=${targetNumber}, userId=${userId}, actionType=${actionType}`);
        return updatedTargetData;
    } catch (error) {
        console.error(`[FirestoreHandler] updateTargetReservation 트랜잭션 오류: warId=${warId}, targetNumber=${targetNumber}, userId=${userId}, actionType=${actionType}:`, error.message);
        throw error;
    }
}


/**
 * 특정 사용자 프로필 정보를 가져옵니다.
 * @param {string} userId - 사용자 ID
 * @returns {Promise<object | null>} 사용자 데이터 또는 null
 */
async function getMemberProfile(userId) {
    console.debug(`[FirestoreHandler] getMemberProfile 호출: userId=${userId}`);
    if (!firebaseInitialized || !db) {
        console.error(`[FirestoreHandler] getMemberProfile 실패: Firebase가 초기화되지 않았습니다. userId=${userId}`);
        return null;
    }
    try {
        const memberRef = db.collection('members').doc(userId);
        const memberSnap = await memberRef.get();
        if (memberSnap.exists) {
            console.debug(`[FirestoreHandler] getMemberProfile 성공: userId=${userId}, data found.`);
            return memberSnap.data();
        } else {
            console.debug(`[FirestoreHandler] getMemberProfile 성공: userId=${userId}, no data.`);
            return null;
        }
    } catch (error) {
        console.error(`[FirestoreHandler] getMemberProfile 오류: userId=${userId}:`, error);
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
    console.debug(`[FirestoreHandler] updateMemberProfile 호출: userId=${userId}, dataToUpdate:`, dataToUpdate);
    if (!firebaseInitialized || !db) {
        console.error(`[FirestoreHandler] updateMemberProfile 실패: Firebase가 초기화되지 않았습니다. userId=${userId}`);
        throw new Error('Firebase not initialized');
    }
    try {
        const memberRef = db.collection('members').doc(userId);
        await memberRef.set(dataToUpdate, { merge: true });
        console.info(`[FirestoreHandler] updateMemberProfile 성공: userId=${userId}`);
    } catch (error) {
        console.error(`[FirestoreHandler] updateMemberProfile 오류: userId=${userId}:`, error);
        throw error;
    }
}

/**
 * 특정 전쟁 세션 정보를 가져옵니다.
 * @param {string} warId - 전쟁 ID
 * @returns {Promise<object | null>} 전쟁 데이터 또는 null
 */
async function getWarSession(warId) {
    console.debug(`[FirestoreHandler] getWarSession 호출: warId=${warId}`);
    if (!firebaseInitialized || !db) {
        console.error(`[FirestoreHandler] getWarSession 실패: Firebase가 초기화되지 않았습니다. warId=${warId}`);
        return null;
    }
    try {
        const warRef = db.collection('wars').doc(warId);
        const warSnap = await warRef.get();
        if (warSnap.exists) {
            console.debug(`[FirestoreHandler] getWarSession 성공: warId=${warId}, data found.`);
            return warSnap.data();
        } else {
            console.debug(`[FirestoreHandler] getWarSession 성공: warId=${warId}, no data.`);
            return null;
        }
    } catch (error) {
        console.error(`[FirestoreHandler] getWarSession 오류: warId=${warId}:`, error);
        throw error;
    }
}

module.exports = {
    // db, // db 객체를 직접 내보내기보다는, 초기화 상태를 확인하는 함수를 제공하거나, 각 함수 내에서 확인하도록 함
    get firebaseInitialized() { // getter를 사용하여 최신 상태를 반영
        return firebaseInitialized;
    },
    getTarget,
    updateTargetReservation,
    getMemberProfile,
    updateMemberProfile,
    getWarSession,
}; 