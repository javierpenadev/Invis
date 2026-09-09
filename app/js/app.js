/*
 * Invis UI: тайтлбар, строки модулей, настройки, статус в контрол-баре.
 * Логика демонов подключается позже (ТЗ фаза 1) — пока IPC-заглушки в main.js.
 */
(function () {
    let isMax = false;

    const $ = (sel) => document.querySelector(sel);

    /* ---------- статус и прогресс в контрол-баре ---------- */
    const setStatus = (text, { progress = null, error = false } = {}) => {
        const wrap = $('#progressWrap');
        const idle = $('#idleText');
        if (progress === null) {
            wrap?.classList.add('is-hidden');
            if (idle) idle.textContent = text;
            return;
        }
        wrap?.classList.remove('is-hidden');
        idle?.classList.add('is-hidden');
        const fill = $('#progressFill');
        if (fill) fill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
        const status = $('#statusText');
        if (status) { status.textContent = text; status.classList.toggle('error', error); }
    };

    /* ---------- состояние модулей (dot в строке + чип внизу) ---------- */
    const MODULES = {
        dnscrypt: { chip: 'chipDnscrypt', label: 'DNS', dot: 'dotDnscrypt', status: 'statusDnscrypt' },
        tor: { chip: 'chipTor', label: 'TOR', dot: 'dotTor', status: 'statusTor' },
        i2p: { chip: 'chipI2p', label: 'I2P', dot: 'dotI2p', status: 'statusI2p' },
    };

    /* state: 'off' | 'busy' | 'on' | 'error' */
    const setModuleState = (name, state, statusText) => {
        const m = MODULES[name];
        if (!m) return;
        $(`#${m.dot}`)?.classList.toggle('is-on', state === 'on');
        $(`#${m.dot}`)?.classList.toggle('is-busy', state === 'busy');
        $(`#${m.dot}`)?.classList.toggle('is-error', state === 'error');
        const chip = $(`#${m.chip}`);
        if (chip) {
            chip.textContent = `${m.label} · ${statusText || { off: '—', busy: '…', on: 'ok', error: 'ошибка' }[state]}`;
            chip.classList.toggle('is-on', state === 'on');
            chip.classList.toggle('is-busy', state === 'busy');
            chip.classList.toggle('is-error', state === 'error');
        }
        if (statusText !== undefined) {
            const el = $(`#${m.status}`);
            if (el) el.textContent = statusText;
        }
        $(`[data-module="${name}"]`)?.classList.toggle('is-on', state === 'on');
    };

    /* ---------- тайтлбар ---------- */
    const updateMaxIcon = () => {
        const m = document.querySelector('.maximize svg');
        if (m) m.innerHTML = isMax
            ? '<rect x="2" y="2" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.5"/>'
            : '<rect x="1" y="1" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5"/>';
    };

    const initTitlebar = () => {
        $('.minimize')?.addEventListener('click', () => UIBridge.send('window-minimize'));
        $('.maximize')?.addEventListener('click', () => { UIBridge.send('window-maximize'); isMax = !isMax; updateMaxIcon(); });
        $('.devtools')?.addEventListener('click', () => UIBridge.send('window-devtools'));
        $('.close')?.addEventListener('click', () => UIBridge.send('window-close'));
    };

    /* ---------- настройки ---------- */
    const SETTINGS_IDS = {
        launchWithWindows: 'setLaunchWithWindows',
        closeToTray: 'setCloseToTray',
        systemDns: 'setSystemDns',
        autoUpdate: 'setAutoUpdate',
        'dnscrypt.autoMode': 'setDnscryptAuto',
        'dnscrypt.requireDnssec': 'fltRequireDnssec',
        'dnscrypt.requireNolog': 'fltRequireNolog',
        'dnscrypt.requireNofilter': 'fltRequireNofilter',
        'dnscrypt.dnscryptProto': 'fltDnscryptProto',
        'dnscrypt.dohProto': 'fltDohProto',
        'dnscrypt.cache': 'setCache',
        'dnscrypt.blockIpv6': 'setBlockIpv6',
        'dnscrypt.forceTcp': 'setForceTcp',
        'dnscrypt.lanAccess': 'setLanAccess',
        'dnscrypt.queryLog': 'setQueryLog',
        'dnscrypt.blockBrowserDoh': 'setBlockBrowserDoh',
        'dnscrypt.presets.ads': 'presetAds',
        'dnscrypt.presets.malware': 'presetMalware',
        'tor.useBridges': 'setUseBridges',
        'autostart.dnscrypt': 'setAutoDnscrypt',
        'autostart.tor': 'setAutoTor',
        'autostart.i2p': 'setAutoI2p',
    };

    const applySettingsToForm = (s) => {
        for (const [key, id] of Object.entries(SETTINGS_IDS)) {
            const value = key.split('.').reduce((acc, part) => acc?.[part], s);
            const input = document.getElementById(id);
            if (input && typeof value === 'boolean') input.checked = value;
        }
    };

    const initSettings = async () => {
        const current = await UIBridge.invoke('settings:get');
        if (current) applySettingsToForm(current);

        for (const [key, id] of Object.entries(SETTINGS_IDS)) {
            document.getElementById(id)?.addEventListener('change', (e) => {
                const patch = {};
                const parts = key.split('.');
                if (parts.length === 1) patch[parts[0]] = e.target.checked;
                else patch[parts[0]] = { [parts[1]]: e.target.checked };
                UIBridge.invoke('settings:set', patch);
                if (key === 'autoUpdate' && e.target.checked) UIBridge.send('update:check');
            });
        }

        /* Настройки могли изменить из трея — синхронизируем форму */
        UIBridge.on('settings:changed', (s) => {
            applySettingsToForm(s);
            syncResolverSelection(s);
        });
    };

    /* ---------- модули: состояния приходят из main (DaemonSupervisor) ---------- */
    const moduleStates = { dnscrypt: 'off', tor: 'off', i2p: 'off' };

    /* Текст статуса модуля: из события или дефолт по состоянию */
    const DEFAULT_STATUS = { off: 'остановлен', busy: 'запуск…', on: 'работает', error: 'ошибка' };
    const statusText = {};

    const applyModuleState = (name, state, text) => {
        moduleStates[name] = state;
        if (text !== undefined && text !== null) statusText[name] = text;
        InvisUI.setModuleState(name, state, statusText[name] || DEFAULT_STATUS[state]);
        /* подпись кнопки Пуск/Стоп в строке модуля */
        const btn = document.querySelector(`.module-toggle[data-module="${name}"]`);
        if (btn) btn.textContent = (state === 'on' || state === 'busy') ? 'Стоп' : 'Пуск';
        updateModuleButtons();
        updateAggregate();
    };

    /* Сводный статус в контрол-баре */
    const NAMES = { dnscrypt: 'DNSCrypt', tor: 'Tor', i2p: 'I2P' };
    const updateAggregate = () => {
        const active = Object.entries(moduleStates).filter(([, s]) => s !== 'off');
        if (!active.length) { InvisUI.setStatus('Готов к работе'); return; }
        const parts = active.map(([n]) => `${NAMES[n]} ${statusText[n] || DEFAULT_STATUS[moduleStates[n]]}`);
        InvisUI.setStatus(parts.join(' · '));
    };

    /* Кнопки Пуск/Стоп: текст и доступность по состоянию модулей */
    const updateModuleButtons = () => {
        const start = $('#startAllBtn'), stop = $('#stopAllBtn');
        if (!start || !stop) return;
        const states = Object.values(moduleStates);
        const busy = states.includes('busy');
        const running = states.filter((s) => s === 'on').length;
        const allOn = running === states.length;
        const allOff = states.every((s) => s === 'off');
        if (busy) {
            start.textContent = '⏳ Запуск…'; start.disabled = true;
            stop.textContent = 'Остановить'; stop.disabled = false;
        } else if (allOn) {
            start.textContent = '✓ Запущено'; start.disabled = true;
            stop.textContent = 'Остановить'; stop.disabled = false;
        } else if (allOff) {
            start.textContent = '⚡ Запустить всё'; start.disabled = false;
            stop.textContent = 'Остановлено'; stop.disabled = true;
        } else {
            start.textContent = '⚡ Запустить всё'; start.disabled = false;
            stop.textContent = 'Остановить'; stop.disabled = false;
        }
    };

    /* ---------- резольверы ---------- */
    const resolverState = { list: [], loaded: false, selected: new Set() };

    const resolverVisible = () => {
        const q = ($('#resolverSearch')?.value || '').toLowerCase();
        const wantDnssec = $('#fltRequireDnssec')?.checked;
        const wantNolog = $('#fltRequireNolog')?.checked;
        const wantNofilter = $('#fltRequireNofilter')?.checked;
        const allowDnscryptProto = $('#fltDnscryptProto')?.checked;
        const allowDoh = $('#fltDohProto')?.checked;
        return resolverState.list.filter((r) => {
            if (q && !(`${r.name} ${r.description}`.toLowerCase().includes(q))) return false;
            if (wantDnssec && !r.dnssec) return false;
            if (wantNolog && !r.nolog) return false;
            if (wantNofilter && !r.nofilter) return false;
            if (allowDnscryptProto && r.protos.includes('DNSCrypt')) return true;
            if (allowDoh && r.protos.includes('DoH')) return true;
            return !(allowDnscryptProto || allowDoh);
        });
    };

    const renderResolverList = () => {
        const box = $('#resolverList');
        if (!box) return;
        const visible = resolverVisible();
        const cap = 300;
        box.innerHTML = '';
        for (const r of visible.slice(0, cap)) {
            const row = document.createElement('label');
            row.className = 'resolver-row';
            const badges = [
                r.protos.join('/'),
                r.dnssec ? 'DNSSEC' : null,
                r.nolog ? 'NOLOG' : null,
                r.nofilter ? 'NOFILTER' : null,
            ].filter(Boolean).join(' · ');
            row.innerHTML = `<input type="checkbox" ${resolverState.selected.has(r.name) ? 'checked' : ''}>`
                + `<span class="resolver-name" title="${StringUtils.escape(r.description)}">${StringUtils.escape(r.name)}</span>`
                + `<span class="hint resolver-props">${StringUtils.escape(badges)}</span>`;
            row.querySelector('input').addEventListener('change', (e) => {
                e.target.checked ? resolverState.selected.add(r.name) : resolverState.selected.delete(r.name);
                UIBridge.invoke('settings:set', { dnscrypt: { autoMode: false, servers: [...resolverState.selected] } });
                updateResolverInfo(visible.length);
            });
            box.appendChild(row);
        }
        updateResolverInfo(visible.length);
    };

    const updateResolverInfo = (shown) => {
        const el = $('#resolverInfo');
        if (el) el.textContent = `выбрано ${resolverState.selected.size} · показано ${Math.min(shown, 300)} из ${resolverState.list.length}`;
    };

    const syncResolverSelection = (s) => {
        resolverState.selected = new Set(s?.dnscrypt?.servers || []);
        renderResolverList();
        const controls = $('#resolverControls');
        if (controls) controls.classList.toggle('is-hidden', Boolean(s?.dnscrypt?.autoMode));
        const auto = $('#setDnscryptAuto');
        if (auto) auto.checked = Boolean(s?.dnscrypt?.autoMode);
    };

    const initResolvers = async () => {
        const r = await UIBridge.invoke('resolvers:list');
        if (r && r.ok) { resolverState.list = r.list; resolverState.loaded = true; }
        const info = $('#resolverInfo');
        if (info && !resolverState.loaded) info.textContent = r?.error || 'Список недоступен';

        $('#resolverSearch')?.addEventListener('input', renderResolverList);
        for (const id of ['fltRequireDnssec', 'fltRequireNolog', 'fltRequireNofilter', 'fltDohProto', 'fltDnscryptProto']) {
            document.getElementById(id)?.addEventListener('change', renderResolverList);
        }
        /* фильтры-галки одновременно являются require_* настройками dnscrypt */
        for (const [key, id] of [['dnscrypt.requireDnssec', 'fltRequireDnssec'],
                                 ['dnscrypt.requireNolog', 'fltRequireNolog'],
                                 ['dnscrypt.requireNofilter', 'fltRequireNofilter'],
                                 ['dnscrypt.dnscryptProto', 'fltDnscryptProto'],
                                 ['dnscrypt.dohProto', 'fltDohProto']]) {
            document.getElementById(id)?.addEventListener('change', (e) => {
                UIBridge.invoke('settings:set', { dnscrypt: { [key.split('.')[1]]: e.target.checked } });
            });
        }
        $('#setDnscryptAuto')?.addEventListener('change', (e) => {
            $('#resolverControls')?.classList.toggle('is-hidden', e.target.checked);
            UIBridge.invoke('settings:set', { dnscrypt: { autoMode: e.target.checked } });
        });
        $('#setBootstrap')?.addEventListener('change', (e) => {
            const list = e.target.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
            if (list.length) UIBridge.invoke('settings:set', { dnscrypt: { bootstrap: list } });
        });
        syncResolverSelection(await UIBridge.invoke('settings:get'));
    };

    /* ---------- адаптеры перехвата DNS ---------- */
    const renderAdapters = (s, list) => {
        const box = $('#adapterList');
        if (!box) return;
        const selected = new Set(s?.systemDnsAdapters || []);
        box.innerHTML = '';
        if (!list || !list.length) {
            box.innerHTML = '<span class="hint">Нет активных адаптеров</span>';
            return;
        }
        for (const name of list) {
            const label = document.createElement('label');
            label.className = 'check-row';
            label.innerHTML = `<input type="checkbox" ${selected.has(name) ? 'checked' : ''}> ${StringUtils.escape(name)}`;
            label.querySelector('input').addEventListener('change', (e) => {
                e.target.checked ? selected.add(name) : selected.delete(name);
                UIBridge.invoke('settings:set', { systemDnsAdapters: [...selected] });
            });
            box.appendChild(label);
        }
    };

    const initAdapters = async () => {
        const r = await UIBridge.invoke('adapters:list');
        const current = await UIBridge.invoke('settings:get');
        renderAdapters(current, r && r.ok ? r.list : []);
        UIBridge.on('settings:changed', (s) => renderAdapters(s, r && r.ok ? r.list : []));
    };

    /* ---------- лог запросов ---------- */
    const initQueryLog = () => {
        const view = $('#qlView');
        const info = $('#qlInfo');
        let filter = '';
        let timer = null;

        const refresh = async () => {
            if (!$('#setQueryLog')?.checked) return;
            const r = await UIBridge.invoke('querylog:get', { filter });
            if (view) view.textContent = r.lines.length ? r.lines.join('\n') : 'Лог пуст';
            if (info) info.textContent = `${r.total} записей`;
        };

        $('#setQueryLog')?.addEventListener('change', (e) => {
            if (e.target.checked) { refresh(); if (!timer) timer = setInterval(refresh, 2000); }
            else if (timer) { clearInterval(timer); timer = null; view.textContent = 'Лог пуст'; info.textContent = ''; }
        });
        $('#qlRefreshBtn')?.addEventListener('click', refresh);
        $('#qlClearBtn')?.addEventListener('click', async () => {
            UIBridge.send('querylog:clear');
            setTimeout(refresh, 200);
        });
        $('#qlFilter')?.addEventListener('input', (e) => {
            filter = e.target.value.trim();
            clearTimeout(initQueryLog._t);
            initQueryLog._t = setTimeout(refresh, 300);
        });
    };

    const initModules = async () => {
        for (const btn of document.querySelectorAll('.module-toggle')) {
            btn.addEventListener('click', () => UIBridge.send('modules:toggle', btn.dataset.module));
        }
        $('#startAllBtn')?.addEventListener('click', () => UIBridge.send('modules:start-all'));
        $('#stopAllBtn')?.addEventListener('click', () => UIBridge.send('modules:stop-all'));

        UIBridge.on('modules:state', ({ name, state, status }) => applyModuleState(name, state, status));

        /* Восстановить статусы при повторном открытии окна */
        const current = await UIBridge.invoke('modules:status');
        if (current) {
            for (const [name, st] of Object.entries(current)) applyModuleState(name, st.state, st.status);
        }
    };

    /* ---------- «О программе» ---------- */
    const initAbout = async () => {
        const el = $('#aboutText');
        if (!el) return;
        try {
            const info = await UIBridge.invoke('app:info');
            if (!info) { el.textContent = 'Invis'; return; }
            el.innerHTML = `Invis <b>v${StringUtils.escape(info.version)}</b> · Electron ${StringUtils.escape(info.electron)}<br>`
                + `Демоны: Tor ${StringUtils.escape(info.daemons.tor)} (BSD-3) · `
                + `dnscrypt-proxy ${StringUtils.escape(info.daemons.dnscrypt)} (ISC) · `
                + `i2pd ${StringUtils.escape(info.daemons.i2pd)} (BSD-3)<br>`
                + `Лицензия Invis: <b>GPL-3.0</b>. Тексты лицензий сторонних компонентов — `
                + `<code>THIRD-PARTY-LICENSES.md</code> в каталоге приложения.`;
        } catch (e) {
            el.textContent = 'Invis';
        }
    };

    /* ---------- инициализация ---------- */
    /* ---------- вкладки ---------- */
    const initTabs = () => {
        const btns = document.querySelectorAll('.tab-btn');
        const activate = (id) => {
            document.querySelectorAll('.tab-page').forEach((p) => p.classList.toggle('active', p.dataset.page === id));
            btns.forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
            try { localStorage.setItem('invis-tab', id); } catch (e) { /* приватный режим */ }
        };
        btns.forEach((b) => b.addEventListener('click', () => activate(b.dataset.tab)));
        let saved = 'modules';
        try { saved = localStorage.getItem('invis-tab') || 'modules'; } catch (e) { /* ignore */ }
        activate(document.querySelector(`.tab-page[data-page="${saved}"]`) ? saved : 'modules');
    };

    /* ---------- Tor: мосты, NEWNYM, диагностика ---------- */
    const syncTorBlock = (s) => {
        const on = Boolean(s?.tor?.useBridges);
        $('#bridgesBlock')?.classList.toggle('is-hidden', !on);
        const ta = $('#setBridges');
        if (ta && document.activeElement !== ta) ta.value = s?.tor?.bridgesText || '';
        const mins = $('#setNewIpMinutes');
        if (mins && document.activeElement !== mins) mins.value = s?.tor?.newIpMinutes || 0;
    };

    const initTor = async () => {
        const current = await UIBridge.invoke('settings:get');
        if (current) syncTorBlock(current);
        UIBridge.on('settings:changed', syncTorBlock);

        $('#setBridges')?.addEventListener('change', (e) => {
            UIBridge.invoke('settings:set', { tor: { bridgesText: e.target.value } });
        });
        $('#fetchBridgesBtn')?.addEventListener('click', async () => {
            const btn = $('#fetchBridgesBtn');
            UIHelpers.setButtonWaiting(btn, true);
            const ta = $('#setBridges');
            const r = await UIBridge.invoke('bridges:fetch', 'obfs4');
            UIHelpers.setButtonWaiting(btn, false);
            if (!r || !r.ok) {
                TemplateUI.setStatus(r?.error || 'Не удалось получить мосты', { error: true });
                return;
            }
            if (ta) {
                const existing = ta.value.trim().split(/\r?\n/).filter(Boolean);
                const merged = [...new Set([...existing, ...r.lines])].join('\n');
                ta.value = merged;
                UIBridge.invoke('settings:set', { tor: { bridgesText: merged } });
            }
            TemplateUI.setStatus(`Получено мостов: ${r.lines.length}`);
        });
        $('#setNewIpMinutes')?.addEventListener('change', (e) => {
            const n = Math.max(0, Math.round(Number(e.target.value) || 0));
            e.target.value = n;
            UIBridge.invoke('settings:set', { tor: { newIpMinutes: n } });
        });
        $('#torNewIpBtn')?.addEventListener('click', () => {
            TemplateUI.setStatus('Tor: запрашиваем новый IP…');
            UIBridge.send('tor:newip');
        });
        UIBridge.on('modules:event', ({ text }) => TemplateUI.setStatus(text));
    };

    const initDiag = () => {
        const box = $('#diagBox');
        $('#diagBtn')?.addEventListener('click', async () => {
            if (box) { box.classList.remove('is-hidden'); box.textContent = 'Проверяю…'; }
            const r = await UIBridge.invoke('diag:run');
            if (box && r) {
                const line = (label, v) =>
                    `<span class="${v.ok ? 'log-info' : 'log-error'}">${v.ok ? '✓' : '✗'} ${label}</span>: ${StringUtils.escape(v.detail || '')}`;
                box.innerHTML = [
                    line('DNSCrypt', r.dns),
                    line('Tor', r.tor),
                    line('I2P', r.i2p),
                    line('Ваш реальный IP', r.realIp),
                    line('IP через Tor', r.torIp),
                ].join('<br>');
            }
        });
        $('#i2pConsoleBtn')?.addEventListener('click', () => UIBridge.send('open:console-i2p'));
        $('#logsFolderBtn')?.addEventListener('click', () => UIBridge.send('open:logs'));
    };

    /* ---------- авто-обновление ---------- */
    const initUpdate = async () => {
        const badge = $('#updateBadge'), text = $('#updateText'), btn = $('#updateBtn');
        const verEl = $('#brandVersion');
        const cur = { available: false, version: null, downloading: false, percent: 0, readyToInstall: false };

        const render = () => {
            if (cur.downloading) {
                badge?.classList.remove('is-hidden');
                if (text) text.textContent = 'Скачивание…';
                if (btn) { btn.textContent = `${cur.percent}%`; btn.disabled = true; }
                return;
            }
            if (cur.available && cur.version) {
                badge?.classList.remove('is-hidden');
                if (text) text.textContent = `Доступна v${cur.version}`;
                if (btn) {
                    btn.disabled = Boolean(cur.readyToInstall);
                    btn.textContent = cur.readyToInstall ? 'Установка…' : 'Обновить';
                }
                return;
            }
            badge?.classList.add('is-hidden');
        };

        const info = await UIBridge.invoke('app:info');
        if (verEl && info) verEl.textContent = `v${info.version}`;

        const st0 = await UIBridge.invoke('update:state');
        if (st0) {
            cur.available = st0.available; cur.version = st0.version;
            render();
        }

        UIBridge.on('update:available', (d) => {
            cur.available = true; cur.version = d.version;
            render();
            TemplateUI.setStatus('Доступна новая версия Invis — можно обновить');
        });
        UIBridge.on('update:progress', (d) => {
            if (d.error) {
                TemplateUI.setStatus(`Ошибка обновления: ${d.error}`, { error: true });
                cur.downloading = false; render();
                return;
            }
            cur.downloading = true; cur.percent = d.percent; render();
        });
        UIBridge.on('update:downloaded', () => {
            cur.downloading = false; cur.readyToInstall = true; render();
            TemplateUI.setStatus('Обновление скачано — приложение перезапустится и установит его');
        });
        btn?.addEventListener('click', () => UIBridge.send('update:install'));
    };

    const init = () => {
        CursorFx.init();
        initTitlebar();
        initTabs();
        initModules();
        initSettings();
        initAbout();
        initResolvers();
        initAdapters();
        initQueryLog();
        initUpdate();
        initTor();
        initDiag();
        setStatus('Готов к работе');
        console.log('Invis UI запущен');
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    /* Публичный мини-апи (для будущей логики демонов) */
    window.InvisUI = { setStatus, setModuleState };
})();
