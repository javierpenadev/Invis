/* Общие хелперы шаблона */
window.StringUtils = {
    escape: (str) => String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c))
};

window.DateUtils = {
    /* 'dd.mm.yyyy' -> Date */
    parse: (str) => {
        if (!str) return null;
        const parts = str.split('.');
        if (parts.length === 3) return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
        return null;
    },
    /* Date -> 'dd.mm.yyyy' */
    format: (d) => {
        if (!d) return '';
        return `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}.${d.getFullYear()}`;
    },
    /* Date -> 'yyyy-mm-dd' (значение для <input type="date">) */
    toInput: (d) => {
        if (!d) return '';
        return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
    }
};

window.UIHelpers = {
    /* Состояние "ожидания" для кнопок (пульсирующая анимация из style.css) */
    setButtonWaiting: (target, waiting) => {
        const button = typeof target === 'string' ? document.getElementById(target) : target;
        if (!button) return;
        button.disabled = !!waiting;
        button.classList.toggle('is-waiting', !!waiting);
        button.setAttribute('aria-busy', waiting ? 'true' : 'false');
    }
};
