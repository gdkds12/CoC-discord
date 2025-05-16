require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, GatewayIntentBits } = require('discord.js');

// Discord 클라이언트 생성
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.commands = new Collection();

// 명령어 파일 로드
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
    } else {
        console.log(`[WARNING] ${filePath} 명령어에 data 또는 execute 속성이 없습니다.`);
    }
}

console.log('[INFO] 명령어 컬렉션 상태:', client.commands.map(c => c.data.name));

// 이벤트 파일 로드
const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
    const filePath = path.join(eventsPath, file);
    const event = require(filePath);
    if (event.once) {
        client.once(event.name, (...args) => event.execute(...args));
    } else {
        client.on(event.name, (...args) => event.execute(...args));
    }
}

// Firestore 초기화 (추후 구현)
// const admin = require('firebase-admin');
// const serviceAccount = require(process.env.FIREBASE_KEY_PATH);
// admin.initializeApp({
// credential: admin.credential.cert(serviceAccount)
// });
// const db = admin.firestore();

// Clash API 클라이언트 (추후 구현)

// 봇이 준비되었을 때 실행될 로직
client.once('ready', () => {
    console.log('[INFO] 봇이 성공적으로 로그인했습니다.');
    console.log(`[INFO] 봇 태그: ${client.user.tag}`);
    console.log('[INFO] 봇이 접속한 길드 목록:');
    client.guilds.cache.forEach(guild => {
        console.log(`- ${guild.name} (ID: ${guild.id})`);
    });
    console.log('[INFO] 로드된 명령어 개수:', client.commands.size);
});

// 봇 토큰으로 로그인
console.log('[INFO] 봇 로그인을 시도합니다...');
client.login(process.env.DISCORD_TOKEN);

console.log('CoC Collaborative War-Map Planner 봇이 준비되었습니다.'); 