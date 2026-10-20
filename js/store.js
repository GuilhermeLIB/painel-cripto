// Estado persistido no navegador (localStorage) e regras da carteira.
window.App = window.App || {};

(function (App) {
    const KEY = 'cripto-dash:v1';
    const { uid, isIsoDate, bus } = App.util;

    const SMART_TABS = ['smart:portfolio', 'smart:discount', 'smart:alerts'];
    const LIST_COLORS = ['#6E8BFF', '#2FD5A0', '#E7B45A', '#FF6F61', '#4FB8D6', '#C77DFF', '#FF9F43', '#9AA3B5'];

    const defaults = () => ({
        version: 2,
        settings: {
            theme: 'auto',
            currency: 'BRL',
            privacy: false,
            timeframe: '1d',
            indicators: { sma: true, bb: false, volume: true, cross: true, buys: true, levels: true, fib: false },
            analysisList: null,
            marketPeriod: '30d',
            marketView: 'table',
            heatSize: 'volume',
        },
        lists: [{ id: 'obs', name: 'Observando', color: LIST_COLORS[0], symbols: [...App.coins.DEFAULT_WATCHLIST] }],
        tabs: ['obs', ...SMART_TABS],
        favoriteTab: 'obs',
        notes: {},
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
        monthly: {
            budgetBrl: 1500,
            weekday: 1,
            weeks: 'four',
            mode: 'all',
            minOrderUsd: 5,
            customWeights: false,
            assets: ['ETH', 'UNI', 'LINK', 'DOT', 'EIGEN', 'ENA', 'AAVE'].map((symbol) => ({ symbol, weight: 1 })),
            log: {},
            walletId: null,
        },
        wallets: [],
        walletSnapshots: {},
        web3Settings: { rpc: {}, blockscoutKey: '', customTokens: [], showSmall: false },
        pools: [],
        poolWatch: {},
        poolForm: null,
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
                ...migrateLists(parsed, base),
                notes: parsed.notes && typeof parsed.notes === 'object' ? parsed.notes : {},
                transactions: Array.isArray(parsed.transactions) ? parsed.transactions.filter(isValidTx).map(normalizeTx) : [],
                alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
                monthly: { ...base.monthly, ...parsed.monthly, log: { ...parsed.monthly?.log } },
                wallets: Array.isArray(parsed.wallets) ? parsed.wallets.filter((w) => w && (/^0x[0-9a-fA-F]{40}$/.test(w.address) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w.address))) : [],
                walletSnapshots: parsed.walletSnapshots && typeof parsed.walletSnapshots === 'object' ? parsed.walletSnapshots : {},
                web3Settings: { ...base.web3Settings, ...parsed.web3Settings, rpc: { ...parsed.web3Settings?.rpc } },
            };
        } catch (error) {
            console.error(error);
            return defaults();
        }
    }

    // Versão 1 tinha uma única lista ("watchlist"); ela vira a lista "Observando".
    function migrateLists(parsed, base) {
        let lists = Array.isArray(parsed.lists) ? parsed.lists.filter((l) => l && l.id && Array.isArray(l.symbols)) : null;
        if (!lists || !lists.length) {
            const symbols = Array.isArray(parsed.watchlist) && parsed.watchlist.length ? parsed.watchlist : base.lists[0].symbols;
            lists = [{ ...base.lists[0], symbols: [...symbols] }];
        }
        const ids = new Set([...lists.map((l) => l.id), ...SMART_TABS]);
        let tabs = Array.isArray(parsed.tabs) ? parsed.tabs.filter((t) => ids.has(t)) : [];
        [...lists.map((l) => l.id), ...SMART_TABS].forEach((id) => { if (!tabs.includes(id)) tabs.push(id); });
        const favoriteTab = tabs.includes(parsed.favoriteTab) ? parsed.favoriteTab : tabs[0];
        return { lists, tabs, favoriteTab };
    }

    const state = load();
    delete state.watchlist;
    // "watchlist" passa a ser a união das listas manuais (só leitura, não é salva).
    Object.defineProperty(state, 'watchlist', {
        enumerable: false,
        get() { return [...new Set(state.lists.flatMap((l) => l.symbols))]; },
    });
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
            walletId: tx.walletId ? String(tx.walletId) : null,
        };
    }

    function upsertTx(tx) {
        const record = normalizeTx(tx);
        const index = state.transactions.findIndex((t) => t.id === record.id);
        if (index >= 0) state.transactions[index] = record;
        else state.transactions.push(record);
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

    // ---- Listas ----
    function getList(id) {
        return state.lists.find((l) => l.id === id) ?? null;
    }

    function listsChanged() {
        commit('lists');
        bus.emit('watchlist', state.watchlist);
    }

    function createList(name, color) {
        const id = `l${uid()}`;
        state.lists.push({ id, name: name.trim().slice(0, 40) || 'Nova lista', color: color || LIST_COLORS[state.lists.length % LIST_COLORS.length], symbols: [] });
        state.tabs.splice(state.lists.length - 1, 0, id);
        listsChanged();
        return id;
    }

    function updateList(id, patch) {
        const list = getList(id);
        if (!list) return;
        if (patch.name !== undefined) list.name = patch.name.trim().slice(0, 40) || list.name;
        if (patch.color) list.color = patch.color;
        listsChanged();
    }

    function deleteList(id) {
        if (state.lists.length <= 1) return false;
        state.lists = state.lists.filter((l) => l.id !== id);
        state.tabs = state.tabs.filter((t) => t !== id);
        if (state.favoriteTab === id) state.favoriteTab = state.tabs[0];
        listsChanged();
        return true;
    }

    function setFavorite(tabId) {
        state.favoriteTab = tabId;
        listsChanged();
    }

    function moveTab(id, toIndex) {
        const from = state.tabs.indexOf(id);
        if (from < 0) return;
        state.tabs.splice(from, 1);
        state.tabs.splice(Math.max(0, Math.min(state.tabs.length, toIndex)), 0, id);
        listsChanged();
    }

    function addToList(listId, symbol) {
        const list = getList(listId);
        if (!list || list.symbols.includes(symbol)) return false;
        list.symbols.push(symbol);
        listsChanged();
        return true;
    }

    function removeFromList(listId, symbol) {
        const list = getList(listId);
        if (!list) return;
        list.symbols = list.symbols.filter((s) => s !== symbol);
        listsChanged();
    }

    function moveInList(listId, symbol, toIndex) {
        const list = getList(listId);
        if (!list) return;
        const from = list.symbols.indexOf(symbol);
        if (from < 0) return;
        list.symbols.splice(from, 1);
        list.symbols.splice(Math.max(0, Math.min(list.symbols.length, toIndex)), 0, symbol);
        listsChanged();
    }

    function listsOf(symbol) {
        return state.lists.filter((l) => l.symbols.includes(symbol)).map((l) => l.id);
    }

    // Compatibilidade: adiciona na lista favorita (ou na primeira manual).
    function addWatch(symbol) {
        const target = getList(state.favoriteTab) ?? state.lists[0];
        return addToList(target.id, symbol);
    }

    // ---- Anotações por cripto: preço que quero pagar e nota ----
    function setNote(symbol, { note, buyPrice }) {
        const clean = { note: String(note ?? '').trim().slice(0, 300), buyPrice: Number(buyPrice) > 0 ? Number(buyPrice) : null };
        if (!clean.note && !clean.buyPrice) delete state.notes[symbol];
        else state.notes[symbol] = { ...clean, updatedAt: Date.now() };
        commit('notes');
    }

    // ---- Carteiras Web3 (só endereços públicos) ----
    function saveWallet(wallet) {
        const clean = {
            id: wallet.id || `w${uid()}`,
            name: String(wallet.name || 'Carteira').trim().slice(0, 40),
            address: String(wallet.address).trim(),
            chains: Array.isArray(wallet.chains) ? wallet.chains : [],
            color: wallet.color || LIST_COLORS[state.wallets.length % LIST_COLORS.length],
        };
        const i = state.wallets.findIndex((w) => w.id === clean.id);
        if (i >= 0) state.wallets[i] = clean;
        else state.wallets.push(clean);
        commit('wallets');
        return clean;
    }

    function removeWallet(id) {
        state.wallets = state.wallets.filter((w) => w.id !== id);
        delete state.walletSnapshots[id];
        if (state.monthly.walletId === id) state.monthly.walletId = null;
        commit('wallets');
    }

    // Guarda o valor total a cada leitura (no máximo um ponto a cada 10 minutos, até 600 pontos).
    function addSnapshot(walletId, usd) {
        const list = state.walletSnapshots[walletId] || (state.walletSnapshots[walletId] = []);
        const now = Date.now();
        const last = list[list.length - 1];
        if (last && now - last.t < 10 * 60 * 1000) list[list.length - 1] = { t: now, usd };
        else list.push({ t: now, usd });
        if (list.length > 600) list.splice(0, list.length - 600);
        save();
    }

    function walletName(id) {
        return state.wallets.find((w) => w.id === id)?.name ?? null;
    }

    // ---- Alertas ----
    function addAlert(alert) {
        state.alerts.push({ id: uid(), createdAt: Date.now(), triggeredAt: null, ...alert });
        commit('alerts');
    }

    function removeAlert(id) {
        state.alerts = state.alerts.filter((a) => a.id !== id);
        commit('alerts');
    }

    // ---- Backup ----
    function exportData() {
        return JSON.stringify({ app: 'cripto-dashboard', exportedAt: new Date().toISOString(), ...state, watchlist: state.watchlist }, null, 2);
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
            Object.assign(state, migrateLists(p, base));
            state.notes = p.notes && typeof p.notes === 'object' ? p.notes : {};
            state.plan = { ...base.plan, ...p.plan, targets: { ...p.plan?.targets } };
            state.alerts = Array.isArray(p.alerts) ? p.alerts : [];
            state.monthly = { ...base.monthly, ...p.monthly, log: { ...p.monthly?.log } };
            state.wallets = Array.isArray(p.wallets) ? p.wallets : [];
            state.walletSnapshots = p.walletSnapshots ?? {};
            state.web3Settings = { ...base.web3Settings, ...p.web3Settings, rpc: { ...p.web3Settings?.rpc } };
            state.pools = Array.isArray(p.pools) ? p.pools : [];
            state.poolWatch = {};
            state.transactions = result.txs;
        } else {
            const known = new Set(state.transactions.map((t) => t.id));
            result.txs.forEach((tx) => {
                if (!known.has(tx.id)) state.transactions.push(tx);
            });
        }
        commit('transactions');
        bus.emit('lists', state);
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
        getList, createList, updateList, deleteList, setFavorite, moveTab,
        addToList, removeFromList, moveInList, listsOf, addWatch, setNote,
        SMART_TABS, LIST_COLORS,
        saveWallet, removeWallet, addSnapshot, walletName,
        addAlert, removeAlert,
        exportData, parseImport, applyImport, legacyToTx, legacyLocalData,
    };
})(window.App);
