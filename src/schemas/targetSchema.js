/**
 * @typedef {Object} TargetResult
 * @property {number} stars - 획득 별 개수
 * @property {number} destruction - 파괴율 (%)
 */

/**
 * @typedef {Object.<string, number>} ConfidenceMap - 유저 ID를 키로, 파괴율을 값으로 가짐
 */

/**
 * @typedef {Object} Target
 * @property {number} targetNumber - 목표 번호 (상대 진영 번호)
 * @property {string[]} reservedBy - 예약한 유저 Discord User ID 배열 (최대 2명)
 * @property {ConfidenceMap} confidence - 예약한 유저들의 예상 파괴율 맵 (예: { "user123": 90, "user456": 85 })
 * @property {TargetResult | null} result - 실제 공격 결과 (stars, destruction)
 */

// 이 파일은 Firestore 스키마 정의를 위한 것으로, 실제 코드로 직접 사용되지 않을 수 있습니다.
// Firestore 보안 규칙이나 데이터 검증 로직을 작성할 때 참고용으로 사용됩니다.
const targetSchema = {
  targetNumber: "number",
  reservedBy: "array", // string[] of user IDs, max 2
  confidence: "map", // { [userId: string]: number }
  result: {
    stars: "number",
    destruction: "number"
  } // or null
};

module.exports = targetSchema; 