// Estado persistido no navegador (localStorage) e regras da carteira.
window.App = window.App || {};

(function (App) {
    const KEY = 'cripto-dash:v1';
    const { uid, isIsoDate, bus } = App.util;

    const defaults = () => ({
        version: 1,
        settings: {
            theme: 'auto',
            currency: 'BRL',
            privacy: false,
            timeframe: '1d',
            indicators: { sma: true, bb: false, volume: true },
        },
        watchlist: [...App.coins.DEFAULT_WATCHLIST],
        transactions: [],
        plan: {
            budgetBrl: 500,
            frequency: 'weekly',
            weekday: 1,
            monthDay: 5,
            targets: {},
            useSignal: false,
        },
        alerts: [],
    });

    function load() {
        try {
            const raw = localStorage.getItem(KEY);
            if (!raw) return defaults();
            const parsed = JSON.parse(raw);
            const base = defaults();
            return {
                ...base,
                ...parsed,
                settings: { ...base.settings, ...parsed.settings, indicators: { ...base.settings.indicators, ...parsed.settings?.indicators } },
                plan: { ...base.plan, ...parsed.plan, targets: { ...parsed.plan?.targets } },
                watchlist: Array.isArray(parsed.watchlist) && parsed.watchlist.length ? parsed.watchlist : base.watchlist,
                transactions: Array.isArray(parsed.transactions) ? parsed.transactions.filter(isValidTx).map(normalizeTx) : [],
                alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
            };
        } catch (error) {
            console.error(error);
            return defaults();
        }
    }

    const state = load();
    let saveTimer = null;

    function save() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            try {
                localStorage.setItem(KEY, JSON.stringify(state));
            } catch (error) {
                console.error(error);
                App.util.toast('Não foi possível salvar no navegador. Exporte seus dados como backup.', 'bad');
            }
        }, 150);
    }

    function commit(event = 'change') {
        save();
        bus.emit(event, state);
        bus.emit('change', state);
    }

    // ---- Transações ----
    // Campos: asset, type (buy|sell), date, qty, priceUsd, totalUsd, totalBrl, fxRate, feeUsd, note.
    function isValidTx(tx) {
        return tx
            && typeof tx.asset === 'string' && /^[A-Z0-9]{1,15}$/.test(tx.asset)
            && (tx.type === 'buy' || tx.type === 'sell')
            && isIsoDate(tx.date)
            && Number(tx.qty) > 0
            && Number(tx.priceUsd) > 0;
    }

    function normalizeTx(tx) {
        const qty = Number(tx.qty);
        const priceUsd = Number(tx.priceUsd);
        const totalUsd = Number(tx.totalUsd) > 0 ? Number(tx.totalUsd) : qty * priceUsd;
        const fxRate = Number(tx.fxRate) > 0 ? Number(tx.fxRate) : null;
        return {
            id: String(tx.id || uid()),
            asset: tx.asset,
            type: tx.type,
            date: tx.date,
            qty,
            priceUsd,
            totalUsd,
            totalBrl: Number(tx.totalBrl) > 0 ? Number(tx.totalBrl) : (fxRate ? totalUsd * fxRate : null),
            fxRate,
            feeUsd: Number(tx.feeUsd) > 0 ? Number(tx.feeUsd) : 0,
            note: String(tx.note ?? '').slice(0, 200),
        };
    }

    function upsertTx(tx) {
        const record = normalizeTx(tx);
        const index = state.transactions.findIndex((t) => t.id === record.id);
        if (index >= 0) state.transactions[index] = record;
        else state.transactions.push(record);
        ensureWatched(record.asset);
        commit('transactions');
        return record;
    }

    function removeTx(id) {
        state.transactions = state.transactions.filter((t) => t.id !== id);
        commit('transactions');
    }

    // Posições pelo método do custo médio ponderado.
    function positions() {
        const map = new Map();
        const sorted = [...state.transactions].sort((a, b) => a.date.localeCompare(b.date) || (a.type === 'buy' ? -1 : 1));
        for (const tx of sorted) {
            if (!map.has(tx.asset)) {
                map.set(tx.asset, { asset: tx.asset, qty: 0, costUsd: 0, costBrl: 0, investedUsd: 0, investedBrl: 0, realizedUsd: 0, buys: 0, firstDate: tx.date });
            }
            const p = map.get(tx.asset);
            if (tx.type === 'buy') {
                p.qty += tx.qty;
                p.costUsd += tx.totalUsd + tx.feeUsd;
                p.costBrl += tx.totalBrl ?? 0;
                p.investedUsd += tx.totalUsd + tx.feeUsd;
                p.investedBrl += tx.totalBrl ?? 0;
                p.buys += 1;
            } else {
                const sellQty = Math.min(tx.qty, p.qty);
                const avg = p.qty > 0 ? p.costUsd / p.qty : 0;
                const avgBrl = p.qty > 0 ? p.costBrl / p.qty : 0;
                p.realizedUsd += sellQty * (tx.priceUsd - avg) - tx.feeUsd;
                p.costUsd -= sellQty * avg;
                p.costBrl -= sellQty * avgBrl;
                p.qty -= sellQty;
            }
        }
        return [...map.values()].map((p) => ({
            ...p,
            qty: p.qty < 1e-12 ? 0 : p.qty,
            avgUsd: p.qty > 1e-12 ? p.costUsd / p.qty : 0,
        }));
    }

    // ---- Lista de acompanhamento ----
    function ensureWatched(symbol) {
        if (!state.watchlist.includes(symbol)) {
            state.watchlist.push(symbol);
            bus.emit('watchlist', state.watchlist);
        }
    }

    function addWatch(symbol) {
        if (state.watchlist.includes(symbol)) return false;
        state.watchlist.push(symbol);
        commit('watchlist');
        return true;
    }

    function removeWatch(symbol) {
        state.watchlist = state.watchlist.filter((s) => s !== symbol);
        commit('watchlist');
    }

    function moveWatch(symbol, delta) {
        const i = state.watchlist.indexOf(symbol);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= state.watchlist.length) return;
        [state.watchlist[i], state.watchlist[j]] = [state.watchlist[j], state.watchlist[i]];
        commit('watchlist');
    }

    // ---- Alertas ----
    function addAlert(alert) {
        state.alerts.push({ id: uid(), createdAt: Date.now(), triggeredAt: null, ...alert });
        ensureWatched(alert.asset);
        commit('alerts');
    }

    function removeAlert(id) {
        state.alerts = state.alerts.filter((a) => a.id !== id);
        commit('alerts');
    }

    // ---- Backup ----
    function exportData() {
        return JSON.stringify({ app: 'cripto-dashboard', exportedAt: new Date().toISOString(), ...state }, null, 2);
    }

    // Aceita o backup deste app e o do dashboard antigo de Bitcoin (lista "contributions").
    function parseImport(text) {
        const payload = JSON.parse(text);
        if (payload?.app === 'cripto-dashboard') {
            const txs = (payload.transactions ?? []).filter(isValidTx).map(normalizeTx);
            return { kind: 'full', payload, txs, skipped: (payload.transactions?.length ?? 0) - txs.length };
        }
        if (Array.isArray(payload?.contributions)) {
            return { kind: 'legacy', ...legacyToTx(payload.contributions) };
        }
        if (Array.isArray(payload)) {
            return { kind: 'legacy', ...legacyToTx(payload) };
        }
        throw new Error('Formato não reconhecido');
    }

    function legacyToTx(list) {
        const txs = [];
        let skipped = 0;
        for (const item of list) {
            const price = Number(item.price);
            const amountUsd = Number(item.amountUsd) || (Number(item.amountBrl) && Number(item.fxRateUsed) ? Number(item.amountBrl) / Number(item.fxRateUsed) : 0);
            const qty = Number(item.btc) || (price && amountUsd ? amountUsd / price : 0);
            const tx = {
                id: `legacy-${item.id ?? uid()}`,
                asset: 'BTC',
                type: 'buy',
                date: item.date,
                qty,
                priceUsd: price,
                totalUsd: amountUsd,
                totalBrl: Number(item.amountBrl) || null,
                fxRate: Number(item.fxRateUsed) || null,
                note: 'Importado do Dashboard Bitcoin',
            };
            if (isValidTx(tx)) txs.push(normalizeTx(tx));
            else skipped += 1;
        }
        return { txs, skipped };
    }

    function applyImport(result, mode) {
        if (result.kind === 'full' && mode === 'replace') {
            const base = defaults();
            const p = result.payload;
            state.settings = { ...base.settings, ...p.settings };
            state.watchlist = Array.isArray(p.watchlist) && p.watchlist.length ? p.watchlist : base.watchlist;
            state.plan = { ...base.plan, ...p.plan, targets: { ...p.plan?.targets } };
            state.alerts = Array.isArray(p.alerts) ? p.alerts : [];
            state.transactions = result.txs;
        } else {
            const known = new Set(state.transactions.map((t) => t.id));
            result.txs.forEach((tx) => {
                if (!known.has(tx.id)) state.transactions.push(tx);
                ensureWatched(tx.asset);
            });
        }
        result.txs.forEach((tx) => ensureWatched(tx.asset));
        commit('transactions');
    }

    function legacyLocalData() {
        try {
            const raw = localStorage.getItem('btc-dca-contributions');
            const list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) && list.length ? list : null;
        } catch {
            return null;
        }
    }

    App.store = {
        state, save, commit,
        upsertTx, removeTx, positions,
        addWatch, removeWatch, moveWatch,
        addAlert, removeAlert,
        exportData, parseImport, applyImport, legacyToTx, legacyLocalData,
    };
})(window.App);
