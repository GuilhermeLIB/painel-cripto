// Casca da aplicação: preços ao vivo, câmbio, roteamento, busca e preferências.
window.App = window.App || {};

(function (App) {
    const { $, $$, html, raw, fmt, bus, toast, debounce, escapeHtml } = App.util;
    const store = App.store;
    const S = store.state;

    // ---------- Preços ao vivo ----------
    const live = {
        prices: {},
        fx: null,
        fxAt: null,
    };
    App.live = live;

    const tickerStream = App.api.createStream('tickers');
    let pendingEmit = null;

    function trackedSymbols() {
        const held = store.positions().filter((p) => p.qty > 0).map((p) => p.asset);
        const alerted = S.alerts.filter((a) => !a.triggeredAt).map((a) => a.asset);
        return [...new Set([...S.watchlist, ...held, ...alerted, ...(App.extraSymbols ?? [])])];
    }

    function emitPricesSoon() {
        if (pendingEmit) return;
        pendingEmit = setTimeout(() => {
            pendingEmit = null;
            bus.emit('prices', live.prices);
            checkAlerts();
        }, 800);
    }

    tickerStream.onMessage((msg) => {
        if (msg.e !== '24hrMiniTicker') return;
        const close = Number(msg.c);
        const open = Number(msg.o);
        if (msg.s === 'USDTBRL') {
            live.fx = close;
            live.fxAt = Date.now();
        } else {
            const symbol = msg.s.replace(/USDT$/, '');
            live.prices[symbol] = {
                ...live.prices[symbol],
                price: close,
                open,
                high: Number(msg.h),
                low: Number(msg.l),
                quoteVolume: Number(msg.q),
                changePct: open ? ((close - open) / open) * 100 : 0,
            };
        }
        emitPricesSoon();
    });

    async function refreshPrices() {
        const symbols = trackedSymbols();
        try {
            const [quotes, fx] = await Promise.all([App.api.tickers(symbols), App.api.fxNow()]);
            Object.assign(live.prices, quotes);
            live.fx = fx;
            live.fxAt = Date.now();
            bus.emit('prices', live.prices);
            checkAlerts();
        } catch (error) {
            console.error(error);
            toast('Não consegui buscar as cotações. Verifique a conexão; vou tentar de novo.', 'bad');
        }
        tickerStream.set([...symbols.map((s) => `${s.toLowerCase()}usdt@miniTicker`), 'usdtbrl@miniTicker']);
    }
    App.refreshPrices = debounce(refreshPrices, 300);

    // ---------- Moeda e privacidade ----------
    function money(usd, { digits = null, priv = false, compact = false } = {}) {
        if (priv && S.settings.privacy) return '•••••';
        if (!Number.isFinite(usd)) return '—';
        if (S.settings.currency === 'BRL') {
            if (!live.fx) return '—';
            return compact ? fmt.compactMoney(usd * live.fx, 'BRL') : fmt.money(usd * live.fx, 'BRL', digits);
        }
        return compact ? fmt.compactMoney(usd, 'USD') : fmt.money(usd, 'USD', digits);
    }
    function signedMoney(usd, { priv = false } = {}) {
        if (priv && S.settings.privacy) return '•••••';
        if (S.settings.currency === 'BRL') return live.fx ? fmt.signedMoney(usd * live.fx, 'BRL') : '—';
        return fmt.signedMoney(usd, 'USD');
    }
    App.money = money;
    App.signedMoney = signedMoney;
    App.priceOf = (symbol) => live.prices[symbol]?.price ?? null;

    // ---------- Alertas ----------
    let notifyAsked = false;
    function checkAlerts() {
        let fired = false;
        S.alerts.forEach((alert) => {
            if (alert.triggeredAt) return;
            const price = live.prices[alert.asset]?.price;
            if (!price) return;
            const hit = alert.condition === 'above' ? price >= alert.price : price <= alert.price;
            if (!hit) return;
            alert.triggeredAt = Date.now();
            alert.triggeredPrice = price;
            fired = true;
            const text = `${alert.asset} ${alert.condition === 'above' ? 'subiu acima de' : 'caiu abaixo de'} ${fmt.money(alert.price)} (agora ${fmt.money(price)})`;
            toast(text, alert.condition === 'above' ? 'up' : 'down', 9000);
            if ('Notification' in window && Notification.permission === 'granted') {
                try { new Notification('Alerta de preço', { body: text }); } catch { /* ignorado */ }
            }
        });
        if (fired) store.commit('alerts');
    }
    App.askNotifications = async () => {
        if (!('Notification' in window) || notifyAsked) return;
        notifyAsked = true;
        if (Notification.permission === 'default') {
            try { await Notification.requestPermission(); } catch { /* ignorado */ }
        }
    };

    // ---------- Tema ----------
    function applyTheme() {
        const pref = S.settings.theme;
        const dark = pref === 'dark' || (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        bus.emit('theme', dark ? 'dark' : 'light');
    }
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
    App.isDark = () => document.documentElement.dataset.theme === 'dark';

    // ---------- Roteamento ----------
    const views = App.views = App.views || {};
    let current = null;

    function parseRoute() {
        const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
        const name = parts[0] || 'mercado';
        return { name: views[name] ? name : 'mercado', params: parts.slice(1).map(decodeURIComponent) };
    }

    function route() {
        const { name, params } = parseRoute();
        if (current?.view.unmount) current.view.unmount();
        const view = views[name];
        const el = $('#view');
        el.innerHTML = '';
        el.dataset.view = name;
        current = { name, view };
        $$('.nav-item').forEach((a) => a.classList.toggle('is-active', a.dataset.route === name));
        document.title = `${view.title ?? 'Cripto'} · Painel Cripto`;
        view.mount(el, params);
        el.focus({ preventScroll: true });
        window.scrollTo({ top: 0 });
    }
    App.go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

    // ---------- Busca (Ctrl+K) ----------
    let searchIndex = [];
    // mode "open": abre a análise. mode "add": adiciona à lista listId (padrão: a favorita).
    async function openSearch(mode = 'open', listId = null) {
        const dialog = $('#search');
        const input = $('#searchInput');
        dialog.dataset.mode = mode;
        dialog.dataset.list = listId || (store.getList(S.favoriteTab) ?? S.lists[0]).id;
        const target = store.getList(dialog.dataset.list);
        $('#searchTitle').textContent = mode === 'add' ? `Adicionar a ${target?.name ?? 'lista'}` : 'Buscar cripto';
        input.placeholder = mode === 'add' ? `Adicionar a “${target?.name ?? 'lista'}”: nome ou símbolo` : 'Nome ou símbolo, ex.: SOL, Chainlink';
        dialog.showModal();
        input.value = '';
        renderSearch('');
        input.focus();
        if (!searchIndex.length) {
            $('#searchResults').innerHTML = '<li class="search-empty">Carregando lista de criptos…</li>';
            try {
                searchIndex = await App.api.universe();
            } catch (error) {
                $('#searchResults').innerHTML = '<li class="search-empty">Não consegui carregar a lista da Binance. Tente de novo em instantes.</li>';
                return;
            }
            renderSearch(input.value);
        }
    }

    function renderSearch(query) {
        const q = query.trim().toUpperCase();
        const list = $('#searchResults');
        let items = searchIndex;
        if (q) {
            items = searchIndex.filter((c) => c.symbol.includes(q) || App.coins.meta(c.symbol).name.toUpperCase().includes(q));
            items.sort((a, b) => (b.symbol === q) - (a.symbol === q) || (b.symbol.startsWith(q)) - (a.symbol.startsWith(q)));
        }
        items = items.slice(0, 40);
        if (!searchIndex.length) return;
        if (!items.length) {
            list.innerHTML = html`<li class="search-empty">Nenhum par ${q}/USDT na Binance.</li>`;
            return;
        }
        list.innerHTML = items.map((c, i) => {
            const m = App.coins.meta(c.symbol);
            const dlg = $('#search');
            const inTarget = store.getList(dlg.dataset.list)?.symbols.includes(c.symbol);
            const tag = dlg.dataset.mode === 'add' ? (inTarget ? 'Já está' : 'Adicionar') : 'Abrir';
            return html`<li role="option" class="search-item${i === 0 ? ' is-focus' : ''}" data-symbol="${c.symbol}" aria-selected="${i === 0}">
                ${raw(App.coins.avatar(c.symbol, 28))}
                <span class="search-name"><strong>${c.symbol}</strong><span>${m.name !== c.symbol ? m.name : 'Par USDT'}</span></span>
                <span class="search-price">${fmt.money(c.price)}</span>
                <span class="search-tag">${tag}</span>
            </li>`;
        }).join('');
    }

    function chooseSearch(symbol) {
        const dialog = $('#search');
        const mode = dialog.dataset.mode;
        dialog.close();
        if (mode === 'add') {
            const list = store.getList(dialog.dataset.list);
            if (list && store.addToList(list.id, symbol)) {
                toast(`${symbol} adicionada a “${list.name}”.`, 'info');
                App.refreshPrices();
            } else if (list) {
                toast(`${symbol} já está em “${list.name}”.`);
            }
            return;
        }
        App.go(`#/ativo/${symbol}`);
    }
    App.openSearch = openSearch;

    function wireSearch() {
        const input = $('#searchInput');
        const list = $('#searchResults');
        input.addEventListener('input', () => renderSearch(input.value));
        input.addEventListener('keydown', (event) => {
            const items = $$('.search-item', list);
            let i = items.findIndex((el) => el.classList.contains('is-focus'));
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                i = Math.max(0, Math.min(items.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)));
                items.forEach((el, j) => { el.classList.toggle('is-focus', j === i); el.setAttribute('aria-selected', j === i); });
                items[i]?.scrollIntoView({ block: 'nearest' });
            } else if (event.key === 'Enter') {
                event.preventDefault();
                const sym = items[Math.max(0, i)]?.dataset.symbol;
                if (sym) chooseSearch(sym);
            }
        });
        list.addEventListener('click', (event) => {
            const item = event.target.closest('.search-item');
            if (item) chooseSearch(item.dataset.symbol);
        });
        $('#search').addEventListener('click', (event) => {
            if (event.target.id === 'search') event.target.close();
        });
        document.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                openSearch('open');
            } else if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
                event.preventDefault();
                openSearch('open');
            }
        });
    }

    // ---------- Barra superior ----------
    function renderTopbar() {
        $('#currencyToggle').innerHTML = ['BRL', 'USD'].map((c) => html`<button type="button" data-cur="${c}" aria-pressed="${S.settings.currency === c}">${c === 'BRL' ? 'R$' : 'US$'}</button>`).join('');
        $('#privacyToggle').setAttribute('aria-pressed', S.settings.privacy);
        $('#privacyToggle').title = S.settings.privacy ? 'Mostrar valores da carteira' : 'Ocultar valores da carteira';
        const themeLabels = { auto: 'Tema: automático', dark: 'Tema: escuro', light: 'Tema: claro' };
        $('#themeToggle').title = themeLabels[S.settings.theme];
        $('#themeToggle').dataset.mode = S.settings.theme;
        renderFx();
    }

    function renderFx() {
        $('#fxRate').textContent = live.fx ? `USDT ${fmt.money(live.fx, 'BRL', 3)}` : 'USDT —';
    }

    function wireTopbar() {
        $('#searchOpen').addEventListener('click', () => openSearch('open'));
        $('#currencyToggle').addEventListener('click', (event) => {
            const btn = event.target.closest('button[data-cur]');
            if (!btn) return;
            S.settings.currency = btn.dataset.cur;
            store.commit('settings');
        });
        $('#privacyToggle').addEventListener('click', () => {
            S.settings.privacy = !S.settings.privacy;
            store.commit('settings');
        });
        $('#themeToggle').addEventListener('click', () => {
            const order = ['auto', 'dark', 'light'];
            S.settings.theme = order[(order.indexOf(S.settings.theme) + 1) % order.length];
            store.commit('settings');
            applyTheme();
        });
        bus.on('stream-status', ({ name, status }) => {
            if (name !== 'tickers') return;
            const dot = $('#liveDot');
            dot.dataset.status = status;
            const labels = { online: 'Ao vivo', connecting: 'Conectando', reconnecting: 'Reconectando', error: 'Sem conexão', stale: 'Atrasado', offline: 'Offline' };
            dot.title = labels[status] ?? status;
            $('#liveLabel').textContent = labels[status] ?? status;
        });
        bus.on('settings', renderTopbar);
        bus.on('prices', renderFx);
    }

    // ---------- Anotações (preço desejado e nota) ----------
    function parseNum(value) {
        let text = String(value ?? '').replace(/\s/g, '');
        if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.');
        const n = Number(text);
        return text && Number.isFinite(n) ? n : NaN;
    }
    App.parseNum = parseNum;

    App.openNote = (symbol) => {
        const dlg = $('#noteDialog');
        const note = S.notes[symbol] ?? {};
        dlg.dataset.symbol = symbol;
        $('#noteTitle').textContent = `Anotações de ${symbol}`;
        const price = App.priceOf(symbol);
        $('#noteNow').textContent = price ? `Preço agora: ${fmt.money(price)}` : '';
        $('#noteBuy').value = note.buyPrice ?? '';
        $('#noteText').value = note.note ?? '';
        $('#noteAlert').checked = false;
        dlg.showModal();
        $('#noteBuy').focus();
    };

    function wireNoteDialog() {
        const dlg = $('#noteDialog');
        $('#noteCancel').addEventListener('click', () => dlg.close());
        $('#noteClear').addEventListener('click', () => {
            store.setNote(dlg.dataset.symbol, {});
            dlg.close();
            toast('Anotações apagadas.');
        });
        $('#noteForm').addEventListener('submit', (event) => {
            event.preventDefault();
            const symbol = dlg.dataset.symbol;
            const rawBuy = $('#noteBuy').value.trim();
            const buy = rawBuy ? parseNum(rawBuy) : null;
            if (rawBuy && !(buy > 0)) {
                toast('O preço desejado precisa ser um número maior que zero.', 'bad');
                return;
            }
            store.setNote(symbol, { note: $('#noteText').value, buyPrice: buy });
            if ($('#noteAlert').checked && buy > 0) {
                const now = App.priceOf(symbol);
                store.addAlert({ asset: symbol, condition: now && buy > now ? 'above' : 'below', price: buy });
                App.askNotifications();
            }
            dlg.close();
            toast(`Anotações de ${symbol} salvas.`, 'up');
        });
    }

    // ---------- Criar / editar lista ----------
    App.openListDialog = (listId = null, onCreate = null) => {
        const dlg = $('#listDialog');
        const list = listId ? store.getList(listId) : null;
        dlg.dataset.list = list?.id ?? '';
        dlg._onCreate = onCreate;
        $('#listTitle').textContent = list ? 'Editar lista' : 'Nova lista';
        $('#listSave').textContent = list ? 'Salvar' : 'Criar lista';
        $('#listName').value = list?.name ?? '';
        $('#listDelete').hidden = !list || S.lists.length <= 1;
        const current = list?.color ?? store.LIST_COLORS[S.lists.length % store.LIST_COLORS.length];
        $('#listColors').innerHTML = store.LIST_COLORS.map((c) => html`<label class="swatch" style="--c:${c}"><input type="radio" name="listColor" value="${c}" ${c === current ? 'checked' : ''}><span class="sr-only">${c}</span></label>`).join('');
        dlg.showModal();
        $('#listName').focus();
    };

    function wireListDialog() {
        const dlg = $('#listDialog');
        $('#listCancel').addEventListener('click', () => dlg.close());
        $('#listDelete').addEventListener('click', () => {
            const list = store.getList(dlg.dataset.list);
            if (!list) return;
            if (!window.confirm(`Apagar a lista “${list.name}”? As criptos continuam nas outras listas e na carteira.`)) return;
            store.deleteList(list.id);
            dlg.close();
            toast(`Lista “${list.name}” apagada.`);
        });
        $('#listForm').addEventListener('submit', (event) => {
            event.preventDefault();
            const name = $('#listName').value.trim();
            if (!name) { toast('Dê um nome para a lista.', 'bad'); return; }
            const color = $('#listColors input:checked')?.value;
            if (dlg.dataset.list) {
                store.updateList(dlg.dataset.list, { name, color });
                toast('Lista atualizada.');
            } else {
                const id = store.createList(name, color);
                toast(`Lista “${name}” criada.`, 'up');
                dlg._onCreate?.(id);
            }
            dlg.close();
        });
    }

    // ---------- Início ----------
    function init() {
        applyTheme();
        renderTopbar();
        wireTopbar();
        wireSearch();
        wireNoteDialog();
        wireListDialog();
        window.addEventListener('hashchange', route);
        bus.on('watchlist', () => App.refreshPrices());
        bus.on('notes', () => App.refreshPrices());
        bus.on('transactions', () => App.refreshPrices());
        bus.on('alerts', () => App.refreshPrices());
        refreshPrices();
        setInterval(refreshPrices, 5 * 60 * 1000);
        route();
        if (location.protocol === 'file:') {
            document.documentElement.classList.add('is-file');
        }
    }

    document.addEventListener('DOMContentLoaded', init);
})(window.App);
