// Tela "Mercado": a lista de criptos acompanhadas, com preço ao vivo e sinal.
window.App = window.App || {};
App.views = App.views || {};

(function (App) {
    const { $, $$, html, raw, fmt, bus, toneOf } = App.util;
    const store = App.store;
    const S = store.state;

    const daily = {}; // símbolo -> { closes30, analysis }
    let root = null;
    let offs = [];
    let sort = { key: 'manual', dir: 1 };

    const SIGNAL_ORDER = { 'Aportar reforçado': 0, 'Aporte normal': 1, 'Esperar recuo': 2 };

    async function loadDaily(symbols) {
        const queue = symbols.filter((s) => !daily[s]);
        const worker = async () => {
            while (queue.length) {
                const symbol = queue.shift();
                try {
                    const data = await App.api.klines(symbol, '1d', 400);
                    daily[symbol] = { closes30: data.slice(-30).map((d) => d.close), analysis: App.ind.analyze(data) };
                } catch (error) {
                    daily[symbol] = { closes30: [], analysis: null, error: true };
                }
                if (root) renderRow(symbol);
                if (root) renderHighlights();
            }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
    }

    function rowsSorted() {
        const list = [...S.watchlist];
        if (sort.key === 'manual') return list;
        const val = (s) => {
            const p = App.live.prices[s];
            switch (sort.key) {
                case 'name': return s;
                case 'price': return p?.price ?? -Infinity;
                case 'change': return p?.changePct ?? -Infinity;
                case 'volume': return p?.quoteVolume ?? -Infinity;
                case 'signal': return SIGNAL_ORDER[daily[s]?.analysis?.action] ?? 9;
                default: return 0;
            }
        };
        return list.sort((a, b) => {
            const va = val(a);
            const vb = val(b);
            if (typeof va === 'string') return va.localeCompare(vb) * sort.dir;
            return (va - vb) * sort.dir;
        });
    }

    function signalChip(analysis) {
        if (!analysis) return '<span class="chip chip-muted">—</span>';
        return html`<span class="chip chip-${analysis.tone}">${analysis.action}</span>`;
    }

    function rowHtml(symbol, index) {
        const m = App.coins.meta(symbol);
        const p = App.live.prices[symbol];
        const d = daily[symbol];
        const tone = toneOf(p?.changePct);
        const trend30 = d?.closes30?.length ? ((d.closes30[d.closes30.length - 1] - d.closes30[0]) / d.closes30[0]) * 100 : null;
        return html`<tr data-symbol="${symbol}" style="--coin:${m.color}">
            <td class="col-coin">
                <a href="#/ativo/${symbol}" class="coin-cell">
                    ${raw(App.coins.avatar(symbol, 34))}
                    <span><strong>${m.name}</strong><span class="muted">${symbol}</span></span>
                </a>
            </td>
            <td class="col-num" data-cell="price">${p ? fmt.money(p.price) : '—'}</td>
            <td class="col-num" data-cell="change"><span class="delta delta-${tone}">${p ? fmt.pct(p.changePct) : '—'}</span></td>
            <td class="col-spark" data-cell="spark">${raw(App.charts.sparkline(d?.closes30, { tone: toneOf(trend30) }))}<span class="muted spark-label">${trend30 === null ? '' : `30d ${fmt.pct(trend30, 1)}`}</span></td>
            <td class="col-num col-vol" data-cell="volume">${p ? App.money(p.quoteVolume, { compact: true }) : '—'}</td>
            <td class="col-signal" data-cell="signal">${raw(signalChip(d?.analysis))}</td>
            <td class="col-actions">
                <button class="icon-btn" type="button" data-act="up" title="Subir na lista" aria-label="Subir ${symbol} na lista" ${index === 0 || sort.key !== 'manual' ? 'disabled' : ''}>↑</button>
                <button class="icon-btn" type="button" data-act="down" title="Descer na lista" aria-label="Descer ${symbol} na lista" ${index === S.watchlist.length - 1 || sort.key !== 'manual' ? 'disabled' : ''}>↓</button>
                <button class="icon-btn" type="button" data-act="remove" title="Remover da lista" aria-label="Remover ${symbol} da lista">✕</button>
            </td>
        </tr>`;
    }

    function renderRow(symbol) {
        const tr = $(`tr[data-symbol="${symbol}"]`, root);
        if (!tr) return;
        const index = S.watchlist.indexOf(symbol);
        tr.outerHTML = rowHtml(symbol, index);
    }

    function renderTable() {
        const body = $('#marketBody', root);
        const list = rowsSorted();
        if (!list.length) {
            body.innerHTML = '<tr><td colspan="7" class="empty-cell">Sua lista está vazia. Use “Adicionar cripto” para montar a sua.</td></tr>';
            return;
        }
        body.innerHTML = list.map((s) => rowHtml(s, S.watchlist.indexOf(s))).join('');
        $$('th[data-sort]', root).forEach((th) => {
            th.setAttribute('aria-sort', th.dataset.sort === sort.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none');
        });
    }

    function updateLiveCells() {
        S.watchlist.forEach((symbol) => {
            const tr = $(`tr[data-symbol="${symbol}"]`, root);
            const p = App.live.prices[symbol];
            if (!tr || !p) return;
            const priceCell = $('[data-cell="price"]', tr);
            const next = fmt.money(p.price);
            if (priceCell.textContent !== next) {
                const prev = Number(priceCell.dataset.raw);
                priceCell.textContent = next;
                if (prev) {
                    priceCell.classList.remove('tick-up', 'tick-down');
                    void priceCell.offsetWidth;
                    priceCell.classList.add(p.price >= prev ? 'tick-up' : 'tick-down');
                }
                priceCell.dataset.raw = p.price;
            }
            $('[data-cell="change"]', tr).innerHTML = html`<span class="delta delta-${toneOf(p.changePct)}">${fmt.pct(p.changePct)}</span>`;
            $('[data-cell="volume"]', tr).textContent = App.money(p.quoteVolume, { compact: true });
        });
        renderBreadth();
        renderHighlights();
    }

    function renderBreadth() {
        const changes = S.watchlist.map((s) => App.live.prices[s]?.changePct).filter(Number.isFinite);
        const up = changes.filter((c) => c > 0).length;
        const down = changes.filter((c) => c < 0).length;
        const avg = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : null;
        const el = $('#breadth', root);
        if (!changes.length) {
            el.innerHTML = '<p class="lede">Carregando cotações…</p>';
            return;
        }
        const mood = avg > 1.5 ? 'dia de alta' : avg < -1.5 ? 'dia de queda' : 'dia de lado';
        el.innerHTML = html`
            <p class="lede">Na sua lista, <strong class="delta-up">${up}</strong> ${up === 1 ? 'sobe' : 'sobem'} e <strong class="delta-down">${down}</strong> ${down === 1 ? 'cai' : 'caem'} nas últimas 24h. Média de <strong class="delta-${toneOf(avg)}">${fmt.pct(avg)}</strong>: ${mood}.</p>
            <div class="breadth-bar" role="img" aria-label="${up} em alta, ${down} em queda">
                <span class="breadth-up" style="flex:${up || 0.001}"></span><span class="breadth-down" style="flex:${down || 0.001}"></span>
            </div>`;
    }

    function renderHighlights() {
        const el = $('#highlights', root);
        if (!el) return;
        const withChange = S.watchlist.filter((s) => Number.isFinite(App.live.prices[s]?.changePct));
        const best = [...withChange].sort((a, b) => App.live.prices[b].changePct - App.live.prices[a].changePct)[0];
        const worst = [...withChange].sort((a, b) => App.live.prices[a].changePct - App.live.prices[b].changePct)[0];
        const discounts = S.watchlist.filter((s) => daily[s]?.analysis?.action === 'Aportar reforçado');
        const stretched = S.watchlist.filter((s) => daily[s]?.analysis?.action === 'Esperar recuo');
        const card = (label, symbol, detail, tone) => (symbol ? html`
            <a class="highlight" href="#/ativo/${symbol}" style="--coin:${App.coins.meta(symbol).color}">
                <span class="highlight-label">${label}</span>
                <span class="highlight-coin">${raw(App.coins.avatar(symbol, 22))}<strong>${symbol}</strong></span>
                <span class="delta delta-${tone}">${detail}</span>
            </a>` : '');
        el.innerHTML = [
            card('Maior alta 24h', best, best ? fmt.pct(App.live.prices[best].changePct) : '', toneOf(App.live.prices[best]?.changePct)),
            card(App.live.prices[worst]?.changePct < 0 ? 'Maior queda 24h' : 'Menor alta 24h', worst !== best ? worst : null, worst ? fmt.pct(App.live.prices[worst].changePct) : '', toneOf(App.live.prices[worst]?.changePct)),
            html`<div class="highlight highlight-list">
                <span class="highlight-label">Com desconto pelo sinal</span>
                <span class="highlight-coins">${discounts.length ? raw(discounts.map((s) => html`<a href="#/ativo/${s}" title="${s}">${raw(App.coins.avatar(s, 22))}</a>`).join('')) : raw('<span class="muted">Nenhuma agora</span>')}</span>
            </div>`,
            html`<div class="highlight highlight-list">
                <span class="highlight-label">Esticadas pelo sinal</span>
                <span class="highlight-coins">${stretched.length ? raw(stretched.map((s) => html`<a href="#/ativo/${s}" title="${s}">${raw(App.coins.avatar(s, 22))}</a>`).join('')) : raw('<span class="muted">Nenhuma agora</span>')}</span>
            </div>`,
        ].join('');
    }

    function onTableClick(event) {
        const btn = event.target.closest('button[data-act]');
        if (!btn) return;
        const symbol = btn.closest('tr').dataset.symbol;
        if (btn.dataset.act === 'remove') {
            const held = store.positions().some((p) => p.asset === symbol && p.qty > 0);
            store.removeWatch(symbol);
            App.util.toast(held ? `${symbol} saiu da lista, mas continua na sua carteira.` : `${symbol} removida da lista.`);
        } else {
            store.moveWatch(symbol, btn.dataset.act === 'up' ? -1 : 1);
        }
    }

    function onSort(event) {
        const th = event.target.closest('th[data-sort]');
        if (!th) return;
        const key = th.dataset.sort;
        if (sort.key === key) {
            sort.dir = -sort.dir;
            if (sort.dir === 1 && key !== 'name') sort = { key: 'manual', dir: 1 };
        } else {
            sort = { key, dir: key === 'name' || key === 'signal' ? 1 : -1 };
        }
        renderTable();
    }

    App.views.mercado = {
        title: 'Mercado',
        mount(el) {
            root = el;
            el.innerHTML = html`
                <header class="page-head">
                    <div>
                        <h1>Mercado</h1>
                        <div id="breadth" class="breadth"></div>
                    </div>
                    <button class="btn btn-primary" type="button" id="addCoin">Adicionar cripto</button>
                </header>
                <section id="highlights" class="highlights" aria-label="Destaques"></section>
                <section class="panel">
                    <div class="table-wrap">
                        <table class="market-table">
                            <thead>
                                <tr>
                                    <th data-sort="name" scope="col">Cripto</th>
                                    <th data-sort="price" class="col-num" scope="col">Preço</th>
                                    <th data-sort="change" class="col-num" scope="col">24h</th>
                                    <th class="col-spark" scope="col">30 dias</th>
                                    <th data-sort="volume" class="col-num col-vol" scope="col">Volume 24h</th>
                                    <th data-sort="signal" scope="col" title="Leitura do gráfico diário: desconto, normal ou esticado">Sinal</th>
                                    <th class="col-actions" scope="col"><span class="sr-only">Ações</span></th>
                                </tr>
                            </thead>
                            <tbody id="marketBody"></tbody>
                        </table>
                    </div>
                    <p class="footnote">Sinal calculado no gráfico diário com médias, RSI, MACD e suporte/resistência, ajustado à volatilidade de cada cripto. Não é recomendação de investimento.</p>
                </section>`;
            $('#addCoin', el).addEventListener('click', () => App.openSearch('add'));
            $('#marketBody', el).addEventListener('click', onTableClick);
            $('thead', el).addEventListener('click', onSort);
            renderTable();
            renderBreadth();
            renderHighlights();
            offs = [
                App.util.bus.on('prices', updateLiveCells),
                App.util.bus.on('watchlist', () => { renderTable(); renderBreadth(); loadDaily(S.watchlist); }),
                App.util.bus.on('settings', () => { renderTable(); }),
            ];
            loadDaily(S.watchlist);
        },
        unmount() {
            offs.forEach((off) => off());
            offs = [];
            root = null;
        },
    };
})(window.App);
