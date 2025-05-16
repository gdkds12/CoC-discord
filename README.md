# CoC Collaborative War-Map Planner

Discord bot for Clash of Clans war planning.

## 목표

Discord Slash Command를 사용하여 전쟁 세션 채널을 생성하고, 팀원들이 공격 목표 2개와 예상 파괴율을 버튼 및 모달을 통해 등록할 수 있게 하며, 전쟁 종료 시 수동으로 세션을 닫을 수 있는 실시간 협업 봇을 구축합니다.

## 주요 기능

- `/startwar`: 전쟁 세션 채널 생성
- `/endwar`: 전쟁 세션 종료
- 목표 예약 및 파괴율 입력 (버튼/모달)
- `/status`: 전쟁 현황 요약
- 자동 리마인더 (공격 미사용자 대상)
- 권한 관리 (리더 역할)
- `/report`: 전쟁 결과 PDF 리포트 생성 (추후 구현)

## 설정

1.  `.env` 파일을 생성하고 다음 환경 변수를 설정합니다:
    *   `DISCORD_TOKEN`: Discord 봇 토큰
    *   `FIREBASE_PROJECT_ID`: Firebase 프로젝트 ID
    *   `FIREBASE_PRIVATE_KEY`: Firebase 비공개 키 (JSON 파일 내용 전체 또는 base64 인코딩된 문자열)
    *   `FIREBASE_CLIENT_EMAIL`: Firebase 서비스 계정 이메일
    *   `CLAN_TAG`: 클래시 오브 클랜 클랜 태그 (예: #ABC123)
    *   `LEADER_ROLE_ID`: 봇 관리자 역할 ID (세션 생성/종료 권한)
    *   `CLIENT_ID`: Discord 봇의 클라이언트 ID (명령어 배포 시 필요)

2.  의존성 설치:
    ```bash
    npm install
    ```

## 실행

- 개발 모드 (nodemon):
  ```bash
  npm run dev
  ```
- 프로덕션 모드:
  ```bash
  npm start
  ```
- PM2로 실행:
  ```bash
  npm run pm2
  npm run pm2-save # 현재 프로세스 목록 저장
  ```

## 명령어 배포

새로운 슬래시 명령어를 추가하거나 기존 명령어를 수정한 경우, 다음 스크립트를 실행하여 Discord에 등록해야 합니다:

```bash
npm run deploy-commands
```

## 데이터베이스

Firebase Firestore를 사용하여 전쟁 세션, 목표, 멤버 데이터를 관리합니다.

## 기여

GitHub Issues 또는 Discord 채널을 통해 제안 및 기여할 수 있습니다. 