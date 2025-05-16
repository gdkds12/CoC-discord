require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const commands = [];
// commands 폴더에서 명령어 파일들을 가져옵니다.
const commandsPath = path.join(__dirname, '../src/commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

// 각 명령어 파일에서 'data' 속성을 가져와서 배포할 명령어 배열에 추가합니다.
for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));
    if (command.data) {
        commands.push(command.data.toJSON());
    } else {
        console.log(`[WARNING] ${file} 명령어에 data 속성이 없습니다.`);
    }
}

// REST 모듈 인스턴스를 생성하고 토큰을 설정합니다.
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

// 명령어를 배포합니다.
(async () => {
    try {
        console.log(`${commands.length}개의 애플리케이션 (/) 명령어를 새로고침합니다.`);

        // put 메서드를 사용하여 모든 길드에 명령어를 배포합니다.
        // 특정 길드에만 배포하려면 Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)를 사용하세요.
        const data = await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID), // CLIENT_ID 환경변수 필요
            { body: commands },
        );

        console.log(`${data.length}개의 애플리케이션 (/) 명령어를 성공적으로 새로고침했습니다.`);
    } catch (error) {
        console.error(error);
    }
})(); 