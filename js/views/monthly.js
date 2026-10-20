// Plano mensal: um valor em reais por mês, dividido em semanas e entre várias
// criptos, convertido para a quantidade exata em dólar (USDT) de cada compra.
window.App = window.App || {};

(function (App) {
    const { $, $$, html, raw, fmt, bus, toneOf, toast, localIso, parseIso, uid } = App.util;
    const store = App.store;
    const S = store.state;
    const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

    let root = null;
    let offs = [];
    let monthKey = localIso().slice(0, 7);

    const M = () => S.monthly;
    const cents = (v) => Math.floor(v * 100 + 1e-6) / 100;

    function weekDates(key) {
        const [y, m] = key.split('-').map(Number);
        const out = [];
        const d = new Date(y, m - 1, 1);
        while (d.getMonth() === m - 1) {
            if (d.getDay() === Number(M().weekday)) out.push(localIso(d));
            d.setDate(d.getDate() + 1);
        }
        return M().weeks === 'four' ? out.slice(0, 4) : out;
    }

    function weights() {
        const assets = M().assets.filter((a) => a.symbol);
        if (!assets.length) return [];
        if (!M().customWeights) return assets.map((a) => ({ symbol: a.symbol, w: 1 / assets.length }));
        const sum = assets.reduce((acc, a) => acc + (Number(a.weight) || 0), 0);
        if (!sum) return assets.map((a) => ({ symbol: a.symbol, w: 1 / assets.length }));
        return assets.map((a) => ({ symbol: a.symbol, w: (Number(a.weight) || 0) / sum })).filter((a) => a.w > 0);
    }

    function logFor(key, index) {
        const month = M().log[key] || (M().log[key] = {});
        return month[index] || (month[index] = { usdReceived: null, fx: null, bought: {} });
    }

    function peekLog(key, index) {
        return M().log[key]?.[index] ?? { usdReceived: null, fx: null, bought: {} };
    }

    // Calcula o cronograma do mês: reais por semana, câmbio, dólares por cripto e sobras.
    function plan(key) {
        const dates = weekDates(key);
        const ws = weights();
        const n = dates.length;
        if (!n || !ws.length) return null;
        const budgetCents = Math.round((Number(M().budgetBrl) || 0) * 100);
        const weeks = dates.map((date, k) => ({ index: k, date, parts: [] }));

        if (M().mode === 'rotate') {
            // Rodízio: cada cripto compra a parte do mês inteira numa só semana,
            // distribuídas para as semanas ficarem com valores parecidos.
            const totals = new Array(n).fill(0);
            [...ws].sort((a, b) => b.w - a.w).forEach((a) => {
                const k = totals.indexOf(Math.min(...totals));
                const brl = (budgetCents * a.w) / 100;
                weeks[k].parts.push({ symbol: a.symbol, brl });
                totals[k] += brl;
            });
        } else {
            const base = Math.floor(budgetCents / n);
            weeks.forEach((w, k) => {
                const weekCents = k === n - 1 ? budgetCents - base * (n - 1) : base;
                ws.forEach((a) => w.parts.push({ symbol: a.symbol, brl: (weekCents * a.w) / 100 }));
            });
        }
        // Mantém a ordem definida no plano dentro de cada semana.
        const order = M().assets.map((a) => a.symbol);
        weeks.forEach((w) => w.parts.sort((a, b) => order.indexOf(a.symbol) - order.indexOf(b.symbol)));

        const live = App.live.fx;
        const today = localIso();
        let carry = 0;
        weeks.forEach((w) => {
            const log = peekLog(key, w.index);
            w.brl = w.parts.reduce((acc, p) => acc + p.brl, 0);
            if (log.usdReceived > 0) {
                w.fx = w.brl / log.usdReceived;
                w.fxSource = 'recebido';
            } else if (log.fx > 0) {
                w.fx = log.fx;
                w.fxSource = 'travado';
            } else {
                w.fx = live;
                w.fxSource = 'estimado';
            }
            w.carryIn = carry;
            w.available = w.fx ? w.brl / w.fx + carry : null;
            let used = 0;
            w.items = w.parts.map((p) => {
                const share = w.brl ? p.brl / w.brl : 0;
                const usd = w.available !== null ? cents(w.available * share) : null;
                const txId = log.bought?.[p.symbol];
                const tx = txId ? S.transactions.find((t) => t.id === txId) : null;
                if (usd !== null) used += tx ? tx.totalUsd : usd;
                return { symbol: p.symbol, brl: p.brl, usd, tx, belowMin: usd !== null && usd < (Number(M().minOrderUsd) || 0) };
            });
            // Compras já feitas nesta semana que não estão mais no plano (o plano mudou
            // no meio do mês) continuam aparecendo, para o histórico não sumir.
            Object.entries(log.bought ?? {}).forEach(([symbol, txId]) => {
                if (w.items.some((i) => i.symbol === symbol)) return;
                const tx = S.transactions.find((t) => t.id === txId);
                if (tx) { w.items.push({ symbol, brl: tx.totalBrl ?? 0, usd: tx.totalUsd, tx, belowMin: false, extra: true }); used += tx.totalUsd; }
            });
            w.leftover = w.available !== null ? Math.max(0, w.available - used) : 0;
            carry = w.leftover;
            w.done = w.items.length > 0 && w.items.every((i) => i.tx);
            w.state = w.done ? 'done' : w.date === today ? 'today' : w.date < today ? 'late' : 'future';
        });
        return { weeks, n };
    }

    function walletLine() {
        const w = S.wallets.find((x) => x.id === M().walletId);
        if (!w) return S.wallets.length ? '<p class="muted small">Sem carteira padrão definida (escolha em “Editar plano”).</p>' : '';
        const r = App.walletResults?.get(w.id);
        const snaps = S.walletSnapshots[w.id] ?? [];
        const last = r?.lines ? { usd: r.total, t: r.at } : snaps[snaps.length - 1];
        const delta = r?.lines && r.prev ? r.total - r.prev.usd : null;
        return html`<p class="mp-wallet"><span class="w3-dot" style="--wc:${w.color}"></span>Aportes em <strong>${w.name}</strong>${raw(last ? html` · saldo ${App.money(last.usd, { priv: true, digits: 2 })}${raw(delta !== null && Math.abs(delta) >= 0.01 ? html` <span class="delta-${toneOf(delta)}">(${App.signedMoney(delta, { priv: true })} desde a leitura anterior)</span>` : '')}` : '')}
            <button class="link-btn" type="button" data-mp="wallet-refresh">${App.walletResults?.get(w.id) && !r?.error ? 'Ler de novo' : 'Ler saldo'}</button> · <a href="#/web3">Detalhes</a></p>`;
    }

    function monthLabel(key) {
        const [y, m] = key.split('-').map(Number);
        const text = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
        return text.charAt(0).toUpperCase() + text.slice(1);
    }

    function shiftMonth(delta) {
        const [y, m] = monthKey.split('-').map(Number);
        monthKey = localIso(new Date(y, m - 1 + delta, 1)).slice(0, 7);
        render();
    }

    // ---------- Render ----------
    function render() {
        if (!root) return;
        const p = plan(monthKey);
        const mm = M();
        const freq = `${mm.weeks === 'four' ? '4 semanas' : 'todas as semanas do mês'}, às ${WEEKDAYS[mm.weekday]}s`;
        const modeLabel = mm.mode === 'rotate' ? 'rodízio entre as semanas' : 'todas as criptos toda semana';
        const head = html`
            <div class="mp-head">
                <div>
                    <h2 class="panel-title">Plano mensal</h2>
                    <p class="muted small">${fmt.money(Number(mm.budgetBrl) || 0, 'BRL', 2)} por mês, ${freq}, ${modeLabel}. Pesos ${mm.customWeights ? 'personalizados' : 'iguais'}.</p>
                    ${raw(walletLine())}
                </div>
                <div class="mp-nav">
                    <button class="icon-btn icon-btn-lg" type="button" data-mp="prev" aria-label="Mês anterior">‹</button>
                    <strong>${monthLabel(monthKey)}</strong>
                    <button class="icon-btn icon-btn-lg" type="button" data-mp="next" aria-label="Próximo mês">›</button>
                    <button class="btn btn-small" type="button" data-mp="edit">Editar plano</button>
                </div>
            </div>`;
        if (!p) {
            root.innerHTML = head + html`<p class="empty-cell">${mm.assets.length ? 'Nenhuma semana nesse mês com o dia escolhido.' : 'Adicione criptos ao plano em “Editar plano”.'}</p>`;
            return;
        }
        const spentBrl = p.weeks.flatMap((w) => w.items).reduce((acc, i) => acc + (i.tx ? (i.tx.totalBrl ?? 0) : 0), 0);
        const pct = mm.budgetBrl ? Math.min(100, (spentBrl / mm.budgetBrl) * 100) : 0;
        const perAsset = weights().map((a) => {
            const items = p.weeks.flatMap((w) => w.items.filter((i) => i.symbol === a.symbol));
            const planned = items.reduce((acc, i) => acc + (i.tx ? i.tx.totalUsd : (i.usd ?? 0)), 0);
            const done = items.filter((i) => i.tx).reduce((acc, i) => acc + i.tx.totalUsd, 0);
            return { symbol: a.symbol, w: a.w, planned, done };
        });
        const warnMin = p.weeks.some((w) => w.items.some((i) => i.belowMin && !i.tx));

        root.innerHTML = head + html`
            <div class="mp-progress">
                <div class="mp-bar"><i style="width:${pct}%"></i></div>
                <span><strong>${fmt.money(spentBrl, 'BRL', 2)}</strong> de ${fmt.money(Number(mm.budgetBrl) || 0, 'BRL', 2)} aportados no mês</span>
            </div>
            <ul class="mp-assets">
                ${raw(perAsset.map((a) => html`<li style="--coin:${App.coins.meta(a.symbol).color}">
                    ${raw(App.coins.avatar(a.symbol, 22))}
                    <span><strong>${a.symbol}</strong> <span class="muted">${fmt.number(a.w * 100, 1)}%</span></span>
                    <span class="mp-asset-usd">${fmt.money(a.done, 'USD', 2)} <span class="muted">/ ${fmt.money(a.planned, 'USD', 2)}</span></span>
                </li>`).join(''))}
            </ul>
            ${raw(warnMin ? html`<p class="mp-warn">Algumas ordens ficaram abaixo do mínimo de ${fmt.money(Number(mm.minOrderUsd), 'USD', 2)} da corretora. Use o rodízio ou aumente o valor do mês.</p>` : '')}
            <div class="mp-weeks">${raw(p.weeks.map(weekCard).join(''))}</div>
            <p class="footnote">Valores em dólar arredondados para baixo nos centavos; o que sobra passa para a semana seguinte. Enquanto você não informa o USDT recebido, a conversão usa a cotação USDT/BRL ao vivo como estimativa.</p>`;
    }

    function weekCard(w) {
        const date = parseIso(w.date);
        const dateText = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' }).format(date);
        const chip = { done: ['Concluída', 'up'], today: ['Hoje', 'warn'], late: ['Pendente', 'down'], future: ['Próxima', 'flat'] }[w.state];
        const log = peekLog(monthKey, w.index);
        const fxText = w.fx ? (w.fxSource === 'recebido' ? `USDT recebido: câmbio ${fmt.money(w.fx, 'BRL', 3)}` : w.fxSource === 'travado' ? `Câmbio da semana ${fmt.money(w.fx, 'BRL', 3)}` : `Estimativa com USDT a ${fmt.money(w.fx, 'BRL', 3)}`) : 'Aguardando cotação';
        const pending = w.items.filter((i) => !i.tx).length;
        return html`<article class="mp-week mp-${w.state}" data-week="${w.index}">
            <header>
                <div><strong>Semana ${w.index + 1}</strong><span class="muted">${dateText}</span></div>
                <span class="chip chip-${chip[1]}">${chip[0]}</span>
            </header>
            <div class="mp-convert">
                <p><span class="muted">Converter</span> <strong>${fmt.money(w.brl, 'BRL', 2)}</strong></p>
                <label class="mp-received"><span>USDT recebido</span><input class="input input-small" data-received="${w.index}" inputmode="decimal" autocomplete="off" placeholder="${w.fx ? fmt.number(w.brl / w.fx, 2) : '—'}" value="${log.usdReceived ? String(log.usdReceived).replace('.', ',') : ''}"></label>
                <p class="muted small">${fxText}${raw(w.carryIn >= 0.01 ? html` · +${fmt.money(w.carryIn, 'USD', 2)} da semana anterior` : '')}</p>
            </div>
            <ul class="mp-items">
                ${raw(w.items.map((i) => {
                    const price = App.priceOf(i.symbol);
                    const qty = i.tx ? i.tx.qty : (i.usd && price ? i.usd / price : null);
                    return html`<li class="${i.tx ? 'is-done' : ''}">
                        <a class="coin-inline" href="#/ativo/${i.symbol}">${raw(App.coins.avatar(i.symbol, 22))}<strong>${i.symbol}</strong></a>
                        <span class="mp-usd"><strong>${i.tx ? fmt.money(i.tx.totalUsd, 'USD', 2) : (i.usd === null ? '—' : fmt.money(i.usd, 'USD', 2))}</strong><small class="muted">${qty ? `≈ ${fmt.qty(qty)}` : ''}</small>${raw(i.belowMin && !i.tx ? '<small class="delta-down">abaixo do mínimo</small>' : '')}</span>
                        ${raw(i.tx
                            ? html`<button class="mp-check is-on" type="button" data-undo="${i.symbol}" title="Desfazer compra" aria-label="Desfazer compra de ${i.symbol}">✓</button>`
                            : html`<button class="mp-check" type="button" data-buy="${i.symbol}" title="Marcar como comprado" aria-label="Registrar compra de ${i.symbol}" ${i.usd ? '' : 'disabled'}></button>`)}
                    </li>`;
                }).join(''))}
            </ul>
            <footer>
                ${raw(pending > 1 ? '<button class="btn btn-small btn-primary" type="button" data-buyall>Comprei todas</button>' : '')}
                ${raw(w.leftover >= 0.01 ? html`<span class="muted small">Sobra ${fmt.money(w.leftover, 'USD', 2)}${w.index < weekDates(monthKey).length - 1 ? ' → próxima' : ''}</span>` : '')}
            </footer>
        </article>`;
    }

    // ---------- Ações ----------
    function weekOf(index) {
        return plan(monthKey)?.weeks[index];
    }

    function txDate(weekDate) {
        const today = localIso();
        return weekDate <= today ? weekDate : today;
    }

    function openBuy(index, symbol) {
        const w = weekOf(index);
        const item = w?.items.find((i) => i.symbol === symbol);
        if (!item) return;
        const dlg = $('#mpBuyDialog');
        dlg.dataset.week = index;
        dlg.dataset.symbol = symbol;
        $('#mpBuyTitle').textContent = `Compra de ${symbol} · semana ${index + 1}`;
        $('#mpBuyUsd').value = item.usd?.toFixed(2).replace('.', ',') ?? '';
        $('#mpBuyPrice').value = App.priceOf(symbol) ? String(+App.priceOf(symbol).toPrecision(8)).replace('.', ',') : '';
        $('#mpBuyDate').value = txDate(w.date);
        $('#mpBuyDate').max = localIso();
        $('#mpBuyWallet').innerHTML = App.walletOptions(M().walletId);
        $('#mpBuyQty').value = '';
        $('#mpBuyFee').value = '';
        updateBuyPreview();
        dlg.showModal();
        $('#mpBuyPrice').focus();
    }

    function updateBuyPreview() {
        const usd = App.parseNum($('#mpBuyUsd').value);
        const qty = App.parseNum($('#mpBuyQty').value);
        const price = App.parseNum($('#mpBuyPrice').value);
        const sym = $('#mpBuyDialog').dataset.symbol;
        if (usd > 0 && qty > 0) {
            $('#mpBuyPreview').textContent = `${fmt.qty(qty)} ${sym} · preço efetivo ${fmt.money(usd / qty)}`;
        } else {
            $('#mpBuyPreview').textContent = usd > 0 && price > 0 ? `${fmt.qty(usd / price)} ${sym}` : 'Informe valor e preço.';
        }
    }

    function recordBuy(index, symbol, usd, price, date, walletId = M().walletId, feeUsd = 0) {
        const w = weekOf(index);
        const log = logFor(monthKey, index);
        const fx = w.fx || App.live.fx;
        if (!log.fx && !log.usdReceived) log.fx = fx;
        const tx = store.upsertTx({
            id: uid(), asset: symbol, type: 'buy', date, qty: usd / price, priceUsd: price, totalUsd: usd,
            totalBrl: fx ? usd * fx : null, fxRate: fx, feeUsd, walletId, note: `Plano mensal ${monthKey} · semana ${index + 1}`,
        });
        log.bought[symbol] = tx.id;
    }

    function saveBuy(event) {
        event.preventDefault();
        const dlg = $('#mpBuyDialog');
        const usd = App.parseNum($('#mpBuyUsd').value);
        const qty = App.parseNum($('#mpBuyQty').value);
        const price = qty > 0 ? usd / qty : App.parseNum($('#mpBuyPrice').value);
        const fee = App.parseNum($('#mpBuyFee').value || '0');
        const date = $('#mpBuyDate').value;
        if (!(usd > 0) || !(price > 0)) { toast('Informe valor e preço (ou quantidade recebida) maiores que zero.', 'bad'); return; }
        if (!date || date > localIso()) { toast('Escolha uma data até hoje.', 'bad'); return; }
        recordBuy(Number(dlg.dataset.week), dlg.dataset.symbol, usd, price, date, $('#mpBuyWallet').value || null, fee > 0 ? fee : 0);
        store.commit('monthly');
        dlg.close();
        toast(`Compra de ${dlg.dataset.symbol} registrada.`, 'up');
    }

    function buyAll(index) {
        const w = weekOf(index);
        const pending = w.items.filter((i) => !i.tx && i.usd > 0 && App.priceOf(i.symbol));
        if (!pending.length) return;
        const lines = pending.map((i) => `• ${i.symbol}: ${fmt.money(i.usd, 'USD', 2)} a ${fmt.money(App.priceOf(i.symbol))}`).join('\n');
        if (!window.confirm(`Registrar ${pending.length} compras da semana ${index + 1} com o preço atual?\n\n${lines}\n\nDepois dá para ajustar cada uma na lista de operações.`)) return;
        pending.forEach((i) => recordBuy(index, i.symbol, i.usd, App.priceOf(i.symbol), txDate(w.date)));
        store.commit('monthly');
        toast(`${pending.length} compras registradas.`, 'up');
    }

    function undo(index, symbol) {
        const log = logFor(monthKey, index);
        const txId = log.bought[symbol];
        if (!window.confirm(`Desfazer a compra de ${symbol} da semana ${index + 1}? A operação também sai da carteira.`)) return;
        delete log.bought[symbol];
        if (!Object.keys(log.bought).length && !log.usdReceived) log.fx = null;
        if (txId) store.removeTx(txId);
        store.commit('monthly');
    }

    function onClick(event) {
        const t = event.target;
        const act = t.closest('[data-mp]')?.dataset.mp;
        if (act === 'prev') return shiftMonth(-1);
        if (act === 'next') return shiftMonth(1);
        if (act === 'edit') return openEditor();
        if (act === 'wallet-refresh' && M().walletId) {
            toast('Lendo a carteira…');
            return App.refreshWallet(M().walletId);
        }
        const card = t.closest('[data-week]');
        if (!card) return;
        const index = Number(card.dataset.week);
        const buy = t.closest('[data-buy]')?.dataset.buy;
        if (buy) return openBuy(index, buy);
        const und = t.closest('[data-undo]')?.dataset.undo;
        if (und) return undo(index, und);
        if (t.closest('[data-buyall]')) buyAll(index);
    }

    function onReceived(event) {
        const input = event.target.closest('[data-received]');
        if (!input) return;
        const index = Number(input.dataset.received);
        const value = input.value.trim() ? App.parseNum(input.value) : null;
        if (value !== null && !(value > 0)) { toast('Informe o USDT recebido como número.', 'bad'); return; }
        const log = logFor(monthKey, index);
        log.usdReceived = value;
        store.commit('monthly');
        if (value) toast(`Semana ${index + 1}: valores recalculados com US$ ${fmt.number(value, 2)} recebidos.`);
    }

    // ---------- Editor do plano ----------
    let draftAssets = [];

    function openEditor() {
        const dlg = $('#mpDialog');
        const mm = M();
        $('#mpBudget').value = mm.budgetBrl;
        $('#mpWeekday').value = String(mm.weekday);
        $('#mpWeeks').value = mm.weeks;
        $('#mpMode').value = mm.mode;
        $('#mpMin').value = mm.minOrderUsd;
        $('#mpCustom').checked = !!mm.customWeights;
        $('#mpWallet').innerHTML = App.walletOptions(mm.walletId, 'Não definida');
        draftAssets = mm.assets.map((a) => ({ ...a }));
        renderEditorAssets();
        dlg.showModal();
    }

    function renderEditorAssets() {
        const custom = $('#mpCustom').checked;
        const equal = draftAssets.length ? 100 / draftAssets.length : 0;
        $('#mpAssets').innerHTML = draftAssets.length ? draftAssets.map((a, i) => html`<li>
            <span class="coin-inline">${raw(App.coins.avatar(a.symbol, 22))}<strong>${a.symbol}</strong></span>
            <label class="pct-input"><span class="sr-only">Peso de ${a.symbol} em %</span><input type="number" min="0" max="100" step="0.1" data-weight="${i}" value="${custom ? Math.round((Number(a.weight) || 0) * 10) / 10 : Math.round(equal * 10) / 10}" ${custom ? '' : 'disabled'}><span>%</span></label>
            <button class="icon-btn" type="button" data-remove-asset="${i}" aria-label="Tirar ${a.symbol} do plano">✕</button>
        </li>`).join('') : '<li class="muted">Nenhuma cripto no plano.</li>';
        const sum = custom ? draftAssets.reduce((acc, a) => acc + (Number(a.weight) || 0), 0) : (draftAssets.length ? 100 : 0);
        const out = $('#mpSum');
        out.textContent = `Soma: ${fmt.number(sum, 1)}%${custom && Math.abs(sum - 100) > 0.05 && sum > 0 ? ' · será ajustada proporcionalmente para 100%' : ''}`;
        out.className = custom && Math.abs(sum - 100) > 0.05 ? 'plan-sum warn' : 'plan-sum ok';
        const budget = Number($('#mpBudget').value) || 0;
        const fx = App.live.fx;
        const nWeeks = $('#mpWeeks').value === 'four' ? 4 : 4.35;
        const per = draftAssets.length && fx ? budget / fx / nWeeks / draftAssets.length : null;
        $('#mpHint').textContent = per && $('#mpMode').value === 'all'
            ? `Com pesos iguais, cada ordem semanal fica perto de ${fmt.money(per, 'USD', 2)}.`
            : '';
    }

    function wireEditor() {
        const dlg = $('#mpDialog');
        if (dlg.dataset.wired) return;
        dlg.dataset.wired = '1';
        $('#mpCustom').addEventListener('change', () => {
            if ($('#mpCustom').checked) {
                const equal = draftAssets.length ? 100 / draftAssets.length : 0;
                draftAssets.forEach((a) => { if (!(a.weight > 1)) a.weight = Math.round(equal * 10) / 10; });
            }
            renderEditorAssets();
        });
        $('#mpForm').addEventListener('input', (event) => {
            const w = event.target.closest('[data-weight]');
            if (w) {
                draftAssets[Number(w.dataset.weight)].weight = Number(w.value) || 0;
                const sum = draftAssets.reduce((acc, a) => acc + (Number(a.weight) || 0), 0);
                $('#mpSum').textContent = `Soma: ${fmt.number(sum, 1)}%${Math.abs(sum - 100) > 0.05 && sum > 0 ? ' · será ajustada proporcionalmente para 100%' : ''}`;
                $('#mpSum').className = Math.abs(sum - 100) > 0.05 ? 'plan-sum warn' : 'plan-sum ok';
            } else if (['mpBudget', 'mpWeeks', 'mpMode'].includes(event.target.id)) {
                renderEditorAssets();
            }
        });
        $('#mpAssets').addEventListener('click', (event) => {
            const r = event.target.closest('[data-remove-asset]');
            if (!r) return;
            draftAssets.splice(Number(r.dataset.removeAsset), 1);
            renderEditorAssets();
        });
        $('#mpAdd').addEventListener('click', () => {
            App.openSearch('pick', null, (symbol) => {
                if (draftAssets.some((a) => a.symbol === symbol)) { toast(`${symbol} já está no plano.`); return; }
                const equal = 100 / (draftAssets.length + 1);
                draftAssets.push({ symbol, weight: Math.round(equal * 10) / 10 });
                renderEditorAssets();
            });
        });
        $('#mpCancel').addEventListener('click', () => dlg.close());
        $('#mpForm').addEventListener('submit', (event) => {
            event.preventDefault();
            const budget = Number($('#mpBudget').value);
            if (!(budget > 0)) { toast('Informe o valor mensal em reais.', 'bad'); return; }
            if (!draftAssets.length) { toast('Inclua pelo menos uma cripto.', 'bad'); return; }
            const custom = $('#mpCustom').checked;
            if (custom && !draftAssets.some((a) => a.weight > 0)) { toast('Dê peso para pelo menos uma cripto.', 'bad'); return; }
            Object.assign(S.monthly, {
                budgetBrl: budget,
                weekday: Number($('#mpWeekday').value),
                weeks: $('#mpWeeks').value,
                mode: $('#mpMode').value,
                minOrderUsd: Math.max(0, Number($('#mpMin').value) || 0),
                customWeights: custom,
                walletId: $('#mpWallet').value || null,
                assets: draftAssets.map((a) => ({ symbol: a.symbol, weight: custom ? Number(a.weight) || 0 : 1 })),
            });
            store.commit('monthly');
            dlg.close();
            toast('Plano mensal salvo.', 'up');
            App.refreshPrices();
        });
    }

    function wireBuyDialog() {
        const dlg = $('#mpBuyDialog');
        if (dlg.dataset.wired) return;
        dlg.dataset.wired = '1';
        $('#mpBuyForm').addEventListener('submit', saveBuy);
        $('#mpBuyForm').addEventListener('input', updateBuyPreview);
        $('#mpBuyCancel').addEventListener('click', () => dlg.close());
    }

    App.monthly = {
        mount(el) {
            root = el;
            monthKey = localIso().slice(0, 7);
            wireEditor();
            wireBuyDialog();
            el.addEventListener('click', onClick);
            el.addEventListener('change', onReceived);
            render();
            let last = 0;
            offs = [
                bus.on('monthly', render),
                bus.on('wallet-read', render),
                bus.on('wallets', render),
                bus.on('transactions', render),
                bus.on('prices', () => {
                    // Só redesenha com preços novos se nenhum campo estiver sendo editado.
                    if (Date.now() - last < 4000 || root?.contains(document.activeElement)) return;
                    last = Date.now();
                    render();
                }),
            ];
        },
        unmount() {
            offs.forEach((o) => o());
            offs = [];
            root = null;
        },
        plan,
    };
})(window.App);
