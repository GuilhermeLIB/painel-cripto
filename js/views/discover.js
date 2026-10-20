// "Descobrir pools": ranking de pools por rede, volume, taxas e app (DEX),
// com destaques automáticos. Fonte: API pública do GeckoTerminal (sem chave).
window.App = window.App || {};

(function (App) {
    const { $, $$, html, raw, fmt, bus, toneOf, toast, debounce } = App.util;
    const store = App.store;
    const S = store.state;

    const GT = 'https://api.geckoterminal.com/api/v2';
    const NETS = {
        ethereum: { gt: 'eth', name: 'Ethereum' },
        arbitrum: { gt: 'arbitrum', name: 'Arbitrum' },
        base: { gt: 'base', name: 'Base' },
        optimism: { gt: 'optimism', name: 'Optimism' },
        polygon: { gt: 'polygon_pos', name: 'Polygon' },
    };
    // Tokens "de primeira linha": usados para o destaque de pools mais seguras.
    const BLUE = new Set(['ETH', 'WETH', 'BTC', 'WBTC', 'CBBTC', 'TBTC', 'USDC', 'USDT', 'DAI', 'USDC.E', 'USDBC', 'STETH', 'WSTETH', 'WEETH', 'CBETH', 'RETH', 'ARB', 'OP', 'POL', 'WPOL', 'WMATIC', 'LINK', 'UNI', 'AAVE', 'USDS', 'USDE', 'GHO']);
    const CACHE_MS = 5 * 60 * 1000;

    let root = null;
    let offs = [];
    let data = { at: 0, pools: [], errors: [] };
    let loading = false;
    let view = { chain: 'all', dex: 'all', sort: 'apr', minTvl: 250000, mine: false, concentrated: false, text: '' };

    // ---------- Coleta ----------
    async function gt(path) {
        const r = await fetch(`${GT}${path}`, { headers: { accept: 'application/json' } });
        if (r.status === 429) throw new Error('limite de consultas do GeckoTerminal; tente em 1 minuto');
        if (!r.ok) throw new Error(`GeckoTerminal HTTP ${r.status}`);
        return r.json();
    }

    function parse(json, chain, trending = false) {
        const inc = new Map((json.included ?? []).map((x) => [x.id, x.attributes]));
        return (json.data ?? []).map((p) => {
            const a = p.attributes;
            const base = inc.get(p.relationships?.base_token?.data?.id) ?? {};
            const quote = inc.get(p.relationships?.quote_token?.data?.id) ?? {};
            const dexId = p.relationships?.dex?.data?.id ?? '';
            const dex = inc.get(p.relationships?.dex?.data?.id)?.name ?? dexId;
            const feeMatch = String(a.name).match(/(\d+(?:[.,]\d+)?)\s*%/);
            const fee = feeMatch ? Number(feeMatch[1].replace(',', '.')) : null;
            const tvl = Number(a.reserve_in_usd) || 0;
            const v = a.volume_usd ?? {};
            const tx = a.transactions ?? {};
            const vol24 = Number(v.h24) || 0;
            const vol6 = Number(v.h6) || 0;
            const vol1 = Number(v.h1) || 0;
            const buys = (tx.h24?.buys ?? 0);
            const sells = (tx.h24?.sells ?? 0);
            const created = a.pool_created_at ? Date.parse(a.pool_created_at) : null;
            return {
                id: `${chain}:${a.address}`,
                chain, address: a.address, name: a.name,
                base: (base.symbol || a.name.split('/')[0] || '?').trim(),
                quote: (quote.symbol || (a.name.split('/')[1] || '?').replace(/[\d.,]+%/, '')).trim(),
                baseAddr: base.address, quoteAddr: quote.address,
                dexId, dex, fee, tvl, vol24, vol6, vol1,
                apr: fee !== null && tvl > 0 ? (vol24 * fee / 100 / tvl) * 365 * 100 : null,
                apr6: fee !== null && tvl > 0 ? (vol6 * 4 * fee / 100 / tvl) * 365 * 100 : null,
                turnover: tvl ? vol24 / tvl : 0,
                accel: vol24 ? (vol6 * 4) / vol24 : 0,
                buyShare: buys + sells ? buys / (buys + sells) : null,
                txs: buys + sells,
                priceChange: Number(a.price_change_percentage?.h24) || 0,
                ageDays: created ? (Date.now() - created) / 86400000 : null,
                concentrated: /v3|slipstream|_cl|clmm|v4|algebra/i.test(dexId),
                trending,
            };
        });
    }

    async function load(force = false) {
        if (loading) return;
        if (!force && data.pools.length && Date.now() - data.at < CACHE_MS) { render(); return; }
        try {
            const cached = JSON.parse(sessionStorage.getItem('gt-pools') || 'null');
            if (!force && cached && Date.now() - cached.at < CACHE_MS) { data = cached; render(); return; }
        } catch { /* sem cache */ }
        loading = true;
        render();
        const pools = new Map();
        const errors = [];
        // 2 páginas por volume + tendências, por rede (≈15 consultas, dentro do limite de 30/min).
        for (const [chain, n] of Object.entries(NETS)) {
            const jobs = [
                gt(`/networks/${n.gt}/pools?sort=h24_volume_usd_desc&page=1&include=base_token,quote_token,dex`).then((j) => parse(j, chain)),
                gt(`/networks/${n.gt}/pools?sort=h24_volume_usd_desc&page=2&include=base_token,quote_token,dex`).then((j) => parse(j, chain)),
                gt(`/networks/${n.gt}/trending_pools?include=base_token,quote_token,dex`).then((j) => parse(j, chain, true)),
            ];
            const res = await Promise.allSettled(jobs);
            res.forEach((r) => {
                if (r.status === 'fulfilled') r.value.forEach((p) => {
                    const prev = pools.get(p.id);
                    pools.set(p.id, prev ? { ...prev, trending: prev.trending || p.trending } : p);
                });
                else errors.push(`${n.name}: ${r.reason.message}`);
            });
            if (root) { data = { at: Date.now(), pools: [...pools.values()], errors }; render(); }
        }
        data = { at: Date.now(), pools: [...pools.values()], errors: [...new Set(errors)] };
        try { sessionStorage.setItem('gt-pools', JSON.stringify(data)); } catch { /* cheio */ }
        loading = false;
        render();
    }

    // ---------- Filtros e destaques ----------
    const sym = (s) => App.web3.underlying(String(s).toUpperCase());
    function mineSet() {
        const held = store.positions().filter((p) => p.qty > 0).map((p) => p.asset);
        return new Set([...S.watchlist, ...held, ...(S.monthly?.assets ?? []).map((a) => a.symbol)].map((s) => sym(s)));
    }

    // Token "principal" da pool: o lado que não é stablecoin (ou a base, se os dois forem voláteis).
    function mainToken(p) {
        return sym(p.base) === 'USD' ? sym(p.quote) : sym(p.base);
    }

    function risk(p) {
        const out = [];
        if (p.tvl < 500000) out.push('liquidez baixa');
        if (p.ageDays !== null && p.ageDays < 30) out.push('pool nova');
        if (p.turnover > 5) out.push('giro muito alto');
        const bothBlue = BLUE.has(String(p.base).toUpperCase()) && BLUE.has(String(p.quote).toUpperCase());
        if (!bothBlue && Math.abs(p.priceChange) > 15) out.push(`preço ${fmt.pct(p.priceChange, 0)} em 24h`);
        return out;
    }

    function filtered() {
        const mine = mineSet();
        const q = view.text.trim().toUpperCase();
        return data.pools.filter((p) => {
            if (view.chain !== 'all' && p.chain !== view.chain) return false;
            if (view.dex !== 'all' && p.dex !== view.dex) return false;
            if (p.tvl < view.minTvl) return false;
            if (view.concentrated && !p.concentrated) return false;
            if (view.mine && !mine.has(mainToken(p))) return false;
            if (q && !`${p.base}/${p.quote} ${p.dex}`.toUpperCase().includes(q)) return false;
            return true;
        });
    }

    function sorted(list) {
        const key = { apr: (p) => p.apr ?? -1, volume: (p) => p.vol24, tvl: (p) => p.tvl, accel: (p) => p.accel * Math.min(1, p.vol24 / 1e6), turnover: (p) => p.turnover }[view.sort];
        return [...list].sort((a, b) => key(b) - key(a));
    }

    function highlights() {
        const base = data.pools.filter((p) => (view.chain === 'all' || p.chain === view.chain) && p.ageDays !== null && p.ageDays >= 14);
        const solid = base.filter((p) => p.tvl >= 1e6 && p.apr !== null && p.turnover < 5);
        const blue = solid.filter((p) => BLUE.has(String(p.base).toUpperCase()) && BLUE.has(String(p.quote).toUpperCase()));
        const pick = (arr, f, n = 3) => [...arr].sort((a, b) => f(b) - f(a)).slice(0, n);
        return [
            { key: 'fees', title: 'Mais taxas com liquidez sólida', hint: 'APR das taxas em 24h entre pools com mais de US$ 1 milhão e pelo menos 14 dias.', items: pick(solid, (p) => p.apr) },
            { key: 'blue', title: 'Primeira linha', hint: 'Pares só com ativos grandes (ETH, BTC, stablecoins, LSTs, LINK, UNI…): risco menor, ideal para começar.', items: pick(blue, (p) => p.apr) },
            { key: 'volume', title: 'Mais volume', hint: 'Onde mais se negocia: liquidez profunda e taxas constantes.', items: pick(base.filter((p) => p.tvl >= 1e6), (p) => p.vol24) },
            { key: 'flow', title: 'Ganhando força agora', hint: 'Volume das últimas 6 h acima do ritmo do dia e mais compras que vendas.', items: pick(base.filter((p) => p.tvl >= 5e5 && p.vol24 >= 2e5 && (p.buyShare ?? 0) >= 0.5), (p) => p.accel) },
        ];
    }

    // ---------- Render ----------
    function chainBadge(key) {
        const c = App.web3.CHAINS[key];
        return html`<span class="chain-badge" style="--c:${c.color}">${c.name}</span>`;
    }

    function poolLink(p) {
        return `https://www.geckoterminal.com/${NETS[p.chain].gt}/pools/${p.address}`;
    }

    function pairHtml(p) {
        return html`<span class="coin-inline">${raw(App.coins.avatar(sym(p.base) === 'USD' ? p.base.toUpperCase() : sym(p.base), 20))}<strong>${p.base}/${p.quote}</strong></span>`;
    }

    function highlightCard(h) {
        return html`<article class="ds-hl">
            <h3>${h.title}</h3>
            <p class="muted small">${h.hint}</p>
            ${raw(h.items.length ? html`<ol>${raw(h.items.map((p) => html`<li>
                <div>${raw(pairHtml(p))} <span class="muted small">${p.fee !== null ? `${fmt.number(p.fee, 2)}% · ` : ''}${p.dex}</span></div>
                <div class="ds-hl-meta">${raw(chainBadge(p.chain))} <span>APR ${p.apr === null ? '—' : `${fmt.number(p.apr, 0)}%`}</span> <span class="muted">vol. ${fmt.compactMoney(p.vol24)}</span>${raw(risk(p).length ? html` <span class="chip chip-down" title="${risk(p).join(', ')}">risco</span>` : '')}</div>
            </li>`).join(''))}</ol>` : '<p class="muted small">Nada que passe nos critérios agora.</p>')}
        </article>`;
    }

    function render() {
        if (!root) return;
        const dexes = [...new Set(data.pools.filter((p) => view.chain === 'all' || p.chain === view.chain).map((p) => p.dex))].sort();
        const dexSel = $('#dsDex', root);
        dexSel.innerHTML = html`<option value="all">Todos os apps</option>${raw(dexes.map((d) => html`<option ${d === view.dex ? 'selected' : ''}>${d}</option>`).join(''))}`;
        $('#dsStatus', root).innerHTML = loading
            ? html`<span class="muted">Consultando pools… ${data.pools.length ? `${data.pools.length} até agora` : ''}</span>`
            : data.pools.length
                ? html`<span class="muted">${data.pools.length} pools · atualizado às ${fmt.time(new Date(data.at))}</span>${raw(data.errors.length ? html` <span class="delta-down" title="${data.errors.join(' | ')}">· ${data.errors.length} falha(s)</span>` : '')}`
                : html`<span class="muted">${data.errors.length ? `Não consegui consultar: ${data.errors[0]}` : 'Sem dados ainda.'}</span>`;

        // Resumo por rede e por app.
        const byChain = Object.keys(NETS).map((k) => {
            const ps = data.pools.filter((p) => p.chain === k);
            const vol = ps.reduce((a, p) => a + p.vol24, 0);
            const tvl = ps.reduce((a, p) => a + p.tvl, 0);
            const fees = ps.reduce((a, p) => a + (p.fee !== null ? p.vol24 * p.fee / 100 : 0), 0);
            return { k, vol, tvl, fees, n: ps.length };
        });
        $('#dsChains', root).innerHTML = byChain.map((c) => html`<button type="button" class="ds-chain${view.chain === c.k ? ' is-on' : ''}" data-chain="${c.k}" style="--c:${App.web3.CHAINS[c.k].color}">
            <span class="ds-chain-name">${App.web3.CHAINS[c.k].name}</span>
            <strong>${c.n ? fmt.compactMoney(c.vol) : '—'}</strong><span class="muted small">volume 24h</span>
            <span class="small">${c.n ? `${fmt.compactMoney(c.fees)} em taxas · TVL ${fmt.compactMoney(c.tvl)}` : 'sem dados'}</span>
        </button>`).join('') + html`<button type="button" class="ds-chain${view.chain === 'all' ? ' is-on' : ''}" data-chain="all" style="--c:var(--ink-3)"><span class="ds-chain-name">Todas</span><strong>${fmt.compactMoney(byChain.reduce((a, c) => a + c.vol, 0))}</strong><span class="muted small">volume 24h</span><span class="small">${data.pools.length} pools</span></button>`;

        const scoped = data.pools.filter((p) => view.chain === 'all' || p.chain === view.chain);
        const apps = [...new Set(scoped.map((p) => p.dex))].map((d) => {
            const ps = scoped.filter((p) => p.dex === d);
            const vol = ps.reduce((a, p) => a + p.vol24, 0);
            const tvl = ps.reduce((a, p) => a + p.tvl, 0);
            const fees = ps.reduce((a, p) => a + (p.fee !== null ? p.vol24 * p.fee / 100 : 0), 0);
            // APR médio só das pools com taxa conhecida (pools no estilo v2 não trazem a taxa no nome).
            const tvlFee = ps.filter((p) => p.fee !== null).reduce((a, p) => a + p.tvl, 0);
            return { d, vol, tvl, fees, n: ps.length, apr: tvlFee ? fees / tvlFee * 365 * 100 : null };
        }).sort((a, b) => b.vol - a.vol).slice(0, 8);
        const maxVol = Math.max(1, ...apps.map((a) => a.vol));
        $('#dsApps', root).innerHTML = apps.length ? apps.map((a) => html`<li class="${view.dex === a.d ? 'is-on' : ''}" data-dex="${a.d}">
            <span class="ds-app-name">${a.d}</span>
            <span class="ds-app-bar"><i style="width:${(a.vol / maxVol) * 100}%"></i></span>
            <span class="ds-app-num">${fmt.compactMoney(a.vol)}</span>
            <span class="ds-app-num muted">${a.apr === null ? '—' : `${fmt.number(a.apr, 0)}% APR médio`}</span>
        </li>`).join('') : '<li class="muted">—</li>';

        $('#dsHighlights', root).innerHTML = data.pools.length ? highlights().map(highlightCard).join('') : '';

        const list = sorted(filtered()).slice(0, 80);
        const mine = mineSet();
        $('#dsBody', root).innerHTML = list.length ? list.map((p) => {
            const r = risk(p);
            const isMine = mine.has(mainToken(p));
            return html`<tr>
                <td>${raw(pairHtml(p))}${raw(p.trending ? ' <span class="chip chip-warn" title="Em alta no GeckoTerminal">em alta</span>' : '')}${raw(isMine ? ' <span class="chip chip-flat" title="Tem cripto das suas listas ou carteira">sua</span>' : '')}<small class="muted">${p.dex}${p.concentrated ? ' · concentrada' : ''}</small></td>
                <td>${raw(chainBadge(p.chain))}</td>
                <td class="col-num">${p.fee === null ? '—' : `${fmt.number(p.fee, 2)}%`}</td>
                <td class="col-num">${fmt.compactMoney(p.tvl)}</td>
                <td class="col-num">${fmt.compactMoney(p.vol24)}<small class="muted">${fmt.number(p.turnover, 2)}× a liquidez</small></td>
                <td class="col-num"><strong>${p.apr === null ? '—' : `${fmt.number(p.apr, 0)}%`}</strong>${raw(p.apr6 !== null ? html`<small class="delta-${toneOf(p.apr6 - p.apr, 1)}">${fmt.number(p.apr6, 0)}% ritmo 6h</small>` : '')}</td>
                <td class="col-num">${p.buyShare === null ? '—' : `${fmt.number(p.buyShare * 100, 0)}%`}<small class="muted">${fmt.number(p.txs, 0)} negócios</small></td>
                <td>${raw(r.length ? r.map((x) => html`<span class="chip chip-down">${x}</span>`).join(' ') : '<span class="chip chip-up">ok</span>')}</td>
                <td class="col-actions">
                    ${raw(p.concentrated ? html`<button class="btn btn-small" type="button" data-plan="${p.id}">Planejar</button>` : '')}
                    <a class="btn btn-small btn-ghost" href="${poolLink(p)}" target="_blank" rel="noopener">Ver</a>
                </td>
            </tr>`;
        }).join('') : html`<tr><td colspan="9" class="empty-cell">${loading ? 'Carregando…' : 'Nenhuma pool com esses filtros.'}</td></tr>`;
    }

    // ---------- Eventos ----------
    function planIn(id) {
        const p = data.pools.find((x) => x.id === id);
        if (!p) return;
        const a = sym(p.base) === 'USD' ? p.quote : p.base;
        const b = a === p.base ? p.quote : p.base;
        const mapSym = (s) => { const u = sym(s); return u === 'USD' ? (String(s).toUpperCase().startsWith('USDT') ? 'USDT' : 'USDC') : u; };
        S.poolForm = { ...(S.poolForm ?? {}), a: mapSym(a), b: mapSym(b), chain: p.chain, fee: p.fee ?? 0.3, mode: 'two', apr: p.apr !== null ? Math.round(p.apr) : '' };
        store.save();
        App.go('#/pools');
        toast(`Planejador preenchido com ${p.base}/${p.quote} (${p.dex}). O APR de 24h entra como referência.`);
    }

    function onClick(event) {
        const t = event.target;
        const ch = t.closest('[data-chain]')?.dataset.chain;
        if (ch) { view.chain = ch; view.dex = 'all'; render(); return; }
        const dx = t.closest('[data-dex]')?.dataset.dex;
        if (dx) { view.dex = view.dex === dx ? 'all' : dx; render(); return; }
        const plan = t.closest('[data-plan]')?.dataset.plan;
        if (plan) { planIn(plan); return; }
        const sortBtn = t.closest('[data-sort]')?.dataset.sort;
        if (sortBtn) {
            view.sort = sortBtn;
            $$('#dsSort button', root).forEach((b) => b.setAttribute('aria-pressed', b.dataset.sort === view.sort));
            render();
            return;
        }
        if (t.closest('[data-ds="reload"]')) load(true);
    }

    App.poolDiscover = {
        mount(el) {
            root = el;
            el.innerHTML = html`
                <section class="panel">
                    <div class="panel-bar">
                        <h2 class="panel-title">Volume e taxas por rede</h2>
                        <div class="toolbar"><span id="dsStatus" class="small"></span><button class="btn btn-small btn-ghost" type="button" data-ds="reload">Atualizar</button></div>
                    </div>
                    <div id="dsChains" class="ds-chains"></div>
                    <h3 class="w3-h3">Apps com mais volume ${raw('<span class="muted small">(clique para filtrar)</span>')}</h3>
                    <ul id="dsApps" class="ds-apps"></ul>
                </section>
                <section id="dsHighlights" class="ds-hls" aria-label="Destaques"></section>
                <section class="panel">
                    <div class="ds-tools">
                        <div id="dsSort" class="seg seg-soft" role="group" aria-label="Ordenar por">
                            <button type="button" data-sort="apr" aria-pressed="true">Mais taxas</button>
                            <button type="button" data-sort="volume" aria-pressed="false">Mais volume</button>
                            <button type="button" data-sort="accel" aria-pressed="false">Ganhando força</button>
                            <button type="button" data-sort="tvl" aria-pressed="false">Mais liquidez</button>
                        </div>
                        <label class="sr-only" for="dsDex">App</label>
                        <select id="dsDex" class="input input-small"></select>
                        <label class="sr-only" for="dsMin">Liquidez mínima</label>
                        <select id="dsMin" class="input input-small">
                            ${raw([[0, 'Qualquer liquidez'], [100000, 'Liquidez ≥ US$ 100 mil'], [250000, 'Liquidez ≥ US$ 250 mil'], [1000000, 'Liquidez ≥ US$ 1 mi'], [10000000, 'Liquidez ≥ US$ 10 mi']].map(([v, l]) => html`<option value="${v}" ${view.minTvl === v ? 'selected' : ''}>${l}</option>`).join(''))}
                        </select>
                        <label class="switch"><input type="checkbox" id="dsMine" ${view.mine ? 'checked' : ''}><span>Só com minhas criptos</span></label>
                        <label class="switch"><input type="checkbox" id="dsConc" ${view.concentrated ? 'checked' : ''}><span>Só liquidez concentrada</span></label>
                        <input id="dsText" class="input input-small" type="search" placeholder="Buscar par ou app" autocomplete="off">
                    </div>
                    <div class="table-wrap">
                        <table class="data-table ds-table">
                            <thead><tr><th>Pool</th><th>Rede</th><th class="col-num">Taxa</th><th class="col-num">Liquidez</th><th class="col-num">Volume 24h</th><th class="col-num">APR das taxas</th><th class="col-num" title="Parcela de compras nos negócios de 24h">Compras</th><th>Riscos</th><th class="col-actions"></th></tr></thead>
                            <tbody id="dsBody"></tbody>
                        </table>
                    </div>
                    <p class="footnote">APR das taxas = volume de 24h × taxa da pool ÷ liquidez, anualizado. É a média de quem está na pool inteira: posições concentradas na faixa certa ganham mais, fora da faixa não ganham nada. Volume de um dia oscila muito; compare com o “ritmo 6h”. Não inclui recompensas em tokens nem a perda impermanente. Dados do GeckoTerminal; “em alta” segue o ranking de tendências dele (visitas e atividade on-chain).</p>
                </section>`;
            el.addEventListener('click', onClick);
            $('#dsDex', el).addEventListener('change', (e) => { view.dex = e.target.value; render(); });
            $('#dsMin', el).addEventListener('change', (e) => { view.minTvl = Number(e.target.value); render(); });
            $('#dsMine', el).addEventListener('change', (e) => { view.mine = e.target.checked; render(); });
            $('#dsConc', el).addEventListener('change', (e) => { view.concentrated = e.target.checked; render(); });
            $('#dsText', el).addEventListener('input', debounce((e) => { view.text = e.target.value; render(); }, 150));
            render();
            load();
        },
        unmount() {
            offs.forEach((o) => o());
            offs = [];
            root = null;
        },
    };
})(window.App);
