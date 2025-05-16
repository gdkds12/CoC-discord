# 안정적인 Node.js LTS 버전을 기반 이미지로 사용합니다.
FROM node:20-alpine AS builder

# 작업 디렉토리 설정
WORKDIR /usr/src/app

# 의존성 설치를 위해 package.json과 package-lock.json(존재한다면)을 먼저 복사합니다.
# 이렇게 하면 의존성이 변경되지 않았을 경우 Docker 캐시를 활용할 수 있습니다.
COPY package*.json ./

# 운영 환경에서는 개발 의존성을 설치하지 않을 수 있습니다.
# 만약 개발 의존성도 필요하다면 RUN npm ci 로 변경하세요.
RUN npm ci --omit=dev

# 애플리케이션 소스 코드를 복사합니다.
COPY . .

# 애플리케이션 실행 명령어 (package.json의 "start" 스크립트 사용)
CMD [ "npm", "start" ]