const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// 데이터베이스 파일 경로 (프로젝트 루트에 'coc_bot.db'로 생성)
const dbPath = path.resolve(__dirname, '../../coc_bot.db');

// 데이터베이스 연결 객체
let db = null;

// 데이터베이스 호출 속도 제한 설정
const RATE_LIMIT = {
    windowMs: 1000, // 1초
    max: 10 // 최대 10회 호출
};

const rateLimit = new Map();

function checkRateLimit(operation) {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT.windowMs;
    
    if (!rateLimit.has(operation)) {
        rateLimit.set(operation, []);
    }
    
    const calls = rateLimit.get(operation);
    const recentCalls = calls.filter(time => time > windowStart);
    
    if (recentCalls.length >= RATE_LIMIT.max) {
        throw new Error('데이터베이스 호출 속도 제한에 도달했습니다. 잠시 후 다시 시도해주세요.');
    }
    
    recentCalls.push(now);
    rateLimit.set(operation, recentCalls);
}

// 데이터베이스 작업 래퍼 함수
async function withRateLimit(operation, callback) {
    checkRateLimit(operation);
    try {
        return await callback();
    } catch (error) {
        console.error(`[DatabaseHandler] Error in ${operation}:`, error);
        throw error;
    }
}

// 데이터베이스 연결 및 초기화 함수
const initializeDatabase = () => {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('[DB Error] Could not connect to database:', err.message);
        return reject(err);
      }
      console.log('[DB Info] Connected to SQLite database.');

      // 테이블 생성
      db.serialize(() => {
        // Wars 테이블
        db.run(`
          CREATE TABLE IF NOT EXISTS wars (
            warId TEXT PRIMARY KEY,
            clanTag TEXT,
            state TEXT DEFAULT 'preparation', 
            teamSize INTEGER,
            channelId TEXT,
            messageIds TEXT, 
            createdBy TEXT,
            createdAt TEXT,
            endedAt TEXT 
          )
        `, (err) => {
          if (err) return reject(err);
          console.log('[DB Info] "wars" table checked/created.');
        });

        // Targets 테이블 (warId를 외래키로 가질 수 있으나, 여기서는 단순화)
        // targetNumber와 warId를 복합키로 사용하거나, 별도의 id를 가질 수 있음
        // 여기서는 warId 내에서 targetNumber가 고유하다고 가정
        db.run(`
          CREATE TABLE IF NOT EXISTS targets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            warId TEXT NOT NULL,
            targetNumber INTEGER NOT NULL,
            reservedBy TEXT, 
            confidence TEXT, 
            result TEXT, 
            messageId TEXT, 
            UNIQUE(warId, targetNumber)
          )
        `, (err) => {
          if (err) return reject(err);
          console.log('[DB Info] "targets" table checked/created.');
        });
        
        // Members 테이블 (uid와 warId를 복합키로 사용)
        db.run(`
          CREATE TABLE IF NOT EXISTS members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            warId TEXT NOT NULL,
            userId TEXT NOT NULL,
            attacksLeft INTEGER DEFAULT 2,
            reservedTargets TEXT, 
            confidence TEXT, 
            UNIQUE(warId, userId)
          )
        `, (err) => {
          if (err) return reject(err);
          console.log('[DB Info] "members" table checked/created.');
          resolve();
        });
      });
    });
  });
};

// 데이터베이스 연결 가져오기
const getDB = () => {
  if (!db) {
    console.warn("[DB Warn] Database not initialized. Call initializeDatabase() first.");
    // 실제 운영 환경에서는 여기서 에러를 throw 하거나 재연결 로직을 넣을 수 있습니다.
    // 여기서는 예시로 null을 반환하지만, 이는 문제를 야기할 수 있습니다.
    // bot.js에서 반드시 초기화 후에 getDB를 호출하도록 합니다.
  }
  return db;
};

