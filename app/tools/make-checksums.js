/*
 * Собирает release/SHA256SUMS.txt по готовым артефактам релиза.
 *
 * Порядок публикации релиза:
 *   npm run dist        — сборка Setup/Portable в release/
 *   npm run checksums   — release/SHA256SUMS.txt по exe/blockmap
 *   gh release upload   — артефакты + SHA256SUMS.txt
 *
 * Без SHA256SUMS.txt в релизе авто-обновление намеренно отказывается
 * ставить апдейт (проверка целостности обязательна).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = path.join(__dirname, '..', 'release');
const patterns = [/^Invis-.*\.exe$/i, /^Invis-.*\.blockmap$/i];

const files = fs.readdirSync(dir)
    .filter((f) => patterns.some((p) => p.test(f)))
    .sort();
if (!files.length) {
    console.error(`В ${dir} нет артефактов релиза — сначала npm run dist`);
    process.exit(1);
}

const lines = [];
for (const f of files) {
    const hex = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
    lines.push(`${hex}  ${f}`);
    console.log(`${hex}  ${f}`);
}
const out = path.join(dir, 'SHA256SUMS.txt');
fs.writeFileSync(out, lines.join('\r\n') + '\r\n', 'utf8');
console.log(`\nOK: ${out} (${files.length} файл(ов)) — не забудь приложить его к релизу.`);
