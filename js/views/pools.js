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
    let pendingRemount = null;

    const under = (s) => App.web3.underlying(s);
    const isStable = (s) => under(s) === 'USD';

    function defaults() {
        return { a: 'ETH', b: 'USDC', mode: 'two', capital: 1000, days: 14, fee: 0.3, apr: '', vol: '', near: 3, far: 20, chain: 'arbitrum' };
    }

    function ensureState() {
        if (!Array.isArray(S.pools)) S.pools = [];
        if (!S.poolDeposits || typeof S.poolDeposits !== 'object') S.poolDeposits = {};
        if (!S.poolWatch || typeof S.poolWatch !== 'object') S.poolWatch = {};
        if (!S.poolForm) S.poolForm = defaults();
    }

    // ---------- Preço e histórico do par ----------
    function pairPrice(a, b) {
        const pa = isStable(a) ? 1 : App.priceOf(under(a));
        const pb = isStable(b) ? 1 : App.priceOf(under(b));
        return pa && pb ? pa / pb : null;
    }

    // Fechamentos diários de uma cripto: Binance e, se não houver par lá, DefiLlama.
    async function closesOf(sym, days = 200) {
        try {
            return (await App.api.klines(sym, '1d', days)).map((r) => ({ time: r.time, close: r.close }));
        } catch (error) {
            const alt = await App.llama?.dailyCloses(sym, days);
            if (alt?.length) return alt.map((r) => ({ time: Math.floor(r.time / 86400) * 86400, close: r.close }));
            throw error;
        }
    }

    async function pairCloses(a, b) {
        const ua = under(a);
        const ub = under(b);
        if (ua === ub) return null;
        if (ub === 'USD') return (await closesOf(ua)).map((r) => r.close);
        if (ua === 'USD') return (await closesOf(ub)).map((r) => 1 / r.close);
        {
            const [ra, rb] = await Promise.all([closesOf(ua), closesOf(ub)]);
            const mb = new Map(rb.map((r) => [r.time, r.close]));
            return ra.filter((r) => mb.has(r.time)).map((r) => r.close / mb.get(r.time));
        }
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
        const rows = await Promise.all(Object.entries(chains).filter(([, c]) => !c.solana).map(async ([key, c]) => {
            try {
                const gwei = await App.web3.gasPriceGwei(key);
                const nativeUsd = App.priceOf(c.native) ?? null;
                const unit = nativeUsd ? gwei * 1e-9 * nativeUsd : null;
                return { key, name: c.name, gwei, mint: unit ? unit * GAS_MINT : null, rebalance: unit ? unit * GAS_REBALANCE : null, l2: key !== 'ethereum' && key !== 'polygon' };
            } catch (error) {
                return { key, name: c.name, error: true };
            }
        }));
        // Solana: sem leilão de gás como no Ethereum; as taxas por transação ficam em frações de centavo.
        const solPrice = App.priceOf('SOL');
        rows.push({ key: 'solana', name: 'Solana', gwei: null, mint: solPrice ? 0.0002 * solPrice : null, rebalance: solPrice ? 0.0006 * solPrice : null, solana: true });
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

    // Faixa informada pelo usuário (ex.: a de uma pool que ele já montou no app).
    function customRange() {
        const lo = App.parseNum(S.poolForm.lo);
        const hi = App.parseNum(S.poolForm.hi);
        if (!(lo > 0) || !(hi > lo) || !calc?.price) return null;
        const P = calc.price;
        const sd = calc.vol ? calc.vol * Math.sqrt(Number(S.poolForm.days)) : null;
        const probEnd = sd ? PM().normCdf(Math.log(hi / P) / sd) - PM().normCdf(Math.log(lo / P) / sd) : null;
        const pos = PM().positionInRange(P, lo, hi);
        const hint = pos < 0 ? 'O preço já está abaixo da sua faixa: a posição está 100% no token e não rende taxas.'
            : pos > 1 ? 'O preço já está acima da sua faixa: a posição está 100% na stablecoin e não rende taxas.'
                : pos < 0.15 ? 'O preço está encostado na borda de baixo: a posição está quase toda no token.'
                    : pos > 0.85 ? 'O preço está encostado na borda de cima: a posição está quase toda na stablecoin.'
                        : 'O preço está dentro da sua faixa.';
        return { key: 'custom', label: 'Sua faixa', lower: lo, upper: hi, widthPct: ((hi / lo) ** 0.5 - 1) * 100, down: (lo / P - 1) * 100, up: (hi / P - 1) * 100, probEnd, probStay: null, hint };
    }

    function profilesNow() {
        if (!calc?.price) return [];
        const base = calc.vol ? PM().profiles(calc.price, calc.vol, Number(S.poolForm.days)) : [];
        const own = customRange();
        return own ? [own, ...base] : base;
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
        if (!root || !$('#plOut', root)) return;
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
                        <span class="muted small">${p.key === 'custom' ? `${fmt.pct(p.down, 1)} / ${fmt.pct(p.up, 1)} do preço` : `±${fmt.number(p.widthPct, 1)}% do preço`}</span>
                        <dl>
                            <dt>Termina na faixa</dt><dd>${p.probEnd === null ? '—' : `${fmt.number(p.probEnd * 100, 0)}%`}</dd>
                            ${raw(p.probStay === null ? '' : html`<dt>Nunca sai da faixa</dt><dd>${fmt.number(p.probStay * 100, 0)}%</dd>`)}
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
        if (!root || !$('#plGas', root)) { await gasTable(force).catch(() => null); return; }
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
                    <td class="col-num">${r.solana ? 'taxa fixa + prioridade' : `${fmt.number(r.gwei, r.gwei < 1 ? 4 : 1)} gwei`}</td>
                    <td class="col-num">${usdCost(r.mint)}</td>
                    <td class="col-num">${usdCost(r.rebalance)}</td>
                    <td class="col-num ${pct === null ? '' : pct > 1 ? 'delta-down' : pct > 0.3 ? '' : 'delta-up'}">${pct === null ? '—' : `${fmt.number(pct, pct < 0.1 ? 3 : 2)}%`}</td>
                </tr>`;
            }).join(''))}</tbody>
        </table></div>
        <p class="footnote">Estimativa com o gás de agora: cerca de ${fmt.number(GAS_MINT / 1000, 0)} mil unidades para montar e ${fmt.number(GAS_REBALANCE / 1000, 0)} mil para remontar (retirar, coletar, trocar e montar de novo). Nas redes de segunda camada há também uma pequena taxa de dados que não aparece aqui. Na Solana a taxa é estimada com folga para prioridade; abrir uma posição ainda exige um depósito de aluguel das contas, devolvido quando você fecha a posição. ${raw(best ? html`Hoje, a mais barata é <strong>${best.name}</strong>. Acima de ~1% do capital por remontagem, faixas estreitas raramente compensam.` : '')} Confira também o volume de cada pool no app: taxa barata não adianta sem negociação.</p>`;
    }

    // ---------- Monitoramento ----------
    function orient(u) {
        // Exibe sempre como "token volátil cotado no outro": se token0 for stablecoin, inverte.
        if (isStable(u.symbol0) && !isStable(u.symbol1)) {
            return { a: u.symbol1, b: u.symbol0, lower: 1 / u.priceUpper, upper: 1 / u.priceLower, price: 1 / u.priceNow, qtyA: u.amount1 ?? undefined, qtyB: u.amount0 ?? undefined, feeA: u.owed1 ?? 0, feeB: u.owed0 ?? 0 };
        }
        return { a: u.symbol0, b: u.symbol1, lower: u.priceLower, upper: u.priceUpper, price: u.priceNow, qtyA: u.amount0 ?? undefined, qtyB: u.amount1 ?? undefined, feeA: u.owed0 ?? 0, feeB: u.owed1 ?? 0 };
    }

    function monitored() {
        const out = [];
        S.wallets.forEach((w) => {
            const r = App.walletResults?.get(w.id);
            r?.parts?.forEach((p) => p.uni.forEach((u) => {
                if (!u.symbol0 || !u.priceLower) return;
                const o = orient(u);
                out.push({ key: `chain:${p.chain}:${u.dex}:${u.id}`, source: `${w.name} · ${App.web3.CHAINS[p.chain].name} · ${u.dex ?? ''}${u.staked ? ' (staking)' : ''}`, chain: p.chain, fee: (u.fee ?? 0) / 10000, ...o, flip: o.a !== u.symbol0, usd: u.usd, feesUsd: feeUsd(u), onchain: true, walletId: w.id, walletName: w.name, dex: u.dex, positionId: u.id, poolAddress: u.pool });
            }));
        });
        S.pools.filter((p) => p.status === 'ativa').forEach((p) => {
            const price = pairPrice(p.a, p.b);
            if (!price) return;
            const qty = p.L ? PM().valueAt(p.L, price, p.lower, p.upper) : null;
            const dep0 = p.L ? PM().valueAt(p.L, p.entryPrice, p.lower, p.upper) : null;
            out.push({ depFromJournal: dep0 ? { qtyA: dep0.qtyA, qtyB: dep0.qtyB } : null, key: `diario:${p.id}`, source: `Diário · ${App.web3.CHAINS[p.chain]?.name ?? p.chain}`, chain: p.chain, fee: p.fee, a: p.a, b: p.b, lower: p.lower, upper: p.upper, price, qtyA: qty?.qtyA, qtyB: qty?.qtyB, usd: qty ? qty.value * (isStable(p.b) ? 1 : App.priceOf(under(p.b)) ?? 0) : null, feesUsd: null, journalId: p.id, createdAt: p.createdAt });
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
        if (!root || !$('#plMon', root)) return;
        const el = $('#plMon', root);
        const list = monitored();
        const hasWallets = S.wallets.length;
        if (!list.length) {
            el.innerHTML = html`<div class="empty-state"><p>${hasWallets ? 'Nenhuma posição de pool encontrada nas suas carteiras nem no diário.' : 'Cadastre suas carteiras em Configurações para acompanhar as pools on-chain, ou planeje uma pool e salve no diário.'}</p>
                <div class="toolbar">${raw(hasWallets ? '<button class="btn btn-small" type="button" data-pl="read">Ler carteiras agora</button>' : '<a class="btn btn-small" href="#/config">Cadastrar carteira</a>')}<a class="btn btn-small btn-primary" href="#/pools/planejar">Planejar uma pool</a><a class="btn btn-small btn-ghost" href="#/pools/explorar">Explorar pools</a></div></div>`;
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
                ${raw(m.onchain ? methodBadge(m) : '')}
                ${raw(holdBlock(m))}
                ${raw(sug && (a.out || a.alerts.length) ? html`<p class="pl-sug">Nova faixa sugerida (equilibrada, 14 dias): <strong>${px2(sug.lower, m.b)} – ${px2(sug.upper, m.b)}</strong>. ${worth}</p>` : (worth ? html`<p class="pl-sug">${worth}</p>` : ''))}
                <div class="toolbar">
                    <button class="btn btn-small" type="button" data-pl="plan" data-a="${m.a}" data-b="${m.b}" data-chain="${m.chain}" data-fee="${m.fee}">Planejar remontagem</button>
                    ${raw(m.onchain ? html`<a class="btn btn-small btn-ghost" href="#/pools/relatorio/${encodeURIComponent(m.key)}">Relatório</a>` : '')}
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

    // "Pool contra só segurar": valor de hoje + taxas, comparado com segurar os tokens depositados.
    function holdBlock(m) {
        const dep = S.poolDeposits?.[m.key] ?? (m.depFromJournal ? { ...m.depFromJournal, fromJournal: true } : null);
        if (!dep) {
            return m.onchain && m.qtyA !== undefined
                ? html`<p class="pl-hold-empty"><button class="link-btn" type="button" data-dep="${m.key}">Informar o depósito inicial</button> para comparar com “só segurar”.</p>`
                : '';
        }
        if (m.qtyA === undefined || m.qtyB === undefined) return '';
        const usdB = isStable(m.b) ? 1 : App.priceOf(under(m.b)) ?? null;
        if (!usdB) return '';
        const feesB = (m.feeA ?? 0) * m.price + (m.feeB ?? 0) + (dep.collectedUsd ?? 0) / usdB;
        const poolB = m.qtyA * m.price + m.qtyB;
        const holdB = dep.qtyA * m.price + dep.qtyB;
        const net = (poolB + feesB - holdB) * usdB;
        const il = (poolB - holdB) * usdB;
        const pct = holdB ? ((poolB + feesB) / holdB - 1) * 100 : 0;
        const priv = S.settings.privacy;
        const money = (v) => (priv ? '•••' : fmt.money(v, 'USD', 2));
        return html`<div class="pl-hold">
            <div class="pl-hold-head"><span class="muted small">Contra só segurar${dep.fromJournal ? ' (sem taxas no diário)' : ''}</span>${raw(dep.fromJournal ? '' : html`<button class="link-btn small" type="button" data-dep="${m.key}">editar depósito</button>`)}</div>
            <dl>
                <dt>Segurar valeria</dt><dd>${money(holdB * usdB)}</dd>
                <dt>Pool agora</dt><dd>${money(poolB * usdB)}</dd>
                <dt>Taxas ganhas</dt><dd class="delta-up">${money(feesB * usdB)}</dd>
                <dt>Diferença de preço</dt><dd class="delta-${toneOf(il)}">${priv ? '•••' : fmt.signedMoney(il, 'USD')}</dd>
                <dt><strong>Resultado da pool</strong></dt><dd class="delta-${toneOf(net)}"><strong>${priv ? '•••' : fmt.signedMoney(net, 'USD')}</strong> <small>${fmt.pct(pct, 2)}</small></dd>
            </dl>
        </div>`;
    }

    function openDeposit(key) {
        const m = monitored().find((x) => x.key === key);
        if (!m) return;
        const dep = S.poolDeposits?.[key];
        const dlg = $('#depDialog');
        dlg.dataset.key = key;
        $('#depTitle').textContent = `Depósito inicial · ${m.a}/${m.b}`;
        $('#depALabel').textContent = `Quantidade de ${m.a} depositada`;
        $('#depBLabel').textContent = `Quantidade de ${m.b} depositada`;
        $('#depA').value = dep?.qtyA ?? '';
        $('#depB').value = dep?.qtyB ?? '';
        $('#depCollected').value = dep?.collectedUsd ?? '';
        $('#depPriceLabel').textContent = `Preço de ${m.a} no depósito, em ${m.b} (opcional)`;
        $('#depPrice').value = dep?.priceEntry ?? '';
        $('#depStart').value = dep?.start ?? '';
        $('#depStart').max = new Date().toISOString().slice(0, 10);
        $('#depHint').textContent = `Hoje a posição tem ${fmt.qty(m.qtyA)} ${m.a} + ${fmt.qty(m.qtyB)} ${m.b}. Use as quantidades do momento em que você depositou (aparecem no app na criação da posição ou na transação de depósito).`;
        dlg.showModal();
        $('#depA').focus();
    }

    function wireDepositDialog() {
        const dlg = $('#depDialog');
        if (dlg.dataset.wired) return;
        dlg.dataset.wired = '1';
        $('#depCancel').addEventListener('click', () => dlg.close());
        $('#depClear').addEventListener('click', () => { delete S.poolDeposits[dlg.dataset.key]; store.commit('pools'); dlg.close(); });
        $('#depForm').addEventListener('submit', (event) => {
            event.preventDefault();
            const qa = App.parseNum($('#depA').value);
            const qb = App.parseNum($('#depB').value);
            const col = $('#depCollected').value.trim() ? App.parseNum($('#depCollected').value) : 0;
            const pe = $('#depPrice').value.trim() ? App.parseNum($('#depPrice').value) : null;
            if (!(qa >= 0) || !(qb >= 0) || qa + qb <= 0) { toast('Informe as quantidades depositadas.', 'bad'); return; }
            S.poolDeposits = { ...(S.poolDeposits ?? {}), [dlg.dataset.key]: { qtyA: qa, qtyB: qb, collectedUsd: col > 0 ? col : 0, priceEntry: pe > 0 ? pe : null, start: $('#depStart').value || null, at: Date.now() } };
            store.commit('pools');
            dlg.close();
            toast('Depósito salvo. A comparação aparece no cartão da pool.', 'up');
        });
    }

    const short = (v) => `${v.slice(0, 6)}…${v.slice(-4)}`;
    const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // ---------- Relatório automático de uma posição ----------
    const GT_NET = { ethereum: 'eth', arbitrum: 'arbitrum', base: 'base', optimism: 'optimism', polygon: 'polygon_pos', bnb: 'bsc', zksync: 'zksync', solana: 'solana' };
    const poolStatsCache = new Map();
    async function poolStats(chain, address, feePct) {
        if (!address || !GT_NET[chain]) return null;
        const key = `${chain}:${address}`;
        const hit = poolStatsCache.get(key);
        if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
        const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${GT_NET[chain]}/pools/${address}`, { headers: { accept: 'application/json' } });
        if (!r.ok) throw new Error(`GeckoTerminal HTTP ${r.status}`);
        const a = (await r.json()).data?.attributes ?? {};
        const tvl = Number(a.reserve_in_usd) || 0;
        const vol = Number(a.volume_usd?.h24) || 0;
        const value = tvl > 0 ? { tvl, vol, fees: vol * feePct / 100, apr: (vol * feePct / 100 / tvl) * 365 * 100, at: Date.now() } : null;
        poolStatsCache.set(key, { at: Date.now(), value });
        return value;
    }

    // Converte um ponto do histórico (token1 por token0) para a orientação exibida (B por A).
    function histPoint(m, h) {
        const price = m.flip ? 1 / h.price0 : h.price0;
        const qtyA = m.flip ? h.amount1 : h.amount0;
        const qtyB = m.flip ? h.amount0 : h.amount1;
        const feeA = m.flip ? h.owed1 : h.owed0;
        const feeB = m.flip ? h.owed0 : h.owed1;
        return { t: h.t, price, valueB: qtyA * price + qtyB, feesB: (feeA ?? 0) * price + (feeB ?? 0) };
    }

    let reportKey = null;
    let reportTimer = null;
    let reportChart = null;

    function renderReport() {
        const el = $('#rpBody', root);
        if (!el) return;
        const list = monitored().filter((x) => x.onchain);
        const ranked = [...list].sort((x, y) => (Number(Boolean(S.poolDeposits?.[y.key])) - Number(Boolean(S.poolDeposits?.[x.key])))
            || (Number(y.price >= y.lower && y.price <= y.upper) - Number(x.price >= x.lower && x.price <= x.upper)) || ((y.usd ?? 0) - (x.usd ?? 0)));
        const m = list.find((x) => x.key === reportKey) ?? ranked[0];
        if (!m) {
            el.innerHTML = S.wallets.length
                ? '<p class="muted">Lendo as carteiras… Se a posição não aparecer, confira em Minhas pools.</p>'
                : '<div class="empty-state"><p>O relatório automático usa as posições das suas carteiras. Cadastre a carteira em Configurações.</p><a class="btn btn-small btn-primary" href="#/config">Cadastrar carteira</a></div>';
            return;
        }
        reportKey = m.key;
        const valueB = m.qtyA * m.price + m.qtyB;
        // Sem cotação direta do token B: usa o valor em dólar que a leitura da carteira já calculou.
        const usdB = isStable(m.b) ? 1 : App.priceOf(under(m.b)) ?? (m.usd && valueB ? m.usd / valueB : null);
        const toUsd = (vB) => (usdB ? vB * usdB : null);
        const dep = S.poolDeposits?.[m.key];
        const feesB = (m.feeA ?? 0) * m.price + (m.feeB ?? 0) + (dep?.collectedUsd && usdB ? dep.collectedUsd / usdB : 0);
        const holdB = dep ? dep.qtyA * m.price + dep.qtyB : null;
        const depB = dep?.priceEntry ? dep.qtyA * dep.priceEntry + dep.qtyB : null;
        const pos = PM().positionInRange(m.price, m.lower, m.upper);
        const status = pos < 0 ? 'fora-baixo' : pos > 1 ? 'fora-cima' : pos < 0.2 ? 'borda-baixo' : pos > 0.8 ? 'borda-cima' : 'centro';
        const take = {
            centro: ['up', 'Dentro da faixa, com o preço no centro.', 'Nada a fazer: deixe a posição trabalhar.'],
            'borda-baixo': ['warn', 'Perto da borda de baixo.', 'Está quase toda em ' + m.a + '. Se ficar aqui por mais de 3 dias, considere remontar.'],
            'borda-cima': ['warn', 'Perto da borda de cima.', 'Está quase toda em ' + m.b + '. Se ficar aqui por mais de 3 dias, considere remontar.'],
            'fora-baixo': ['down', 'Fora da faixa, por baixo.', 'Está 100% em ' + m.a + ' e não rende taxas. Se continuar fora por mais de um dia, avalie remontar.'],
            'fora-cima': ['down', 'Fora da faixa, por cima.', 'Está 100% em ' + m.b + ' e não rende taxas. Se continuar fora por mais de um dia, avalie remontar.'],
        }[status];
        // Ritmo das taxas pelo histórico automático.
        const hist = (S.poolHistory?.[m.key] ?? []).map((h) => histPoint(m, h)).filter((h) => Number.isFinite(h.valueB));
        const first = hist[0];
        const last = hist[hist.length - 1];
        const hours = first && last ? (last.t - first.t) / 3600000 : 0;
        const ratePerDayB = hours >= 1 ? Math.max(0, last.feesB - first.feesB) / hours * 24 : null;
        const aprReal = ratePerDayB !== null && valueB ? ratePerDayB * 365 / valueB * 100 : null;
        const priv = S.settings.privacy;
        const usd = (vB) => (priv ? '•••' : vB === null || !usdB ? '—' : fmt.money(toUsd(vB), 'USD', 2));
        const sUsd = (vB) => (priv ? '•••' : vB === null || !usdB ? '—' : fmt.signedMoney(toUsd(vB), 'USD'));
        const res = holdB !== null ? valueB + feesB - holdB : null;
        const vsUsd = depB !== null ? valueB + feesB - depB : null;

        el.innerHTML = html`
            <section class="panel rp-head">
                <div class="rp-title">
                    <h2>${m.a}/${m.b} · ${App.web3.CHAINS[m.chain]?.name} · ${m.dex ?? ''} ${raw(m.fee ? html`<span class="muted">${fmt.number(m.fee, 2)}%</span>` : '')}</h2>
                    <p class="muted small">${m.walletName} · posição ${String(m.positionId).length > 12 ? short(String(m.positionId)) : `#${m.positionId}`} · ${last ? `atualizado às ${fmt.time(new Date(last.t))}` : 'lendo…'} · atualiza sozinho a cada 5 minutos</p>
                </div>
                <p class="rp-take"><strong class="delta-${take[0]}">${take[1]}</strong> ${take[2]}</p>
                ${raw(reviewLine(dep, m))}
            </section>
            <div class="rp-kpis">
                <div class="panel"><span class="pf-label">Valor da posição</span><strong class="rp-big">${usd(valueB)}</strong><span class="muted small">${fmt.qty(m.qtyA)} ${m.a} + ${fmt.qty(m.qtyB)} ${m.b}</span></div>
                <div class="panel"><span class="pf-label">Taxas ganhas</span><strong class="rp-big">${usd(feesB)}</strong><span class="muted small">${ratePerDayB !== null ? `≈ ${usd(ratePerDayB)} por dia` : 'ritmo aparece após 1 h de histórico'}</span></div>
                <div class="panel"><span class="pf-label">Contra só segurar</span><strong class="rp-big delta-${toneOf(res)}">${res === null ? '—' : sUsd(res)}</strong><span class="muted small">${raw(res === null ? html`<button class="link-btn" type="button" data-dep="${m.key}">informe o depósito inicial</button>` : html`${fmt.pct((valueB + feesB) / holdB * 100 - 100, 2)} contra segurar`)}</span></div>
                <div class="panel"><span class="pf-label">Contra ter ficado em dólar</span><strong class="rp-big delta-${toneOf(vsUsd)}">${vsUsd === null ? '—' : sUsd(vsUsd)}</strong><span class="muted small">${vsUsd === null ? 'informe o preço de entrada no depósito' : `${fmt.pct((valueB + feesB) / depB * 100 - 100, 2)} sobre o depositado`}</span></div>
            </div>
            <div id="rpMethod"></div>
            <section class="panel">
                <h3 class="panel-title">Onde o preço está na faixa</h3>
                <div class="rp-range">${raw(rangeSvg(m, status))}</div>
                <dl class="rp-dl">
                    <dt>Posição na faixa (0% = borda de baixo)</dt><dd>${fmt.number(Math.max(-99, Math.min(199, pos * 100)), 0)}%</dd>
                    <dt>Até a borda de baixo</dt><dd>${fmt.pct((m.lower / m.price - 1) * 100, 2)}</dd>
                    <dt>Até a borda de cima</dt><dd>${fmt.pct((m.upper / m.price - 1) * 100, 2)}</dd>
                </dl>
            </section>
            <div class="rp-grid">
                <section class="panel">
                    <div class="panel-bar"><h3 class="panel-title">Contra só segurar</h3>${raw(dep ? html`<button class="link-btn small" type="button" data-dep="${m.key}">editar depósito</button>` : '')}</div>
                    ${raw(dep ? html`<dl class="rp-dl">
                        <dt>Segurar ${fmt.qty(dep.qtyA)} ${m.a} + ${fmt.qty(dep.qtyB)} ${m.b} valeria</dt><dd>${usd(holdB)}</dd>
                        <dt>Pool agora</dt><dd>${usd(valueB)}</dd>
                        <dt>Diferença de preço (sem taxas)</dt><dd class="delta-${toneOf(valueB - holdB)}">${sUsd(valueB - holdB)}</dd>
                        <dt>Taxas ganhas</dt><dd class="delta-up">${usd(feesB)}</dd>
                        <dt class="rp-total">Resultado da pool</dt><dd class="rp-total delta-${toneOf(res)}">${sUsd(res)}</dd>
                    </dl>` : html`<p class="muted">Informe quanto você depositou para ver se a pool está ganhando de só segurar.</p><button class="btn btn-small btn-primary" type="button" data-dep="${m.key}">Informar depósito inicial</button>`)}
                </section>
                <section class="panel">
                    <h3 class="panel-title">Taxas e expectativa</h3>
                    <div id="rpExp"><p class="muted">Buscando o APR da pool…</p></div>
                </section>
            </div>
            <p class="footnote">Não é a pool que você procura? O relatório mostra as posições das carteiras cadastradas. Confira em <a href="#/config">Configurações</a> se a carteira dela está lá com a rede certa marcada (por exemplo, Base).</p>
            <section class="panel">
                <h3 class="panel-title">Evolução</h3>
                <p class="muted small">${dep ? 'Pool + taxas contra só segurar, a cada leitura da carteira.' : 'Valor da posição + taxas, a cada leitura da carteira.'}</p>
                <div id="rpChart" class="rp-chart"></div>
                <p class="footnote">${hist.length} leitura(s) guardadas neste navegador, desde ${first ? fmt.date(new Date(first.t).toISOString().slice(0, 10)) : '—'}. O painel guarda um ponto a cada 10 minutos enquanto estiver aberto.</p>
            </section>`;
        renderMethod(m, hist, dep, usdB);
        renderReportChart(m, hist, dep, usdB);
        renderExpectation(m, valueB, ratePerDayB, aprReal, usd);
    }

    const ZONE = { green: ['🟢', 'Verde', 'up'], yellow: ['🟡', 'Amarelo', 'warn'], red: ['🔴', 'Vermelho', 'down'] };

    function methodFor(m, dep) {
        const hist = (S.poolHistory?.[m.key] ?? []).map((h) => histPoint(m, h)).filter((h) => Number.isFinite(h.price));
        const tvl = poolStatsCache.get(`${m.chain}:${m.poolAddress}`)?.value?.tvl ?? null;
        return App.method.evaluate({ m, hist, dep, tvlUsd: tvl });
    }

    // Painel "Regras do método": semáforo, tempo na cor, ação do dia, checklist e remontagem sugerida.
    function methodBadge(m) {
        const r = methodFor(m, S.poolDeposits?.[m.key] ?? null);
        const z = ZONE[r.zone];
        return html`<p class="pl-method"><span>${z[0]} ${z[1]} há ${App.method.duration(r.inZone)}</span><strong>${r.action.text}</strong></p>`;
    }

    function renderMethod(m, hist, dep, usdB) {
        const el = $('#rpMethod', root);
        if (!el) return;
        const r = methodFor(m, dep);
        const z = ZONE[r.zone];
        const usd = (vB) => (usdB ? fmt.money(vB * usdB, 'USD', 2) : `${fmt.qty(vB)} ${m.b}`);
        const sug = r.suggestion;
        el.innerHTML = html`<section class="panel rp-method rp-method-${r.action.level}">
            <div class="panel-bar"><h3 class="panel-title">Regras do método</h3><span class="muted small">faixa de ±${fmt.number(r.profile, 1)}% · perfil ${r.profile <= 8 ? 'ativo (olhar todo dia)' : 'tranquilo (olhar 1 vez por semana)'}</span></div>
            <div class="rp-sem">
                <span class="rp-sem-light">${z[0]}</span>
                <div><strong class="delta-${z[2]}">${z[1]}</strong> · ${fmt.number(Math.max(-99, Math.min(199, r.pos * 100)), 0)}% da faixa · há ${App.method.duration(r.inZone)}</div>
            </div>
            <p class="rp-action"><span class="pf-label">Ação de hoje</span><strong>${r.action.text}</strong></p>
            <ul class="rp-checks">${raw(r.checks.map((c) => html`<li class="${c.ok === null ? 'is-na' : c.ok ? 'is-ok' : c.warn ? 'is-warn' : 'is-bad'}">${c.ok === null ? '·' : c.ok ? '✓' : c.warn ? '!' : '✗'} ${c.text}${c.ok === null ? ' (aguardando dados)' : ''}</li>`).join(''))}</ul>
            ${raw(sug ? html`<div class="rp-sug">
                <p class="pf-label">${r.action.level === 'act' ? 'Remontagem pelas regras, com o preço de agora' : 'Se precisar remontar, com o preço de agora'}${sug.widened ? ' (faixa 50% mais larga)' : ''}</p>
                <div class="table-wrap"><table class="data-table"><thead><tr><th>Parte</th><th>Faixa</th><th class="col-num">Depositar</th></tr></thead><tbody>
                    <tr><td>Metade centrada (±${fmt.number(sug.halfPct, 1)}%)</td><td>${px2(sug.centered.lower, m.b)} – ${px2(sug.centered.upper, m.b)}</td><td class="col-num">${fmt.qty(sug.centered.qtyA)} ${m.a} + ${fmt.qty(sug.centered.qtyB)} ${m.b}</td></tr>
                    <tr><td>Metade ${sug.oneSide.note}</td><td>${px2(sug.oneSide.lower, m.b)} – ${px2(sug.oneSide.upper, m.b)}</td><td class="col-num">${sug.oneSide.qtyA ? `${fmt.qty(sug.oneSide.qtyA)} ${m.a}` : `${fmt.qty(sug.oneSide.qtyB)} ${m.b}`}</td></tr>
                </tbody></table></div>
                <p class="footnote">Troca necessária: ~${usd(sug.swap.amountB)} de ${sug.swap.from} para ${sug.swap.to}, só para a parte centrada. As quantidades mudam com o preço: confira na hora de montar.</p>
            </div>` : '')}
        </section>`;
    }

    // Data de montagem, idade da posição e próxima revisão semanal (mesmo dia da semana da montagem).
    function reviewLine(dep, m) {
        if (!dep?.start) return html`<p class="muted small"><button class="link-btn" type="button" data-dep="${m.key}">Informe a data de montagem</button> para acompanhar a idade da posição e as revisões semanais.</p>`;
        const start = new Date(`${dep.start}T12:00:00`);
        const today = new Date(); today.setHours(12, 0, 0, 0);
        const days = Math.round((today - start) / 86400000);
        const next = new Date(start);
        while (next <= today) next.setDate(next.getDate() + 7);
        const isToday = days > 0 && days % 7 === 0;
        // Mesmo dia do mês da montagem (ou o último dia, em meses mais curtos).
        const monthly = (k) => { const d = new Date(start.getFullYear(), start.getMonth() + k, 1, 12); d.setDate(Math.min(start.getDate(), new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); return d; };
        let k = 1;
        while (monthly(k) <= today) k += 1;
        const month = monthly(k);
        const fmtD = (d) => new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }).format(d);
        return html`<p class="rp-review"><span>Montada em <strong>${fmt.date(dep.start)}</strong> · ${days} dia(s)</span><span>${raw(isToday ? html`<strong class="delta-warn">Dia de revisão semanal hoje</strong>` : html`Próxima revisão semanal: <strong>${fmtD(next)}</strong>`)}</span><span>Revisão do mês: <strong>${fmtD(month)}</strong></span></p>`;
    }

    // Barra da faixa em HTML (o texto não muda de tamanho com a largura da tela).
    function rangeSvg(m, status) {
        const lo = Math.min(m.lower, m.price) / 1.03, hi = Math.max(m.upper, m.price) * 1.03;
        const pct = (v) => ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * 100;
        const col = status === 'centro' ? 'up' : status.startsWith('borda') ? 'warn' : 'down';
        const nowPct = Math.max(1, Math.min(99, pct(m.price)));
        return html`<div class="rp-bar">
            <span class="rp-bar-now-label" style="left:${nowPct}%">agora ${px2(m.price, m.b)}</span>
            <div class="rp-bar-track">
                <span class="rp-bar-range rp-${col}" style="left:${pct(m.lower)}%;width:${pct(m.upper) - pct(m.lower)}%"></span>
                <span class="rp-bar-now" style="left:${nowPct}%"></span>
            </div>
            <span class="rp-bar-edge" style="left:${pct(m.lower)}%">${px2(m.lower, m.b)}</span>
            <span class="rp-bar-edge" style="left:${pct(m.upper)}%">${px2(m.upper, m.b)}</span>
        </div>`;
    }

    function renderReportChart(m, hist, dep, usdB) {
        const box = $('#rpChart', root);
        if (!box) return;
        reportChart?.remove();
        reportChart = null;
        if (hist.length < 2 || !usdB) { box.innerHTML = '<p class="muted">O gráfico aparece a partir da segunda leitura (cerca de 10 minutos com o painel aberto).</p>'; return; }
        reportChart = window.LightweightCharts.createChart(box, App.charts.chartOptions({ handleScroll: false, handleScale: false, timeScale: { borderColor: App.charts.css('--line'), timeVisible: true, secondsVisible: false } }));
        const toPts = (fn) => hist.map((h) => ({ time: Math.floor(h.t / 1000), value: fn(h) * usdB }));
        const pool = reportChart.addLineSeries({ color: App.charts.css('--brand'), lineWidth: 2, priceLineVisible: false, title: 'Pool + taxas' });
        pool.setData(toPts((h) => h.valueB + h.feesB));
        if (dep) {
            const hold = reportChart.addLineSeries({ color: App.charts.css('--ink-3'), lineWidth: 2, lineStyle: 2, priceLineVisible: false, title: 'Só segurar' });
            hold.setData(toPts((h) => dep.qtyA * h.price + dep.qtyB));
        }
        reportChart.timeScale().fitContent();
    }

    async function renderExpectation(m, valueB, ratePerDayB, aprReal, usd) {
        const el = $('#rpExp', root);
        if (!el) return;
        let st = null;
        try { st = await poolStats(m.chain, m.poolAddress, m.fee); } catch { st = null; }
        if (!root || !$('#rpExp', root)) return;
        const rows = [];
        if (st?.apr) {
            rows.push(['APR da pool hoje, sempre dentro', st.apr]);
            rows.push(['APR da pool, dentro 70% do tempo', st.apr * 0.7]);
            rows.push(['Volume normal (metade), dentro 70% do tempo', st.apr * 0.35]);
        }
        if (aprReal !== null) rows.push(['Seu ritmo real (histórico)', aprReal]);
        el.innerHTML = html`
            ${raw(st ? html`<p class="muted small">Pool inteira: ${fmt.compactMoney(st.fees)} em taxas em 24 h sobre ${fmt.compactMoney(st.tvl)} de liquidez (volume de ${fmt.compactMoney(st.vol)}), APR de ${fmt.number(st.apr ?? 0, 1)}%. Fonte: GeckoTerminal.</p>` : '<p class="muted small">APR da pool indisponível agora (GeckoTerminal).</p>')}
            ${raw(rows.length ? html`<div class="table-wrap"><table class="data-table"><thead><tr><th>Cenário</th><th class="col-num">APR</th><th class="col-num">Por dia</th><th class="col-num">Por mês</th><th class="col-num">% ao mês</th></tr></thead><tbody>
                ${raw(rows.map(([name, apr]) => html`<tr><td>${name}</td><td class="col-num">${fmt.number(apr, 0)}%</td><td class="col-num">${usd(valueB * apr / 100 / 365)}</td><td class="col-num"><strong>${usd(valueB * apr / 100 / 12)}</strong></td><td class="col-num">${fmt.number(apr / 12, 1)}%</td></tr>`).join(''))}
            </tbody></table></div>` : '')}
            ${raw(st?.apr && aprReal !== null ? html`<p class="footnote">Seu ritmo real está em ${fmt.number(aprReal / st.apr * 100, 0)}% do APR da pool.</p>` : '')}`;
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
        if (!root || !$('#plJournal', root)) return;
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
        if (!root || !$('#plTg', root)) return;
        const addrs = S.wallets.map((w) => w.address).join(',');
        $('#plTg', root).innerHTML = html`
            <p>Uma tarefa agendada no seu repositório do GitHub confere as pools das carteiras a cada hora e manda mensagem no Telegram quando uma posição sai da faixa, chega perto da borda ou quando o fator de saúde do Aave cai. Funciona com o computador desligado. O passo a passo completo está no arquivo <strong>ALERTAS.md</strong> do projeto.</p>
            <ol class="pl-steps">
                <li>No Telegram, fale com <strong>@BotFather</strong>, crie um bot e guarde o token.</li>
                <li>Mande qualquer mensagem para o seu bot e descubra o seu chat id (instruções no ALERTAS.md).</li>
                <li>No GitHub: Settings → Secrets and variables → Actions → crie os segredos <code>TELEGRAM_BOT_TOKEN</code>, <code>TELEGRAM_CHAT_ID</code> e <code>WALLETS</code>.</li>
                <li>Na aba Actions do repositório, rode “Alertas de pools” manualmente uma vez para testar.</li>
            </ol>
            ${raw(addrs ? html`<label class="w3-key">Valor para o segredo WALLETS (suas carteiras cadastradas)<span class="inline-form"><input class="input input-small mono-addr" readonly value="${addrs}"><button class="btn btn-small" type="button" data-pl="copy" data-text="${addrs}">Copiar</button></span></label>` : '<p class="muted small">Cadastre carteiras em Configurações para gerar o valor do segredo WALLETS.</p>')}
            <p class="footnote">Os endereços ficam em segredos do GitHub, não no código público. O token do bot também. O GitHub pausa tarefas agendadas de repositórios sem nenhuma atividade por 60 dias; um commit qualquer reativa.</p>`;
    }

    // ---------- Formulário ----------
    function renderForm() {
        if (!root || !$('#plForm', root)) return;
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
                    ? html`<label>APR da pool no app (opcional, %)<input class="input" data-f="apr" inputmode="decimal" value="${f.apr}" placeholder="ex.: 18"></label><label>Sua faixa: mínimo (opcional)<input class="input" data-f="lo" inputmode="decimal" value="${f.lo ?? ''}" placeholder="ex.: 2248,5"></label><label>Sua faixa: máximo<input class="input" data-f="hi" inputmode="decimal" value="${f.hi ?? ''}" placeholder="ex.: 2489,93"></label>`
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
        if (['lo', 'hi'].includes(key) && customRange()) selected = 'custom';
        if (event.type === 'change' || ['capital', 'apr', 'vol', 'near', 'far', 'lo', 'hi'].includes(key)) recompute();
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
        const depKey = t.closest('[data-dep]')?.dataset.dep;
        if (depKey) { wireDepositDialog(); openDeposit(depKey); return; }
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
            App.go('#/pools/planejar');
        }
        if (act === 'remount') {
            const p = S.pools.find((x) => x.id === btn.dataset.id);
            if (!p) return;
            Object.assign(S.poolForm, { a: p.a, b: p.b, chain: p.chain, fee: p.fee, mode: p.mode ?? 'two', capital: p.capitalUsd ?? p.capital });
            store.save();
            pendingRemount = p.id;
            App.go('#/pools/planejar');
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
            const sub = params[0] === 'planejar' ? 'planejar' : params[0] === 'relatorio' ? 'relatorio' : (params[0] === 'explorar' || params[0] === 'descobrir') ? 'explorar' : 'minhas';
            const tabs = html`<nav class="subtabs" aria-label="Seções de pools">
                ${raw([['minhas', 'Minhas pools', '#/pools'], ['relatorio', 'Relatório', '#/pools/relatorio'], ['planejar', 'Planejar', '#/pools/planejar'], ['explorar', 'Explorar', '#/pools/explorar']].map(([k, label, href]) => html`<a href="${href}" class="${sub === k ? 'is-active' : ''}" ${raw(sub === k ? 'aria-current="page"' : '')}>${label}</a>`).join(''))}
            </nav>`;
            const lede = { relatorio: 'O relatório da posição, montado sozinho a partir da carteira: situação, resultado, taxas e expectativa.', minhas: 'Suas posições de liquidez, o que precisa de atenção e o diário de montagens.', planejar: 'Escolha o par e o capital: o painel sugere faixas pela volatilidade real e mostra o custo em cada rede.', explorar: 'Onde está o volume, as taxas e o rendimento, por rede e por app.' }[sub];
            const head = html`<header class="page-head"><div><h1>Pools</h1><p class="lede">${lede}</p></div></header>${raw(tabs)}`;
            if (sub === 'explorar') {
                discovering = true;
                el.innerHTML = head + '<div id="dsRoot" class="ds-root"></div>';
                App.poolDiscover.mount($('#dsRoot', el));
                return;
            }
            discovering = false;
            root = el;
            if (sub === 'relatorio') {
                reportKey = params[1] || null;
                el.innerHTML = head + html`${raw(monitored().filter((x) => x.onchain).length > 1 ? html`<div class="toolbar"><label class="sr-only" for="rpPick">Posição</label><select id="rpPick" class="input input-small">${raw(monitored().filter((x) => x.onchain).map((x) => html`<option value="${x.key}" ${x.key === reportKey ? 'selected' : ''}>${x.a}/${x.b} · ${x.source}</option>`).join(''))}</select></div>` : '')}<div id="rpBody" class="rp"></div>`;
                el.addEventListener('click', onClick);
                $('#rpPick', el)?.addEventListener('change', (e) => App.go(`#/pools/relatorio/${encodeURIComponent(e.target.value)}`));
                renderReport();
                const readAll = () => S.wallets.forEach((w) => App.refreshWallet(w.id));
                if (S.wallets.some((w) => !App.walletResults?.get(w.id))) readAll();
                reportTimer = setInterval(readAll, 5 * 60 * 1000);
                offs = [
                    bus.on('wallet-read', renderReport),
                    bus.on('pools', renderReport),
                    bus.on('settings', renderReport),
                ];
                return;
            }
            App.extraSymbols = [...new Set([under(S.poolForm.a), under(S.poolForm.b), 'ETH', 'POL', 'BNB', 'SOL'].filter((s) => s !== 'USD'))];
            App.refreshPrices();
            el.innerHTML = head + (sub === 'planejar' ? html`
                <section class="panel" id="plPlanner">
                    <div class="panel-bar"><h2 class="panel-title">Montar uma pool</h2><button class="btn btn-small btn-primary" type="button" data-pl="save">Salvar no diário</button></div>
                    <div id="plForm" class="pl-form"></div>
                    <div id="plOut" class="pl-out"></div>
                </section>
                <details class="panel fold">
                    <summary><span class="panel-title">Custo em cada rede</span><span class="muted small">Gás para montar e remontar, com o seu capital</span></summary>
                    <div class="toolbar"><button class="btn btn-small btn-ghost" type="button" data-pl="gas">Atualizar gás</button></div>
                    <div id="plGas"></div>
                </details>` : html`
                <section class="panel">
                    <div class="panel-bar"><h2 class="panel-title">Monitoramento</h2><button class="btn btn-small btn-ghost" type="button" data-pl="read">Atualizar carteiras</button></div>
                    <div id="plMon" class="pl-mon"></div>
                </section>
                <section class="panel">
                    <h2 class="panel-title">Diário de pools</h2>
                    <div id="plJournal"></div>
                </section>
                <p class="footnote">Alertas no Telegram com o painel fechado: veja em <a href="#/config">Configurações</a>.</p>`);
            el.addEventListener('click', onClick);
            el.addEventListener('input', onFormInput);
            el.addEventListener('change', onFormInput);
            if (sub === 'planejar') {
                renderForm();
                if (pendingRemount) { $('#plOut', el).dataset.remount = pendingRemount; pendingRemount = null; }
                recompute();
                $('#plGas', el).closest('details').addEventListener('toggle', () => renderGas());
            } else {
                renderJournal();
                renderMonitor();
                gasTable().then(() => root && renderMonitor()).catch(() => {});
                if (S.wallets.some((w) => !App.walletResults?.get(w.id))) S.wallets.forEach((w) => { if (!App.walletResults?.get(w.id)) App.refreshWallet(w.id); });
            }
            let lastMon = 0;
            offs = [
                bus.on('pools', () => { renderJournal(); renderMonitor(); }),
                bus.on('wallet-read', () => renderMonitor()),
                bus.on('wallets', () => renderMonitor()),
                bus.on('prices', () => {
                    if (sub === 'planejar' && !calc?.price && root) recompute();
                    if (sub === 'minhas' && Date.now() - lastMon > 5000) { lastMon = Date.now(); renderMonitor(); }
                }),
            ];
        },
        unmount() {
            if (discovering) { App.poolDiscover.unmount(); discovering = false; return; }
            clearInterval(reportTimer);
            reportTimer = null;
            reportChart?.remove();
            reportChart = null;
            offs.forEach((o) => o());
            offs = [];
            App.extraSymbols = [];
            root = null;
        },
    };
})(window.App);