// 전쟁 정보 저장
const saveWar = async (warData) => {
  return new Promise((resolve, reject) => {
    const query = `
      INSERT INTO wars (warId, clanTag, state, teamSize, channelId, messageIds, createdBy, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      warData.warId,
      warData.clanTag,
      warData.state || 'preparation',
      warData.teamSize,
      warData.channelId,
      JSON.stringify(warData.messageIds || {}), // 객체/배열은 JSON 문자열로 저장
      warData.createdBy,
      warData.createdAt || new Date().toISOString()
    ];
    getDB().run(query, params, function(err) {
      if (err) {
        console.error('[DB Error] Error saving war:', err.message);
        return reject(err);
      }
      resolve({ id: this.lastID, warId: warData.warId });
    });
  });
};

// 전쟁 정보 조회 (warId 기준)
const getWar = async (warId) => {
  return new Promise((resolve, reject) => {
    const query = `SELECT * FROM wars WHERE warId = ?`;
    getDB().get(query, [warId], (err, row) => {
      if (err) {
        console.error('[DB Error] Error fetching war:', err.message);
        return reject(err);
      }
      if (row && row.messageIds) {
        row.messageIds = JSON.parse(row.messageIds); // JSON 문자열을 다시 객체로
      }
      resolve(row);
    });
  });
};

// 전쟁 상태 업데이트
const updateWarState = async (warId, newState) => {
  return new Promise((resolve, reject) => {
    const query = `UPDATE wars SET state = ? WHERE warId = ?`;
    getDB().run(query, [newState, warId], function(err) {
      if (err) {
        console.error('[DB Error] Error updating war state:', err.message);
        return reject(err);
      }
      resolve({ changes: this.changes });
    });
  });
};

// 전쟁 종료 업데이트
const endWar = async (warId) => {
  return new Promise((resolve, reject) => {
    const query = `UPDATE wars SET state = 'ended', endedAt = ? WHERE warId = ?`;
    getDB().run(query, [new Date().toISOString(), warId], function(err) {
      if (err) {
        console.error('[DB Error] Error ending war:', err.message);
        return reject(err);
      }
      resolve({ changes: this.changes });
    });
  });
};


// 목표 정보 초기 저장 (여러 목표 한번에)
const saveInitialTargets = async (warId, targets) => {
  // targets는 [{ targetNumber: 1, messageId: '...' }, { targetNumber: 2, messageId: '...' }] 형태
  return new Promise((resolve, reject) => {
    const dbInstance = getDB();
    dbInstance.serialize(() => {
      const stmt = dbInstance.prepare(`
        INSERT INTO targets (warId, targetNumber, messageId, reservedBy, confidence, result) 
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      let completed = 0;
      targets.forEach(target => {
        stmt.run(
          warId, 
          target.targetNumber, 
          target.messageId, // 각 타겟의 메시지 ID
          JSON.stringify([]), // reservedBy: 빈 배열로 시작
          JSON.stringify({}),  // confidence: 빈 객체로 시작
          JSON.stringify({ stars: 0, destruction: 0, attacker: null }), // result: 기본값
          (err) => {
            if (err) {
              console.error('[DB Error] Error saving initial target:', target.targetNumber, err.message);
              // 하나의 타겟 저장 실패 시 전체 롤백은 복잡하므로, 여기서는 에러 로깅만 합니다.
              // 필요시 트랜잭션 처리를 고려해야 합니다.
            }
            completed++;
            if (completed === targets.length) {
              stmt.finalize((finalizeErr) => {
                if (finalizeErr) {
                  console.error('[DB Error] Error finalizing statement for initial targets:', finalizeErr.message);
                  return reject(finalizeErr);
                }
                resolve({ count: targets.length });
              });
            }
          }
        );
      });
    });
  });
};

// 특정 전쟁의 모든 목표 조회
const getTargetsByWarId = async (warId) => {
  return new Promise((resolve, reject) => {
    const query = `SELECT * FROM targets WHERE warId = ? ORDER BY targetNumber ASC`;
    getDB().all(query, [warId], (err, rows) => {
      if (err) {
        console.error('[DB Error] Error fetching targets by warId:', err.message);
        return reject(err);
      }
      rows.forEach(row => {
        if (row.reservedBy) row.reservedBy = JSON.parse(row.reservedBy);
        if (row.confidence) row.confidence = JSON.parse(row.confidence);
        if (row.result) row.result = JSON.parse(row.result);
      });
      resolve(rows);
    });
  });
};

// 특정 목표 정보 조회
const getTarget = async (warId, targetNumber) => {
  return new Promise((resolve, reject) => {
    const query = `SELECT * FROM targets WHERE warId = ? AND targetNumber = ?`;
    getDB().get(query, [warId, targetNumber], (err, row) => {
      if (err) {
        console.error('[DB Error] Error fetching target:', err.message);
        return reject(err);
      }
      if (row) {
        if (row.reservedBy) row.reservedBy = JSON.parse(row.reservedBy);
        if (row.confidence) row.confidence = JSON.parse(row.confidence);
        if (row.result) row.result = JSON.parse(row.result);
      }
      resolve(row);
    });
  });
};

// 목표 예약 업데이트
const updateTargetReservation = async (warId, targetNumber, userId, addReservation = true) => {
  return new Promise(async (resolve, reject) => {
    const target = await getTarget(warId, targetNumber);
    if (!target) return reject(new Error('Target not found'));

    let reservedBy = target.reservedBy || [];
    if (addReservation) {
      if (reservedBy.includes(userId)) return resolve({ ...target, reservedBy, updated: false, message: 'Already reserved' }); // 이미 예약됨
      if (reservedBy.length >= 2) return resolve({ ...target, reservedBy, updated: false, message: 'Reservation limit reached' }); // 예약 한도 초과
      reservedBy.push(userId);
    } else {
      reservedBy = reservedBy.filter(id => id !== userId);
    }

    const query = `UPDATE targets SET reservedBy = ? WHERE warId = ? AND targetNumber = ?`;
    getDB().run(query, [JSON.stringify(reservedBy), warId, targetNumber], function(err) {
      if (err) {
        console.error('[DB Error] Error updating target reservation:', err.message);
        return reject(err);
      }
      resolve({ ...target, reservedBy, updated: this.changes > 0 });
    });
  });
};

