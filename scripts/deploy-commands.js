require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const logPrefix = '[DeployCommands]';

console.info(`${logPrefix} Starting command deployment script at ${new Date().toISOString()}`);

// 환경 변수 확인 및 로깅 강화
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

console.info(`${logPrefix} Environment Variables Loaded:`);
console.info(`${logPrefix}   DISCORD_TOKEN: ${token ? token.substring(0, 10) + '...' : 'Not Set'}`); // 토큰 일부만 로깅
console.info(`${logPrefix}   CLIENT_ID: ${clientId || 'Not Set'}`);
console.info(`${logPrefix}   GUILD_ID: ${guildId || 'Not Set (Global Deployment will be attempted)'}`);

if (!token) {
    console.error(`${logPrefix} FATAL: DISCORD_TOKEN이 .env 파일에 설정되지 않았습니다. 명령어 배포를 중단합니다.`);
    process.exit(1);
}
if (!clientId) {
    console.error(`${logPrefix} FATAL: CLIENT_ID가 .env 파일에 설정되지 않았습니다. 명령어 배포를 중단합니다.`);
    process.exit(1);
}
// GUILD_ID는 이제 선택 사항으로, 없으면 전역 배포 시도
if (guildId) {
    console.info(`${logPrefix} GUILD_ID가 설정되었습니다: ${guildId}. 해당 길드에 명령어를 배포합니다.`);
} else {
    console.warn(`${logPrefix} GUILD_ID가 .env 파일에 설정되지 않았습니다. 명령어를 전역으로 배포합니다. (최대 1시간 소요될 수 있음)`);
}

const commands = [];
const commandsPath = path.join(__dirname, '../src/commands');
console.info(`${logPrefix} Reading command files from: ${commandsPath}`);

const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
console.info(`${logPrefix} Found command files: ${commandFiles.join(', ') || 'None'}`);

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    console.debug(`${logPrefix} Attempting to load command from file: ${filePath}`);
    try {
        const command = require(filePath);
        if (command.data && typeof command.data.toJSON === 'function') {
            const commandJSON = command.data.toJSON();
            commands.push(commandJSON);
            console.info(`${logPrefix} Successfully loaded command: ${commandJSON.name} (Description: ${commandJSON.description}) from ${file}`);
            console.debug(`${logPrefix} Command data for ${commandJSON.name}:`, JSON.stringify(commandJSON, null, 2));
        } else {
            console.warn(`${logPrefix} [WARNING] ${file} 명령어에 유효한 data.toJSON 속성이 없습니다. filePath: ${filePath}`);
        }
    } catch (err) {
        console.error(`${logPrefix} Error loading command file ${filePath}:`, err);
    }
}

if (commands.length === 0) {
    console.warn(`${logPrefix} 배포할 명령어가 없습니다. src/commands 폴더를 확인해주세요. 스크립트를 종료합니다.`);
    process.exit(0);
}

console.info(`${logPrefix} Total ${commands.length} command(s) prepared for deployment.`);

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
    try {
        console.info(`${logPrefix} ${commands.length}개의 애플리케이션 (/) 명령어를 Discord API에 새로고침 시작...`);

        let deploymentRoute;
        let deploymentType;
        if (guildId) {
            deploymentRoute = Routes.applicationGuildCommands(clientId, guildId);
            deploymentType = `guild (${guildId})`;
            console.info(`${logPrefix} Deploying commands to specific guild: ${guildId}`);
        } else {
            deploymentRoute = Routes.applicationCommands(clientId);
            deploymentType = 'global';
            console.info(`${logPrefix} Deploying commands globally.`);
        }

        console.debug(`${logPrefix} Using deployment route: ${deploymentRoute}`);
        console.debug(`${logPrefix} Sending command data to Discord:`, JSON.stringify(commands, null, 2));

        const data = await rest.put(
            deploymentRoute,
            { body: commands },
        );

        console.info(`${logPrefix} Discord API Response for PUT command:`);
        console.debug(`${logPrefix} Full API Response Data:`, JSON.stringify(data, null, 2)); // API 응답 전체 로깅

        if (Array.isArray(data)) {
            console.info(`${logPrefix} ${data.length}개의 애플리케이션 (/) 명령어를 성공적으로 ${deploymentType}에 새로고침했습니다.`);
            data.forEach(cmd => console.info(`${logPrefix}   - Deployed: ${cmd.name} (ID: ${cmd.id})`));
        } else {
            console.warn(`${logPrefix} 명령어 배포 후 예상치 못한 API 응답 형식입니다. 응답을 확인하세요.`);
        }
        
        if (guildId) {
            console.info(`${logPrefix} 명령어가 길드 ${guildId}에 배포되었습니다. Discord 클라이언트에서 즉시 확인 가능할 수 있습니다.`);
        } else {
            console.info(`${logPrefix} 명령어가 전역으로 배포 요청되었습니다. 모든 서버에 반영되기까지 최대 1시간이 소요될 수 있습니다.`);
        }

    } catch (error) {
        console.error(`${logPrefix} 명령어 배포 중 심각한 오류 발생:`, error); // 전체 에러 객체 로깅
        if (error.rawError && error.rawError.errors) {
            console.error(`${logPrefix} Discord API 상세 오류:`, JSON.stringify(error.rawError.errors, null, 2));
        }
        if (error.response && error.response.data) {
            console.error(`${logPrefix} Axios/HTTP 응답 오류 데이터:`, JSON.stringify(error.response.data, null, 2));
        }
        console.error(`${logPrefix} 스택 트레이스:`, error.stack);
        process.exit(1); // 오류 발생 시 스크립트 종료
    }
})(); 