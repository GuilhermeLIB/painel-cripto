// Tela "Carteira": posições, plano de aportes com sugestão de divisão,
// evolução do patrimônio, histórico de operações, simulador e backup.
window.App = window.App || {};
App.views = App.views || {};

(function (App) {
    const { $, $$, html, raw, fmt, bus, toneOf, toast, localIso, parseIso, isIsoDate, uid } = App.util;
    const store = App.store;
    const S = store.state;

    let root = null;
    let offs = [];
    let evoChart = null;
    let evoRange = 'all';
    let txFilter = 'all';
    const signals = {};

    // ---------- Cálculos ----------
    function snapshot() {
        const positions = store.positions();
        const open = positions.filter((p) => p.qty > 0);
        let value = 0;
        let cost = 0;
        let costBrl = 0;
        let change24 = 0;
        let missing = false;
        open.forEach((p) => {
            const q = App.live.prices[p.asset];
            p.price = q?.price ?? null;
            p.value = p.price ? p.qty * p.price : null;
            if (p.value === null) missing = true;
            value += p.value ?? 0;
            cost += p.costUsd;
            costBrl += p.costBrl;
            if (q && q.open) change24 += p.qty * (q.price - q.open);
        });
        open.forEach((p) => { p.share = value ? (p.value ?? 0) / value * 100 : 0; });
        const realized = positions.reduce((a, p) => a + p.realizedUsd, 0);
        return { positions, open, value, cost, costBrl, unrealized: value - cost, realized, change24, missing };
    }

    function nextContributionDate() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayIso = localIso(today);
        const boughtToday = S.transactions.some((t) => t.type === 'buy' && t.date === todayIso);
        const d = new Date(today);
        if (S.plan.frequency === 'monthly') {
            const day = Math.min(28, Math.max(1, Number(S.plan.monthDay) || 1));
            d.setDate(day);
            if (d < today || (localIso(d) === todayIso && boughtToday)) d.setMonth(d.getMonth() + 1);
        } else {
            let diff = (Number(S.plan.weekday) - today.getDay() + 7) % 7;
            if (diff === 0 && boughtToday) diff = 7;
            d.setDate(d.getDate() + diff);
        }
        return d;
    }

    function signalMultiplier(symbol) {
        if (!S.plan.useSignal) return 1;
        const a = signals[symbol];
        if (!a) return 1;
        return a.action === 'Aportar reforçado' ? 1.25 : a.action === 'Esperar recuo' ? 0.75 : 1;
    }

    function suggestion(snap) {
        const targets = Object.entries(S.plan.targets).filter(([, v]) => Number(v) > 0);
        const fx = App.live.fx;
        const budgetBrl = Number(S.plan.budgetBrl) || 0;
        if (!targets.length || !fx || !budgetBrl) return null;
        const sumT = targets.reduce((a, [, v]) => a + Number(v), 0);
        const budgetUsd = budgetBrl / fx;
        const valueOf = (s) => snap.open.find((p) => p.asset === s)?.value ?? 0;
        const total = snap.value + budgetUsd;
        let rows = targets.map(([asset, t]) => {
            const target = Number(t) / sumT;
            const gap = Math.max(0, total * target - valueOf(asset));
            return { asset, target: target * 100, current: snap.value ? (valueOf(asset) / snap.value) * 100 : 0, gap };
        });
        const sumGap = rows.reduce((a, r) => a + r.gap, 0);
        rows.forEach((r) => {
            const base = sumGap > 0 ? r.gap / sumGap : r.target / 100;
            r.weight = base * signalMultiplier(r.asset);
        });
        const sumW = rows.reduce((a, r) => a + r.weight, 0) || 1;
        rows.forEach((r) => {
            r.usd = (budgetUsd * r.weight) / sumW;
            r.brl = r.usd * fx;
            const price = App.priceOf(r.asset);
            r.qty = price ? r.usd / price : null;
            r.mult = signalMultiplier(r.asset);
        });
        rows = rows.filter((r) => r.brl >= 0.01).sort((a, b) => b.brl - a.brl);
        return { rows, budgetBrl, fx };
    }

    // Resultado na moeda escolhida. Em reais, compara o valor de hoje com os
    // reais efetivamente pagos (inclui o efeito do câmbio), que é o que importa
    // para quem aporta em BRL.
    function result(valueUsd, costUsd, costBrl) {
        if (!Number.isFinite(valueUsd)) return { value: null, pct: null, text: '—' };
        if (S.settings.currency === 'BRL' && App.live.fx && costBrl > 0) {
            const diff = valueUsd * App.live.fx - costBrl;
            return { value: diff, pct: (diff / costBrl) * 100, text: S.settings.privacy ? '•••••' : fmt.signedMoney(diff, 'BRL') };
        }
        const diff = valueUsd - costUsd;
        return { value: diff, pct: costUsd ? (diff / costUsd) * 100 : null, text: App.signedMoney(diff, { priv: true }) };
    }

    function investedText(costUsd, costBrl) {
        if (S.settings.privacy) return '•••••';
        if (S.settings.currency === 'BRL' && costBrl > 0) return fmt.money(costBrl, 'BRL', 2);
        return App.money(costUsd, { digits: 2 });
    }

    // ---------- Render ----------
    function renderSummary(snap) {
        const el = $('#pfSummary', root);
        const open = result(snap.value, snap.cost, snap.costBrl);
        const realized = snap.realized;
        const totalValue = (open.value ?? 0) + (S.settings.currency === 'BRL' && App.live.fx ? realized * App.live.fx : realized);
        const totalText = S.settings.privacy ? '•••••' : fmt.signedMoney(totalValue, S.settings.currency);
        const prevValue = snap.value - snap.change24;
        const pct24 = prevValue ? (snap.change24 / prevValue) * 100 : null;
        el.innerHTML = html`
            <div class="pf-main">
                <p class="pf-label">Patrimônio em cripto</p>
                <p class="price-xl">${App.money(snap.value, { priv: true, digits: 2 })}</p>
                <p class="pf-sub"><span class="delta delta-${toneOf(snap.change24)}">${App.signedMoney(snap.change24, { priv: true })} (${fmt.pct(pct24)})</span> <span class="muted">nas últimas 24h</span></p>
            </div>
            <dl class="pf-stats">
                <div><dt>Investido</dt><dd>${investedText(snap.cost, snap.costBrl)}</dd>${raw(S.settings.currency === 'BRL' && snap.costBrl ? '<small class="muted">reais pagos nas compras</small>' : '')}</div>
                <div><dt>Resultado aberto</dt><dd class="delta-${toneOf(open.value)}">${open.text}</dd><small class="delta-${toneOf(open.pct)}">${fmt.pct(open.pct)}</small></div>
                <div><dt>Realizado em vendas</dt><dd class="delta-${toneOf(realized)}">${App.signedMoney(realized, { priv: true })}</dd></div>
                <div><dt>Resultado total</dt><dd class="delta-${toneOf(totalValue)}">${totalText}</dd></div>
            </dl>`;
        const bar = $('#allocBar', root);
        if (!snap.open.length) {
            bar.innerHTML = '';
            return;
        }
        const sorted = [...snap.open].sort((a, b) => b.share - a.share);
        bar.innerHTML = html`
            <div class="alloc-track" role="img" aria-label="Divisão da carteira">
                ${raw(sorted.map((p) => html`<span style="flex:${Math.max(p.share, 0.5)};background:${App.coins.meta(p.asset).color}" title="${p.asset} ${fmt.pct(p.share, 1).replace('+', '')}"></span>`).join(''))}
            </div>
            <ul class="alloc-legend">
                ${raw(sorted.map((p) => html`<li><i style="background:${App.coins.meta(p.asset).color}"></i>${p.asset} <span class="muted">${fmt.number(p.share, 1)}%</span></li>`).join(''))}
            </ul>`;
    }

    function renderPlan(snap) {
        const el = $('#planCard', root);
        const next = nextContributionDate();
        const isToday = localIso(next) === localIso();
        const sug = suggestion(snap);
        const freq = S.plan.frequency === 'monthly'
            ? `todo dia ${S.plan.monthDay}`
            : `toda ${['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][S.plan.weekday]}`;
        let body;
        if (!Object.values(S.plan.targets).some((v) => Number(v) > 0)) {
            body = html`<div class="empty-state">
                <p>Defina quanto quer aportar e a divisão desejada entre as criptos. A cada aporte eu sugiro quanto colocar em cada uma para manter a carteira no alvo.</p>
                <button class="btn btn-primary" type="button" data-act="plan">Montar plano</button>
            </div>`;
        } else if (!sug) {
            body = '<p class="muted">Aguardando cotações para calcular a sugestão…</p>';
        } else {
            body = html`
                <table class="plan-table">
                    <thead><tr><th>Cripto</th><th class="col-num">Agora</th><th class="col-num">Alvo</th><th class="col-num">Aportar</th></tr></thead>
                    <tbody>${raw(sug.rows.map((r) => html`<tr>
                        <td><span class="coin-inline">${raw(App.coins.avatar(r.asset, 20))}${r.asset}${raw(r.mult !== 1 ? html` <span class="chip chip-${r.mult > 1 ? 'up' : 'down'}" title="Ajustado pelo sinal">${r.mult > 1 ? 'reforço' : 'menos'}</span>` : '')}</span></td>
                        <td class="col-num muted">${fmt.number(r.current, 1)}%</td>
                        <td class="col-num muted">${fmt.number(r.target, 1)}%</td>
                        <td class="col-num"><strong>${fmt.money(r.brl, 'BRL', 2)}</strong><small class="muted">${r.qty ? `≈ ${fmt.qty(r.qty)} ${r.asset}` : ''}</small></td>
                    </tr>`).join(''))}</tbody>
                </table>
                <div class="plan-actions">
                    <label class="switch"><input type="checkbox" id="useSignal" ${S.plan.useSignal ? 'checked' : ''}><span>Ajustar pelo sinal técnico</span></label>
                    <button class="btn btn-primary" type="button" data-act="execute">Registrar estes aportes</button>
                </div>`;
        }
        el.innerHTML = html`
            <div class="plan-head">
                <div>
                    <h2 class="panel-title">Próximo aporte</h2>
                    <p class="plan-date">${isToday ? 'Hoje' : fmt.dateLong(next)}</p>
                    <p class="muted">${fmt.money(Number(S.plan.budgetBrl) || 0, 'BRL', 2)} ${freq}</p>
                </div>
                <button class="btn btn-ghost" type="button" data-act="plan">Editar plano</button>
            </div>
            ${raw(body)}`;
        const sig = $('#useSignal', el);
        if (sig) sig.addEventListener('change', () => { S.plan.useSignal = sig.checked; store.commit('plan'); });
    }

    function renderPositions(snap) {
        const body = $('#posBody', root);
        if (!snap.open.length) {
            body.innerHTML = '<tr><td colspan="7" class="empty-cell">Nenhuma posição ainda. Registre sua primeira compra para começar.</td></tr>';
            return;
        }
        const priv = S.settings.privacy;
        body.innerHTML = [...snap.open].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).map((p) => {
            const r = result(p.value, p.costUsd, p.costBrl);
            const target = Number(S.plan.targets[p.asset]) || 0;
            return html`<tr style="--coin:${App.coins.meta(p.asset).color}">
                <td><a class="coin-cell" href="#/ativo/${p.asset}">${raw(App.coins.avatar(p.asset, 30))}<span><strong>${p.asset}</strong><span class="muted">${priv ? '•••' : fmt.qty(p.qty)}</span></span></a></td>
                <td class="col-num">${fmt.money(p.avgUsd)}</td>
                <td class="col-num">${fmt.money(p.price)}</td>
                <td class="col-num"><strong>${App.money(p.value, { priv: true, digits: 2 })}</strong></td>
                <td class="col-num delta-${toneOf(r.value)}">${r.text}<small>${fmt.pct(r.pct)}</small></td>
                <td class="col-num"><span class="share"><span class="share-bar"><i style="width:${Math.min(100, p.share)}%"></i>${raw(target ? html`<b style="left:${Math.min(100, target)}%" title="Alvo ${target}%"></b>` : '')}</span>${fmt.number(p.share, 1)}%</span></td>
                <td class="col-actions"><a class="btn btn-small" href="#/carteira/novo/${p.asset}">Aportar</a></td>
            </tr>`;
        }).join('');
    }

    function renderTransactions() {
        const assets = [...new Set(S.transactions.map((t) => t.asset))].sort();
        const filter = $('#txFilter', root);
        filter.innerHTML = html`<option value="all">Todas as criptos</option>${raw(assets.map((a) => html`<option value="${a}" ${txFilter === a ? 'selected' : ''}>${a}</option>`).join(''))}`;
        const list = S.transactions
            .filter((t) => txFilter === 'all' || t.asset === txFilter)
            .sort((a, b) => b.date.localeCompare(a.date));
        const body = $('#txBody', root);
        $('#txCount', root).textContent = list.length ? `${list.length} ${list.length === 1 ? 'operação' : 'operações'}` : '';
        if (!list.length) {
            body.innerHTML = '<tr><td colspan="7" class="empty-cell">Nenhuma operação registrada.</td></tr>';
            return;
        }
        const priv = S.settings.privacy;
        body.innerHTML = list.slice(0, 300).map((t) => html`<tr>
            <td>${fmt.date(t.date)}</td>
            <td><span class="coin-inline">${raw(App.coins.avatar(t.asset, 20))}${t.asset}</span></td>
            <td><span class="chip chip-${t.type === 'buy' ? 'up' : 'down'}">${t.type === 'buy' ? 'Compra' : 'Venda'}</span></td>
            <td class="col-num">${priv ? '•••' : fmt.qty(t.qty)}</td>
            <td class="col-num">${fmt.money(t.priceUsd)}</td>
            <td class="col-num">${priv ? '•••' : (t.totalBrl ? fmt.money(t.totalBrl, 'BRL', 2) : fmt.money(t.totalUsd, 'USD', 2))}${raw(t.note ? html`<small class="muted" title="${t.note}">${t.note.length > 28 ? `${t.note.slice(0, 28)}…` : t.note}</small>` : '')}</td>
            <td class="col-actions">
                <button class="icon-btn" type="button" data-edit="${t.id}" aria-label="Editar operação">✎</button>
                <button class="icon-btn" type="button" data-del="${t.id}" aria-label="Apagar operação">✕</button>
            </td>
        </tr>`).join('');
    }

    async function renderEvolution() {
        const el = $('#evoChart', root);
        const note = $('#evoNote', root);
        if (!S.transactions.length) {
            el.innerHTML = '';
            note.textContent = 'O gráfico aparece depois da primeira operação.';
            evoChart?.remove();
            evoChart = null;
            return;
        }
        note.textContent = 'Calculando histórico…';
        const firstDate = S.transactions.reduce((m, t) => (t.date < m ? t.date : m), localIso());
        const assets = [...new Set(S.transactions.map((t) => t.asset))];
        try {
            const histories = await Promise.all(assets.map((a) => App.api.dailyHistory(a, firstDate).catch(() => [])));
            const fxStart = firstDate < '2019-01-01' ? '2019-01-01' : firstDate;
            const fxHist = S.settings.currency === 'BRL' ? await App.api.dailyHistory('USDTBRL', fxStart).catch(() => []) : [];
            if (!root) return;
            const closeMaps = Object.fromEntries(assets.map((a, i) => [a, new Map(histories[i].map((k) => [k.day, k.close]))]));
            const fxMap = new Map(fxHist.map((k) => [k.day, k.close]));
            const txs = [...S.transactions].sort((a, b) => a.date.localeCompare(b.date));
            const qty = {};
            const lastClose = {};
            const cost = { usd: 0, brl: 0 };
            const held = {};
            let lastFx = fxHist[0]?.close ?? App.live.fx;
            let ti = 0;
            const valuePts = [];
            const costPts = [];
            const today = localIso();
            for (let day = firstDate; day <= today; day = App.util.addDays(day, 1)) {
                while (ti < txs.length && txs[ti].date <= day) {
                    const t = txs[ti];
                    const h = held[t.asset] || (held[t.asset] = { qty: 0, usd: 0, brl: 0 });
                    if (t.type === 'buy') {
                        h.qty += t.qty; h.usd += t.totalUsd + t.feeUsd; h.brl += t.totalBrl ?? 0;
                    } else {
                        const q = Math.min(t.qty, h.qty);
                        const fr = h.qty ? q / h.qty : 0;
                        h.usd -= h.usd * fr; h.brl -= h.brl * fr; h.qty -= q;
                    }
                    qty[t.asset] = h.qty;
                    ti += 1;
                }
                if (fxMap.has(day)) lastFx = fxMap.get(day);
                let value = 0;
                for (const a of assets) {
                    const c = closeMaps[a].get(day);
                    if (c) lastClose[a] = c;
                    if (qty[a] && lastClose[a]) value += qty[a] * lastClose[a];
                }
                cost.usd = Object.values(held).reduce((s, h) => s + h.usd, 0);
                cost.brl = Object.values(held).reduce((s, h) => s + h.brl, 0);
                const [y, m, d] = day.split('-').map(Number);
                const time = Date.UTC(y, m - 1, d) / 1000;
                if (S.settings.currency === 'BRL') {
                    valuePts.push({ time, value: value * (lastFx || 0) });
                    costPts.push({ time, value: cost.brl || cost.usd * (lastFx || 0) });
                } else {
                    valuePts.push({ time, value });
                    costPts.push({ time, value: cost.usd });
                }
            }
            drawEvolution(valuePts, costPts);
            note.textContent = S.settings.currency === 'BRL'
                ? 'Valor diário pelo fechamento de cada cripto convertido pelo USDT/BRL do dia. Investido = reais efetivamente pagos.'
                : 'Valor diário pelo fechamento de cada cripto, em dólar.';
        } catch (error) {
            console.error(error);
            note.textContent = 'Não consegui montar o histórico agora.';
        }
    }

    function drawEvolution(valuePts, costPts) {
        const el = $('#evoChart', root);
        evoChart?.remove();
        el.innerHTML = '';
        if (!window.LightweightCharts) return;
        const accent = App.charts.css('--brand');
        evoChart = window.LightweightCharts.createChart(el, App.charts.chartOptions({ handleScroll: false, handleScale: false, timeScale: { borderColor: App.charts.css('--line'), timeVisible: false } }));
        const value = evoChart.addAreaSeries({ lineColor: accent, topColor: `${accent}55`, bottomColor: `${accent}05`, lineWidth: 2, priceLineVisible: false });
        const cost = evoChart.addLineSeries({ color: App.charts.css('--ink-3'), lineWidth: 1.5, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
        const cut = evoRange === 'all' ? 0 : Math.max(0, valuePts.length - (evoRange === '6m' ? 182 : 365));
        value.setData(valuePts.slice(cut));
        cost.setData(costPts.slice(cut));
        value.applyOptions({ priceFormat: { type: 'custom', formatter: (v) => (S.settings.privacy ? '•••' : fmt.compactMoney(v, S.settings.currency)) } });
        evoChart.timeScale().fitContent();
    }

    function renderAll() {
        if (!root) return;
        const snap = snapshot();
        renderSummary(snap);
        renderPlan(snap);
        renderPositions(snap);
    }

    async function loadSignals() {
        const assets = Object.keys(S.plan.targets).filter((a) => Number(S.plan.targets[a]) > 0);
        await Promise.all(assets.map(async (a) => {
            if (signals[a]) return;
            try { signals[a] = App.ind.analyze(await App.api.klines(a, '1d', 1000)); } catch { signals[a] = null; }
        }));
        if (root) renderPlan(snapshot());
    }

    // ---------- Diálogo de operação ----------
    let txDraft = null;

    function openTx(prefill = {}) {
        const dlg = $('#txDialog');
        const editing = prefill.id ? S.transactions.find((t) => t.id === prefill.id) : null;
        txDraft = editing ? { ...editing, mode: editing.totalBrl ? 'brl' : 'usd' } : { id: null, asset: prefill.asset || S.watchlist[0] || 'BTC', type: 'buy', date: localIso(), mode: 'brl', note: '' };
        $('#txTitle').textContent = editing ? 'Editar operação' : 'Nova operação';
        $('#txSave').textContent = editing ? 'Salvar alterações' : 'Registrar operação';
        const assets = [...new Set([...S.watchlist, ...S.transactions.map((t) => t.asset), txDraft.asset])];
        $('#txAsset').innerHTML = assets.map((a) => html`<option value="${a}" ${a === txDraft.asset ? 'selected' : ''}>${a} · ${App.coins.meta(a).name}</option>`).join('');
        $('#txDate').value = txDraft.date;
        $('#txDate').max = localIso();
        $$('#txType button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.type === txDraft.type));
        $$('#txMode button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === txDraft.mode));
        $('#txAmount').value = editing ? (txDraft.mode === 'brl' ? editing.totalBrl : editing.totalUsd).toFixed(2) : '';
        $('#txPrice').value = editing ? editing.priceUsd : '';
        $('#txPrice').dataset.auto = editing ? '0' : '1';
        $('#txFee').value = editing?.feeUsd || '';
        $('#txNote').value = editing?.note || '';
        $('#txMsg').textContent = '';
        updateModeLabel();
        dlg.showModal();
        $('#txAmount').focus();
        refreshTxQuotes();
    }

    function updateModeLabel() {
        const labels = { brl: 'Valor pago em R$', usd: 'Valor em US$', qty: 'Quantidade de moedas' };
        $('#txAmountLabel').textContent = labels[txDraft.mode];
        $('#txAmount').placeholder = txDraft.mode === 'qty' ? 'Ex.: 0,005' : 'Ex.: 500';
    }

    async function refreshTxQuotes() {
        const asset = $('#txAsset').value;
        const date = $('#txDate').value;
        txDraft.quote = null;
        txDraft.fx = null;
        updateTxPreview();
        if (!isIsoDate(date)) return;
        const isToday = date === localIso();
        try {
            const [price, fx] = await Promise.all([
                isToday && App.priceOf(asset) ? App.priceOf(asset) : App.api.closeOn(App.api.pair(asset), date),
                isToday && App.live.fx ? App.live.fx : App.api.closeOn('USDTBRL', date),
            ]);
            if ($('#txAsset').value !== asset || $('#txDate').value !== date) return;
            txDraft.quote = price;
            txDraft.fx = fx;
            if ($('#txPrice').dataset.auto === '1') $('#txPrice').value = price ? +price.toPrecision(8) : '';
        } catch (error) {
            console.error(error);
        }
        updateTxPreview();
    }

    // Aceita "1.234,56", "1234,56" e "1234.56".
    function num(value) {
        let text = String(value ?? '').replace(/\s/g, '');
        if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.');
        const n = Number(text);
        return text && Number.isFinite(n) ? n : NaN;
    }

    function computeTx() {
        const amount = num($('#txAmount').value);
        const price = num($('#txPrice').value);
        const fee = num($('#txFee').value || '0');
        const fx = txDraft.fx;
        if (!(amount > 0) || !(price > 0)) return null;
        let qty;
        let totalUsd;
        let totalBrl = null;
        if (txDraft.mode === 'brl') {
            if (!fx) return { error: 'Sem cotação do USDT/BRL para essa data. Use o valor em US$.' };
            totalBrl = amount;
            totalUsd = amount / fx;
            qty = totalUsd / price;
        } else if (txDraft.mode === 'usd') {
            totalUsd = amount;
            qty = amount / price;
            totalBrl = fx ? amount * fx : null;
        } else {
            qty = amount;
            totalUsd = amount * price;
            totalBrl = fx ? totalUsd * fx : null;
        }
        return { qty, totalUsd, totalBrl, priceUsd: price, feeUsd: fee > 0 ? fee : 0, fxRate: fx };
    }

    function updateTxPreview() {
        const out = $('#txPreview');
        const asset = $('#txAsset').value;
        const date = $('#txDate').value;
        const hint = $('#txPriceHint');
        hint.textContent = txDraft.quote
            ? `Fechamento de ${date === localIso() ? 'agora' : fmt.date(date)}: ${fmt.money(txDraft.quote)}${txDraft.fx ? ` · USDT ${fmt.money(txDraft.fx, 'BRL', 3)}` : ''}`
            : (isIsoDate(date) ? 'Buscando preço da data…' : '');
        const c = computeTx();
        if (!c) { out.innerHTML = '<span class="muted">Preencha valor e preço para ver o resumo.</span>'; return; }
        if (c.error) { out.innerHTML = html`<span class="delta-down">${c.error}</span>`; return; }
        out.innerHTML = html`${txDraft.type === 'buy' ? 'Compra de' : 'Venda de'} <strong>${fmt.qty(c.qty)} ${asset}</strong> por <strong>${fmt.money(c.totalUsd, 'USD', 2)}</strong>${raw(c.totalBrl ? html` (${fmt.money(c.totalBrl, 'BRL', 2)})` : '')}`;
    }

    function saveTx(event) {
        event.preventDefault();
        const asset = $('#txAsset').value;
        const date = $('#txDate').value;
        const msg = $('#txMsg');
        if (!isIsoDate(date) || date > localIso()) { msg.textContent = 'Escolha uma data até hoje.'; return; }
        const c = computeTx();
        if (!c) { msg.textContent = 'Informe valor e preço maiores que zero.'; return; }
        if (c.error) { msg.textContent = c.error; return; }
        if (txDraft.type === 'sell') {
            const pos = store.positions().find((p) => p.asset === asset);
            const available = (pos?.qty ?? 0) + (txDraft.id && txDraft.type === 'sell' ? (S.transactions.find((t) => t.id === txDraft.id)?.qty ?? 0) : 0);
            if (c.qty > available + 1e-9) { msg.textContent = `Você tem ${fmt.qty(available)} ${asset}; não dá para vender ${fmt.qty(c.qty)}.`; return; }
        }
        store.upsertTx({ id: txDraft.id || uid(), asset, type: txDraft.type, date, note: $('#txNote').value.trim(), ...c });
        $('#txDialog').close();
        toast(txDraft.id ? 'Operação atualizada.' : `${txDraft.type === 'buy' ? 'Compra' : 'Venda'} de ${asset} registrada.`, 'up');
        if (location.hash.startsWith('#/carteira/novo')) history.replaceState(null, '', '#/carteira');
    }

    function wireTxDialog() {
        const dlg = $('#txDialog');
        if (dlg.dataset.wired) return;
        dlg.dataset.wired = '1';
        $('#txForm').addEventListener('submit', saveTx);
        $('#txCancel').addEventListener('click', () => dlg.close());
        $('#txType').addEventListener('click', (e) => {
            const b = e.target.closest('button[data-type]'); if (!b) return;
            txDraft.type = b.dataset.type;
            $$('#txType button').forEach((x) => x.setAttribute('aria-pressed', x === b));
            updateTxPreview();
        });
        $('#txMode').addEventListener('click', (e) => {
            const b = e.target.closest('button[data-mode]'); if (!b) return;
            txDraft.mode = b.dataset.mode;
            $$('#txMode button').forEach((x) => x.setAttribute('aria-pressed', x === b));
            updateModeLabel();
            updateTxPreview();
        });
        $('#txAsset').addEventListener('change', () => { $('#txPrice').dataset.auto = '1'; refreshTxQuotes(); });
        $('#txDate').addEventListener('change', () => { $('#txPrice').dataset.auto = '1'; refreshTxQuotes(); });
        $('#txPrice').addEventListener('input', () => { $('#txPrice').dataset.auto = '0'; updateTxPreview(); });
        ['txAmount', 'txFee'].forEach((id) => $(`#${id}`).addEventListener('input', updateTxPreview));
        dlg.addEventListener('close', () => {
            if (location.hash.startsWith('#/carteira/novo')) history.replaceState(null, '', '#/carteira');
        });
    }

    // ---------- Diálogo do plano ----------
    function openPlan() {
        const dlg = $('#planDialog');
        const snap = snapshot();
        const candidates = [...new Set([...snap.open.map((p) => p.asset), ...Object.keys(S.plan.targets), ...S.watchlist])];
        $('#planBudget').value = S.plan.budgetBrl;
        $('#planFreq').value = S.plan.frequency;
        $('#planWeekday').value = String(S.plan.weekday);
        $('#planMonthDay').value = S.plan.monthDay;
        $('#planTargets').innerHTML = candidates.map((a) => {
            const share = snap.open.find((p) => p.asset === a)?.share;
            return html`<li>
                <span class="coin-inline">${raw(App.coins.avatar(a, 22))}<strong>${a}</strong>${raw(share ? html` <span class="muted">hoje ${fmt.number(share, 1)}%</span>` : '')}</span>
                <label class="pct-input"><span class="sr-only">Alvo de ${a} em %</span><input type="number" min="0" max="100" step="1" inputmode="numeric" data-target="${a}" value="${Number(S.plan.targets[a]) || ''}" placeholder="0"><span>%</span></label>
            </li>`;
        }).join('');
        syncPlanForm();
        dlg.showModal();
    }

    function syncPlanForm() {
        const monthly = $('#planFreq').value === 'monthly';
        $('#planWeekdayWrap').hidden = monthly;
        $('#planMonthDayWrap').hidden = !monthly;
        const sum = $$('#planTargets input').reduce((a, i) => a + (Number(i.value) || 0), 0);
        const out = $('#planSum');
        out.textContent = `Soma dos alvos: ${fmt.number(sum, 0)}%`;
        out.className = Math.abs(sum - 100) < 0.5 ? 'plan-sum ok' : 'plan-sum warn';
        if (sum && Math.abs(sum - 100) >= 0.5) out.textContent += ' · será ajustada proporcionalmente para 100%';
    }

    function wirePlanDialog() {
        const dlg = $('#planDialog');
        if (dlg.dataset.wired) return;
        dlg.dataset.wired = '1';
        $('#planForm').addEventListener('input', syncPlanForm);
        $('#planCancel').addEventListener('click', () => dlg.close());
        $('#planEqual').addEventListener('click', () => {
            const inputs = $$('#planTargets input').filter((i) => Number(i.value) > 0);
            const pick = inputs.length ? inputs : $$('#planTargets input').slice(0, 3);
            const each = Math.floor(100 / pick.length);
            $$('#planTargets input').forEach((i) => { i.value = ''; });
            pick.forEach((i, j) => { i.value = j === 0 ? 100 - each * (pick.length - 1) : each; });
            syncPlanForm();
        });
        $('#planForm').addEventListener('submit', (event) => {
            event.preventDefault();
            const budget = Number($('#planBudget').value);
            if (!(budget > 0)) { toast('Informe um valor de aporte maior que zero.', 'bad'); return; }
            const targets = {};
            $$('#planTargets input').forEach((i) => { const v = Number(i.value); if (v > 0) targets[i.dataset.target] = v; });
            S.plan = { ...S.plan, budgetBrl: budget, frequency: $('#planFreq').value, weekday: Number($('#planWeekday').value), monthDay: Math.min(28, Math.max(1, Number($('#planMonthDay').value) || 1)), targets };
            store.commit('plan');
            dlg.close();
            toast('Plano de aportes salvo.', 'up');
            loadSignals();
        });
    }

    function executeSuggestion() {
        const sug = suggestion(snapshot());
        if (!sug) return;
        const lines = sug.rows.map((r) => `• ${r.asset}: ${fmt.money(r.brl, 'BRL', 2)} (≈ ${fmt.qty(r.qty)} a ${fmt.money(App.priceOf(r.asset))})`).join('\n');
        if (!window.confirm(`Registrar estas compras com data de hoje e preço atual?\n\n${lines}\n\nVocê pode editar cada uma depois para colocar o preço exato da exchange.`)) return;
        const today = localIso();
        sug.rows.forEach((r) => {
            const price = App.priceOf(r.asset);
            if (!price) return;
            store.upsertTx({ id: uid(), asset: r.asset, type: 'buy', date: today, qty: r.usd / price, priceUsd: price, totalUsd: r.usd, totalBrl: r.brl, fxRate: sug.fx, note: 'Aporte do plano' });
        });
        toast(`${sug.rows.length} aporte(s) registrados.`, 'up');
    }

    // ---------- Simulador ----------
    async function runSimulator(event) {
        event?.preventDefault();
        const asset = $('#simAsset').value;
        const amount = Number($('#simAmount').value);
        const start = $('#simStart').value;
        const freq = $('#simFreq').value;
        const out = $('#simOut');
        if (!(amount > 0) || !isIsoDate(start)) { out.innerHTML = '<p class="muted">Preencha valor e data inicial.</p>'; return; }
        out.innerHTML = '<p class="muted">Simulando…</p>';
        try {
            const fxStart = start < '2019-01-01' ? '2019-01-01' : start;
            const [hist, fxHist] = await Promise.all([App.api.dailyHistory(asset, start), App.api.dailyHistory('USDTBRL', fxStart)]);
            if (!hist.length) { out.innerHTML = '<p class="muted">Sem histórico para essa cripto nesse período.</p>'; return; }
            const close = new Map(hist.map((k) => [k.day, k.close]));
            const fxm = new Map(fxHist.map((k) => [k.day, k.close]));
            let invested = 0;
            let qty = 0;
            let n = 0;
            let skipped = 0;
            let day = start < hist[0].day ? hist[0].day : start;
            const today = localIso();
            let lastFx = null;
            while (day <= today) {
                const fx = fxm.get(day) ?? lastFx;
                if (fxm.has(day)) lastFx = fxm.get(day);
                const c = close.get(day);
                if (c && fx) {
                    invested += amount;
                    qty += amount / fx / c;
                    n += 1;
                } else {
                    skipped += 1;
                }
                if (freq === 'monthly') {
                    const d = parseIso(day); d.setMonth(d.getMonth() + 1); day = localIso(d);
                } else {
                    day = App.util.addDays(day, freq === 'daily' ? 1 : 7);
                }
            }
            const fxNow = App.live.fx;
            const price = App.priceOf(asset) ?? hist[hist.length - 1].close;
            const valueBrl = qty * price * (fxNow || 0);
            const pnl = valueBrl - invested;
            const firstFx = fxm.get(hist[0].day) ?? fxHist[0]?.close;
            const lump = firstFx ? (invested / firstFx / hist[0].close) * price * fxNow : null;
            out.innerHTML = html`
                <dl class="sim-grid">
                    <div><dt>Aportes</dt><dd>${n}</dd></div>
                    <div><dt>Investido</dt><dd>${fmt.money(invested, 'BRL', 2)}</dd></div>
                    <div><dt>Valor hoje</dt><dd>${fmt.money(valueBrl, 'BRL', 2)}</dd></div>
                    <div><dt>Resultado</dt><dd class="delta-${toneOf(pnl)}">${fmt.signedMoney(pnl, 'BRL')} <small>${fmt.pct(invested ? (pnl / invested) * 100 : 0)}</small></dd></div>
                    <div><dt>Acumulado</dt><dd>${fmt.qty(qty)} ${asset}</dd></div>
                    <div><dt>Preço médio</dt><dd>${fmt.money(qty ? invested / (fxNow || 1) / qty : 0)}</dd></div>
                </dl>
                ${raw(lump ? html`<p class="muted small">Se o mesmo total fosse investido de uma vez no primeiro dia, valeria ${fmt.money(lump, 'BRL', 2)} hoje.${skipped ? ` ${skipped} data(s) sem cotação foram puladas.` : ''}</p>` : '')}`;
        } catch (error) {
            console.error(error);
            out.innerHTML = '<p class="muted">Não consegui simular agora. Confira se o par existe na Binance.</p>';
        }
    }

    // ---------- Backup ----------
    function download(name, text, type) {
        const blob = new Blob([text], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function exportCsv() {
        const head = 'data;cripto;tipo;quantidade;preco_usd;total_usd;total_brl;cotacao_usdt_brl;taxa_usd;nota';
        const rows = [...S.transactions].sort((a, b) => a.date.localeCompare(b.date)).map((t) => [
            t.date, t.asset, t.type === 'buy' ? 'compra' : 'venda', t.qty, t.priceUsd, t.totalUsd.toFixed(2), t.totalBrl?.toFixed(2) ?? '', t.fxRate ?? '', t.feeUsd || '', `"${(t.note || '').replace(/"/g, '""')}"`,
        ].join(';').replace(/(\d)\.(\d)/g, '$1,$2'));
        download(`operacoes-cripto-${localIso()}.csv`, `\ufeff${[head, ...rows].join('\n')}`, 'text/csv;charset=utf-8');
    }

    async function importFile(file) {
        try {
            const result = store.parseImport(await file.text());
            if (!result.txs.length && result.kind !== 'full') { toast('O arquivo não tem operações válidas.', 'bad'); return; }
            let mode = 'merge';
            if (result.kind === 'full') {
                mode = window.confirm(`Backup com ${result.txs.length} operação(ões).\n\nOK: substituir tudo (lista, plano, alertas e operações).\nCancelar: só juntar as operações às atuais.`) ? 'replace' : 'merge';
            } else if (!window.confirm(`Importar ${result.txs.length} aporte(s) de Bitcoin do dashboard antigo${result.skipped ? ` (${result.skipped} inválido(s) ignorado(s))` : ''}?`)) {
                return;
            }
            store.applyImport(result, mode);
            toast(`${result.txs.length} operação(ões) importadas.`, 'up');
        } catch (error) {
            console.error(error);
            toast('Arquivo não reconhecido. Use um backup deste painel ou o export do dashboard antigo.', 'bad');
        }
    }

    function renderLegacyBanner() {
        const el = $('#legacyBanner', root);
        const legacy = store.legacyLocalData();
        const already = S.transactions.some((t) => t.id.startsWith('legacy-'));
        if (!legacy || already) { el.hidden = true; return; }
        el.hidden = false;
        el.innerHTML = html`<p>Encontrei <strong>${legacy.length} aporte(s)</strong> do seu Dashboard Bitcoin antigo neste navegador.</p><button class="btn btn-primary" type="button" id="legacyImport">Trazer para a carteira</button>`;
        $('#legacyImport', el).addEventListener('click', () => {
            store.applyImport({ kind: 'legacy', ...store.legacyToTx(legacy) }, 'merge');
            toast('Aportes antigos importados.', 'up');
        });
    }

    // ---------- Montagem ----------
    App.views.carteira = {
        title: 'Carteira',
        mount(el, params) {
            root = el;
            el.innerHTML = html`
                <header class="page-head">
                    <div><h1>Carteira</h1><p class="lede">Suas posições, o plano de aportes e o histórico de compras e vendas.</p></div>
                    <button class="btn btn-primary" type="button" data-act="new">Nova operação</button>
                </header>
                <div id="legacyBanner" class="banner" hidden></div>
                <section class="panel pf-hero">
                    <div id="pfSummary" class="pf-summary"></div>
                    <div id="allocBar" class="alloc"></div>
                </section>
                <div class="pf-grid">
                    <section class="panel" id="planCard"></section>
                    <section class="panel evo-panel">
                        <div class="panel-bar">
                            <h2 class="panel-title">Evolução</h2>
                            <div class="seg seg-soft" id="evoRange" role="group" aria-label="Período">
                                <button type="button" data-range="6m" aria-pressed="${evoRange === '6m'}">6M</button>
                                <button type="button" data-range="1y" aria-pressed="${evoRange === '1y'}">1A</button>
                                <button type="button" data-range="all" aria-pressed="${evoRange === 'all'}">Tudo</button>
                            </div>
                        </div>
                        <div class="chart-legend"><span><i style="background:var(--brand)"></i>Valor da carteira</span><span><i class="dashed"></i>Investido</span></div>
                        <div id="evoChart" class="chart-evo"></div>
                        <p id="evoNote" class="footnote"></p>
                    </section>
                </div>
                <section class="panel">
                    <h2 class="panel-title">Posições</h2>
                    <div class="table-wrap">
                        <table class="data-table">
                            <thead><tr><th>Cripto</th><th class="col-num">Preço médio</th><th class="col-num">Preço atual</th><th class="col-num">Valor</th><th class="col-num">Resultado</th><th class="col-num">Peso / alvo</th><th class="col-actions"><span class="sr-only">Ações</span></th></tr></thead>
                            <tbody id="posBody"></tbody>
                        </table>
                    </div>
                </section>
                <section class="panel">
                    <div class="panel-bar">
                        <h2 class="panel-title">Operações <span id="txCount" class="muted small"></span></h2>
                        <div class="toolbar">
                            <label class="sr-only" for="txFilter">Filtrar por cripto</label>
                            <select id="txFilter" class="input input-small"></select>
                            <button class="btn btn-small" type="button" data-act="csv">Exportar CSV</button>
                            <button class="btn btn-small" type="button" data-act="backup">Fazer backup</button>
                            <label class="btn btn-small" for="importFile">Importar</label>
                            <input id="importFile" type="file" accept="application/json,.json" hidden>
                        </div>
                    </div>
                    <div class="table-wrap">
                        <table class="data-table">
                            <thead><tr><th>Data</th><th>Cripto</th><th>Tipo</th><th class="col-num">Quantidade</th><th class="col-num">Preço</th><th class="col-num">Total</th><th class="col-actions"><span class="sr-only">Ações</span></th></tr></thead>
                            <tbody id="txBody"></tbody>
                        </table>
                    </div>
                    <p class="footnote">Os dados ficam só neste navegador. Faça backup de vez em quando para não perder nada.</p>
                </section>
                <section class="panel">
                    <h2 class="panel-title">Simulador de aportes</h2>
                    <p class="muted">Quanto você teria hoje se tivesse aportado um valor fixo em reais desde uma data.</p>
                    <form id="simForm" class="sim-form">
                        <label>Cripto<select id="simAsset" class="input">${raw([...new Set([...S.watchlist, 'BTC'])].map((a) => html`<option>${a}</option>`).join(''))}</select></label>
                        <label>Valor por aporte (R$)<input id="simAmount" class="input" type="number" min="1" step="1" value="${S.plan.budgetBrl || 200}"></label>
                        <label>Frequência<select id="simFreq" class="input"><option value="weekly">Semanal</option><option value="monthly">Mensal</option><option value="daily">Diária</option></select></label>
                        <label>Desde<input id="simStart" class="input" type="date" value="${App.util.addDays(localIso(), -365 * 2)}" max="${localIso()}"></label>
                        <button class="btn btn-primary" type="submit">Simular</button>
                    </form>
                    <div id="simOut"></div>
                </section>`;

            el.addEventListener('click', (event) => {
                const act = event.target.closest('[data-act]')?.dataset.act;
                if (act === 'new') openTx();
                else if (act === 'plan') openPlan();
                else if (act === 'execute') executeSuggestion();
                else if (act === 'csv') exportCsv();
                else if (act === 'backup') download(`backup-painel-cripto-${localIso()}.json`, store.exportData(), 'application/json');
                const edit = event.target.closest('[data-edit]')?.dataset.edit;
                if (edit) openTx({ id: edit });
                const del = event.target.closest('[data-del]')?.dataset.del;
                if (del) {
                    const t = S.transactions.find((x) => x.id === del);
                    if (t && window.confirm(`Apagar ${t.type === 'buy' ? 'compra' : 'venda'} de ${fmt.qty(t.qty)} ${t.asset} em ${fmt.date(t.date)}?`)) {
                        store.removeTx(del);
                        toast('Operação apagada.');
                    }
                }
            });
            $('#txFilter', el).addEventListener('change', (e) => { txFilter = e.target.value; renderTransactions(); });
            $('#importFile', el).addEventListener('change', async (e) => {
                const [file] = e.target.files ?? [];
                if (file) await importFile(file);
                e.target.value = '';
            });
            $('#evoRange', el).addEventListener('click', (e) => {
                const b = e.target.closest('button[data-range]'); if (!b) return;
                evoRange = b.dataset.range;
                $$('#evoRange button', el).forEach((x) => x.setAttribute('aria-pressed', x === b));
                renderEvolution();
            });
            $('#simForm', el).addEventListener('submit', runSimulator);

            wireTxDialog();
            wirePlanDialog();
            renderAll();
            renderTransactions();
            renderLegacyBanner();
            renderEvolution();
            loadSignals();

            const refreshEvo = App.util.debounce(renderEvolution, 400);
            let lastLive = 0;
            offs = [
                bus.on('prices', () => { if (Date.now() - lastLive > 1500) { lastLive = Date.now(); renderAll(); } }),
                bus.on('transactions', () => { renderAll(); renderTransactions(); renderLegacyBanner(); refreshEvo(); }),
                bus.on('plan', () => renderAll()),
                bus.on('settings', () => { renderAll(); renderTransactions(); refreshEvo(); }),
                bus.on('theme', refreshEvo),
            ];

            if (params[0] === 'novo') openTx({ asset: (params[1] || '').toUpperCase() || undefined });
        },
        unmount() {
            offs.forEach((off) => off());
            offs = [];
            evoChart?.remove();
            evoChart = null;
            root = null;
            if ($('#txDialog').open) $('#txDialog').close();
            if ($('#planDialog').open) $('#planDialog').close();
        },
    };
})(window.App);
