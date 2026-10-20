// "Descobrir pools": ranking de pools por rede, volume, taxas e app (DEX),
// com destaques automáticos. Fonte: API pública do GeckoTerminal (sem chave).
window.App = window.App || {};

(function (App) {
    const { $, $$, html, raw, fmt, bus, toneOf, toast, debounce } = App.util;
    const store = App.store;
    const S = store.state;

    const GT = 'https://api.geckoterminal.com/api/v2';
    // Ordem de consulta: as redes mais usadas primeiro.
    const NETS = {
        ethereum: { gt: 'eth', name: 'Ethereum' },
        bnb: { gt: 'bsc', name: 'BNB Chain' },
        solana: { gt: 'solana', name: 'Solana' },
        base: { gt: 'base', name: 'Base' },
        arbitrum: { gt: 'arbitrum', name: 'Arbitrum' },
        optimism: { gt: 'optimism', name: 'Optimism' },
        polygon: { gt: 'polygon_pos', name: 'Polygon' },
        zksync: { gt: 'zksync', name: 'zkSync Era' },
    };
    // Tokens "de primeira linha": usados para o destaque de pools mais seguras.
    const BLUE = new Set(['SOL', 'WSOL', 'JITOSOL', 'MSOL', 'BNB', 'WBNB', 'BTCB', 'ETH', 'WETH', 'BTC', 'WBTC', 'CBBTC', 'TBTC', 'USDC', 'USDT', 'DAI', 'USDC.E', 'USDBC', 'STETH', 'WSTETH', 'WEETH', 'CBETH', 'RETH', 'ARB', 'OP', 'POL', 'WPOL', 'WMATIC', 'LINK', 'UNI', 'AAVE', 'USDS', 'USDE', 'GHO']);
    const CACHE_MS = 15 * 60 * 1000;

    let root = null;
    let offs = [];
    let data = { at: 0, pools: [], errors: [] };
    let loading = false;
    let progress = null;
    let view = { chain: 'all', dex: 'all', sort: 'apr', minTvl: 250000, mine: false, concentrated: false, text: '' };

    // ---------- Coleta ----------
    // A API pública do GeckoTerminal limita as consultas por minuto. As chamadas
    // são feitas em fila, com intervalo, e uma resposta 429 espera e tenta de novo.
    const GAP_MS = window.__gtGap ?? 2600;
    let lastCall = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function gt(path, attempt = 0) {
        const wait = lastCall + GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        lastCall = Date.now();
        const r = await fetch(`${GT}${path}`, { headers: { accept: 'application/json' } });
        if (r.status === 429 && attempt < 2) {
            if (root) { progress.waiting = true; render(); }
            await sleep((window.__gtRetry ?? 20000) * (attempt + 1));
            if (root) progress.waiting = false;
            return gt(path, attempt + 1);
        }
        if (r.status === 429) throw new Error('limite de consultas do GeckoTerminal; tente de novo em alguns minutos');
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
                _learn: [App.llama?.learn((base.symbol || '').trim(), chain, base.address), App.llama?.learn((quote.symbol || '').trim(), chain, quote.address)],
                dexId, dex, fee, tvl, vol24, vol6, vol1,
                apr: fee !== null && tvl > 0 ? (vol24 * fee / 100 / tvl) * 365 * 100 : null,
                apr6: fee !== null && tvl > 0 ? (vol6 * 4 * fee / 100 / tvl) * 365 * 100 : null,
                turnover: tvl ? vol24 / tvl : 0,
                accel: vol24 ? (vol6 * 4) / vol24 : 0,
                buyShare: buys + sells ? buys / (buys + sells) : null,
                txs: buys + sells,
                priceChange: Number(a.price_change_percentage?.h24) || 0,
                ageDays: created ? (Date.now() - created) / 86400000 : null,
                concentrated: /v3|slipstream|_cl|clmm|v4|algebra|orca|whirlpool|meteora|dlmm/i.test(dexId),
                trending,
            };
        });
    }

    function saveCache() {
        try { localStorage.setItem('gt-pools', JSON.stringify(data)); } catch { /* cheio */ }
    }

    async function load(force = false) {
        if (loading) return;
        if (!force && data.pools.length && Date.now() - data.at < CACHE_MS) { render(); return; }
        try {
            const cached = JSON.parse(localStorage.getItem('gt-pools') || 'null');
            if (cached?.pools?.length) {
                data = cached;
                if (!force && Date.now() - cached.at < CACHE_MS) { render(); return; }
            }
        } catch { /* sem cache */ }
        loading = true;
        const pools = new Map(force ? [] : data.pools.map((p) => [p.id, p]));
        const errors = [];
        const nets = Object.entries(NETS);
        // Rodadas: primeiro a página principal de todas as redes (o painel já fica útil),
        // depois as tendências e, por último, a segunda página de volume.
        const rounds = [
            (n) => `/networks/${n.gt}/pools?sort=h24_volume_usd_desc&page=1&include=base_token,quote_token,dex`,
            (n) => `/networks/${n.gt}/trending_pools?include=base_token,quote_token,dex`,
            (n) => `/networks/${n.gt}/pools?sort=h24_volume_usd_desc&page=2&include=base_token,quote_token,dex`,
        ];
        progress = { done: 0, total: rounds.length * nets.length, waiting: false };
        render();
        for (let r = 0; r < rounds.length; r += 1) {
            for (const [chain, n] of nets) {
                try {
                    const json = await gt(rounds[r](n));
                    parse(json, chain, r === 1).forEach((p) => {
                        const prev = pools.get(p.id);
                        pools.set(p.id, prev ? { ...p, trending: r === 1 || prev.trending } : p);
                    });
                } catch (error) {
                    errors.push(`${n.name}: ${error.message}`);
                }
                progress.done += 1;
                data = { at: Date.now(), pools: [...pools.values()], errors: [...new Set(errors)] };
                if (root) render();
            }
        }
        saveCache();
        loading = false;
        progress = null;
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
            ? html`<span class="muted">${progress?.waiting ? 'Limite da API atingido, aguardando para continuar…' : `Consultando pools (${progress ? Math.round((progress.done / progress.total) * 100) : 0}%)…`} ${data.pools.length ? `${data.pools.length} até agora` : ''}</span>`
            : data.pools.length
                ? html`<span class="muted">${data.pools.length} pools · atualizado às ${fmt.time(new Date(data.at))}</span>${raw(data.errors.length ? html` <span class="delta-down" title="${data.errors.join(' | ')}">· ${data.errors.length} falha(s)</span>` : '')}`
                : html`<span class="muted">${data.errors.length ? `Não consegui consultar: ${data.errors[0]}` : 'Sem dados ainda.'}</span>`;

        renderChains();
        renderAppsFallback();
        $('#dsHighlights', root).innerHTML = data.pools.length ? highlights().map(highlightCard).join('') : '';
        renderBodyOnly();
    }

    // Cartões de rede: volume das maiores pools (GeckoTerminal) + entrada de capital (DefiLlama).
    function renderChains() {
        const ll = App.llamaDiscover?.state ?? {};
        const pct = (v) => (Number.isFinite(v) ? fmt.pct(v, 1) : '—');
        const byChain = Object.keys(NETS).map((k) => {
            const ps = data.pools.filter((p) => p.chain === k);
            return { k, vol: ps.reduce((a, p) => a + p.vol24, 0), n: ps.length, flow: ll.flows?.[k], tvl: ll.flows?.[k]?.tvl?.now ?? ll.tvl?.[k] };
        });
        $('#dsChains', root).innerHTML = byChain.map((c) => html`<button type="button" class="ds-chain${view.chain === c.k ? ' is-on' : ''}" data-chain="${c.k}" style="--c:${App.web3.CHAINS[c.k].color}">
            <span class="ds-chain-name">${App.web3.CHAINS[c.k].name}</span>
            <strong>${c.n ? fmt.compactMoney(c.vol) : '—'}</strong><span class="muted small">volume 24h nas maiores pools</span>
            <span class="small">TVL ${Number.isFinite(c.tvl) ? fmt.compactMoney(c.tvl) : '—'} <span class="delta-${toneOf(c.flow?.tvl?.ch7)}">${pct(c.flow?.tvl?.ch7)}</span></span>
            <span class="small">Stablecoins <span class="delta-${toneOf(c.flow?.stables?.ch7)}">${pct(c.flow?.stables?.ch7)}</span> <span class="muted">7d</span></span>
        </button>`).join('') + html`<button type="button" class="ds-chain${view.chain === 'all' ? ' is-on' : ''}" data-chain="all" style="--c:var(--ink-3)"><span class="ds-chain-name">Todas</span><strong>${fmt.compactMoney(byChain.reduce((a, c) => a + c.vol, 0))}</strong><span class="muted small">volume 24h</span><span class="small">${data.pools.length} pools</span></button>`;
    }

    // Lista de apps pelo GeckoTerminal: só aparece se a DefiLlama não responder.
    function renderAppsFallback() {
        const el = $('#dsApps', root);
        const llOk = Boolean(App.llamaDiscover?.state?.dexs?.length);
        el.hidden = llOk;
        if (llOk) return;
        const scoped = data.pools.filter((p) => view.chain === 'all' || p.chain === view.chain);
        const apps = [...new Set(scoped.map((p) => p.dex))].map((d) => {
            const ps = scoped.filter((p) => p.dex === d);
            return { d, vol: ps.reduce((a, p) => a + p.vol24, 0) };
        }).sort((x, y) => y.vol - x.vol).slice(0, 8);
        const maxVol = Math.max(1, ...apps.map((x) => x.vol));
        el.innerHTML = apps.map((x) => html`<li class="${view.dex === x.d ? 'is-on' : ''}" data-dex="${x.d}"><span class="ds-app-name">${x.d}</span><span class="ds-app-bar"><i style="width:${(x.vol / maxVol) * 100}%"></i></span><span class="ds-app-num">${fmt.compactMoney(x.vol)}</span><span class="ds-app-num muted">nas maiores pools</span></li>`).join('');
    }

    // Liga uma pool do GeckoTerminal à mesma pool na DefiLlama (rede, app, tokens e taxa).
    const FAMILIES = ['uniswap', 'pancake', 'aerodrome', 'velodrome', 'orca', 'raydium', 'meteora', 'camelot', 'curve', 'sushi', 'balancer', 'syncswap', 'quickswap', 'thena', 'fluid'];
    const famOf = (txt) => FAMILIES.find((f) => String(txt).toLowerCase().includes(f)) ?? null;
    let llIndex = null;
    let llIndexSrc = null;
    function llamaMatch(p) {
        const pools = App.llamaDiscover?.state?.pools;
        if (!pools?.length) return null;
        if (llIndexSrc !== pools) {
            llIndex = new Map();
            pools.forEach((q) => {
                const fam = famOf(q.project);
                if (!fam) return;
                const key = `${q.chain}|${fam}|${String(q.symbol).toUpperCase().split(/[-/ ]+/).sort().join('-')}`;
                if (!llIndex.has(key)) llIndex.set(key, []);
                llIndex.get(key).push(q);
            });
            llIndexSrc = pools;
        }
        const fam = famOf(p.dex);
        if (!fam) return null;
        const key = `${p.chain}|${fam}|${[p.base, p.quote].map((x) => String(x).toUpperCase()).sort().join('-')}`;
        const cands = (llIndex.get(key) ?? []).filter((q) => q.tvl > p.tvl / 3 && q.tvl < p.tvl * 3);
        if (!cands.length) return null;
        const byFee = p.fee !== null ? cands.filter((q) => String(q.meta).includes(`${p.fee}%`)) : [];
        return (byFee.length ? byFee : cands).sort((x, y) => Math.abs(Math.log(x.tvl / p.tvl)) - Math.abs(Math.log(y.tvl / p.tvl)))[0];
    }

    function renderBodyOnly() {
        if (!root) return;
        const list = sorted(filtered()).slice(0, 80);
        const mine = mineSet();
        $('#dsBody', root).innerHTML = list.length ? list.map((p) => {
            const r = risk(p);
            const isMine = mine.has(mainToken(p));
            const ll = llamaMatch(p);
            return html`<tr>
                <td>${raw(pairHtml(p))}${raw(p.trending ? ' <span class="chip chip-warn" title="Em alta no GeckoTerminal">em alta</span>' : '')}${raw(isMine ? ' <span class="chip chip-flat" title="Tem cripto das suas listas ou carteira">sua</span>' : '')}<small class="muted">${p.dex}${p.fee !== null ? ` · ${fmt.number(p.fee, 2)}%` : ''}${p.concentrated ? ' · concentrada' : ''}</small></td>
                <td>${raw(chainBadge(p.chain))}</td>
                <td class="col-num">${fmt.compactMoney(p.tvl)}</td>
                <td class="col-num">${fmt.compactMoney(p.vol24)}<small class="muted">${fmt.number(p.turnover, 2)}× a liquidez</small></td>
                <td class="col-num"><strong>${p.apr === null ? '—' : `${fmt.number(p.apr, 0)}%`}</strong>${raw(p.apr6 !== null ? html`<small class="delta-${toneOf(p.apr6 - p.apr, 1)}">${fmt.number(p.apr6, 0)}% ritmo 6h</small>` : '')}</td>
                <td class="col-num">${raw(ll && Number.isFinite(ll.apyMean30d) ? html`<strong>${fmt.number(ll.apyMean30d, 1)}%</strong>${raw(ll.apyReward ? html`<small class="muted">${fmt.number(ll.apyReward, 1)}% em recompensas</small>` : '')}` : '<span class="muted">—</span>')}</td>
                <td>${raw(r.length ? r.map((x) => html`<span class="chip chip-down">${x}</span>`).join(' ') : '<span class="chip chip-up">ok</span>')}</td>
                <td class="col-actions">
                    ${raw(p.concentrated ? html`<button class="btn btn-small" type="button" data-plan="${p.id}">Planejar</button>` : '')}
                    <a class="btn btn-small btn-ghost" href="${poolLink(p)}" target="_blank" rel="noopener">Ver</a>
                </td>
            </tr>`;
        }).join('') : html`<tr><td colspan="8" class="empty-cell">${loading ? 'Carregando…' : 'Nenhuma pool com esses filtros.'}</td></tr>`;
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
        App.go('#/pools/planejar');
        toast(`Planejador preenchido com ${p.base}/${p.quote} (${p.dex}). O APR de 24h entra como referência.`);
    }

    function onClick(event) {
        const t = event.target;
        const ch = t.closest('[data-chain]')?.dataset.chain;
        if (ch) { view.chain = ch; view.dex = 'all'; render(); bus.emit('discover-chain', ch); return; }
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
                        <h2 class="panel-title">Redes</h2>
                        <div class="toolbar"><span id="dsStatus" class="small"></span><button class="btn btn-small btn-ghost" type="button" data-ds="reload">Atualizar</button></div>
                    </div>
                    <div id="dsChains" class="ds-chains"></div>
                    <p id="llFlowNote" class="footnote"></p>
                </section>
                <section id="dsHighlights" class="ds-hls" aria-label="Destaques"></section>
                <section class="panel">
                    <div class="panel-bar">
                        <h2 class="panel-title">Ranking</h2>
                        <div id="dsTab" class="seg" role="group" aria-label="Tipo de ranking">
                            <button type="button" data-tab="pools" aria-pressed="true">Pools de liquidez</button>
                            <button type="button" data-tab="yields" aria-pressed="false">Rendimentos e cofres</button>
                        </div>
                    </div>
                    <div id="dsTabPools">
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
                            <label class="switch"><input type="checkbox" id="dsMine" ${view.mine ? 'checked' : ''}><span>Só minhas criptos</span></label>
                            <label class="switch"><input type="checkbox" id="dsConc" ${view.concentrated ? 'checked' : ''}><span>Só concentrada</span></label>
                            <input id="dsText" class="input input-small" type="search" placeholder="Buscar par ou app" autocomplete="off">
                        </div>
                        <div class="table-wrap">
                            <table class="data-table ds-table">
                                <thead><tr><th>Pool</th><th>Rede</th><th class="col-num">Liquidez</th><th class="col-num">Volume 24h</th><th class="col-num" title="Volume de 24h × taxa ÷ liquidez, anualizado">APR 24h</th><th class="col-num" title="Média de 30 dias da DefiLlama, quando a pool é encontrada lá">Média 30 dias</th><th>Riscos</th><th class="col-actions"></th></tr></thead>
                                <tbody id="dsBody"></tbody>
                            </table>
                        </div>
                        <p class="footnote">APR 24h: volume do dia × taxa ÷ liquidez, anualizado (GeckoTerminal). Média 30 dias: o que a pool vem pagando no mês, com recompensas, segundo a DefiLlama. Os dois são médias de quem está na pool inteira; posições concentradas na faixa certa ganham mais, e fora da faixa não ganham nada.</p>
                    </div>
                    <div id="dsTabYields" hidden>
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
                            <select id="llMin" class="input input-small">${raw([[1e5, 'Liquidez ≥ US$ 100 mil'], [1e6, 'Liquidez ≥ US$ 1 mi'], [1e7, 'Liquidez ≥ US$ 10 mi']].map(([v, l]) => html`<option value="${v}" ${v === 1e6 ? 'selected' : ''}>${l}</option>`).join(''))}</select>
                            <label class="switch"><input type="checkbox" id="llStable"><span>Só stablecoins</span></label>
                            <label class="switch"><input type="checkbox" id="llNoIl"><span>Sem perda impermanente</span></label>
                            <input id="llText" class="input input-small" type="search" placeholder="Buscar token ou protocolo" autocomplete="off">
                        </div>
                        <div id="llYields"></div>
                        <p class="footnote">Inclui pools, empréstimos e cofres (DefiLlama). “Taxas” vem das negociações ou dos juros; “recompensas” são tokens extras e mudam com o preço desses tokens.</p>
                    </div>
                </section>
                <section class="panel">
                    <div class="panel-bar"><h2 class="panel-title">Apps</h2><span class="muted small">Volume e taxas do app inteiro</span></div>
                    <div id="llApps"></div>
                    <ul id="dsApps" class="ds-apps" hidden></ul>
                </section>
                <details class="panel fold">
                    <summary><span class="panel-title">Protocolos ganhando e perdendo TVL</span><span class="muted small">Variação de 7 dias</span></summary>
                    <div id="llProtocols" class="ll-protocols"></div>
                </details>
                <p id="llStatus" class="footnote delta-down"></p>`;
            el.querySelector('#dsTab').addEventListener('click', (e) => {
                const b = e.target.closest('[data-tab]');
                if (!b) return;
                $$('#dsTab button', el).forEach((x) => x.setAttribute('aria-pressed', x === b));
                $('#dsTabPools', el).hidden = b.dataset.tab !== 'pools';
                $('#dsTabYields', el).hidden = b.dataset.tab !== 'yields';
            });
            el.addEventListener('click', onClick);
            $('#dsDex', el).addEventListener('change', (e) => { view.dex = e.target.value; render(); });
            $('#dsMin', el).addEventListener('change', (e) => { view.minTvl = Number(e.target.value); render(); });
            $('#dsMine', el).addEventListener('change', (e) => { view.mine = e.target.checked; render(); });
            $('#dsConc', el).addEventListener('change', (e) => { view.concentrated = e.target.checked; render(); });
            $('#dsText', el).addEventListener('input', debounce((e) => { view.text = e.target.value; render(); }, 150));
            render();
            load();
            App.llamaDiscover?.mount(el, { bind: true });
            offs.push(bus.on('llama-update', () => { if (root) { renderChains(); renderBodyOnly(); } }));
            if (view.chain !== 'all') bus.emit('discover-chain', view.chain);
        },
        unmount() {
            App.llamaDiscover?.unmount();
            offs.forEach((o) => o());
            offs = [];
            root = null;
        },
    };
})(window.App);
