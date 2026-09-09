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
            });
        }

        /* Настройки могли изменить из трея — синхронизируем форму */
        UIBridge.on('settings:changed', applySettingsToForm);
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
    const init = () => {
        CursorFx.init();
        initTitlebar();
        initModules();
        initSettings();
        initAbout();
        setStatus('Готов к работе');
        console.log('Invis UI запущен');
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    /* Публичный мини-апи (для будущей логики демонов) */
    window.InvisUI = { setStatus, setModuleState };
})();
