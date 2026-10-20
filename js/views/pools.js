// Tela "Pools": planejar faixas de liquidez concentrada, comparar redes,
// monitorar posições (lidas das carteiras ou do diário) e alertar para remontar.
window.App = window.App || {};
App.views = App.views || {};

(function (App) {
    const { $, $$, html, raw, fmt, bus, toneOf, toast, uid, debounce } = App.util;
    const store = App.store;
    const S = store.state;
    const PM = () => App.poolmath;

    // Gás aproximado (unidades) por operação na Uniswap v3.
    const GAS_MINT = 450000;
    const GAS_REBALANCE = 800000;
    const FEES = [0.05, 0.3, 1];

    let root = null;
    let offs = [];
    let form = null;
    let calc = null;
    let selected = 'eq';
    let gasCache = { at: 0, data: null };
    let discovering = false;

    const under = (s) => App.web3.underlying(s);
    const isStable = (s) => under(s) === 'USD';

    function defaults() {
        return { a: 'ETH', b: 'USDC', mode: 'two', capital: 1000, days: 14, fee: 0.3, apr: '', vol: '', near: 3, far: 20, chain: 'arbitrum' };
    }

    function ensureState() {
        if (!Array.isArray(S.pools)) S.pools = [];
        if (!S.poolWatch || typeof S.poolWatch !== 'object') S.poolWatch = {};
        if (!S.poolForm) S.poolForm = defaults();
    }

    // ---------- Preço e histórico do par ----------
    function pairPrice(a, b) {
        const pa = isStable(a) ? 1 : App.priceOf(under(a));
        const pb = isStable(b) ? 1 : App.priceOf(under(b));
        return pa && pb ? pa / pb : null;
    }

    async function pairCloses(a, b) {
        const ua = under(a);
        const ub = under(b);
        if (ua === ub) return null;
        if (ub === 'USD') return (await App.api.klines(ua, '1d', 200)).map((r) => r.close);
        if (ua === 'USD') return (await App.api.klines(ub, '1d', 200)).map((r) => 1 / r.close);
        const [ra, rb] = await Promise.all([App.api.klines(ua, '1d', 200), App.api.klines(ub, '1d', 200)]);
        const mb = new Map(rb.map((r) => [r.time, r.close]));
        return ra.filter((r) => mb.has(r.time)).map((r) => r.close / mb.get(r.time));
    }

    function pairType(a, b) {
        const ua = under(a);
        const ub = under(b);
        if (ua === 'USD' && ub === 'USD') return 'stable';
        if (ua === ub) return 'correlated';
        if (ua === 'USD' || ub === 'USD') return 'stable-volatile';
        return 'volatile';
    }

    // ---------- Gás por rede ----------
    async function gasTable(force = false) {
        if (!force && gasCache.data && Date.now() - gasCache.at < 2 * 60 * 1000) return gasCache.data;
        const chains = App.web3.CHAINS;
        const rows = await Promise.all(Object.entries(chains).map(async ([key, c]) => {
            try {
                const gwei = await App.web3.gasPriceGwei(key);
                const nativeUsd = App.priceOf(c.native) ?? null;
                const unit = nativeUsd ? gwei * 1e-9 * nativeUsd : null;
                return { key, name: c.name, gwei, mint: unit ? unit * GAS_MINT : null, rebalance: unit ? unit * GAS_REBALANCE : null, l2: key !== 'ethereum' && key !== 'polygon' };
            } catch (error) {
                return { key, name: c.name, error: true };
            }
        }));
        gasCache = { at: Date.now(), data: rows };
        return rows;
    }

    // ---------- Planejador ----------
    async function compute() {
        const f = S.poolForm;
        const price = pairPrice(f.a, f.b);
        let vol = null;
        let volSource = 'histórico de 90 dias';
        if (f.vol !== '' && Number(App.parseNum(f.vol)) > 0) {
            vol = App.parseNum(f.vol) / 100;
            volSource = 'informada por você';
        } else {
            try {
                const closes = await pairCloses(f.a, f.b);
                vol = closes ? PM().dailyVol(closes) : null;
            } catch { vol = null; }
            if (!vol) {
                vol = pairType(f.a, f.b) === 'correlated' ? 0.002 : pairType(f.a, f.b) === 'stable' ? 0.0005 : null;
                volSource = vol ? 'padrão para pares que andam juntos (informe a sua se souber)' : volSource;
            }
        }
        let signal = null;
        if (!isStable(f.a)) {
            try { signal = App.ind.analyze(await App.api.klines(under(f.a), '1d', 1000)); } catch { signal = null; }
        }
        calc = { price, vol, volSource, signal, type: pairType(f.a, f.b) };
        return calc;
    }

    function profilesNow() {
        if (!calc?.price || !calc.vol) return [];
        return PM().profiles(calc.price, calc.vol, Number(S.poolForm.days));
    }

    function currentRange() {
        const f = S.poolForm;
        if (!calc?.price) return null;
        if (f.mode === 'two') {
            const p = profilesNow().find((x) => x.key === selected);
            return p ? { lower: p.lower, upper: p.upper } : null;
        }
        const ro = PM().rangeOrder(calc.price, f.mode === 'buy' ? 'buy' : 'sell', Number(f.near) || 1, Number(f.far) || 10);
        return { lower: ro.lower, upper: ro.upper, avgPrice: ro.avgPrice };
    }

    // O capital é sempre informado em dólar e convertido para o token de cotação (B).
    function capitalInB() {
        const usd = Number(App.parseNum(S.poolForm.capital)) || 0;
        const pB = isStable(S.poolForm.b) ? 1 : App.priceOf(under(S.poolForm.b));
        return pB ? usd / pB : 0;
    }

    function usdCost(v) {
        if (v === null || v === undefined) return '—';
        return v > 0 && v < 0.01 ? '< US$ 0,01' : fmt.money(v, 'USD', 2);
    }

    function px(v) {
        if (!Number.isFinite(v)) return '—';
        const f = S.poolForm;
        return isStable(f.b) ? fmt.money(v) : `${fmt.number(v, v < 0.01 ? 8 : v < 1 ? 6 : 4)} ${f.b}`;
    }

    function tips() {
        const f = S.poolForm;
        const out = [];
        const t = calc?.type;
        if (f.mode === 'buy') {
            out.push(`Faixa só com ${f.b} abaixo do preço funciona como compra gradual: se ${f.a} cair até a faixa, a pool vai trocando ${f.b} por ${f.a} e ainda cobra taxa no caminho. Preço médio de compra: a média geométrica das bordas.`);
            out.push(`Se o preço atravessar a faixa inteira para baixo, você termina 100% em ${f.a}. Para “travar” a compra, retire a liquidez nesse momento; se o preço voltar a subir pela faixa, a pool desfaz a compra.`);
        } else if (f.mode === 'sell') {
            out.push(`Faixa só com ${f.a} acima do preço funciona como venda escalonada: se ${f.a} subir até lá, a pool vende aos poucos para ${f.b}. Bom para realizar lucro em alta.`);
            out.push(`Atravessada a faixa para cima, você fica 100% em ${f.b}. Retire a liquidez para não “desvender” se o preço voltar.`);
        } else {
            if (t === 'stable-volatile') out.push(`Par com stablecoin: quanto mais ${f.a} sobe, mais a pool vende ${f.a}; quanto mais cai, mais compra. Na prática, é um rebalanceamento automático contra a tendência.`);
            if (t === 'correlated') out.push('Par de tokens que andam juntos: a faixa pode ser bem estreita e quase não há perda impermanente. Prefira a taxa de 0,01% ou 0,05%.');
            if (t === 'volatile') out.push(`Dois voláteis: o preço do par depende de quem anda mais. A perda impermanente é menor se ${f.a} e ${f.b} costumam andar juntos.`);
            out.push('Taxa da pool: 0,05% para pares estáveis ou muito negociados (ETH/USDC), 0,3% para a maioria, 1% para tokens pequenos e muito voláteis. Escolha a pool com mais volume, não só a com taxa maior.');
        }
        if (calc?.signal && f.mode === 'two') {
            const tr = calc.signal.trend;
            if (tr === 'Alta forte' || tr === 'Baixa forte') out.push(`${f.a} está em ${tr.toLowerCase()} no diário. Faixas simétricas costumam ser atravessadas em tendência forte; considere a conservadora ou esperar o preço acomodar.`);
            else out.push(`Tendência de ${f.a} no diário: ${tr.toLowerCase()}. Mercado sem tendência forte é o melhor cenário para faixas estreitas.`);
        }
        out.push('Toda remontagem paga gás e, em geral, um swap para rebalancear. Faixas muito estreitas em rede cara costumam render menos que o custo de manutenção.');
        return out;
    }

    function renderPlanner() {
        const f = S.poolForm;
        const el = $('#plOut', root);
        if (!calc) { el.innerHTML = '<p class="muted">Calculando…</p>'; return; }
        if (!calc.price) { el.innerHTML = html`<p class="muted">Sem cotação para ${f.a}/${f.b} na Binance. Para pares sem cotação, escolha tokens listados ou informe a volatilidade e use um par equivalente.</p>`; return; }
        const capital = capitalInB();
        const head = html`<div class="pl-facts">
            <div><span class="muted">Preço agora</span><strong>${px(calc.price)}</strong></div>
            <div><span class="muted">Volatilidade diária</span><strong>${calc.vol ? `${fmt.number(calc.vol * 100, 2)}%` : '—'}</strong><small class="muted">${calc.volSource}</small></div>
            <div><span class="muted">No horizonte de ${f.days} dias</span><strong>${calc.vol ? `±${fmt.number(calc.vol * Math.sqrt(f.days) * 100, 1)}%` : '—'}</strong><small class="muted">um desvio-padrão</small></div>
            ${raw(calc.signal ? html`<div><span class="muted">${f.a} no diário</span><strong>${calc.signal.trend}</strong><small class="muted">${calc.signal.action}</small></div>` : '')}
        </div>`;

        let body = '';
        const range = currentRange();
        if (f.mode === 'two') {
            if (!calc.vol) {
                body = '<p class="muted">Sem histórico suficiente para calcular a volatilidade. Informe a volatilidade diária manualmente.</p>';
            } else {
                const apr = Number(App.parseNum(f.apr));
                body = html`<div class="pl-profiles">${raw(profilesNow().map((p) => {
                    const dep = PM().deposit(calc.price, p.lower, p.upper, capital);
                    const eff = PM().efficiency(calc.price, p.lower, p.upper);
                    const estApr = apr > 0 ? apr * Math.min(eff, 200) * p.probEnd : null;
                    return html`<button type="button" class="pl-card${p.key === selected ? ' is-on' : ''}" data-profile="${p.key}" aria-pressed="${p.key === selected}">
                        <span class="pl-card-title">${p.label}</span>
                        <strong class="pl-range">${px(p.lower)} – ${px(p.upper)}</strong>
                        <span class="muted small">±${fmt.number(p.widthPct, 1)}% do preço</span>
                        <dl>
                            <dt>Termina na faixa</dt><dd>${fmt.number(p.probEnd * 100, 0)}%</dd>
                            <dt>Nunca sai da faixa</dt><dd>${fmt.number(p.probStay * 100, 0)}%</dd>
                            <dt>Eficiência</dt><dd>${fmt.number(eff, 1)}×</dd>
                            <dt>Depositar</dt><dd>${fmt.qty(dep.qtyA)} ${f.a}<br>${fmt.qty(dep.qtyB)} ${f.b}</dd>
                            ${raw(estApr !== null ? html`<dt>APR estimado</dt><dd>${fmt.number(estApr, 0)}%</dd>` : '')}
                        </dl>
                        <span class="muted small">${p.hint}</span>
                    </button>`;
                }).join(''))}</div>
                ${raw(range ? simulationHtml(range, capital) : '')}
                <p class="footnote">Probabilidades por um modelo simples (preço sem tendência e com a volatilidade recente); servem para comparar faixas, não para prever. ${raw(apr > 0 ? 'O APR estimado multiplica o APR da pool pela eficiência e pela chance de terminar na faixa: é só uma ordem de grandeza.' : 'Informe o APR mostrado no app da pool para ver uma estimativa de rendimento.')}</p>`;
            }
        } else {
            const ro = range;
            const qtyIfFilled = f.mode === 'buy' ? capital / ro.avgPrice : capital * ro.avgPrice;
            const distNear = ((f.mode === 'buy' ? ro.upper : ro.lower) / calc.price - 1) * 100;
            body = html`<div class="pl-ro">
                <dl class="pl-ro-grid">
                    <div><dt>Faixa</dt><dd>${px(ro.lower)} – ${px(ro.upper)}</dd></div>
                    <div><dt>${f.mode === 'buy' ? 'Começa a comprar' : 'Começa a vender'} em</dt><dd>${fmt.pct(distNear, 1)} do preço</dd></div>
                    <div><dt>Preço médio se executar tudo</dt><dd>${px(ro.avgPrice)}</dd></div>
                    <div><dt>${f.mode === 'buy' ? 'Você recebe' : 'Você recebe'}</dt><dd>${fmt.qty(qtyIfFilled)} ${f.mode === 'buy' ? f.a : f.b}</dd></div>
                    <div><dt>Depositar</dt><dd>${f.mode === 'buy' ? `${fmt.qty(capital)} ${f.b}` : `${fmt.qty(capital / calc.price)} ${f.a}`}</dd></div>
                </dl>
                ${raw(calc.vol ? html`<p class="muted small">Chance aproximada de o preço chegar até o início da faixa em ${f.days} dias: ${fmt.number(Math.min(100, 2 * (1 - PM().normCdf(Math.abs(Math.log(1 + distNear / 100)) / (calc.vol * Math.sqrt(f.days)))) * 100), 0)}%.</p>` : '')}
            </div>`;
        }
        el.innerHTML = head + body + html`<ul class="pl-tips">${raw(tips().map((t) => html`<li>${t}</li>`).join(''))}</ul>`;
    }

    function simulationHtml(range, capital) {
        const f = S.poolForm;
        const rows = PM().simulate(calc.price, range.lower, range.upper, capital);
        return html`<div class="pl-sim">
            <h3 class="w3-h3">Se o preço de ${f.a} andar (sem contar as taxas ganhas)</h3>
            <div class="table-wrap"><table class="data-table">
                <thead><tr><th>Preço</th><th class="col-num">Pool vale</th><th class="col-num">Segurando valeria</th><th class="col-num">Diferença</th><th class="col-num">Você fica com</th></tr></thead>
                <tbody>${raw(rows.map((r) => html`<tr>
                    <td><span class="delta-${toneOf(r.move)}">${fmt.pct(r.move, 0)}</span> <span class="muted small">${px(r.price)}</span>${raw(r.inRange ? '' : ' <span class="chip chip-warn">fora</span>')}</td>
                    <td class="col-num">${fmt.number(r.lp, 2)} ${f.b}</td>
                    <td class="col-num">${fmt.number(r.hold, 2)} ${f.b}</td>
                    <td class="col-num delta-${toneOf(r.diffPct, 0.05)}">${fmt.pct(r.diffPct, 1)}</td>
                    <td class="col-num"><small>${fmt.qty(r.qtyA)} ${f.a} + ${fmt.qty(r.qtyB)} ${f.b}</small></td>
                </tr>`).join(''))}</tbody>
            </table></div>
            <p class="muted small">A “diferença” é a perda impermanente: as taxas ganhas precisam cobrir isso para a pool valer mais que segurar.</p>
        </div>`;
    }

    async function renderGas(force = false) {
        const el = $('#plGas', root);
        el.innerHTML = '<p class="muted">Consultando o gás de cada rede…</p>';
        const rows = await gasTable(force);
        if (!root) return;
        const capital = Number(App.parseNum(S.poolForm.capital)) || 0;
        const ok = rows.filter((r) => r.rebalance !== null && !r.error).sort((a, b) => a.rebalance - b.rebalance);
        const best = ok[0];
        el.innerHTML = html`<div class="table-wrap"><table class="data-table">
            <thead><tr><th>Rede</th><th class="col-num">Gás agora</th><th class="col-num">Montar</th><th class="col-num">Remontar</th><th class="col-num">Remontar / capital</th></tr></thead>
            <tbody>${raw(rows.map((r) => {
                if (r.error) return html`<tr><td>${r.name}</td><td colspan="4" class="muted">sem resposta do RPC</td></tr>`;
                const pct = capital && r.rebalance ? (r.rebalance / capital) * 100 : null;
                return html`<tr${raw(best && r.key === best.key ? ' class="is-best"' : '')}>
                    <td>${raw(html`<span class="chain-badge" style="--c:${App.web3.CHAINS[r.key].color}">${r.name}</span>`)}</td>
                    <td class="col-num">${fmt.number(r.gwei, r.gwei < 1 ? 4 : 1)} gwei</td>
                    <td class="col-num">${usdCost(r.mint)}</td>
                    <td class="col-num">${usdCost(r.rebalance)}</td>
                    <td class="col-num ${pct === null ? '' : pct > 1 ? 'delta-down' : pct > 0.3 ? '' : 'delta-up'}">${pct === null ? '—' : `${fmt.number(pct, pct < 0.1 ? 3 : 2)}%`}</td>
                </tr>`;
            }).join(''))}</tbody>
        </table></div>
        <p class="footnote">Estimativa com o gás de agora: cerca de ${fmt.number(GAS_MINT / 1000, 0)} mil unidades para montar e ${fmt.number(GAS_REBALANCE / 1000, 0)} mil para remontar (retirar, coletar, trocar e montar de novo). Nas redes de segunda camada há também uma pequena taxa de dados que não aparece aqui. ${raw(best ? html`Hoje, a mais barata é <strong>${best.name}</strong>. Acima de ~1% do capital por remontagem, faixas estreitas raramente compensam.` : '')} Confira também o volume de cada pool no app: taxa barata não adianta sem negociação.</p>`;
    }

    // ---------- Monitoramento ----------
    function orient(u) {
        // Exibe sempre como "token volátil cotado no outro": se token0 for stablecoin, inverte.
        if (isStable(u.symbol0) && !isStable(u.symbol1)) {
            return { a: u.symbol1, b: u.symbol0, lower: 1 / u.priceUpper, upper: 1 / u.priceLower, price: 1 / u.priceNow, qtyA: u.amount1, qtyB: u.amount0 };
        }
        return { a: u.symbol0, b: u.symbol1, lower: u.priceLower, upper: u.priceUpper, price: u.priceNow, qtyA: u.amount0, qtyB: u.amount1 };
    }

    function monitored() {
        const out = [];
        S.wallets.forEach((w) => {
            const r = App.walletResults?.get(w.id);
            r?.parts?.forEach((p) => p.uni.forEach((u) => {
                if (!u.symbol0 || !u.priceLower) return;
                const o = orient(u);
                out.push({ key: `chain:${p.chain}:${u.id}`, source: `${w.name} · ${App.web3.CHAINS[p.chain].name}`, chain: p.chain, fee: u.fee / 10000, ...o, usd: u.usd, feesUsd: feeUsd(u), onchain: true });
            }));
        });
        S.pools.filter((p) => p.status === 'ativa').forEach((p) => {
            const price = pairPrice(p.a, p.b);
            if (!price) return;
            const qty = p.L ? PM().valueAt(p.L, price, p.lower, p.upper) : null;
            out.push({ key: `diario:${p.id}`, source: `Diário · ${App.web3.CHAINS[p.chain]?.name ?? p.chain}`, chain: p.chain, fee: p.fee, a: p.a, b: p.b, lower: p.lower, upper: p.upper, price, qtyA: qty?.qtyA, qtyB: qty?.qtyB, usd: qty ? qty.value * (isStable(p.b) ? 1 : App.priceOf(under(p.b)) ?? 0) : null, feesUsd: null, journalId: p.id, createdAt: p.createdAt });
        });
        return out;
    }

    function feeUsd(u) {
        const p0 = isStable(u.symbol0) ? 1 : App.priceOf(under(u.symbol0));
        const p1 = isStable(u.symbol1) ? 1 : App.priceOf(under(u.symbol1));
        return (p0 ? u.owed0 * p0 : 0) + (p1 ? u.owed1 * p1 : 0);
    }

    function analyzePosition(m) {
        const pos = PM().positionInRange(m.price, m.lower, m.upper);
        const out = pos < 0 || pos > 1;
        const watch = S.poolWatch[m.key] || (S.poolWatch[m.key] = {});
        if (out && !watch.outSince) watch.outSince = Date.now();
        if (!out && watch.outSince) delete watch.outSince;
        const valueA = (m.qtyA ?? 0) * m.price;
        const total = valueA + (m.qtyB ?? 0);
        const shareA = total ? valueA / total : null;
        const alerts = [];
        if (out) {
            const hours = watch.outSince ? (Date.now() - watch.outSince) / 3600000 : 0;
            alerts.push({ tone: 'down', text: `Fora da faixa ${pos < 0 ? 'por baixo' : 'por cima'}${hours >= 1 ? ` há ${hours >= 48 ? `${fmt.number(hours / 24, 0)} dias` : `${fmt.number(hours, 0)} h`}` : ''}: não está rendendo taxas e está 100% em ${pos < 0 ? m.a : m.b}.` });
        } else {
            const edge = Math.min(pos, 1 - pos);
            if (edge < 0.12) alerts.push({ tone: 'warn', text: `Perto da borda ${pos < 0.5 ? 'de baixo' : 'de cima'}: falta ${fmt.number(Math.abs(Math.log((pos < 0.5 ? m.lower : m.upper) / m.price)) * 100, 1)}% para sair.` });
            if (shareA !== null && (shareA > 0.85 || shareA < 0.15)) alerts.push({ tone: 'warn', text: `Desbalanceada: ${fmt.number(shareA * 100, 0)}% em ${m.a} e ${fmt.number((1 - shareA) * 100, 0)}% em ${m.b}.` });
        }
        return { pos, out, shareA, alerts };
    }

    async function volFor(a, b) {
        try { const c = await pairCloses(a, b); return c ? PM().dailyVol(c) : null; } catch { return null; }
    }

    const volCache = new Map();
    async function renderMonitor() {
        const el = $('#plMon', root);
        const list = monitored();
        const hasWallets = S.wallets.length;
        if (!list.length) {
            el.innerHTML = html`<p class="muted">${hasWallets ? 'Nenhuma posição de pool encontrada nas carteiras lidas nem no diário.' : 'Cadastre carteiras na aba Web3 para monitorar pools on-chain, ou salve uma pool no diário a partir do planejador.'}</p>
                ${raw(hasWallets ? '<button class="btn btn-small" type="button" data-pl="read">Ler carteiras agora</button>' : '')}`;
            return;
        }
        const gas = gasCache.data ?? [];
        el.innerHTML = list.map((m) => {
            const a = analyzePosition(m);
            const vkey = `${m.a}/${m.b}`;
            const vol = volCache.get(vkey);
            const sug = vol ? PM().rangeFor(m.price, vol, 14, 1.2) : null;
            const width = Math.log(m.upper / m.lower);
            const tooNarrow = vol && width < 2 * vol * Math.sqrt(3);
            if (tooNarrow && !a.out) a.alerts.push({ tone: 'warn', text: `Faixa estreita para a volatilidade atual (±${fmt.number(vol * 100, 1)}% ao dia): tende a sair em poucos dias.` });
            const g = gas.find((x) => x.key === m.chain);
            let worth = '';
            if (a.out && g?.rebalance) {
                worth = m.feesUsd !== null && m.feesUsd !== undefined
                    ? (m.feesUsd > g.rebalance ? `As taxas a coletar (${fmt.money(m.feesUsd, 'USD', 2)}) cobrem o custo de remontar (~${fmt.money(g.rebalance, 'USD', 2)}).` : `Remontar custa ~${fmt.money(g.rebalance, 'USD', 2)} em gás${m.usd ? `, ${fmt.number((g.rebalance / m.usd) * 100, 2)}% da posição` : ''}.`)
                    : `Remontar custa ~${fmt.money(g.rebalance, 'USD', 2)} em gás nessa rede.`;
            }
            const trend = !isStable(m.a) ? App.signals?.[under(m.a)]?.trend : null;
            if (a.out && (trend === 'Alta forte' || trend === 'Baixa forte')) a.alerts.push({ tone: 'warn', text: `${m.a} em ${trend.toLowerCase()}: considere esperar acomodar antes de remontar, para não ser atravessado de novo.` });
            const marker = Math.max(0, Math.min(1, a.pos)) * 100;
            const status = a.out ? ['Fora da faixa', 'down'] : a.alerts.length ? ['Atenção', 'warn'] : ['Na faixa', 'up'];
            return html`<article class="pl-pos" data-key="${m.key}">
                <header>
                    <div><strong>${m.a}/${m.b}</strong> <span class="muted small">${fmt.number(m.fee, 2)}% · ${m.source}</span></div>
                    <span class="chip chip-${status[1]}">${status[0]}</span>
                </header>
                <div class="pl-bar"><span class="pl-bar-range"></span><i style="left:${marker}%" class="${a.out ? 'is-out' : ''}"></i></div>
                <div class="pl-bar-labels"><span>${px2(m.lower, m.b)}</span><span>agora ${px2(m.price, m.b)}</span><span>${px2(m.upper, m.b)}</span></div>
                <p class="small">${m.qtyA !== undefined && m.qtyA !== null ? `${S.settings.privacy ? '•••' : fmt.qty(m.qtyA)} ${m.a} + ${S.settings.privacy ? '•••' : fmt.qty(m.qtyB)} ${m.b}` : ''}${m.usd ? ` · ${App.money(m.usd, { priv: true, digits: 2 })}` : ''}${m.feesUsd ? ` · taxas a coletar ~${fmt.money(m.feesUsd, 'USD', 2)}` : ''}</p>
                ${raw(a.alerts.length ? html`<ul class="w3-alerts">${raw(a.alerts.map((x) => html`<li class="w3-alert w3-alert-${x.tone}">${x.text}</li>`).join(''))}</ul>` : '')}
                ${raw(sug && (a.out || a.alerts.length) ? html`<p class="pl-sug">Nova faixa sugerida (equilibrada, 14 dias): <strong>${px2(sug.lower, m.b)} – ${px2(sug.upper, m.b)}</strong>. ${worth}</p>` : (worth ? html`<p class="pl-sug">${worth}</p>` : ''))}
                <div class="toolbar">
                    <button class="btn btn-small" type="button" data-pl="plan" data-a="${m.a}" data-b="${m.b}" data-chain="${m.chain}" data-fee="${m.fee}">Planejar remontagem</button>
                    ${raw(m.journalId ? html`<button class="btn btn-small btn-ghost" type="button" data-pl="close" data-id="${m.journalId}">Encerrar no diário</button>` : '')}
                </div>
            </article>`;
        }).join('');
        // Volatilidades (assíncrono) para as sugestões de nova faixa.
        const missing = [...new Set(list.map((m) => `${m.a}/${m.b}`))].filter((k) => !volCache.has(k));
        if (missing.length) {
            await Promise.all(missing.map(async (k) => { const [x, y] = k.split('/'); volCache.set(k, await volFor(x, y)); }));
            if (root) renderMonitor();
        }
        store.save();
    }

    function px2(v, b) {
        if (!Number.isFinite(v)) return '—';
        return isStable(b) ? fmt.money(v) : `${fmt.number(v, v < 0.01 ? 8 : v < 1 ? 6 : 4)} ${b}`;
    }

    // ---------- Diário ----------
    function saveToJournal() {
        const f = S.poolForm;
        const range = currentRange();
        const capital = capitalInB();
        if (!range || !calc?.price || !capital) { toast('Complete o planejamento antes de salvar.', 'bad'); return; }
        const dep = PM().deposit(calc.price, range.lower, range.upper, capital);
        const editing = $('#plOut', root).dataset.remount;
        const entry = {
            id: editing || uid(), a: f.a, b: f.b, chain: f.chain, fee: Number(f.fee), mode: f.mode,
            lower: range.lower, upper: range.upper, entryPrice: calc.price, capital, capitalUsd: Number(App.parseNum(f.capital)) || 0, L: dep.L,
            status: 'ativa', createdAt: Date.now(),
        };
        const existing = S.pools.find((p) => p.id === editing);
        if (existing) {
            existing.history = [...(existing.history ?? []), { t: Date.now(), lower: existing.lower, upper: existing.upper, price: existing.entryPrice, action: 'remontada' }];
            Object.assign(existing, entry, { history: existing.history, createdAt: existing.createdAt, remountedAt: Date.now() });
        } else {
            S.pools.push({ ...entry, history: [] });
        }
        delete $('#plOut', root).dataset.remount;
        store.commit('pools');
        toast(existing ? 'Remontagem registrada no diário.' : 'Pool salva no diário. Ela passa a ser monitorada.', 'up');
    }

    function renderJournal() {
        const el = $('#plJournal', root);
        if (!S.pools.length) { el.innerHTML = '<p class="muted">Nenhuma pool no diário ainda. Planeje acima e clique em “Salvar no diário” quando montar.</p>'; return; }
        const rows = [...S.pools].sort((a, b) => (b.remountedAt ?? b.createdAt) - (a.remountedAt ?? a.createdAt));
        el.innerHTML = html`<div class="table-wrap"><table class="data-table">
            <thead><tr><th>Par</th><th>Rede</th><th class="col-num">Faixa</th><th class="col-num">Entrada</th><th>Status</th><th class="col-num">Remontagens</th><th class="col-actions"></th></tr></thead>
            <tbody>${raw(rows.map((p) => html`<tr>
                <td><strong>${p.a}/${p.b}</strong> <span class="muted small">${fmt.number(p.fee, 2)}%${p.mode !== 'two' ? (p.mode === 'buy' ? ' · compra gradual' : ' · venda gradual') : ''}</span></td>
                <td>${App.web3.CHAINS[p.chain]?.name ?? p.chain}</td>
                <td class="col-num">${px2(p.lower, p.b)} – ${px2(p.upper, p.b)}</td>
                <td class="col-num">${px2(p.entryPrice, p.b)}<small class="muted">${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(p.remountedAt ?? p.createdAt)}</small></td>
                <td><span class="chip chip-${p.status === 'ativa' ? 'up' : 'flat'}">${p.status === 'ativa' ? 'Ativa' : 'Encerrada'}</span></td>
                <td class="col-num">${(p.history ?? []).length}</td>
                <td class="col-actions">
                    ${raw(p.status === 'ativa' ? html`<button class="btn btn-small btn-ghost" type="button" data-pl="remount" data-id="${p.id}">Remontar</button>` : '')}
                    <button class="icon-btn" type="button" data-pl="delete" data-id="${p.id}" aria-label="Apagar do diário">✕</button>
                </td>
            </tr>`).join(''))}</tbody>
        </table></div>`;
    }

    // ---------- Alertas fora do painel ----------
    function renderTelegram() {
        const addrs = S.wallets.map((w) => w.address).join(',');
        $('#plTg', root).innerHTML = html`
            <p>Uma tarefa agendada no seu repositório do GitHub confere as pools das carteiras a cada hora e manda mensagem no Telegram quando uma posição sai da faixa, chega perto da borda ou quando o fator de saúde do Aave cai. Funciona com o computador desligado. O passo a passo completo está no arquivo <strong>ALERTAS.md</strong> do projeto.</p>
            <ol class="pl-steps">
                <li>No Telegram, fale com <strong>@BotFather</strong>, crie um bot e guarde o token.</li>
                <li>Mande qualquer mensagem para o seu bot e descubra o seu chat id (instruções no ALERTAS.md).</li>
                <li>No GitHub: Settings → Secrets and variables → Actions → crie os segredos <code>TELEGRAM_BOT_TOKEN</code>, <code>TELEGRAM_CHAT_ID</code> e <code>WALLETS</code>.</li>
                <li>Na aba Actions do repositório, rode “Alertas de pools” manualmente uma vez para testar.</li>
            </ol>
            ${raw(addrs ? html`<label class="w3-key">Valor para o segredo WALLETS (suas carteiras cadastradas)<span class="inline-form"><input class="input input-small mono-addr" readonly value="${addrs}"><button class="btn btn-small" type="button" data-pl="copy" data-text="${addrs}">Copiar</button></span></label>` : '<p class="muted small">Cadastre carteiras na aba Web3 para gerar o valor do segredo WALLETS.</p>')}
            <p class="footnote">Os endereços ficam em segredos do GitHub, não no código público. O token do bot também. O GitHub pausa tarefas agendadas de repositórios sem nenhuma atividade por 60 dias; um commit qualquer reativa.</p>`;
    }

    // ---------- Formulário ----------
    function renderForm() {
        const f = S.poolForm;
        const symbols = [...new Set([f.a, ...S.watchlist, 'ETH', 'BTC'])];
        const quotes = [...new Set([f.b, 'USDC', 'USDT', 'ETH', 'BTC'])];
        $('#plForm', root).innerHTML = html`
            <div class="pl-mode seg seg-wide" role="group" aria-label="Estratégia">
                <button type="button" data-mode="two" aria-pressed="${f.mode === 'two'}">Faixa nos dois lados</button>
                <button type="button" data-mode="buy" aria-pressed="${f.mode === 'buy'}">Comprar aos poucos</button>
                <button type="button" data-mode="sell" aria-pressed="${f.mode === 'sell'}">Vender aos poucos</button>
            </div>
            <div class="form-row">
                <label>Token<span class="inline-form"><select class="input" data-f="a">${raw(symbols.map((s) => html`<option ${s === f.a ? 'selected' : ''}>${s}</option>`).join(''))}</select><button class="btn btn-small" type="button" data-pl="pick-a" title="Outra cripto">…</button></span></label>
                <label>Par com<span class="inline-form"><select class="input" data-f="b">${raw(quotes.map((s) => html`<option ${s === f.b ? 'selected' : ''}>${s}</option>`).join(''))}</select><button class="btn btn-small" type="button" data-pl="pick-b" title="Outra cripto">…</button></span></label>
                <label>Capital (US$)<input class="input" data-f="capital" inputmode="decimal" value="${f.capital}"></label>
                <label>Horizonte<select class="input" data-f="days">${raw([7, 14, 30, 60].map((d) => html`<option value="${d}" ${Number(f.days) === d ? 'selected' : ''}>${d} dias</option>`).join(''))}</select></label>
            </div>
            <div class="form-row">
                <label>Rede<select class="input" data-f="chain">${raw(Object.entries(App.web3.CHAINS).map(([k, c]) => html`<option value="${k}" ${f.chain === k ? 'selected' : ''}>${c.name}</option>`).join(''))}</select></label>
                <label>Taxa da pool<select class="input" data-f="fee">${raw([0.01, ...FEES].map((x) => html`<option value="${x}" ${Number(f.fee) === x ? 'selected' : ''}>${fmt.number(x, 2)}%</option>`).join(''))}</select></label>
                ${raw(f.mode === 'two'
                    ? html`<label>APR da pool no app (opcional, %)<input class="input" data-f="apr" inputmode="decimal" value="${f.apr}" placeholder="ex.: 18"></label>`
                    : html`<label>Começar a ${f.mode === 'buy' ? 'comprar' : 'vender'} a (%)<input class="input" data-f="near" inputmode="decimal" value="${f.near}"></label><label>Até (%)<input class="input" data-f="far" inputmode="decimal" value="${f.far}"></label>`)}
                <label>Volatilidade diária (opcional, %)<input class="input" data-f="vol" inputmode="decimal" value="${f.vol}" placeholder="automática"></label>
            </div>`;
    }

    const recompute = debounce(async () => {
        await compute();
        if (root) { renderPlanner(); }
    }, 250);

    function onFormInput(event) {
        const el = event.target.closest('[data-f]');
        if (!el) return;
        const key = el.dataset.f;
        S.poolForm[key] = ['days'].includes(key) ? Number(el.value) : el.value;
        store.save();
        if (['a', 'b'].includes(key)) {
            App.extraSymbols = [...new Set([under(S.poolForm.a), under(S.poolForm.b)].filter((s) => s !== 'USD'))];
            App.refreshPrices();
            renderForm();
        }
        if (key === 'capital' || key === 'b') renderGas();
        if (event.type === 'change' || ['capital', 'apr', 'vol', 'near', 'far'].includes(key)) recompute();
    }

    function onClick(event) {
        const t = event.target;
        const mode = t.closest('[data-mode]')?.dataset.mode;
        if (mode) {
            S.poolForm.mode = mode;
            store.save();
            renderForm();
            recompute();
            return;
        }
        const prof = t.closest('[data-profile]')?.dataset.profile;
        if (prof) { selected = prof; renderPlanner(); return; }
        const act = t.closest('[data-pl]')?.dataset.pl;
        const btn = t.closest('[data-pl]');
        if (act === 'save') saveToJournal();
        if (act === 'gas') renderGas(true);
        if (act === 'read') { S.wallets.forEach((w) => App.refreshWallet(w.id)); toast('Lendo carteiras…'); }
        if (act === 'pick-a' || act === 'pick-b') {
            App.openSearch('pick', null, (symbol) => {
                S.poolForm[act === 'pick-a' ? 'a' : 'b'] = symbol;
                store.save();
                App.extraSymbols = [...new Set([under(S.poolForm.a), under(S.poolForm.b)].filter((s) => s !== 'USD'))];
                App.refreshPrices();
                renderForm();
                recompute();
            });
        }
        if (act === 'plan') {
            Object.assign(S.poolForm, { a: btn.dataset.a, b: btn.dataset.b, chain: btn.dataset.chain, fee: Number(btn.dataset.fee), mode: 'two' });
            store.save();
            renderForm();
            recompute();
            $('#plPlanner', root).scrollIntoView({ behavior: 'smooth' });
        }
        if (act === 'remount') {
            const p = S.pools.find((x) => x.id === btn.dataset.id);
            if (!p) return;
            Object.assign(S.poolForm, { a: p.a, b: p.b, chain: p.chain, fee: p.fee, mode: p.mode ?? 'two', capital: p.capitalUsd ?? p.capital });
            $('#plOut', root).dataset.remount = p.id;
            renderForm();
            recompute();
            $('#plPlanner', root).scrollIntoView({ behavior: 'smooth' });
            toast('Ajuste a nova faixa e clique em “Salvar no diário” para registrar a remontagem.');
        }
        if (act === 'close') {
            const p = S.pools.find((x) => x.id === btn.dataset.id);
            if (p && window.confirm(`Encerrar ${p.a}/${p.b} no diário? Ela deixa de ser monitorada.`)) { p.status = 'encerrada'; p.closedAt = Date.now(); store.commit('pools'); }
        }
        if (act === 'delete') {
            const p = S.pools.find((x) => x.id === btn.dataset.id);
            if (p && window.confirm(`Apagar ${p.a}/${p.b} do diário?`)) { S.pools = S.pools.filter((x) => x.id !== p.id); store.commit('pools'); }
        }
        if (act === 'copy') navigator.clipboard?.writeText(btn.dataset.text).then(() => toast('Copiado.'));
    }

    App.views.pools = {
        title: 'Pools',
        mount(el, params = []) {
            ensureState();
            const tabs = (active) => html`<nav class="subtabs" aria-label="Seções de pools">
                <a href="#/pools" class="${active === 'minhas' ? 'is-active' : ''}" ${raw(active === 'minhas' ? 'aria-current="page"' : '')}>Planejar e monitorar</a>
                <a href="#/pools/descobrir" class="${active === 'descobrir' ? 'is-active' : ''}" ${raw(active === 'descobrir' ? 'aria-current="page"' : '')}>Descobrir pools</a>
            </nav>`;
            if (params[0] === 'descobrir') {
                discovering = true;
                el.innerHTML = html`<header class="page-head"><div><h1>Pools</h1><p class="lede">Onde está o volume e as taxas, por rede e por app, para escolher onde montar.</p></div></header>${raw(tabs('descobrir'))}<div id="dsRoot" class="ds-root"></div>`;
                App.poolDiscover.mount($('#dsRoot', el));
                return;
            }
            discovering = false;
            root = el;
            App.extraSymbols = [...new Set([under(S.poolForm.a), under(S.poolForm.b), 'ETH', 'POL'].filter((s) => s !== 'USD'))];
            App.refreshPrices();
            el.innerHTML = html`
                <header class="page-head">
                    <div><h1>Pools</h1><p class="lede">Planeje faixas pela volatilidade real do par, compare o custo nas redes e receba alertas para remontar.</p></div>
                </header>
                ${raw(tabs('minhas'))}
                <section class="panel" id="plPlanner">
                    <div class="panel-bar"><h2 class="panel-title">Montar uma pool</h2><button class="btn btn-small btn-primary" type="button" data-pl="save">Salvar no diário</button></div>
                    <div id="plForm" class="pl-form"></div>
                    <div id="plOut" class="pl-out"></div>
                </section>
                <section class="panel">
                    <div class="panel-bar"><h2 class="panel-title">Comparar redes</h2><button class="btn btn-small btn-ghost" type="button" data-pl="gas">Atualizar gás</button></div>
                    <div id="plGas"></div>
                </section>
                <section class="panel">
                    <div class="panel-bar"><h2 class="panel-title">Monitoramento e alertas</h2><button class="btn btn-small btn-ghost" type="button" data-pl="read">Ler carteiras</button></div>
                    <div id="plMon" class="pl-mon"></div>
                </section>
                <section class="panel">
                    <h2 class="panel-title">Diário de pools</h2>
                    <div id="plJournal"></div>
                </section>
                <details class="panel w3-settings">
                    <summary><h2 class="panel-title">Alertas no Telegram (com o painel fechado)</h2></summary>
                    <div id="plTg"></div>
                </details>`;
            el.addEventListener('click', onClick);
            el.addEventListener('input', onFormInput);
            el.addEventListener('change', onFormInput);
            renderForm();
            renderJournal();
            renderTelegram();
            renderMonitor();
            renderGas().then(() => root && renderMonitor());
            recompute();
            if (S.wallets.some((w) => !App.walletResults?.get(w.id))) S.wallets.forEach((w) => { if (!App.walletResults?.get(w.id)) App.refreshWallet(w.id); });
            let lastMon = 0;
            offs = [
                bus.on('pools', () => { renderJournal(); renderMonitor(); }),
                bus.on('wallet-read', () => renderMonitor()),
                bus.on('wallets', () => { renderTelegram(); renderMonitor(); }),
                bus.on('prices', () => {
                    if (!calc?.price && root) recompute();
                    if (Date.now() - lastMon > 5000 && !root?.querySelector('#plForm')?.contains(document.activeElement)) { lastMon = Date.now(); renderMonitor(); }
                }),
            ];
        },
        unmount() {
            if (discovering) { App.poolDiscover.unmount(); discovering = false; return; }
            offs.forEach((o) => o());
            offs = [];
            App.extraSymbols = [];
            root = null;
        },
    };
})(window.App);