// 목표 파괴율 및 결과 업데이트
const updateTargetResult = async (warId, targetNumber, stars, destruction, attackerId) => {
  return new Promise(async (resolve, reject) => {
    const target = await getTarget(warId, targetNumber);
    if (!target) return reject(new Error('Target not found'));

    const result = { stars, destruction, attacker: attackerId };
    
    // 이미 3별인 경우 업데이트하지 않음 (선택적 로직)
    // if (target.result && target.result.stars === 3) {
    //   return resolve({ ...target, updated: false, message: 'Target already 3-starred.' });
    // }

    const query = `UPDATE targets SET result = ? WHERE warId = ? AND targetNumber = ?`;
    getDB().run(query, [JSON.stringify(result), warId, targetNumber], function(err) {
      if (err) {
        console.error('[DB Error] Error updating target result:', err.message);
        return reject(err);
      }
      resolve({ ...target, result, updated: this.changes > 0 });
    });
  });
};

// 목표 자신감(confidence) 업데이트
const updateTargetConfidence = async (warId, targetNumber, userId, confidencePercentage) => {
  return new Promise(async (resolve, reject) => {
    const target = await getTarget(warId, targetNumber);
    if (!target) return reject(new Error('Target not found'));

    let confidence = target.confidence || {}; // JSON.parse는 getTarget에서 이미 처리됨
    confidence[userId] = confidencePercentage;

    const query = `UPDATE targets SET confidence = ? WHERE warId = ? AND targetNumber = ?`;
    getDB().run(query, [JSON.stringify(confidence), warId, targetNumber], function(err) {
      if (err) {
        console.error('[DB Error] Error updating target confidence:', err.message);
        return reject(err);
      }
      resolve({ ...target, confidence, updated: this.changes > 0 });
    });
  });
};


// 멤버 정보 가져오기 또는 생성
const getOrCreateMember = async (warId, userId) => {
  return new Promise((resolve, reject) => {
    const querySelect = `SELECT * FROM members WHERE warId = ? AND userId = ?`;
    getDB().get(querySelect, [warId, userId], (err, row) => {
      if (err) {
        console.error('[DB Error] Error fetching member:', err.message);
        return reject(err);
      }
      if (row) {
        if (row.reservedTargets) row.reservedTargets = JSON.parse(row.reservedTargets);
        if (row.confidence) row.confidence = JSON.parse(row.confidence);
        resolve(row);
      } else {
        // 멤버가 없으면 새로 생성
        const attacksLeft = 2; // 기본 공격권
        const reservedTargets = [];
        const confidence = {};
        const queryInsert = `
          INSERT INTO members (warId, userId, attacksLeft, reservedTargets, confidence)
          VALUES (?, ?, ?, ?, ?)
        `;
        getDB().run(queryInsert, [warId, userId, attacksLeft, JSON.stringify(reservedTargets), JSON.stringify(confidence)], function(err) {
          if (err) {
            console.error('[DB Error] Error creating member:', err.message);
            return reject(err);
          }
          resolve({ id: this.lastID, warId, userId, attacksLeft, reservedTargets, confidence });
        });
      }
    });
  });
};

// 멤버 정보 업데이트 (예약, 공격권 등)
const updateMemberProfile = async (warId, userId, updates) => {
  // updates 예시: { attacksLeft: 1, reservedTargets: ['1', '5'] }
  return new Promise(async (resolve, reject) => {
    let member = await getOrCreateMember(warId, userId); // 먼저 멤버 정보를 가져오거나 생성
    if (!member) return reject(new Error('Failed to get or create member'));

    // 업데이트할 필드들
    const fieldsToUpdate = [];
    const params = [];

    if (updates.attacksLeft !== undefined) {
      fieldsToUpdate.push('attacksLeft = ?');
      params.push(updates.attacksLeft);
      member.attacksLeft = updates.attacksLeft;
    }
    if (updates.reservedTargets !== undefined) {
      fieldsToUpdate.push('reservedTargets = ?');
      params.push(JSON.stringify(updates.reservedTargets));
      member.reservedTargets = updates.reservedTargets;
    }
    if (updates.confidence !== undefined) { // 자신감 맵은 전체를 업데이트
        fieldsToUpdate.push('confidence = ?');
        params.push(JSON.stringify(updates.confidence));
        member.confidence = updates.confidence;
    }

    if (fieldsToUpdate.length === 0) {
      return resolve(member); // 변경사항 없음
    }

    params.push(warId, userId);
    const query = `UPDATE members SET ${fieldsToUpdate.join(', ')} WHERE warId = ? AND userId = ?`;
    
    getDB().run(query, params, function(err) {
      if (err) {
        console.error('[DB Error] Error updating member profile:', err.message);
        return reject(err);
      }
      resolve(member); // 업데이트된 멤버 정보 반환
    });
  });
};


module.exports = {
  initializeDatabase,
  getDB,
  saveWar,
  getWar,
  updateWarState,
  endWar,
  saveInitialTargets,
  getTargetsByWarId,
  getTarget,
  updateTargetReservation,
  updateTargetResult,
  updateTargetConfidence,
  getOrCreateMember,
  updateMemberProfile,
}; 