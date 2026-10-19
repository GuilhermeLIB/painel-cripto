// Tela "Mercado": listas de criptos (manuais e automáticas), tabela ou mapa
// de calor, período selecionável, força contra o BTC, distância da máxima,
// preço desejado e comparador de desempenho.
window.App = window.App || {};
App.views = App.views || {};

(function (App) {
    const { $, $$, html, raw, fmt, bus, toneOf, toast, debounce } = App.util;
    const store = App.store;
    const S = store.state;

    const PERIODS = {
        '24h': { label: '24h', days: 1 },
        '7d': { label: '7 dias', days: 7 },
        '30d': { label: '30 dias', days: 30 },
        '1y': { label: '1 ano', days: 365 },
    };
    const SMART = {
        'smart:portfolio': { name: 'Na carteira', hint: 'Criptos em que você tem posição. Atualiza sozinha.' },
        'smart:discount': { name: 'Com desconto', hint: 'Das suas listas e da carteira, as que o sinal diário marca como “Aportar reforçado”.' },
        'smart:alerts': { name: 'Com alerta', hint: 'Criptos com alerta de preço ativo.' },
    };
    const SIGNAL_ORDER = { 'Aportar reforçado': 0, 'Aporte normal': 1, 'Esperar recuo': 2 };
    const MAX_COMPARE = 6;

    const data = {}; // símbolo -> { d1, analysis, ath, h1, error }
    const pending = new Set();
    let root = null;
    let offs = [];
    let tab = null;
    let sort = { key: 'manual', dir: 1 };
    let filter = { text: '', signal: 'all' };
    let compare = { picked: null, chart: null };
    let dragSymbol = null;

    // ---------- Dados ----------
    function enqueue(symbols, withHourly) {
        const queue = symbols.filter((s) => {
            const d = data[s];
            const need = !d || (!d.d1 && !d.error) || (withHourly && !d.h1 && !d.error);
            return need && !pending.has(s);
        });
        if (!queue.length) return;
        queue.forEach((s) => pending.add(s));
        const worker = async () => {
            while (queue.length) {
                const symbol = queue.shift();
                const d = data[symbol] || (data[symbol] = {});
                try {
                    const jobs = [];
                    if (!d.d1) jobs.push(App.api.klines(symbol, '1d', 1000).then((rows) => { d.d1 = rows; d.analysis = App.ind.analyze(rows); }));
                    if (d.ath === undefined) jobs.push(App.api.klines(symbol, '1w', 1000).then((rows) => { d.ath = Math.max(...rows.map((r) => r.high)); }).catch(() => { d.ath = null; }));
                    if (withHourly && !d.h1) jobs.push(App.api.klines(symbol, '1h', 25).then((rows) => { d.h1 = rows; }));
                    await Promise.all(jobs);
                } catch (error) {
                    d.error = true;
                }
                pending.delete(symbol);
                if (root) { scheduleRender(); scheduleCompare(); }
            }
        };
        Promise.all([worker(), worker(), worker(), worker()]);
    }

    const scheduleRender = debounce(() => { if (root) renderBody(); }, 120);

    function period() { return S.settings.marketPeriod in PERIODS ? S.settings.marketPeriod : '30d'; }

    function priceNow(symbol) {
        return App.priceOf(symbol) ?? data[symbol]?.d1?.at(-1)?.close ?? null;
    }

    function changeFor(symbol) {
        const p = period();
        if (p === '24h') return App.live.prices[symbol]?.changePct ?? null;
        const d1 = data[symbol]?.d1;
        const now = priceNow(symbol);
        const days = PERIODS[p].days;
        if (!d1 || !now || d1.length <= days) return null;
        const base = d1[d1.length - 1 - days].close;
        return ((now - base) / base) * 100;
    }

    function sparkFor(symbol) {
        const p = period();
        const d = data[symbol];
        let values = null;
        if (p === '24h') values = d?.h1?.map((r) => r.close);
        else if (d?.d1) {
            values = d.d1.slice(-(PERIODS[p].days + 1)).map((r) => r.close);
            if (values.length > 90) {
                const step = Math.ceil(values.length / 90);
                values = values.filter((_, i) => i % step === 0 || i === values.length - 1);
            }
        }
        const now = priceNow(symbol);
        if (values && now) values = [...values.slice(0, -1), now];
        return values;
    }

    function vsBtc(symbol) {
        if (symbol === 'BTC') return null;
        const a = changeFor(symbol);
        const b = changeFor('BTC');
        if (a === null || b === null) return null;
        return ((1 + a / 100) / (1 + b / 100) - 1) * 100;
    }

    function athGap(symbol) {
        const ath = data[symbol]?.ath;
        const now = priceNow(symbol);
        if (!ath || !now) return null;
        return Math.min(0, ((now - ath) / ath) * 100);
    }

    function targetGap(symbol) {
        const buy = S.notes[symbol]?.buyPrice;
        const now = priceNow(symbol);
        if (!buy || !now) return null;
        return ((buy - now) / now) * 100;
    }

    // ---------- Listas ----------
    function isSmart(id) { return id.startsWith('smart:'); }

    function tabName(id) {
        return isSmart(id) ? SMART[id].name : store.getList(id)?.name ?? '';
    }

    function tabSymbols(id) {
        if (id === 'smart:portfolio') {
            return store.positions().filter((p) => p.qty > 0)
                .sort((a, b) => b.qty * (priceNow(b.asset) ?? 0) - a.qty * (priceNow(a.asset) ?? 0))
                .map((p) => p.asset);
        }
        if (id === 'smart:discount') {
            const pool = new Set([...S.watchlist, ...store.positions().filter((p) => p.qty > 0).map((p) => p.asset)]);
            return [...pool].filter((s) => data[s]?.analysis?.action === 'Aportar reforçado');
        }
        if (id === 'smart:alerts') {
            return [...new Set(S.alerts.filter((a) => !a.triggeredAt).map((a) => a.asset))];
        }
        return store.getList(id)?.symbols ?? [];
    }

    function visibleSymbols() {
        let list = [...tabSymbols(tab)];
        if (filter.text) {
            const q = filter.text.toUpperCase();
            list = list.filter((s) => s.includes(q) || App.coins.meta(s).name.toUpperCase().includes(q));
        }
        if (filter.signal !== 'all') list = list.filter((s) => data[s]?.analysis?.action === filter.signal);
        if (sort.key === 'manual') return list;
        const val = (s) => {
            switch (sort.key) {
                case 'name': return s;
                case 'price': return priceNow(s) ?? -Infinity;
                case 'change': return changeFor(s) ?? -Infinity;
                case 'vsbtc': return vsBtc(s) ?? -Infinity;
                case 'ath': return athGap(s) ?? -Infinity;
                case 'target': { const g = targetGap(s); return g === null ? -Infinity : g; }
                case 'signal': return SIGNAL_ORDER[data[s]?.analysis?.action] ?? 9;
                default: return 0;
            }
        };
        return list.sort((a, b) => {
            const va = val(a);
            const vb = val(b);
            if (typeof va === 'string') return va.localeCompare(vb) * sort.dir;
            if (va === vb) return 0;
            return (va > vb ? 1 : -1) * sort.dir;
        });
    }

    function canReorder() {
        return !isSmart(tab) && sort.key === 'manual' && !filter.text && filter.signal === 'all';
    }

    // ---------- Render: abas ----------
    function renderTabs() {
        const el = $('#tabs', root);
        el.innerHTML = S.tabs.map((id) => {
            const smart = isSmart(id);
            const list = smart ? null : store.getList(id);
            const count = tabSymbols(id).length;
            const fav = S.favoriteTab === id;
            return html`<button type="button" role="tab" class="tab${id === tab ? ' is-active' : ''}${smart ? ' tab-smart' : ''}" data-tab="${id}" aria-selected="${id === tab}" draggable="true" title="${smart ? SMART[id].hint : list.name}">
                ${raw(smart ? '<svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.4 5.6 6 .5-4.6 4 1.4 5.9L12 16l-5.2 3 1.4-5.9-4.6-4 6-.5z"/></svg>' : html`<i class="tab-dot" style="background:${list.color}"></i>`)}
                <span>${tabName(id)}</span>
                <span class="tab-count">${count}</span>
                ${raw(fav ? '<span class="tab-fav" title="Lista favorita: abre primeiro">★</span>' : '')}
            </button>`;
        }).join('') + '<button type="button" class="tab tab-new" data-act="new-list" title="Criar lista">+ Nova lista</button>';
        renderTabMenu();
    }

    function renderTabMenu() {
        const el = $('#tabMenu', root);
        const smart = isSmart(tab);
        const i = S.tabs.indexOf(tab);
        const fav = S.favoriteTab === tab;
        el.innerHTML = html`
            <p class="tab-hint">${smart ? SMART[tab].hint : `${tabSymbols(tab).length} ${tabSymbols(tab).length === 1 ? 'cripto' : 'criptos'}. Arraste as linhas para ordenar.`}</p>
            <div class="toolbar">
                <button class="btn btn-small btn-ghost" type="button" data-act="fav" ${fav ? 'disabled' : ''}>${fav ? '★ Favorita' : '☆ Tornar favorita'}</button>
                <button class="btn btn-small btn-ghost" type="button" data-act="tab-left" ${i <= 0 ? 'disabled' : ''} aria-label="Mover lista para a esquerda">←</button>
                <button class="btn btn-small btn-ghost" type="button" data-act="tab-right" ${i >= S.tabs.length - 1 ? 'disabled' : ''} aria-label="Mover lista para a direita">→</button>
                ${raw(smart ? '' : '<button class="btn btn-small btn-ghost" type="button" data-act="edit-list">Editar lista</button>')}
                ${raw(smart ? '' : '<button class="btn btn-small btn-primary" type="button" data-act="add-coin">Adicionar cripto</button>')}
            </div>`;
    }

    // ---------- Render: tabela ----------
    function signalChip(analysis) {
        if (!analysis) return '<span class="chip chip-muted">—</span>';
        return html`<span class="chip chip-${analysis.tone}">${analysis.action}</span>`;
    }

    function targetCell(symbol) {
        const buy = S.notes[symbol]?.buyPrice;
        if (!buy) return html`<button class="link-btn" type="button" data-note="${symbol}">Definir</button>`;
        const gap = targetGap(symbol);
        if (gap === null) return html`${fmt.money(buy)}`;
        if (gap >= 0) return html`${fmt.money(buy)}<span class="chip chip-up">No alvo</span>`;
        return html`${fmt.money(buy)}<small class="muted">precisa cair ${fmt.pct(-gap, 1).replace('+', '')}</small>`;
    }

    function rowHtml(symbol, reorder) {
        const m = App.coins.meta(symbol);
        const ch = changeFor(symbol);
        const spark = sparkFor(symbol);
        const vb = vsBtc(symbol);
        const ath = athGap(symbol);
        const note = S.notes[symbol];
        const loading = !data[symbol]?.d1 && !data[symbol]?.error;
        return html`<tr data-symbol="${symbol}" style="--coin:${m.color}" ${raw(reorder ? 'draggable="true"' : '')}>
            ${raw(reorder ? html`<td class="col-drag"><button class="drag-handle" type="button" data-handle="${symbol}" aria-label="Reordenar ${symbol}: use as setas para cima e para baixo" title="Arraste para ordenar">⋮⋮</button></td>` : '<td class="col-drag"></td>')}
            <td class="col-coin">
                <a href="#/ativo/${symbol}" class="coin-cell">
                    ${raw(App.coins.avatar(symbol, 34))}
                    <span><strong>${m.name}</strong><span class="muted">${symbol}${raw(note?.note ? html` · <span class="note-flag" title="${note.note}">nota</span>` : '')}</span></span>
                </a>
            </td>
            <td class="col-num" data-cell="price">${priceNow(symbol) ? fmt.money(priceNow(symbol)) : '—'}</td>
            <td class="col-num" data-cell="change"><span class="delta delta-${toneOf(ch)}">${ch === null ? (loading ? '…' : '—') : fmt.pct(ch)}</span></td>
            <td class="col-spark">${raw(App.charts.sparkline(spark, { tone: toneOf(ch) }))}</td>
            <td class="col-num col-vsbtc" data-cell="vsbtc"><span class="delta-${toneOf(vb)}">${vb === null ? '—' : fmt.pct(vb, 1)}</span></td>
            <td class="col-num col-ath" data-cell="ath">${ath === null ? '—' : raw(html`<span class="ath"><span class="ath-bar"><i style="width:${Math.max(2, 100 + ath)}%"></i></span>${fmt.pct(ath, 0)}</span>`)}</td>
            <td class="col-num col-target" data-cell="target">${raw(targetCell(symbol))}</td>
            <td class="col-signal">${raw(signalChip(data[symbol]?.analysis))}</td>
            <td class="col-actions">
                <button class="icon-btn" type="button" data-note="${symbol}" title="Anotações e preço desejado" aria-label="Anotações de ${symbol}">✎</button>
                ${raw(isSmart(tab) ? '' : html`<button class="icon-btn" type="button" data-remove="${symbol}" title="Remover desta lista" aria-label="Remover ${symbol} desta lista">✕</button>`)}
            </td>
        </tr>`;
    }

    function renderTable(list) {
        const body = $('#marketBody', root);
        $$('th[data-sort]', root).forEach((th) => {
            th.setAttribute('aria-sort', th.dataset.sort === sort.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none');
        });
        $('#colChange', root).textContent = PERIODS[period()].label;
        if (!list.length) {
            const empty = filter.text || filter.signal !== 'all'
                ? 'Nada nesta lista com esse filtro.'
                : isSmart(tab)
                    ? ({ 'smart:portfolio': 'Nenhuma posição ainda. Registre compras na Carteira.', 'smart:discount': 'Nenhuma cripto das suas listas está com desconto pelo sinal agora.', 'smart:alerts': 'Nenhum alerta ativo. Crie na tela de Análise ou em Alertas.' })[tab]
                    : 'Lista vazia. Use “Adicionar cripto” para incluir moedas.';
            body.innerHTML = html`<tr><td colspan="10" class="empty-cell">${empty}</td></tr>`;
            return;
        }
        const reorder = canReorder();
        body.innerHTML = list.map((s) => rowHtml(s, reorder)).join('');
    }

    // ---------- Render: mapa de calor ----------
    // Treemap "squarified": blocos com proporção próxima de quadrado.
    function squarify(items, x, y, w, h) {
        const out = [];
        const total = items.reduce((a, b) => a + b.value, 0) || 1;
        let rest = items.map((it) => ({ ...it, area: (it.value / total) * w * h }));
        while (rest.length) {
            const short = Math.min(w, h);
            let row = [];
            let best = Infinity;
            for (const item of rest) {
                const test = [...row, item];
                const sum = test.reduce((a, b) => a + b.area, 0);
                const max = Math.max(...test.map((t) => t.area));
                const min = Math.min(...test.map((t) => t.area));
                const worst = Math.max((short * short * max) / (sum * sum), (sum * sum) / (short * short * min));
                if (worst > best) break;
                best = worst;
                row = test;
            }
            const sum = row.reduce((a, b) => a + b.area, 0);
            if (w >= h) {
                const cw = sum / h;
                let cy = y;
                row.forEach((r) => { const rh = r.area / cw; out.push({ ...r, x, y: cy, w: cw, h: rh }); cy += rh; });
                x += cw; w -= cw;
            } else {
                const rh = sum / w;
                let cx = x;
                row.forEach((r) => { const rw = r.area / rh; out.push({ ...r, x: cx, y, w: rw, h: rh }); cx += rw; });
                y += rh; h -= rh;
            }
            rest = rest.slice(row.length);
        }
        return out;
    }

    function renderHeatmap(list) {
        const el = $('#heatmap', root);
        if (!list.length) {
            el.innerHTML = '<p class="empty-cell">Nada para mostrar nesta lista.</p>';
            return;
        }
        const bySize = S.settings.heatSize;
        const positions = store.positions();
        const items = list.map((s) => {
            let value;
            if (bySize === 'position') {
                const p = positions.find((x) => x.asset === s);
                value = p && p.qty > 0 ? p.qty * (priceNow(s) ?? 0) : 0;
            } else if (bySize === 'equal') {
                value = 1;
            } else {
                value = App.live.prices[s]?.quoteVolume ?? 0;
            }
            return { symbol: s, value: Math.max(value, 0) };
        });
        const total = items.reduce((a, b) => a + b.value, 0);
        if (!total) items.forEach((it) => { it.value = 1; });
        // Garante um tamanho mínimo para nenhuma moeda sumir.
        const sum = items.reduce((a, b) => a + b.value, 0);
        items.forEach((it) => { it.value = Math.max(it.value, sum * 0.012); });
        items.sort((a, b) => b.value - a.value);
        const W = el.clientWidth || 1000;
        const H = el.clientHeight || 560;
        const tiles = squarify(items, 0, 0, W, H);
        const scale = { '24h': 8, '7d': 15, '30d': 30, '1y': 100 }[period()];
        el.innerHTML = tiles.map((t) => {
            const ch = changeFor(t.symbol);
            const strength = ch === null ? 0 : Math.min(1, Math.abs(ch) / scale);
            const colorVar = ch === null ? '--surface-3' : ch >= 0 ? '--up' : '--down';
            const mix = Math.round(18 + strength * 62);
            const small = t.w < 110 || t.h < 70;
            const tiny = t.w < 64 || t.h < 44;
            return html`<a class="tile${small ? ' tile-small' : ''}${tiny ? ' tile-tiny' : ''}" href="#/ativo/${t.symbol}"
                style="left:${(t.x / W) * 100}%;top:${(t.y / H) * 100}%;width:${(t.w / W) * 100}%;height:${(t.h / H) * 100}%;background:color-mix(in srgb, var(${colorVar}) ${mix}%, var(--surface-2))"
                title="${t.symbol} ${ch === null ? '' : fmt.pct(ch)}">
                <strong>${t.symbol}</strong>
                <span>${ch === null ? '—' : fmt.pct(ch, 1)}</span>
                ${raw(small ? '' : html`<small>${fmt.money(priceNow(t.symbol))}</small>`)}
            </a>`;
        }).join('');
    }

    // ---------- Render: resumo e geral ----------
    function renderBreadth(list) {
        const changes = list.map(changeFor).filter(Number.isFinite);
        const el = $('#breadth', root);
        if (!changes.length) {
            el.innerHTML = list.length ? '<p class="lede">Carregando cotações…</p>' : '';
            return;
        }
        const up = changes.filter((c) => c > 0).length;
        const down = changes.filter((c) => c < 0).length;
        const avg = changes.reduce((a, b) => a + b, 0) / changes.length;
        const label = PERIODS[period()].label;
        el.innerHTML = html`
            <p class="lede">Em “${tabName(tab)}”, <strong class="delta-up">${up}</strong> ${up === 1 ? 'subiu' : 'subiram'} e <strong class="delta-down">${down}</strong> ${down === 1 ? 'caiu' : 'caíram'} em ${period() === '24h' ? '24h' : label}. Média de <strong class="delta-${toneOf(avg)}">${fmt.pct(avg)}</strong>.</p>
            <div class="breadth-bar" role="img" aria-label="${up} em alta, ${down} em queda">
                <span class="breadth-up" style="flex:${up || 0.001}"></span><span class="breadth-down" style="flex:${down || 0.001}"></span>
            </div>`;
    }

    function renderBody() {
        if (!root) return;
        const list = visibleSymbols();
        const all = tabSymbols(tab);
        enqueue([...new Set([...all, 'BTC', ...(compare.picked ?? [])])], period() === '24h');
        renderBreadth(all);
        const isMap = S.settings.marketView === 'heatmap';
        $('#tableWrap', root).hidden = isMap;
        $('#heatWrap', root).hidden = !isMap;
        if (isMap) renderHeatmap(list);
        else renderTable(list);
        renderTabsCounts();
        renderCompareChips();
    }

    function renderTabsCounts() {
        $$('.tab[data-tab]', root).forEach((b) => {
            const c = $('.tab-count', b);
            if (c) c.textContent = tabSymbols(b.dataset.tab).length;
        });
    }

    // Atualização leve a cada preço novo: só textos que mudam, sem redesenhar a tabela.
    let lastHeat = 0;
    function onPrices() {
        if (!root) return;
        if (S.settings.marketView === 'heatmap') {
            if (Date.now() - lastHeat > 3000) { lastHeat = Date.now(); renderHeatmap(visibleSymbols()); }
            return;
        }
        $$('#marketBody tr[data-symbol]', root).forEach((tr) => {
            const symbol = tr.dataset.symbol;
            const now = priceNow(symbol);
            if (!now) return;
            const priceCell = $('[data-cell="price"]', tr);
            const next = fmt.money(now);
            if (priceCell.textContent !== next) {
                const prev = Number(priceCell.dataset.raw);
                priceCell.textContent = next;
                if (prev) {
                    priceCell.classList.remove('tick-up', 'tick-down');
                    void priceCell.offsetWidth;
                    priceCell.classList.add(now >= prev ? 'tick-up' : 'tick-down');
                }
                priceCell.dataset.raw = now;
            }
            const ch = changeFor(symbol);
            $('[data-cell="change"]', tr).innerHTML = html`<span class="delta delta-${toneOf(ch)}">${ch === null ? '—' : fmt.pct(ch)}</span>`;
            const vb = vsBtc(symbol);
            $('[data-cell="vsbtc"]', tr).innerHTML = html`<span class="delta-${toneOf(vb)}">${vb === null ? '—' : fmt.pct(vb, 1)}</span>`;
            $('[data-cell="target"]', tr).innerHTML = targetCell(symbol);
        });
        renderBreadth(tabSymbols(tab));
    }

    // ---------- Comparador ----------
    function defaultPicks() {
        const list = tabSymbols(tab);
        const picks = list.slice(0, 3);
        if (!picks.includes('BTC') && list.length) picks.splice(Math.min(2, picks.length), picks.length >= 3 ? 1 : 0, 'BTC');
        return [...new Set(picks.length ? picks : ['BTC', 'ETH'])].slice(0, MAX_COMPARE);
    }

    function renderCompareChips() {
        const el = $('#compareChips', root);
        if (!el) return;
        if (!compare.picked) compare.picked = defaultPicks();
        const pool = [...new Set([...compare.picked, ...tabSymbols(tab), 'BTC'])];
        el.innerHTML = pool.map((s) => {
            const on = compare.picked.includes(s);
            return html`<button type="button" class="pick${on ? ' is-on' : ''}" data-pick="${s}" aria-pressed="${on}" style="--coin:${App.coins.meta(s).color}">${raw(App.coins.avatar(s, 18))}${s}</button>`;
        }).join('');
    }

    function drawCompare() {
        const box = $('#compareChart', root);
        const legend = $('#compareLegend', root);
        if (!box || !window.LightweightCharts) return;
        compare.chart?.remove();
        compare.chart = null;
        box.innerHTML = '';
        const p = period();
        const lines = [];
        compare.picked.forEach((s) => {
            const d = data[s];
            const rows = p === '24h' ? d?.h1 : d?.d1?.slice(-(PERIODS[p].days + 1));
            if (!rows || rows.length < 2) return;
            const base = rows[0].close;
            lines.push({ symbol: s, points: rows.map((r) => ({ time: r.time, value: (r.close / base) * 100 })) });
        });
        if (!lines.length) {
            box.innerHTML = '<p class="empty-cell">Carregando histórico…</p>';
            legend.innerHTML = '';
            return;
        }
        compare.chart = window.LightweightCharts.createChart(box, App.charts.chartOptions({
            handleScroll: false,
            handleScale: false,
            timeScale: { borderColor: App.charts.css('--line'), timeVisible: p === '24h' },
            localization: { locale: 'pt-BR', priceFormatter: (v) => `${fmt.number(v - 100, 1)}%` },
        }));
        lines.forEach((l) => {
            const series = compare.chart.addLineSeries({ color: App.coins.meta(l.symbol).color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: l.symbol });
            series.setData(l.points);
        });
        const zero = compare.chart.addLineSeries({ color: App.charts.css('--ink-3'), lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        zero.setData([{ time: lines[0].points[0].time, value: 100 }, { time: lines[0].points.at(-1).time, value: 100 }]);
        compare.chart.timeScale().fitContent();
        const ranked = lines.map((l) => ({ s: l.symbol, v: l.points.at(-1).value - 100 })).sort((a, b) => b.v - a.v);
        legend.innerHTML = ranked.map((r, i) => html`<li><i style="background:${App.coins.meta(r.s).color}"></i><strong>${r.s}</strong> <span class="delta-${toneOf(r.v)}">${fmt.pct(r.v, 1)}</span>${raw(i === 0 && ranked.length > 1 ? ' <span class="chip chip-up">melhor</span>' : '')}</li>`).join('');
    }

    const scheduleCompare = debounce(() => { if (root && $('#compareDetails', root)?.open) drawCompare(); }, 250);

    // ---------- Eventos ----------
    function setTab(id) {
        tab = id;
        sort = { key: 'manual', dir: 1 };
        compare.picked = null;
        history.replaceState(null, '', `#/mercado/${encodeURIComponent(id)}`);
        renderTabs();
        renderBody();
        scheduleCompare();
    }

    function onTabsClick(event) {
        const t = event.target.closest('[data-tab]');
        if (t) { setTab(t.dataset.tab); return; }
        if (event.target.closest('[data-act="new-list"]')) App.openListDialog(null, (id) => setTab(id));
    }

    function onMenuClick(event) {
        const act = event.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        const i = S.tabs.indexOf(tab);
        if (act === 'fav') { store.setFavorite(tab); toast(`“${tabName(tab)}” agora abre primeiro.`); }
        if (act === 'tab-left') store.moveTab(tab, i - 1);
        if (act === 'tab-right') store.moveTab(tab, i + 1);
        if (act === 'edit-list') App.openListDialog(tab);
        if (act === 'add-coin') App.openSearch('add', tab);
    }

    function onTableClick(event) {
        const note = event.target.closest('[data-note]')?.dataset.note;
        if (note) { App.openNote(note); return; }
        const rem = event.target.closest('[data-remove]')?.dataset.remove;
        if (rem) {
            store.removeFromList(tab, rem);
            const elsewhere = store.listsOf(rem).length;
            toast(`${rem} saiu de “${tabName(tab)}”${elsewhere ? ', mas continua em outra lista' : ''}.`);
        }
    }

    function onHandleKey(event) {
        const symbol = event.target.closest('[data-handle]')?.dataset.handle;
        if (!symbol || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const list = store.getList(tab).symbols;
        const i = list.indexOf(symbol);
        store.moveInList(tab, symbol, i + (event.key === 'ArrowUp' ? -1 : 1));
        requestAnimationFrame(() => $(`[data-handle="${symbol}"]`, root)?.focus());
    }

    function wireRowDrag() {
        const body = $('#marketBody', root);
        body.addEventListener('dragstart', (event) => {
            const tr = event.target.closest('tr[data-symbol]');
            if (!tr || !canReorder()) return;
            dragSymbol = tr.dataset.symbol;
            tr.classList.add('is-dragging');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', dragSymbol);
        });
        body.addEventListener('dragover', (event) => {
            if (!dragSymbol) return;
            event.preventDefault();
            const tr = event.target.closest('tr[data-symbol]');
            $$('tr.drop-before, tr.drop-after', body).forEach((r) => r.classList.remove('drop-before', 'drop-after'));
            if (!tr || tr.dataset.symbol === dragSymbol) return;
            const box = tr.getBoundingClientRect();
            tr.classList.add(event.clientY < box.top + box.height / 2 ? 'drop-before' : 'drop-after');
        });
        body.addEventListener('drop', (event) => {
            if (!dragSymbol) return;
            event.preventDefault();
            const tr = event.target.closest('tr[data-symbol]');
            const symbol = dragSymbol;
            dragSymbol = null;
            if (!tr || tr.dataset.symbol === symbol) { renderBody(); return; }
            const list = store.getList(tab).symbols.filter((s) => s !== symbol);
            let index = list.indexOf(tr.dataset.symbol);
            if (tr.classList.contains('drop-after')) index += 1;
            store.moveInList(tab, symbol, index);
        });
        body.addEventListener('dragend', () => {
            dragSymbol = null;
            $$('tr', body).forEach((r) => r.classList.remove('is-dragging', 'drop-before', 'drop-after'));
        });
    }

    function wireTabDrag() {
        const el = $('#tabs', root);
        let dragTab = null;
        el.addEventListener('dragstart', (event) => {
            const t = event.target.closest('[data-tab]');
            if (!t) return;
            dragTab = t.dataset.tab;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', dragTab);
        });
        el.addEventListener('dragover', (event) => {
            if (dragTab) event.preventDefault();
        });
        el.addEventListener('drop', (event) => {
            const t = event.target.closest('[data-tab]');
            if (!dragTab || !t || t.dataset.tab === dragTab) { dragTab = null; return; }
            event.preventDefault();
            const box = t.getBoundingClientRect();
            const targetIndex = S.tabs.indexOf(t.dataset.tab);
            const from = S.tabs.indexOf(dragTab);
            let to = targetIndex + (event.clientX > box.left + box.width / 2 ? 1 : 0);
            if (from < to) to -= 1;
            store.moveTab(dragTab, to);
            dragTab = null;
        });
    }

    function onSort(event) {
        const th = event.target.closest('th[data-sort]');
        if (!th) return;
        const key = th.dataset.sort;
        if (sort.key === key) {
            sort.dir = -sort.dir;
            if (sort.dir === (key === 'name' || key === 'signal' ? 1 : -1)) sort = { key: 'manual', dir: 1 };
        } else {
            sort = { key, dir: key === 'name' || key === 'signal' ? 1 : -1 };
        }
        renderBody();
    }

    // ---------- Montagem ----------
    App.views.mercado = {
        title: 'Mercado',
        mount(el, params) {
            root = el;
            const wanted = params[0] ? decodeURIComponent(params[0]) : null;
            tab = S.tabs.includes(wanted) ? wanted : (S.tabs.includes(S.favoriteTab) ? S.favoriteTab : S.tabs[0]);
            sort = { key: 'manual', dir: 1 };
            filter = { text: '', signal: 'all' };
            compare = { picked: null, chart: null };
            const per = period();
            el.innerHTML = html`
                <header class="page-head">
                    <div>
                        <h1>Mercado</h1>
                        <div id="breadth" class="breadth"></div>
                    </div>
                </header>
                <div class="tabs-row">
                    <div id="tabs" class="tabs" role="tablist" aria-label="Listas"></div>
                </div>
                <div id="tabMenu" class="tab-menu"></div>
                <section class="panel">
                    <div class="market-tools">
                        <div id="periodSwitch" class="seg seg-soft" role="group" aria-label="Período da variação">
                            ${raw(Object.entries(PERIODS).map(([k, v]) => html`<button type="button" data-period="${k}" aria-pressed="${per === k}">${k === '1y' ? '1 ano' : v.label}</button>`).join(''))}
                        </div>
                        <div id="viewSwitch" class="seg seg-soft" role="group" aria-label="Visualização">
                            <button type="button" data-viewmode="table" aria-pressed="${S.settings.marketView !== 'heatmap'}">Tabela</button>
                            <button type="button" data-viewmode="heatmap" aria-pressed="${S.settings.marketView === 'heatmap'}">Mapa</button>
                        </div>
                        <label class="sr-only" for="heatSize">Tamanho dos blocos</label>
                        <select id="heatSize" class="input input-small" ${S.settings.marketView === 'heatmap' ? '' : 'hidden'}>
                            <option value="volume" ${S.settings.heatSize === 'volume' ? 'selected' : ''}>Tamanho: volume 24h</option>
                            <option value="position" ${S.settings.heatSize === 'position' ? 'selected' : ''}>Tamanho: valor na carteira</option>
                            <option value="equal" ${S.settings.heatSize === 'equal' ? 'selected' : ''}>Tamanho: igual</option>
                        </select>
                        <span class="spacer"></span>
                        <label class="sr-only" for="filterText">Filtrar nesta lista</label>
                        <input id="filterText" class="input input-small" type="search" placeholder="Filtrar nesta lista" autocomplete="off">
                        <label class="sr-only" for="filterSignal">Filtrar por sinal</label>
                        <select id="filterSignal" class="input input-small">
                            <option value="all">Todos os sinais</option>
                            <option value="Aportar reforçado">Com desconto</option>
                            <option value="Aporte normal">Normal</option>
                            <option value="Esperar recuo">Esticadas</option>
                        </select>
                    </div>
                    <div id="tableWrap" class="table-wrap">
                        <table class="market-table">
                            <thead>
                                <tr>
                                    <th class="col-drag" scope="col"><span class="sr-only">Ordem</span></th>
                                    <th data-sort="name" scope="col">Cripto</th>
                                    <th data-sort="price" class="col-num" scope="col">Preço</th>
                                    <th data-sort="change" class="col-num" scope="col" id="colChange">30 dias</th>
                                    <th class="col-spark" scope="col">Gráfico</th>
                                    <th data-sort="vsbtc" class="col-num col-vsbtc" scope="col" title="Desempenho no período comparado ao Bitcoin">vs BTC</th>
                                    <th data-sort="ath" class="col-num col-ath" scope="col" title="Distância da máxima desde que a cripto está na Binance">Da máxima</th>
                                    <th data-sort="target" class="col-num col-target" scope="col" title="Preço que você quer pagar">Meu preço</th>
                                    <th data-sort="signal" scope="col" title="Leitura do gráfico diário: desconto, normal ou esticado">Sinal</th>
                                    <th class="col-actions" scope="col"><span class="sr-only">Ações</span></th>
                                </tr>
                            </thead>
                            <tbody id="marketBody"></tbody>
                        </table>
                    </div>
                    <div id="heatWrap" class="heat-wrap" hidden>
                        <div id="heatmap" class="heatmap"></div>
                    </div>
                    <p class="footnote">“Da máxima” considera o histórico na Binance. Sinal calculado no gráfico diário, ajustado à volatilidade de cada cripto. Não é recomendação de investimento.</p>
                </section>
                <details id="compareDetails" class="panel compare">
                    <summary><h2 class="panel-title">Comparar desempenho</h2><span class="muted small">Base 100 no início do período escolhido acima</span></summary>
                    <div id="compareChips" class="picks"></div>
                    <div id="compareChart" class="chart-compare"></div>
                    <ul id="compareLegend" class="compare-legend"></ul>
                </details>`;

            $('#tabs', el).addEventListener('click', onTabsClick);
            $('#tabMenu', el).addEventListener('click', onMenuClick);
            $('#marketBody', el).addEventListener('click', onTableClick);
            $('#marketBody', el).addEventListener('keydown', onHandleKey);
            $('thead', el).addEventListener('click', onSort);
            wireRowDrag();
            wireTabDrag();
            $('#periodSwitch', el).addEventListener('click', (event) => {
                const b = event.target.closest('[data-period]');
                if (!b) return;
                S.settings.marketPeriod = b.dataset.period;
                store.save();
                $$('#periodSwitch button', el).forEach((x) => x.setAttribute('aria-pressed', x === b));
                renderBody();
                scheduleCompare();
            });
            $('#viewSwitch', el).addEventListener('click', (event) => {
                const b = event.target.closest('[data-viewmode]');
                if (!b) return;
                S.settings.marketView = b.dataset.viewmode;
                store.save();
                $$('#viewSwitch button', el).forEach((x) => x.setAttribute('aria-pressed', x === b));
                $('#heatSize', el).hidden = S.settings.marketView !== 'heatmap';
                renderBody();
            });
            $('#heatSize', el).addEventListener('change', (event) => {
                S.settings.heatSize = event.target.value;
                store.save();
                renderBody();
            });
            $('#filterText', el).addEventListener('input', debounce((event) => { filter.text = event.target.value.trim(); renderBody(); }, 150));
            $('#filterSignal', el).addEventListener('change', (event) => { filter.signal = event.target.value; renderBody(); });
            $('#compareDetails', el).addEventListener('toggle', () => { if ($('#compareDetails', el).open) drawCompare(); });
            $('#compareChips', el).addEventListener('click', (event) => {
                const b = event.target.closest('[data-pick]');
                if (!b) return;
                const s = b.dataset.pick;
                if (compare.picked.includes(s)) {
                    if (compare.picked.length === 1) return;
                    compare.picked = compare.picked.filter((x) => x !== s);
                } else {
                    if (compare.picked.length >= MAX_COMPARE) { toast(`Compare até ${MAX_COMPARE} criptos por vez.`); return; }
                    compare.picked = [...compare.picked, s];
                }
                renderCompareChips();
                enqueue(compare.picked, period() === '24h');
                scheduleCompare();
            });

            renderTabs();
            renderBody();
            offs = [
                bus.on('prices', onPrices),
                bus.on('lists', () => { if (!S.tabs.includes(tab)) tab = S.favoriteTab; renderTabs(); renderBody(); }),
                bus.on('notes', renderBody),
                bus.on('alerts', () => { renderTabsCounts(); if (tab === 'smart:alerts') renderBody(); }),
                bus.on('transactions', () => { renderTabsCounts(); if (tab === 'smart:portfolio') renderBody(); }),
                bus.on('settings', renderBody),
                bus.on('theme', () => scheduleCompare()),
            ];
        },
        unmount() {
            offs.forEach((off) => off());
            offs = [];
            compare.chart?.remove();
            compare.chart = null;
            root = null;
        },
    };
})(window.App);
