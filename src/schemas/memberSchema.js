/**
 * @typedef {Object.<number, number>} TargetConfidenceMap - 목표 번호를 키로, 파괴율을 값으로 가짐
 */

/**
 * @typedef {Object} Member
 * @property {string} uid - Discord User ID
 * @property {number[]} targets - 해당 유저가 예약한 목표 번호 배열 (최대 2개)
 * @property {TargetConfidenceMap} confidence - 각 목표에 대한 예상 파괴율 맵 (예: { 3: 90, 5: 80 })
 * @property {number} attacksLeft - 남은 공격권 수 (일반적으로 2에서 시작)
 */

// 이 파일은 Firestore 스키마 정의를 위한 것으로, 실제 코드로 직접 사용되지 않을 수 있습니다.
// Firestore 보안 규칙이나 데이터 검증 로직을 작성할 때 참고용으로 사용됩니다.
const memberSchema = {
  uid: "string",
  targets: "array", // number[], max 2 target numbers
  confidence: "map", // { [targetNumber: number]: number }
  attacksLeft: "number"
};

module.exports = memberSchema; 