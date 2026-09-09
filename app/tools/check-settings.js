/*
 * Регрессионный тест: каждая галка из SETTINGS_IDS (js/app.js) обязана
 * существовать в DEFAULTS (store.js) с типом boolean.
 * Запуск: node tools/check-settings.js — падает с кодом 1 при ошибке.
 */
const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const block = appJs.match(/const SETTINGS_IDS = \{([\s\S]*?)\};/);
if (!block) { console.error('SETTINGS_IDS не найден'); process.exit(1); }

const keys = [...block[1].matchAll(/(?:'([^']+)'|([A-Za-z0-9_]+))\s*:\s*'([^']+)'/g)]
    .map((m) => m[1] || m[2]);
if (!keys.length) { console.error('Ключи не распознаны'); process.exit(1); }

const storeJs = fs.readFileSync(path.join(__dirname, '..', 'store.js'), 'utf8');
const defaultsSrc = storeJs.match(/const DEFAULTS = (\{[\s\S]*?\n\});/);
if (!defaultsSrc) { console.error('DEFAULTS не найден'); process.exit(1); }
const DEFAULTS = eval('(' + defaultsSrc[1] + ')');

let fail = 0;
for (const key of keys) {
    const value = key.split('.').reduce((acc, part) => (acc ? acc[part] : undefined), DEFAULTS);
    const ok = typeof value === 'boolean';
    if (!ok) { console.error(`✗ ${key}: нет в DEFAULTS или не boolean`); fail++; }
    else console.log(`✓ ${key}`);
}
console.log(fail ? `ОШИБОК: ${fail}` : 'Все галки из UI есть в DEFAULTS.');
process.exit(fail ? 1 : 0);
