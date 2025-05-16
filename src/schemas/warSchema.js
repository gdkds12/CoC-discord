/**
 * @typedef {Object} War
 * @property {string} warId - 전쟁 ID (예: "20240516-#1234")
 * @property {string} clanTag - 클랜 태그 (예: "#ABC123")
 * @property {string} state - 전쟁 상태 ("inWar", "warEnded", "preparation")
 * @property {number} teamSize - 팀 규모 (예: 10)
 * @property {string} channelId - 전쟁 세션 채널 ID
 * @property {string} createdBy - 세션 생성자 Discord User ID
 * @property {number} createdAt - 생성 타임스탬프 (Unix timestamp)
 * @property {boolean} ended - 전쟁 종료 여부
 */

// 이 파일은 Firestore 스키마 정의를 위한 것으로, 실제 코드로 직접 사용되지 않을 수 있습니다.
// Firestore 보안 규칙이나 데이터 검증 로직을 작성할 때 참고용으로 사용됩니다.
const warSchema = {
  warId: "string",
  clanTag: "string",
  state: "string", // "inWar", "warEnded", "preparation"
  teamSize: "number",
  channelId: "string",
  createdBy: "string",
  createdAt: "number",
  ended: "boolean"
};

module.exports = warSchema; 