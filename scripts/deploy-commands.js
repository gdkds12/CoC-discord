require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const logPrefix = '[DeployCommands]';

// 환경 변수 확인
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID; // 특정 길드 ID

console.info(`${logPrefix} Starting command deployment script.`);

if (!token) {
    console.error(`${logPrefix} DISCORD_TOKEN이 .env 파일에 설정되지 않았습니다. 명령어 배포를 중단합니다.`);
    process.exit(1);
}
if (!clientId) {
    console.error(`${logPrefix} CLIENT_ID가 .env 파일에 설정되지 않았습니다. 명령어 배포를 중단합니다.`);
    process.exit(1);
}
// guildId는 개발/테스트 시에만 사용하고, 프로덕션에서는 전역 배포를 고려할 수 있음
// 여기서는 길드 ID가 있으면 해당 길드에, 없으면 전역으로 배포하도록 유연하게 처리 (또는 guildId 필수 강제)
if (guildId) {
    console.info(`${logPrefix} GUILD_ID가 설정되었습니다: ${guildId}. 해당 길드에 명령어를 배포합니다.`);
} else {
    console.warn(`${logPrefix} GUILD_ID가 .env 파일에 설정되지 않았습니다. 명령어를 전역으로 배포합니다. (최대 1시간 소요될 수 있음)`);
    // process.exit(1); // 개발 중에는 GUILD_ID를 필수로 하고 싶다면 주석 해제
}

const commands = [];
const commandsPath = path.join(__dirname, '../src/commands');
console.info(`${logPrefix} Reading command files from: ${commandsPath}`);
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    try {
        const command = require(filePath);
        if (command.data && typeof command.data.toJSON === 'function') {
            commands.push(command.data.toJSON());
            console.info(`${logPrefix} Loaded command: ${command.data.name} from ${file}`);
        } else {
            console.warn(`${logPrefix} [WARNING] ${file} 명령어에 유효한 data.toJSON 속성이 없습니다. filePath: ${filePath}`);
        }
    } catch (err) {
        console.error(`${logPrefix} Error loading command file ${filePath}:`, err);
    }
}

if (commands.length === 0) {
    console.warn(`${logPrefix} 배포할 명령어가 없습니다. src/commands 폴더를 확인해주세요.`);
    process.exit(0);
}

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
    try {
        console.info(`${logPrefix} ${commands.length}개의 애플리케이션 (/) 명령어를 새로고침합니다.`);

        let deploymentRoute;
        if (guildId) {
            // 특정 길드에 명령어 배포
            deploymentRoute = Routes.applicationGuildCommands(clientId, guildId);
            console.info(`${logPrefix} Deploying to guild: ${guildId}`);
        } else {
            // 전역 명령어 배포
            deploymentRoute = Routes.applicationCommands(clientId);
            console.info(`${logPrefix} Deploying globally.`);
        }

        const data = await rest.put(
            deploymentRoute,
            { body: commands },
        );

        console.info(`${logPrefix} ${data.length}개의 애플리케이션 (/) 명령어를 성공적으로 새로고침했습니다.`);
        if (guildId) {
            console.info(`${logPrefix} 명령어가 길드 ${guildId}에 배포되었습니다. Discord 클라이언트에서 즉시 확인 가능할 수 있습니다.`);
        } else {
            console.info(`${logPrefix} 명령어가 전역으로 배포 요청되었습니다. 모든 서버에 반영되기까지 최대 1시간이 소요될 수 있습니다.`);
        }

    } catch (error) {
        console.error(`${logPrefix} 명령어 배포 중 오류 발생:`, error);
        if (error.rawError && error.rawError.errors) {
            console.error(`${logPrefix} Discord API 상세 오류:`, JSON.stringify(error.rawError.errors, null, 2));
        }
    }
})(); 