// Tela "Análise": gráfico completo de uma cripto, sinal de aporte e alertas.
window.App = window.App || {};
App.views = App.views || {};

(function (App) {
    const { $, $$, html, raw, fmt, bus, toneOf, toast } = App.util;
    const store = App.store;
    const S = store.state;

    const TF = { '1h': { label: '1H', limit: 1000 }, '4h': { label: '4H', limit: 1000 }, '1d': { label: '1D', limit: 1000 }, '1w': { label: '1S', limit: 520 } };

    let root = null;
    let symbol = null;
    let charts = {};
    let series = {};
    let data = [];
    let offs = [];
    let klineStream = null;
    let syncing = false;
    let lastCandleDraw = 0;
    let loadToken = 0;

    function destroyCharts() {
        Object.values(charts).forEach((c) => c.remove());
        charts = {};
        series = {};
    }

    function buildCharts() {
        destroyCharts();
        const LC = window.LightweightCharts;
        if (!LC) {
            $('#chartMain', root).innerHTML = '<p class="empty-cell">A biblioteca de gráficos não carregou. Verifique a conexão.</p>';
            return;
        }
        const c = App.charts.colors();
        const coin = App.coins.meta(symbol).color;
        charts.main = LC.createChart($('#chartMain', root), App.charts.chartOptions({ rightPriceScale: { borderColor: App.charts.css('--line'), scaleMargins: { top: 0.08, bottom: 0.22 } } }));
        charts.rsi = LC.createChart($('#chartRsi', root), App.charts.chartOptions({ timeScale: { visible: false }, handleScroll: false, handleScale: false }));
        charts.macd = LC.createChart($('#chartMacd', root), App.charts.chartOptions({ timeScale: { visible: false }, handleScroll: false, handleScale: false }));

        series.candles = charts.main.addCandlestickSeries({ upColor: c.up, downColor: c.down, borderVisible: false, wickUpColor: c.up, wickDownColor: c.down, priceFormat: { type: 'price', precision: precisionFor(data), minMove: 10 ** -precisionFor(data) } });
        series.volume = charts.main.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
        charts.main.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        const line = (color, width = 1.5, extra = {}) => charts.main.addLineSeries({ color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra });
        series.sma20 = line(App.charts.css('--sma20'));
        series.sma50 = line(App.charts.css('--sma50'));
        series.sma200 = line(coin, 2);
        series.bbUp = line(App.charts.css('--ink-3'), 1, { lineStyle: 2 });
        series.bbLow = line(App.charts.css('--ink-3'), 1, { lineStyle: 2 });

        // Âncoras invisíveis: mesmos horários nos três gráficos para a sincronização não deslocar os indicadores.
        series.rsiAnchor = charts.rsi.addLineSeries({ visible: false, lastValueVisible: false, priceLineVisible: false });
        series.macdAnchor = charts.macd.addLineSeries({ visible: false, lastValueVisible: false, priceLineVisible: false });
        series.rsi = charts.rsi.addLineSeries({ color: coin, lineWidth: 1.5, priceLineVisible: false });
        [70, 30].forEach((level) => series.rsi.createPriceLine({ price: level, color: App.charts.css('--ink-3'), lineWidth: 1, lineStyle: 2, axisLabelVisible: false }));
        series.hist = charts.macd.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
        series.macd = charts.macd.addLineSeries({ color: App.charts.css('--ink'), lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
        series.signal = charts.macd.addLineSeries({ color: App.charts.css('--sma20'), lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });

        const all = Object.values(charts);
        all.forEach((chart) => {
            chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
                if (syncing || !range) return;
                syncing = true;
                all.forEach((peer) => { if (peer !== chart) peer.timeScale().setVisibleLogicalRange(range); });
                syncing = false;
            });
        });
        charts.main.subscribeCrosshairMove(onCrosshair);
    }

    function precisionFor(rows) {
        const p = rows.length ? rows[rows.length - 1].close : 1;
        if (p >= 1000) return 2;
        if (p >= 1) return 3;
        if (p >= 0.01) return 5;
        return 8;
    }

    function fillCharts() {
        if (!series.candles || !data.length) return;
        const c = App.charts.colors();
        const ind = S.settings.indicators;
        const anchors = data.map(({ time }) => ({ time }));
        series.rsiAnchor.setData(anchors);
        series.macdAnchor.setData(anchors);
        series.candles.setData(data.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
        series.volume.setData(ind.volume ? data.map((d) => ({ time: d.time, value: d.quoteVolume, color: d.close >= d.open ? hexA(c.up, 0.35) : hexA(c.down, 0.35) })) : []);
        series.sma20.setData(ind.sma ? App.ind.sma(data, 20) : []);
        series.sma50.setData(ind.sma ? App.ind.sma(data, 50) : []);
        series.sma200.setData(ind.sma ? App.ind.sma(data, 200) : []);
        const bb = ind.bb ? App.ind.bollinger(data) : { upper: [], lower: [] };
        series.bbUp.setData(bb.upper);
        series.bbLow.setData(bb.lower);
        series.rsi.setData(App.ind.rsi(data));
        const m = App.ind.macd(data);
        series.macd.setData(m.macdLine);
        series.signal.setData(m.signalLine);
        series.hist.setData(m.histogram.map((h) => ({ ...h, color: h.value >= 0 ? hexA(c.up, 0.5) : hexA(c.down, 0.5) })));
        const visible = Math.min(data.length, S.settings.timeframe === '1w' ? 160 : 180);
        const range = { from: data.length - visible, to: data.length + 3 };
        Object.values(charts).forEach((chart) => chart.timeScale().setVisibleLogicalRange(range));
        renderIndicatorReadout();
    }

    function hexA(color, alpha) {
        if (color.startsWith('#') && color.length === 7) {
            const n = parseInt(color.slice(1), 16);
            return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
        }
        return color;
    }

    function onCrosshair(param) {
        const tip = $('#chartTip', root);
        if (!tip) return;
        if (!param?.time || !param.point) {
            tip.hidden = true;
            return;
        }
        const d = data.find((row) => row.time === param.time);
        if (!d) { tip.hidden = true; return; }
        const change = ((d.close - d.open) / d.open) * 100;
        const when = new Date(d.time * 1000);
        const dateText = ['1d', '1w'].includes(S.settings.timeframe)
            ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'UTC' }).format(when)
            : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(when);
        tip.innerHTML = html`<strong>${dateText}</strong>
            <dl>
                <dt>Abertura</dt><dd>${fmt.money(d.open)}</dd>
                <dt>Máxima</dt><dd>${fmt.money(d.high)}</dd>
                <dt>Mínima</dt><dd>${fmt.money(d.low)}</dd>
                <dt>Fechamento</dt><dd>${fmt.money(d.close)}</dd>
                <dt>Variação</dt><dd class="delta-${toneOf(change)}">${fmt.pct(change)}</dd>
                <dt>Volume</dt><dd>${fmt.compactMoney(d.quoteVolume)}</dd>
            </dl>`;
        tip.hidden = false;
        const box = $('#chartMain', root).getBoundingClientRect();
        const left = param.point.x > box.width / 2 ? param.point.x - tip.offsetWidth - 16 : param.point.x + 16;
        tip.style.left = `${Math.max(8, left)}px`;
        tip.style.top = `${Math.max(8, Math.min(param.point.y - 40, box.height - tip.offsetHeight - 8))}px`;
    }

    function renderIndicatorReadout() {
        const r = App.ind.rsi(data);
        const m = App.ind.macd(data);
        const lastR = r[r.length - 1]?.value;
        const lm = m.macdLine[m.macdLine.length - 1]?.value;
        const ls = m.signalLine[m.signalLine.length - 1]?.value;
        $('#rsiReadout', root).innerHTML = html`<span class="${lastR >= 70 ? 'delta-down' : lastR <= 30 ? 'delta-up' : ''}">${fmt.number(lastR, 1)}</span> ${lastR >= 70 ? 'sobrecompra' : lastR <= 30 ? 'sobrevenda' : 'neutro'}`;
        $('#macdReadout', root).textContent = Number.isFinite(lm) ? `${lm > ls ? 'acima' : 'abaixo'} do sinal` : '—';
    }

    async function loadChart() {
        const token = ++loadToken;
        const tf = S.settings.timeframe;
        $('#chartState', root).textContent = 'Carregando gráfico…';
        $('#chartState', root).hidden = false;
        try {
            const rows = await App.api.klines(symbol, tf, TF[tf].limit);
            if (token !== loadToken || !root) return;
            data = rows.map((r) => ({ ...r }));
            $('#chartState', root).hidden = true;
            buildCharts();
            fillCharts();
            klineStream.set([`${symbol.toLowerCase()}usdt@kline_${tf}`]);
        } catch (error) {
            if (token !== loadToken || !root) return;
            $('#chartState', root).textContent = error.status === 400
                ? `${symbol}/USDT não existe na Binance.`
                : 'Não consegui carregar o gráfico. Tente atualizar a página.';
        }
    }

    function onKline(msg) {
        if (msg.e !== 'kline' || !data.length) return;
        const k = msg.k;
        if (k.i !== S.settings.timeframe || !k.s.startsWith(symbol)) return;
        const candle = { time: Math.floor(k.t / 1000), open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v), quoteVolume: Number(k.q) };
        const lastRow = data[data.length - 1];
        if (candle.time > lastRow.time) {
            data.push(candle);
            if (data.length > TF[S.settings.timeframe].limit) data.shift();
            fillCharts();
            return;
        }
        if (candle.time !== lastRow.time) return;
        data[data.length - 1] = candle;
        const now = Date.now();
        if (now - lastCandleDraw < 400) return;
        lastCandleDraw = now;
        series.candles?.update({ time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close });
        const c = App.charts.colors();
        if (S.settings.indicators.volume) series.volume?.update({ time: candle.time, value: candle.quoteVolume, color: candle.close >= candle.open ? hexA(c.up, 0.35) : hexA(c.down, 0.35) });
    }

    function renderHero() {
        const p = App.live.prices[symbol];
        const m = App.coins.meta(symbol);
        const tone = toneOf(p?.changePct);
        $('#heroPrice', root).textContent = p ? fmt.money(p.price) : '—';
        $('#heroPriceAlt', root).textContent = p && App.live.fx ? (S.settings.currency === 'BRL' ? fmt.money(p.price * App.live.fx, 'BRL') : '') : '';
        $('#heroChange', root).innerHTML = p ? html`<span class="delta delta-${tone}">${fmt.pct(p.changePct)}</span> <span class="muted">em 24h</span>` : '';
        $('#heroRange', root).innerHTML = p ? html`<span class="muted">Mín.</span> ${fmt.money(p.low)} <span class="muted">Máx.</span> ${fmt.money(p.high)} <span class="muted">Vol.</span> ${App.money(p.quoteVolume, { compact: true })}` : '';
        const inLists = store.listsOf(symbol);
        const btn = $('#watchToggle', root);
        btn.textContent = inLists.length ? (inLists.length === 1 ? `Em “${store.getList(inLists[0]).name}”` : `Em ${inLists.length} listas`) : 'Adicionar a uma lista';
        btn.setAttribute('aria-pressed', inLists.length > 0);
        document.documentElement.style.setProperty('--accent', m.color);
        renderPosition();
    }

    function renderPosition() {
        const pos = store.positions().find((p) => p.asset === symbol && p.qty > 0);
        const el = $('#positionCard', root);
        if (!pos) {
            el.innerHTML = html`<p class="muted">Você ainda não tem ${symbol} na carteira.</p><a class="btn" href="#/carteira/novo/${symbol}">Registrar compra</a>`;
            return;
        }
        const price = App.priceOf(symbol);
        const value = price ? pos.qty * price : null;
        const inBrl = S.settings.currency === 'BRL' && App.live.fx && pos.costBrl > 0;
        const pnl = value === null ? null : inBrl ? value * App.live.fx - pos.costBrl : value - pos.costUsd;
        const pnlPct = pnl === null ? null : inBrl ? (pnl / pos.costBrl) * 100 : (pos.costUsd ? (pnl / pos.costUsd) * 100 : null);
        const pnlText = S.settings.privacy ? '•••••' : inBrl ? fmt.signedMoney(pnl, 'BRL') : App.signedMoney(pnl);
        const vsAvg = price && pos.avgUsd ? ((price - pos.avgUsd) / pos.avgUsd) * 100 : null;
        el.innerHTML = html`
            <dl class="kv">
                <dt>Quantidade</dt><dd>${S.settings.privacy ? '•••' : fmt.qty(pos.qty)} ${symbol}</dd>
                <dt>Valor atual</dt><dd>${App.money(value, { priv: true })}</dd>
                <dt>Preço médio</dt><dd>${fmt.money(pos.avgUsd)}</dd>
                <dt>Resultado</dt><dd class="delta-${toneOf(pnl)}">${pnlText} <small>${fmt.pct(pnlPct)}</small></dd>
            </dl>
            <p class="muted small">Preço atual ${fmt.pct(vsAvg)} em relação ao seu preço médio.</p>
            <a class="btn" href="#/carteira/novo/${symbol}">Registrar aporte</a>`;
    }

    async function renderSignal() {
        const el = $('#signalPanel', root);
        try {
            const rows = await App.api.klines(symbol, '1d', 1000);
            if (!root) return;
            const a = App.ind.analyze(rows);
            if (!a) {
                el.innerHTML = '<p class="muted">Histórico curto demais para formar uma leitura (mínimo de 60 dias).</p>';
                return;
            }
            const t = a.thresholds;
            el.innerHTML = html`
                <div class="signal-head signal-${a.tone}">
                    <span class="signal-badge">${a.tone === 'up' ? 'Favorável' : a.tone === 'down' ? 'Cautela' : 'Neutro'}</span>
                    <h2>${a.action}</h2>
                    <p>${a.summary}</p>
                </div>
                <dl class="signal-facts">
                    <div><dt>Tendência</dt><dd>${a.trend}</dd></div>
                    <div><dt>Confiança</dt><dd>${a.confidence}</dd></div>
                    <div><dt>Suporte</dt><dd>${fmt.money(a.support)}</dd></div>
                    <div><dt>Resistência</dt><dd>${fmt.money(a.resistance)}</dd></div>
                </dl>
                <ul class="reasons">${raw(a.reasons.map((r) => html`<li><strong>${r.title}</strong> ${r.text}</li>`).join(''))}</ul>
                <details class="method">
                    <summary>Como essa leitura é formada</summary>
                    <p>Usa o gráfico diário. Desconto quando o preço está ${fmt.pct(t.discount, 1)} ou mais abaixo da ${a.longLabel} com RSI até 50, ou encostado no suporte com RSI até 55. Esticado quando está ${fmt.pct(t.stretched, 1)} acima com RSI acima de 68, ou perto da resistência com RSI acima de 60.</p>
                    <p>A volatilidade diária de ${symbol} é ${fmt.number(a.volatility, 2)}%, ${a.factor > 1.05 ? `${fmt.number(a.factor, 2)}× a referência do Bitcoin, então as faixas foram alargadas na mesma proporção` : 'parecida com a do Bitcoin, então as faixas padrão valem'}.</p>
                    <p class="muted">Leitura técnica automática, não é recomendação de investimento.</p>
                </details>`;
        } catch (error) {
            if (root) el.innerHTML = '<p class="muted">Não foi possível calcular o sinal agora.</p>';
        }
    }

    function renderListPop() {
        const inLists = store.listsOf(symbol);
        $('#listPop', root).innerHTML = html`<p class="pop-title">Listas de ${symbol}</p>
            ${raw(S.lists.map((l) => html`<label class="pop-item"><input type="checkbox" data-list="${l.id}" ${inLists.includes(l.id) ? 'checked' : ''}><i style="background:${l.color}"></i>${l.name}</label>`).join(''))}
            <button class="btn btn-small btn-ghost" type="button" data-act="new-list">Nova lista…</button>`;
    }

    function renderNote() {
        const el = $('#noteCard', root);
        if (!el) return;
        const n = S.notes[symbol];
        const price = App.priceOf(symbol);
        if (!n) {
            el.innerHTML = html`<p class="muted">Anote o preço que você quer pagar e por que está de olho em ${symbol}.</p>`;
            return;
        }
        const gap = n.buyPrice && price ? ((n.buyPrice - price) / price) * 100 : null;
        el.innerHTML = html`
            ${raw(n.buyPrice ? html`<p class="note-target"><span class="muted">Quero pagar</span> <strong>${fmt.money(n.buyPrice)}</strong> ${raw(gap === null ? '' : gap >= 0 ? '<span class="chip chip-up">No alvo</span>' : html`<span class="muted">precisa cair ${fmt.pct(-gap, 1).replace('+', '')}</span>`)}</p>` : '')}
            ${raw(n.note ? html`<p class="note-text">${n.note}</p>` : '')}`;
    }

    function renderAlerts() {
        const list = S.alerts.filter((a) => a.asset === symbol);
        const el = $('#assetAlerts', root);
        el.innerHTML = list.length
            ? list.map((a) => html`<li class="${a.triggeredAt ? 'is-done' : ''}"><span>${a.condition === 'above' ? 'Acima de' : 'Abaixo de'} <strong>${fmt.money(a.price)}</strong>${a.triggeredAt ? ' · disparado' : ''}</span><button class="icon-btn" data-alert="${a.id}" type="button" aria-label="Apagar alerta">✕</button></li>`).join('')
            : '<li class="muted">Nenhum alerta para esta cripto.</li>';
    }

    function wire() {
        $('#tfSwitch', root).addEventListener('click', (event) => {
            const btn = event.target.closest('button[data-tf]');
            if (!btn) return;
            S.settings.timeframe = btn.dataset.tf;
            store.commit('settings');
            $$('#tfSwitch button', root).forEach((b) => b.setAttribute('aria-pressed', b === btn));
            loadChart();
        });
        $('#indSwitch', root).addEventListener('click', (event) => {
            const btn = event.target.closest('button[data-ind]');
            if (!btn) return;
            const key = btn.dataset.ind;
            S.settings.indicators[key] = !S.settings.indicators[key];
            btn.setAttribute('aria-pressed', S.settings.indicators[key]);
            store.save();
            fillCharts();
        });
        $('#watchToggle', root).addEventListener('click', (event) => {
            event.stopPropagation();
            const pop = $('#listPop', root);
            if (!pop.hidden) { pop.hidden = true; return; }
            renderListPop();
            pop.hidden = false;
            $('input', pop)?.focus();
        });
        $('#listPop', root).addEventListener('change', (event) => {
            const box = event.target.closest('input[data-list]');
            if (!box) return;
            if (box.checked) store.addToList(box.dataset.list, symbol);
            else store.removeFromList(box.dataset.list, symbol);
            renderHero();
        });
        $('#listPop', root).addEventListener('click', (event) => {
            event.stopPropagation();
            if (event.target.closest('[data-act="new-list"]')) {
                $('#listPop', root).hidden = true;
                App.openListDialog(null, (id) => { store.addToList(id, symbol); renderHero(); });
            }
        });
        const closePop = () => { const pop = root && $('#listPop', root); if (pop) pop.hidden = true; };
        document.addEventListener('click', closePop);
        offs.push(() => document.removeEventListener('click', closePop));
        $('#noteEdit', root).addEventListener('click', () => App.openNote(symbol));
        $('#alertForm', root).addEventListener('submit', (event) => {
            event.preventDefault();
            const price = Number($('#alertPrice', root).value.replace(',', '.'));
            if (!(price > 0)) {
                toast('Informe um preço maior que zero.', 'bad');
                return;
            }
            const now = App.priceOf(symbol);
            const condition = now && price < now ? 'below' : 'above';
            store.addAlert({ asset: symbol, condition, price });
            App.askNotifications();
            $('#alertPrice', root).value = '';
            toast(`Vou avisar quando ${symbol} ${condition === 'above' ? 'passar de' : 'cair abaixo de'} ${fmt.money(price)}.`, 'info');
            renderAlerts();
        });
        $('#assetAlerts', root).addEventListener('click', (event) => {
            const btn = event.target.closest('button[data-alert]');
            if (!btn) return;
            store.removeAlert(btn.dataset.alert);
            renderAlerts();
        });
    }

    App.views.ativo = {
        title: 'Análise',
        mount(el, params) {
            root = el;
            symbol = (params[0] || S.watchlist[0] || 'BTC').toUpperCase().replace(/[^A-Z0-9]/g, '');
            this.title = symbol;
            document.title = `${symbol} · Painel Cripto`;
            App.extraSymbols = [symbol];
            App.refreshPrices();
            const m = App.coins.meta(symbol);
            el.style.setProperty('--coin', m.color);
            el.innerHTML = html`
                <header class="asset-hero">
                    <div class="asset-id">
                        ${raw(App.coins.avatar(symbol, 52))}
                        <div>
                            <h1>${m.name}</h1>
                            <p class="muted">${symbol} / USDT</p>
                        </div>
                    </div>
                    <div class="asset-price">
                        <p id="heroPrice" class="price-xl">—</p>
                        <p id="heroPriceAlt" class="muted"></p>
                        <p id="heroChange"></p>
                    </div>
                    <div class="asset-actions">
                        <div class="pop-wrap">
                            <button id="watchToggle" class="btn" type="button" aria-pressed="false" aria-haspopup="true">Adicionar a uma lista</button>
                            <div id="listPop" class="popover" hidden></div>
                        </div>
                        <a class="btn btn-primary" href="#/carteira/novo/${symbol}">Registrar aporte</a>
                    </div>
                    <p id="heroRange" class="asset-range"></p>
                </header>

                <div class="asset-grid">
                    <section class="panel chart-panel">
                        <div class="chart-bar">
                            <div id="tfSwitch" class="seg" role="group" aria-label="Período de cada candle">
                                ${raw(Object.entries(TF).map(([k, v]) => html`<button type="button" data-tf="${k}" aria-pressed="${S.settings.timeframe === k}">${v.label}</button>`).join(''))}
                            </div>
                            <div id="indSwitch" class="seg seg-soft" role="group" aria-label="Indicadores no gráfico">
                                <button type="button" data-ind="sma" aria-pressed="${S.settings.indicators.sma}">Médias</button>
                                <button type="button" data-ind="bb" aria-pressed="${S.settings.indicators.bb}">Bollinger</button>
                                <button type="button" data-ind="volume" aria-pressed="${S.settings.indicators.volume}">Volume</button>
                            </div>
                        </div>
                        <div class="chart-legend">
                            <span><i style="background:var(--sma20)"></i>SMA 20</span>
                            <span><i style="background:var(--sma50)"></i>SMA 50</span>
                            <span><i style="background:var(--coin)"></i>SMA 200</span>
                        </div>
                        <div class="chart-box">
                            <div id="chartMain" class="chart-main"></div>
                            <div id="chartTip" class="chart-tip" hidden></div>
                            <p id="chartState" class="chart-state">Carregando gráfico…</p>
                        </div>
                        <div class="sub-chart">
                            <div class="sub-head"><span>RSI 14</span><span id="rsiReadout"></span></div>
                            <div id="chartRsi" class="chart-sub"></div>
                        </div>
                        <div class="sub-chart">
                            <div class="sub-head"><span>MACD 12 26 9</span><span id="macdReadout"></span></div>
                            <div id="chartMacd" class="chart-sub"></div>
                        </div>
                    </section>

                    <aside class="asset-side">
                        <section class="panel" id="signalPanel"><p class="muted">Calculando sinal…</p></section>
                        <section class="panel">
                            <h2 class="panel-title">Sua posição</h2>
                            <div id="positionCard"></div>
                        </section>
                        <section class="panel">
                            <div class="panel-bar"><h2 class="panel-title">Anotações</h2><button id="noteEdit" class="btn btn-small" type="button">Editar</button></div>
                            <div id="noteCard"></div>
                        </section>
                        <section class="panel">
                            <h2 class="panel-title">Alertas de preço</h2>
                            <form id="alertForm" class="inline-form">
                                <label class="sr-only" for="alertPrice">Preço do alerta em US$</label>
                                <input id="alertPrice" class="input" inputmode="decimal" placeholder="Preço em US$" autocomplete="off">
                                <button class="btn" type="submit">Criar alerta</button>
                            </form>
                            <ul id="assetAlerts" class="alert-list"></ul>
                        </section>
                    </aside>
                </div>`;
            klineStream = App.api.createStream(`kline-${symbol}`);
            klineStream.onMessage(onKline);
            wire();
            renderHero();
            renderAlerts();
            renderNote();
            loadChart();
            renderSignal();
            offs.push(
                bus.on('prices', () => { renderHero(); renderNote(); }),
                bus.on('notes', renderNote),
                bus.on('lists', renderHero),
                bus.on('settings', renderHero),
                bus.on('transactions', renderPosition),
                bus.on('alerts', renderAlerts),
                bus.on('theme', () => { buildCharts(); fillCharts(); }),
            );
        },
        unmount() {
            offs.forEach((off) => off());
            offs = [];
            klineStream?.set([]);
            klineStream = null;
            destroyCharts();
            App.extraSymbols = [];
            document.documentElement.style.removeProperty('--accent');
            root = null;
            data = [];
        },
    };
})(window.App);
