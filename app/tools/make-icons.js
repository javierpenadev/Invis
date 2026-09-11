/*
 * Генерация иконок из исходного логотипа (logo-omg.svg в корне репозитория).
 * Перекрашивает глиф в палитру Invis и собирает:
 *   assets/img/logo.svg         — мастер-SVG (тёмный скруглённый фон + акцентный градиент)
 *   assets/img/icon.ico         — иконка окна/приложения (16…256 px)
 *   assets/img/tray-on.png      — трей: глиф зелёный (запущен)
 *   assets/img/tray-off.png     — трей: глиф красный (выключен)
 *   assets/img/tray-busy.png    — трей: глиф жёлтый (проблема/переход)
 *   index.html                  — инжект глифа между маркерами <!-- glyph:start|end -->
 *   assets/img/icon-preview.png — превью-сетка для визуальной проверки
 * Запуск: node tools/make-icons.js
 */
const fs = require('fs');
const path = require('path');
/* Опциональные dev-зависимости: нужны только для перегенерации иконок.
 * На чистом клоне даём понятную ошибку вместо стек-трейса (BUG-12). */
let sharp, pngToIco;
try {
    sharp = require('sharp');
    pngToIco = require('png-to-ico').default;
} catch (e) {
    console.error('Для make-icons нужны одноразовые пакеты: npm i -D sharp png-to-ico');
    process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const SRC = fs.existsSync(path.resolve(ROOT, '..', 'logo-omg.svg'))
    ? path.resolve(ROOT, '..', 'logo-omg.svg')
    : path.resolve(ROOT, '..', 'logo.svg');
const IMG = path.join(ROOT, 'assets', 'img');
const INDEX = path.join(ROOT, 'index.html');

/* Глиф — путь без белой подложки; evenodd обязателен: линзы очков — дырки */
const src = fs.readFileSync(SRC, 'utf8');
const GLYPH_D = src.match(/<path(?![^>]*fill="#fff")[^>]*\sd="([^"]+)"/)?.[1];
if (!GLYPH_D) throw new Error('Не найден путь глифа в ' + SRC);

const COLORS = {
    bg1: '#232338', bg2: '#15151f',
    accent1: '#7474ff', accent2: '#4f4fef',
    on: '#3fe08a', off: '#ff5a5a', busy: '#ffd479',
};

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">';
const glyph = (fill) => `<path d="${GLYPH_D}" fill="${fill}" fill-rule="evenodd"/>`;
const bgRect = (rx) =>
    `<defs>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${COLORS.bg1}"/><stop offset="1" stop-color="${COLORS.bg2}"/>` +
    `</linearGradient>` +
    `<linearGradient id="ac" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${COLORS.accent1}"/><stop offset="1" stop-color="${COLORS.accent2}"/>` +
    `</linearGradient>` +
    `</defs>` +
    `<rect width="512" height="512" rx="${rx}" fill="url(#bg)"/>`;

(async () => {
    fs.mkdirSync(IMG, { recursive: true });

    /* 1. Мастер-SVG для UI и прелоадера */
    fs.writeFileSync(path.join(IMG, 'logo.svg'), HEAD + bgRect(96) + glyph('url(#ac)') + '</svg>');
    console.log('logo.svg готов');

    /* 2. icon.ico: PNG каждого размера во временные файлы → ico */
    const icoSizes = [16, 24, 32, 48, 64, 128, 256];
    const tmpPngs = [];
    for (const size of icoSizes) {
        const tmp = path.join(IMG, `.ico-${size}.png`);
        await sharp(Buffer.from(HEAD + bgRect(96) + glyph('url(#ac)') + '</svg>'))
            .resize(size, size).png().toFile(tmp);
        tmpPngs.push(tmp);
    }
    fs.writeFileSync(path.join(IMG, 'icon.ico'), await pngToIco(tmpPngs));
    tmpPngs.forEach((p) => fs.unlinkSync(p));
    console.log('icon.ico готов');

    /* 3. Трей: сам глиф, окрашенный в цвет статуса; без фона и без масштабирования */
    for (const [name, color] of [['on', COLORS.on], ['off', COLORS.off], ['busy', COLORS.busy]]) {
        await sharp(Buffer.from(HEAD + glyph(color) + '</svg>'))
            .resize(32, 32).png().toFile(path.join(IMG, `tray-${name}.png`));
    }
    console.log('tray-on/off/busy.png готовы');

    /* 4. Инжект глифа в index.html (идемпотентно, между маркерами) */
    const START = '<!-- glyph:start -->', END = '<!-- glyph:end -->';
    const block = `${START}<g class="bl-glyph" fill="url(#blAc)"><path d="${GLYPH_D}" fill-rule="evenodd"/></g>${END}`;
    let html = fs.readFileSync(INDEX, 'utf8');
    if (html.includes(START) && html.includes(END)) {
        html = html.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block);
    } else if (/\.bl-glyph[^>]*?-->/.test(html) || /<path class="bl-glyph"[\s\S]*?\/>/.test(html)) {
        html = html.replace(/<path class="bl-glyph"[\s\S]*?\/>/, block);
    } else {
        throw new Error('В index.html не найдено место для глифа');
    }
    fs.writeFileSync(INDEX, html);
    console.log('index.html: глиф обновлён');

    /* 5. Превью-сетка (для визуальной проверки) */
    const previews = [];
    for (const svg of [
        HEAD + bgRect(96) + glyph('url(#ac)') + '</svg>',
        HEAD + glyph(COLORS.on) + '</svg>',
        HEAD + glyph(COLORS.off) + '</svg>',
        HEAD + glyph(COLORS.busy) + '</svg>',
    ]) {
        previews.push(await sharp(Buffer.from(svg)).resize(128, 128).png().toBuffer());
    }
    await sharp({ create: { width: 128 * 4 + 30, height: 128, channels: 4, background: { r: 40, g: 40, b: 60, alpha: 1 } } })
        .composite(previews.map((input, i) => ({ input, left: i * (128 + 10), top: 0 })))
        .png().toFile(path.join(IMG, 'icon-preview.png'));
    console.log('icon-preview.png готов (master, on, off, busy)');
})().catch((e) => { console.error(e); process.exit(1); });
