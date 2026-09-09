/*
 * Headless-проверка демонов без GUI: генерирует конфиги во временный каталог,
 * запускает все три модуля, печатает переходы состояний, гасит процессы.
 * Запуск: node tools/dev-check.js [секунды]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildAll } = require('../lib/configs');
const { DaemonSupervisor } = require('../lib/daemons');

const RUN_SECONDS = Number(process.argv[2]) || 45;
/* База в домашнем каталоге: специально с не-ASCII путём (кириллица в имени
 * пользователя) — проверяет конвертацию в короткие пути для tor */
const base = path.join(os.homedir(), 'invis-check-tmp');
const configDir = path.join(base, 'configs');

buildAll({
    configDir,
    torDataDir: path.join(base, 'data', 'tor'),
    i2pDataDir: path.join(base, 'data', 'i2pd'),
    geoipDir: path.join(__dirname, '..', 'bin', 'tor', 'data'),
    i2pdContribDir: path.join(__dirname, '..', 'bin', 'i2pd', 'contrib'),
});

const sup = new DaemonSupervisor({
    binDir: path.join(__dirname, '..', 'bin'),
    configDir,
    logDir: path.join(base, 'logs'),
    onState: ({ name, state, status }) => {
        console.log(`[${new Date().toISOString().slice(11, 19)}] ${name}: ${state} — ${status}`);
    },
});

console.log(`Каталог проверки: ${base}`);
sup.start('tor');
sup.start('dnscrypt');
sup.start('i2p');

setTimeout(async () => {
    console.log('--- статусы ---');
    console.log(JSON.stringify(sup.status(), null, 2));
    await sup.stopAll();
    console.log('Все процессы остановлены.');
    fs.rmSync(base, { recursive: true, force: true });
    setTimeout(() => process.exit(0), 1000);
}, RUN_SECONDS * 1000);
