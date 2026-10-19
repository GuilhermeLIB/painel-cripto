// Utilidades compartilhadas: formatação, datas, DOM e eventos.
window.App = window.App || {};

(function (App) {
    const locale = 'pt-BR';

    const fmtCache = new Map();
    function nf(options) {
        const key = JSON.stringify(options);
        if (!fmtCache.has(key)) {
            fmtCache.set(key, new Intl.NumberFormat(locale, options));
        }
        return fmtCache.get(key);
    }

    function priceDigits(value) {
        const abs = Math.abs(value);
        if (abs >= 1000) return 2;
        if (abs >= 1) return 2;
        if (abs >= 0.01) return 4;
        if (abs >= 0.0001) return 6;
        return 8;
    }

    const fmt = {
        money(value, currency = 'USD', digits = null) {
            if (value === null || value === undefined || !Number.isFinite(value)) return '—';
            const d = digits ?? priceDigits(value);
            return nf({ style: 'currency', currency, minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d }).format(value);
        },
        compactMoney(value, currency = 'USD') {
            if (!Number.isFinite(value)) return '—';
            return nf({ style: 'currency', currency, notation: 'compact', maximumFractionDigits: 2 }).format(value);
        },
        number(value, digits = 2) {
            if (!Number.isFinite(value)) return '—';
            return nf({ maximumFractionDigits: digits }).format(value);
        },
        qty(value) {
            if (!Number.isFinite(value)) return '—';
            const abs = Math.abs(value);
            const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
            return nf({ maximumFractionDigits: digits }).format(value);
        },
        pct(value, digits = 2) {
            if (!Number.isFinite(value)) return '—';
            const sign = value > 0 ? '+' : value < 0 ? '−' : '';
            return `${sign}${nf({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Math.abs(value))}%`;
        },
        signedMoney(value, currency = 'USD') {
            if (!Number.isFinite(value)) return '—';
            const sign = value > 0 ? '+' : value < 0 ? '−' : '';
            return `${sign}${fmt.money(Math.abs(value), currency, 2)}`;
        },
        date(iso) {
            if (!iso) return '—';
            const [y, m, d] = iso.split('-').map(Number);
            return new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(new Date(y, m - 1, d));
        },
        dateLong(date) {
            return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
        },
        time(date) {
            return new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(date);
        },
    };

    function toneOf(value, neutralBand = 0) {
        if (!Number.isFinite(value) || Math.abs(value) <= neutralBand) return 'flat';
        return value > 0 ? 'up' : 'down';
    }

    // Datas: "dia local" no formato AAAA-MM-DD.
    function localIso(date = new Date()) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function parseIso(iso) {
        const [y, m, d] = iso.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    function utcDay(ms) {
        return new Date(ms).toISOString().slice(0, 10);
    }

    function isIsoDate(value) {
        return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseIso(value).getTime());
    }

    function addDays(iso, days) {
        const date = parseIso(iso);
        date.setDate(date.getDate() + days);
        return localIso(date);
    }

    function uid() {
        return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Template literal que escapa interpolações; use raw() para HTML confiável.
    class Raw {
        constructor(value) { this.value = value; }
    }
    function raw(value) { return new Raw(value); }
    function html(strings, ...values) {
        return strings.reduce((out, str, i) => {
            if (i >= values.length) return out + str;
            const v = values[i];
            let piece;
            if (v instanceof Raw) piece = v.value;
            else if (Array.isArray(v)) piece = v.map((item) => (item instanceof Raw ? item.value : escapeHtml(item))).join('');
            else piece = escapeHtml(v);
            return out + str + piece;
        }, '');
    }

    function $(selector, root = document) { return root.querySelector(selector); }
    function $$(selector, root = document) { return Array.from(root.querySelectorAll(selector)); }

    function debounce(fn, ms) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), ms);
        };
    }

    // Pequeno barramento de eventos.
    const listeners = new Map();
    const bus = {
        on(event, fn) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event).add(fn);
            return () => listeners.get(event)?.delete(fn);
        },
        emit(event, payload) {
            listeners.get(event)?.forEach((fn) => {
                try { fn(payload); } catch (error) { console.error(error); }
            });
        },
    };

    function toast(message, tone = 'info', timeout = 4200) {
        let host = $('#toasts');
        if (!host) {
            host = document.createElement('div');
            host.id = 'toasts';
            host.setAttribute('aria-live', 'polite');
            document.body.appendChild(host);
        }
        const el = document.createElement('div');
        el.className = `toast toast-${tone}`;
        el.textContent = message;
        host.appendChild(el);
        setTimeout(() => {
            el.classList.add('is-leaving');
            setTimeout(() => el.remove(), 300);
        }, timeout);
    }

    App.util = { fmt, toneOf, localIso, parseIso, utcDay, isIsoDate, addDays, uid, escapeHtml, html, raw, $, $$, debounce, bus, toast };
})(window.App);
