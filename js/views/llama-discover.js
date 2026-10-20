// Seções da DefiLlama dentro de "Descobrir pools": fluxo de capital, protocolos
// em alta, volume e taxas completos por app e rendimento médio de 30 dias.
window.App = window.App || {};

(function (App) {
    const { $, $$, html, raw, fmt, bus, toneOf, toast, debounce } = App.util;
    const L = () => App.llama;
    let root = null;
    let offs = [];
    let chain = 'all';
    let state = { flows: {}, tvl: null, stables: null, protocols: null, dexs: null, fees: null, pools: null, errors: [] };
    let yv = { sort: 'mean', minTvl: 1e6, project: 'all', stableOnly: false, noIl: false, text: '' };
    let histChart = null;

    const name = (k) => App.web3.CHAINS[k]?.name ?? k;
    const badge = (k) => html`<span class="chain-badge" style="--c:${App.web3.CHAINS[k]?.color ?? 'var(--ink-3)'}">${name(k)}</span>`;
    const pct = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : fmt.pct(v, 1));
    const money = (v) => (Number.isFinite(v) ? fmt.compactMoney(v) : '—');

    function inScope(k) { return chain === 'all' || chain === k; }

    // ---------- Fluxo de capital ----------
    function renderFlows() {
        const el = $('#llFlows', root);
        const keys = L().ours.filter(inScope);
        if (el) el.innerHTML = keys.map((k) => {
            const f = state.flows[k];
            const tvl = f?.tvl?.now ?? state.tvl?.[k];
            const st = f?.stables?.now ?? state.stables?.[k];
            return html`<article class="ll-flow" style="--c:${App.web3.CHAINS[k].color}">
                <span class="ll-flow-name">${name(k)}</span>
                <div><span class="muted small">TVL</span><strong>${money(tvl)}</strong><span class="small"><span class="delta-${toneOf(f?.tvl?.ch7)}">${pct(f?.tvl?.ch7)}</span> <span class="muted">7d</span> · <span class="delta-${toneOf(f?.tvl?.ch30)}">${pct(f?.tvl?.ch30)}</span> <span class="muted">30d</span></span></div>
                <div><span class="muted small">Stablecoins</span><strong>${money(st)}</strong><span class="small"><span class="delta-${toneOf(f?.stables?.ch7)}">${pct(f?.stables?.ch7)}</span> <span class="muted">7d</span> · <span class="delta-${toneOf(f?.stables?.ch30)}">${pct(f?.stables?.ch30)}</span> <span class="muted">30d</span></span></div>
            </article>`;
        }).join('');
        const ranked = L().ours.map((k) => ({ k, v: state.flows[k]?.stables?.ch7 })).filter((x) => Number.isFinite(x.v)).sort((a, b) => b.v - a.v);
        const note = $('#llFlowNote', root);
        if (note) note.textContent = ranked.length
            ? `Mais stablecoins entrando na semana: ${ranked.slice(0, 3).map((x) => `${name(x.k)} (${pct(x.v)})`).join(', ')}. Stablecoins chegando costumam indicar capital novo para negociar e montar pools.`
            : 'Carregando variações…';
    }

    function renderProtocols() {
        const el = $('#llProtocols', root);
        if (!el || !state.protocols) return;
        const list = state.protocols
            .map((p) => ({ ...p, scopedTvl: chain === 'all' ? p.tvl : p.chains[chain] ?? 0 }))
            .filter((p) => p.scopedTvl >= 5e6 && Number.isFinite(p.ch7));
        const up = [...list].sort((a, b) => b.ch7 - a.ch7).slice(0, 8);
        const down = [...list].sort((a, b) => a.ch7 - b.ch7).slice(0, 5);
        const row = (p) => html`<li><span><strong>${p.name}</strong> <span class="muted small">${p.category ?? ''}</span></span><span class="muted small">${money(p.scopedTvl)}</span><span class="delta-${toneOf(p.ch7)}">${pct(p.ch7)}</span></li>`;
        el.innerHTML = html`<div><h3 class="w3-h3">Ganhando TVL na semana</h3><ul class="ll-list">${raw(up.map(row).join(''))}</ul></div>
            <div><h3 class="w3-h3">Perdendo TVL na semana</h3><ul class="ll-list">${raw(down.map(row).join(''))}</ul></div>`;
    }

    // ---------- Volume e taxas por app ----------
    function renderApps() {
        const el = $('#llApps', root);
        if (!el) return;
        if (!state.dexs) { el.innerHTML = '<p class="muted">Carregando volumes da DefiLlama…</p>'; return; }
        const feesBy = new Map((state.fees ?? []).map((f) => [f.slug ?? f.name, f]));
        const feesByName = new Map((state.fees ?? []).map((f) => [f.name, f]));
        const vol = (p) => (chain === 'all' ? p.total24h : p.byChain[chain] ?? 0);
        const rows = state.dexs.map((p) => {
            const f = feesBy.get(p.slug) ?? feesByName.get(p.name);
            return { ...p, v: vol(p), fee: f ? (chain === 'all' ? f.total24h : f.byChain[chain] ?? null) : null, feeCh7: f?.ch7 ?? null };
        }).filter((p) => p.v > 0).sort((a, b) => b.v - a.v).slice(0, 15);
        const max = Math.max(1, ...rows.map((r) => r.v));
        el.innerHTML = html`<div class="table-wrap"><table class="data-table">
            <thead><tr><th>App</th><th></th><th class="col-num">Volume 24h</th><th class="col-num">Var. 7d</th><th class="col-num">Taxas 24h</th><th class="col-num">Taxas / volume</th></tr></thead>
            <tbody>${raw(rows.map((r) => html`<tr>
                <td><strong>${r.name}</strong></td>
                <td class="ll-bar-cell"><span class="ds-app-bar"><i style="width:${(r.v / max) * 100}%"></i></span></td>
                <td class="col-num">${money(r.v)}</td>
                <td class="col-num delta-${toneOf(r.ch7)}">${pct(r.ch7)}</td>
                <td class="col-num">${r.fee ? money(r.fee) : '—'}</td>
                <td class="col-num">${r.fee && r.v ? `${fmt.number((r.fee / r.v) * 100, 2)}%` : '—'}</td>
            </tr>`).join(''))}</tbody></table></div>
            <p class="footnote">Totais do app inteiro (todas as pools), segundo a DefiLlama. “Taxas / volume” é a taxa média cobrada por negociação.${chain !== 'all' ? ' Volume por rede; a variação de 7 dias e as taxas são do app em todas as redes quando a DefiLlama não separa por rede.' : ''}</p>`;
    }

    // ---------- Rendimento médio de 30 dias ----------
    function yieldRows() {
        if (!state.pools) return [];
        const q = yv.text.trim().toUpperCase();
        let list = state.pools.filter((p) => inScope(p.chain) && p.tvl >= yv.minTvl && Number.isFinite(p.apy));
        if (yv.project !== 'all') list = list.filter((p) => p.project === yv.project);
        if (yv.stableOnly) list = list.filter((p) => p.stable);
        if (yv.noIl) list = list.filter((p) => p.ilRisk === 'no');
        if (q) list = list.filter((p) => `${p.symbol} ${p.project}`.toUpperCase().includes(q));
        const key = { mean: (p) => p.apyMean30d ?? -1, apy: (p) => p.apy ?? -1, tvl: (p) => p.tvl, fees: (p) => p.apyBase ?? -1 }[yv.sort];
        return list.sort((a, b) => key(b) - key(a)).slice(0, 60);
    }

    function renderYields() {
        const el = $('#llYields', root);
        if (!el) return;
        if (!state.pools) { el.innerHTML = '<p class="muted">Carregando rendimentos da DefiLlama (arquivo grande, só na primeira vez)…</p>'; return; }
        const projects = [...new Set(state.pools.filter((p) => inScope(p.chain)).map((p) => p.project))].sort();
        $('#llProject', root).innerHTML = html`<option value="all">Todos os protocolos</option>${raw(projects.map((p) => html`<option ${p === yv.project ? 'selected' : ''}>${p}</option>`).join(''))}`;
        const rows = yieldRows();
        el.innerHTML = rows.length ? html`<div class="table-wrap"><table class="data-table ds-table">
            <thead><tr><th>Pool</th><th>Rede</th><th class="col-num">Liquidez</th><th class="col-num">Taxas (APY)</th><th class="col-num">Recompensas</th><th class="col-num">Total agora</th><th class="col-num">Média 30 dias</th><th>Risco</th><th class="col-actions"></th></tr></thead>
            <tbody>${raw(rows.map((p) => {
                const drop = p.apyMean30d && p.apy ? p.apy / p.apyMean30d : null;
                return html`<tr>
                    <td><strong>${p.symbol}</strong><small class="muted">${p.project}${p.meta ? ` · ${p.meta}` : ''}</small></td>
                    <td>${raw(badge(p.chain))}</td>
                    <td class="col-num">${money(p.tvl)}</td>
                    <td class="col-num">${pct(p.apyBase)}</td>
                    <td class="col-num">${p.apyReward ? pct(p.apyReward) : '—'}</td>
                    <td class="col-num">${pct(p.apy)}</td>
                    <td class="col-num"><strong>${pct(p.apyMean30d)}</strong>${raw(drop !== null && (drop > 2 || drop < 0.5) ? html`<small class="${drop > 2 ? 'delta-up' : 'delta-down'}">${drop > 2 ? 'agora bem acima da média' : 'agora bem abaixo da média'}</small>` : '')}</td>
                    <td>${raw([p.stable ? '<span class="chip chip-up">stablecoin</span>' : '', p.ilRisk === 'yes' ? '<span class="chip chip-warn">perda impermanente</span>' : '', p.apyReward && p.apyBase !== null && p.apyReward > (p.apyBase ?? 0) * 2 ? '<span class="chip chip-down" title="A maior parte do rendimento vem de recompensas em token, que podem cair de preço">depende de recompensa</span>' : ''].join(' ') || '<span class="muted">—</span>')}</td>
                    <td class="col-actions"><button class="btn btn-small btn-ghost" type="button" data-hist="${p.id}">Histórico</button></td>
                </tr>
                <tr class="ll-hist-row" data-hist-row="${p.id}" hidden><td colspan="9"><div class="ll-hist" id="hist-${p.id}"></div></td></tr>`;
            }).join(''))}</tbody></table></div>` : '<p class="muted">Nenhuma pool com esses filtros.</p>';
    }

    async function toggleHistory(id) {
        const row = $(`[data-hist-row="${id}"]`, root);
        if (!row) return;
        if (!row.hidden) { row.hidden = true; histChart?.remove(); histChart = null; return; }
        $$('.ll-hist-row', root).forEach((r) => { r.hidden = true; });
        row.hidden = false;
        const box = $(`#hist-${CSS.escape(id)}`, root);
        box.innerHTML = '<p class="muted">Carregando histórico…</p>';
        try {
            const data = await L().poolHistory(id);
            if (!root || row.hidden) return;
            box.innerHTML = '';
            histChart?.remove();
            histChart = window.LightweightCharts.createChart(box, App.charts.chartOptions({ handleScroll: false, handleScale: false, timeScale: { borderColor: App.charts.css('--line'), timeVisible: false }, leftPriceScale: { visible: true, borderColor: App.charts.css('--line') } }));
            const apy = histChart.addLineSeries({ color: App.charts.css('--brand'), lineWidth: 2, priceLineVisible: false, title: 'APY %' });
            const tvl = histChart.addAreaSeries({ priceScaleId: 'left', lineColor: App.charts.css('--ink-3'), topColor: 'rgba(124,131,153,0.25)', bottomColor: 'rgba(124,131,153,0.02)', lineWidth: 1, priceLineVisible: false, title: 'Liquidez' });
            const pts = data.filter((d) => Number.isFinite(d.t)).map((d) => ({ ...d, time: Math.floor(d.t / 1000) }));
            apy.setData(pts.filter((d) => Number.isFinite(d.apy)).map((d) => ({ time: d.time, value: d.apy })));
            tvl.setData(pts.filter((d) => Number.isFinite(d.tvl)).map((d) => ({ time: d.time, value: d.tvl })));
            tvl.applyOptions({ priceFormat: { type: 'custom', formatter: (v) => fmt.compactMoney(v) } });
            histChart.timeScale().fitContent();
        } catch (error) {
            box.innerHTML = html`<p class="muted">Não consegui carregar o histórico: ${error.message}</p>`;
        }
    }

    function renderAll() {
        renderFlows();
        renderProtocols();
        renderApps();
        renderYields();
        bus.emit('llama-update');
        const err = $('#llStatus', root);
        if (err) err.textContent = state.errors.length ? `Algumas consultas à DefiLlama falharam: ${[...new Set(state.errors)].join('; ')}` : '';
    }

    async function load() {
        const run = (p, set) => p.then((v) => { set(v); if (root) renderAll(); }).catch((e) => { state.errors.push(e.message); if (root) renderAll(); });
        await Promise.all([
            run(L().chainTvlNow(), (v) => { state.tvl = v; }),
            run(L().stablesNow(), (v) => { state.stables = v; }),
            run(L().overview('dexs'), (v) => { state.dexs = v; }),
            run(L().overview('fees'), (v) => { state.fees = v; }),
        ]);
        await run(L().protocols(), (v) => { state.protocols = v; });
        await run(L().yieldPools(), (v) => { state.pools = v; });
        for (const k of L().ours) {
            if (!root) return;
            await run(L().chainFlow(k), (v) => { state.flows[k] = v; });
        }
    }

    App.llamaDiscover = {
        state: null,
        mount(el, opts = {}) {
            root = el;
            this.state = state;
            if (!opts.bind) el.innerHTML = html`
                <section class="panel">
                    <div class="panel-bar"><h2 class="panel-title">Fluxo de capital</h2><span class="muted small">DefiLlama</span></div>
                    <div id="llFlows" class="ll-flows"></div>
                    <p id="llFlowNote" class="footnote"></p>
                    <div id="llProtocols" class="ll-protocols"></div>
                </section>
                <section class="panel">
                    <div class="panel-bar"><h2 class="panel-title">Volume e taxas por app</h2><span class="muted small">DefiLlama · app inteiro</span></div>
                    <div id="llApps"></div>
                </section>
                <section class="panel">
                    <div class="panel-bar"><h2 class="panel-title">Rendimento médio de 30 dias</h2><span class="muted small">DefiLlama</span></div>
                    <div class="ds-tools">
                        <div id="llSort" class="seg seg-soft" role="group" aria-label="Ordenar rendimentos">
                            <button type="button" data-ysort="mean" aria-pressed="true">Média 30 dias</button>
                            <button type="button" data-ysort="fees" aria-pressed="false">Só taxas</button>
                            <button type="button" data-ysort="apy" aria-pressed="false">Total agora</button>
                            <button type="button" data-ysort="tvl" aria-pressed="false">Liquidez</button>
                        </div>
                        <label class="sr-only" for="llProject">Protocolo</label>
                        <select id="llProject" class="input input-small"></select>
                        <label class="sr-only" for="llMin">Liquidez mínima</label>
                        <select id="llMin" class="input input-small">${raw([[1e5, 'Liquidez ≥ US$ 100 mil'], [1e6, 'Liquidez ≥ US$ 1 mi'], [1e7, 'Liquidez ≥ US$ 10 mi']].map(([v, l]) => html`<option value="${v}" ${yv.minTvl === v ? 'selected' : ''}>${l}</option>`).join(''))}</select>
                        <label class="switch"><input type="checkbox" id="llStable"><span>Só stablecoins</span></label>
                        <label class="switch"><input type="checkbox" id="llNoIl"><span>Sem perda impermanente</span></label>
                        <input id="llText" class="input input-small" type="search" placeholder="Buscar token ou protocolo" autocomplete="off">
                    </div>
                    <div id="llYields"></div>
                    <p class="footnote">APY anualizado com juros compostos, como a DefiLlama publica. “Taxas” vem das negociações; “recompensas” são tokens extras do protocolo e mudam com o preço desses tokens. A média de 30 dias mostra o que a pool realmente vem pagando, sem o efeito de um dia atípico.</p>
                </section>
                <p id="llStatus" class="footnote delta-down"></p>`;
            el.addEventListener('click', (event) => {
                const s = event.target.closest('[data-ysort]')?.dataset.ysort;
                if (s) { yv.sort = s; $$('#llSort button', el).forEach((b) => b.setAttribute('aria-pressed', b.dataset.ysort === s)); renderYields(); }
                const h = event.target.closest('[data-hist]')?.dataset.hist;
                if (h) toggleHistory(h);
            });
            $('#llProject', el).addEventListener('change', (e) => { yv.project = e.target.value; renderYields(); });
            $('#llMin', el).addEventListener('change', (e) => { yv.minTvl = Number(e.target.value); renderYields(); });
            $('#llStable', el).addEventListener('change', (e) => { yv.stableOnly = e.target.checked; renderYields(); });
            $('#llNoIl', el).addEventListener('change', (e) => { yv.noIl = e.target.checked; renderYields(); });
            $('#llText', el).addEventListener('input', debounce((e) => { yv.text = e.target.value; renderYields(); }, 150));
            offs = [bus.on('discover-chain', (c) => { chain = c; yv.project = 'all'; renderAll(); })];
            renderAll();
            load();
        },
        unmount() {
            offs.forEach((o) => o());
            offs = [];
            histChart?.remove();
            histChart = null;
            root = null;
        },
    };
})(window.App);
