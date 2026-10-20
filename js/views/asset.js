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
    let crossList = [];
    let pickerList = null;
    let quote = 'USDT';
    let synthetic = false;
    let priceLines = [];
    let buyMap = new Map();
    let resetRange = true;

    // Formata preço conforme a cotação do gráfico (dólar ou BTC).
    function px(value) {
        if (!Number.isFinite(value)) return '—';
        if (quote === 'BTC') return `${fmt.number(value, value < 0.001 ? 8 : 6)} BTC`;
        return fmt.money(value);
    }

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

        const prec = quote === 'BTC' ? 8 : precisionFor(data);
        series.candles = charts.main.addCandlestickSeries({ upColor: c.up, downColor: c.down, borderVisible: false, wickUpColor: c.up, wickDownColor: c.down, priceFormat: { type: 'price', precision: prec, minMove: 10 ** -prec } });
        priceLines = [];
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
        crossList = App.ind.crosses(data);
        buyMap = quote === 'USDT' ? groupTransactions() : new Map();
        const markers = [];
        if (ind.cross) {
            crossList.forEach((x) => markers.push(x.type === 'golden'
                ? { time: x.time, position: 'belowBar', color: App.charts.css('--gold'), shape: 'arrowUp', text: 'Golden cross' }
                : { time: x.time, position: 'aboveBar', color: App.charts.css('--death'), shape: 'arrowDown', text: 'Death cross' }));
        }
        if (ind.buys) {
            buyMap.forEach((txs, time) => {
                const buys = txs.filter((t) => t.type === 'buy').length;
                const sells = txs.length - buys;
                if (buys) markers.push({ time, position: 'belowBar', color: App.charts.css('--brand'), shape: 'circle', size: 0.8 });
                if (sells) markers.push({ time, position: 'aboveBar', color: App.charts.css('--down'), shape: 'square', size: 0.8 });
            });
        }
        markers.sort((a, b) => a.time - b.time);
        series.candles.setMarkers(markers);
        drawPriceLines();
        const bb = ind.bb ? App.ind.bollinger(data) : { upper: [], lower: [] };
        series.bbUp.setData(bb.upper);
        series.bbLow.setData(bb.lower);
        series.rsi.setData(App.ind.rsi(data));
        const m = App.ind.macd(data);
        series.macd.setData(m.macdLine);
        series.signal.setData(m.signalLine);
        series.hist.setData(m.histogram.map((h) => ({ ...h, color: h.value >= 0 ? hexA(c.up, 0.5) : hexA(c.down, 0.5) })));
        if (resetRange) {
            const visible = Math.min(data.length, S.settings.timeframe === '1w' ? 160 : 180);
            const range = { from: data.length - visible, to: data.length + 3 };
            Object.values(charts).forEach((chart) => chart.timeScale().setVisibleLogicalRange(range));
            resetRange = false;
        }
        renderIndicatorReadout();
    }

    // Agrupa as operações da carteira pelo candle em que caíram.
    function groupTransactions() {
        const map = new Map();
        if (!data.length) return map;
        const times = data.map((d) => d.time);
        S.transactions.filter((t) => t.asset === symbol).forEach((t) => {
            const [y, m, d] = t.date.split('-').map(Number);
            const ts = Date.UTC(y, m - 1, d) / 1000;
            if (ts < times[0] - 7 * 86400) return;
            let lo = 0;
            let hi = times.length - 1;
            while (lo < hi) {
                const mid = Math.ceil((lo + hi) / 2);
                if (times[mid] <= ts) lo = mid; else hi = mid - 1;
            }
            const key = times[lo];
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(t);
        });
        return map;
    }

    function drawPriceLines() {
        priceLines.forEach((l) => { try { series.candles.removePriceLine(l); } catch { /* já removida */ } });
        priceLines = [];
        const ind = S.settings.indicators;
        const add = (price, color, title, style = 2, width = 1) => {
            if (!Number.isFinite(price) || price <= 0) return;
            priceLines.push(series.candles.createPriceLine({ price, color, title, lineStyle: style, lineWidth: width, axisLabelVisible: true }));
        };
        if (ind.levels) {
            const lv = App.ind.pivots(data);
            add(lv.support, App.charts.css('--up'), 'Suporte');
            add(lv.resistance, App.charts.css('--down'), 'Resistência');
            if (quote === 'USDT') add(S.notes[symbol]?.buyPrice, App.charts.css('--gold'), 'Meu preço', 0, 2);
        }
        if (ind.buys && quote === 'USDT') {
            const pos = store.positions().find((p) => p.asset === symbol && p.qty > 0);
            if (pos) add(pos.avgUsd, App.charts.css('--brand'), 'Preço médio', 0, 2);
        }
        if (ind.fib) {
            const sample = S.settings.timeframe === '1w' ? data.slice(-260) : data;
            (App.ind.fibonacci(sample) ?? []).forEach((f) => add(f.price, App.charts.css('--ink-3'), `Fib ${String(f.ratio).replace('.', ',')}`, 1));
        }
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
                <dt>Abertura</dt><dd>${px(d.open)}</dd>
                <dt>Máxima</dt><dd>${px(d.high)}</dd>
                <dt>Mínima</dt><dd>${px(d.low)}</dd>
                <dt>Fechamento</dt><dd>${px(d.close)}</dd>
                <dt>Variação</dt><dd class="delta-${toneOf(change)}">${fmt.pct(change)}</dd>
                <dt>Volume</dt><dd>${fmt.compactMoney(d.quoteVolume)}</dd>
            </dl>${raw((() => { const x = crossList.find((c) => c.time === d.time); return x ? html`<p class="tip-cross tip-${x.type}">${x.type === 'golden' ? 'Golden cross: SMA 50 cruzou acima da SMA 200' : 'Death cross: SMA 50 cruzou abaixo da SMA 200'}</p>` : ''; })())}${raw((() => {
                const txs = S.settings.indicators.buys ? buyMap.get(d.time) : null;
                if (!txs?.length) return '';
                return html`<p class="tip-buys">${raw(txs.map((t) => html`<span>${t.type === 'buy' ? 'Você comprou' : 'Você vendeu'} ${S.settings.privacy ? '•••' : fmt.qty(t.qty)} a ${fmt.money(t.priceUsd)}</span>`).join(''))}</p>`;
            })())}`;
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
            let rows;
            if (quote === 'BTC') {
                const res = await App.api.klinesInBtc(symbol, tf, TF[tf].limit);
                rows = res.rows;
                synthetic = res.synthetic;
            } else {
                rows = await App.api.klines(symbol, tf, TF[tf].limit);
                synthetic = false;
            }
            if (token !== loadToken || !root) return;
            data = rows.map((r) => ({ ...r }));
            $('#chartState', root).hidden = true;
            resetRange = true;
            buildCharts();
            fillCharts();
            renderQuoteNote();
            klineStream.set(quote === 'BTC' && synthetic ? [] : [`${symbol.toLowerCase()}${quote.toLowerCase()}@kline_${tf}`]);
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
        if (k.i !== S.settings.timeframe || k.s !== `${symbol}${quote}`) return;
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
            const [rows, rows4h, rows1w] = await Promise.all([
                App.api.klines(symbol, '1d', 1000),
                App.api.klines(symbol, '4h', 1000).catch(() => []),
                App.api.klines(symbol, '1w', 520).catch(() => []),
            ]);
            if (!root) return;
            const a = App.ind.analyze(rows);
            const multi = [['4H', App.ind.analyze(rows4h)], ['1D', a], ['1S', App.ind.analyze(rows1w)]];
            const valid = multi.filter(([, x]) => x);
            const tones = new Set(valid.map(([, x]) => x.tone));
            const agree = valid.length === 3 && tones.size === 1;
            const multiHtml = html`<div class="mtf">
                <p class="mtf-title">Em cada tempo gráfico</p>
                <div class="mtf-row">${raw(multi.map(([label, x]) => html`<span class="mtf-item mtf-${x?.tone ?? 'none'}"><b>${label}</b>${x ? x.action : 'sem dados'}</span>`).join(''))}</div>
                <p class="mtf-note">${agree ? 'Os três tempos concordam: leitura mais forte.' : valid.length < 3 ? 'Histórico curto em algum tempo gráfico.' : 'Os tempos divergem: trate o sinal com mais cautela.'}</p>
            </div>`;
            if (!a) {
                el.innerHTML = '<p class="muted">Histórico curto demais para formar uma leitura (mínimo de 60 dias).</p>';
                return;
            }
            const t = a.thresholds;
            const dailyCrosses = App.ind.crosses(rows);
            const lastCross = dailyCrosses[dailyCrosses.length - 1];
            const s50 = App.ind.sma(rows, 50).at(-1)?.value;
            const s200 = rows.length >= 200 ? App.ind.sma(rows, 200).at(-1)?.value : null;
            const spread = s50 && s200 ? ((s50 - s200) / s200) * 100 : null;
            const crossHtml = lastCross
                ? html`<div class="cross-note cross-${lastCross.type}">
                    <strong>${lastCross.type === 'golden' ? 'Golden cross' : 'Death cross'}</strong> no diário em ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(lastCross.time * 1000))}, há ${Math.max(0, Math.round((Date.now() / 1000 - lastCross.time) / 86400))} dias.
                    ${spread === null ? '' : `A SMA 50 está ${fmt.number(Math.abs(spread), 1)}% ${spread >= 0 ? 'acima' : 'abaixo'} da SMA 200.`}
                </div>`
                : (s200 ? html`<div class="cross-note">Sem cruzamento da SMA 50 com a SMA 200 no histórico disponível.</div>` : '');
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
                ${raw(multiHtml)}
                ${raw(crossHtml)}
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

    function renderQuoteNote() {
        const el = $('#quoteNote', root);
        if (!el) return;
        el.hidden = quote !== 'BTC';
        el.textContent = synthetic
            ? `Não existe o par ${symbol}/BTC na Binance; o gráfico divide ${symbol}/USDT por BTC/USDT (máximas e mínimas aproximadas, sem atualização ao vivo).`
            : `Preço de ${symbol} em BTC. Subindo aqui, ${symbol} está ganhando do Bitcoin.`;
    }

    // ---------- Calculadora de aporte ----------
    function renderCalc() {
        const el = $('#calcOut', root);
        if (!el) return;
        const amount = App.parseNum($('#calcAmount', root).value);
        const price = App.priceOf(symbol);
        const fx = App.live.fx;
        if (!(amount > 0) || !price || !fx) {
            el.innerHTML = html`<p class="muted small">${!(amount > 0) ? 'Digite um valor em reais.' : 'Aguardando cotação…'}</p>`;
            $('#calcBuy', root).disabled = true;
            return;
        }
        const usd = amount / fx;
        const qty = usd / price;
        const positions = store.positions().filter((p) => p.qty > 0);
        const pos = positions.find((p) => p.asset === symbol);
        const newQty = (pos?.qty ?? 0) + qty;
        const newCost = (pos?.costUsd ?? 0) + usd;
        const newAvg = newCost / newQty;
        const totalNow = positions.reduce((a, p) => a + p.qty * (App.priceOf(p.asset) ?? 0), 0);
        const weightNow = totalNow ? ((pos?.qty ?? 0) * price / totalNow) * 100 : 0;
        const weightAfter = ((newQty * price) / (totalNow + usd)) * 100;
        const avgChange = pos?.avgUsd ? ((newAvg - pos.avgUsd) / pos.avgUsd) * 100 : null;
        el.innerHTML = html`<dl class="kv">
            <dt>Você compra</dt><dd>${fmt.qty(qty)} ${symbol}</dd>
            <dt>Em dólar</dt><dd>${fmt.money(usd, 'USD', 2)}</dd>
            <dt>Preço médio</dt><dd>${fmt.money(newAvg)}${raw(avgChange === null ? '' : html` <small class="delta-${toneOf(-avgChange)}">${fmt.pct(avgChange, 1)}</small>`)}</dd>
            <dt>Peso na carteira</dt><dd>${fmt.number(weightNow, 1)}% → ${fmt.number(weightAfter, 1)}%</dd>
        </dl>`;
        $('#calcBuy', root).disabled = false;
    }

    function registerCalc() {
        const amount = App.parseNum($('#calcAmount', root).value);
        const price = App.priceOf(symbol);
        const fx = App.live.fx;
        if (!(amount > 0) || !price || !fx) return;
        const usd = amount / fx;
        if (!window.confirm(`Registrar compra de ${fmt.qty(usd / price)} ${symbol} por ${fmt.money(amount, 'BRL', 2)} hoje, a ${fmt.money(price)}?\n\nDepois você pode editar na Carteira para colocar o preço exato da corretora.`)) return;
        store.upsertTx({ asset: symbol, type: 'buy', date: App.util.localIso(), qty: usd / price, priceUsd: price, totalUsd: usd, totalBrl: amount, fxRate: fx, note: 'Calculadora da Análise' });
        toast(`Compra de ${symbol} registrada.`, 'up');
    }

    // ---------- Estatísticas ----------
    const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

    async function renderStats() {
        const el = $('#statsBody', root);
        try {
            const [daily, btcDaily] = await Promise.all([
                App.api.dailyHistory(symbol, '2017-08-17'),
                symbol === 'BTC' ? Promise.resolve(null) : App.api.dailyHistory('BTC', '2017-08-17').catch(() => null),
            ]);
            if (!root) return;
            const st = App.ind.stats(daily);
            if (!st) { el.innerHTML = '<p class="muted">Histórico curto demais para estatísticas.</p>'; return; }
            const btc = btcDaily ? App.ind.stats(btcDaily) : null;
            const dfmt = (iso) => fmt.date(iso);
            const years = [...new Set(st.months.map((m) => m.key.slice(0, 4)))];
            const byKey = new Map(st.months.map((m) => [m.key, m]));
            const avg = MONTHS.map((_, i) => {
                const vals = st.months.filter((m) => Number(m.key.slice(5, 7)) === i + 1 && !m.partial).map((m) => m.ret);
                return vals.length ? { v: vals.reduce((a, b) => a + b, 0) / vals.length, up: vals.filter((v) => v > 0).length, n: vals.length } : null;
            });
            const cell = (v, extra = '') => {
                if (v === null || v === undefined) return '<td class="hm-empty"></td>';
                const strength = Math.min(1, Math.abs(v) / 40);
                const mix = Math.round(10 + strength * 60);
                return html`<td class="hm" style="background:color-mix(in srgb, var(${v >= 0 ? '--up' : '--down'}) ${mix}%, transparent)" ${raw(extra)}>${fmt.number(Math.abs(v) < 0.5 ? 0 : v, 0)}%</td>`;
            };
            el.innerHTML = html`
                <dl class="stat-kpis">
                    <div><dt>Últimos 12 meses</dt><dd class="delta-${toneOf(st.yearReturn)}">${st.yearReturn === null ? '—' : fmt.pct(st.yearReturn, 1)}</dd></div>
                    <div><dt>Abaixo da máxima</dt><dd class="delta-${toneOf(st.fromAth)}">${fmt.pct(st.fromAth, 1)}</dd></div>
                    <div><dt>Maior queda</dt><dd class="delta-down">${fmt.pct(st.maxDrawdown, 1)}</dd><small class="muted">${dfmt(st.ddPeakDay)} a ${dfmt(st.ddTroughDay)} (${st.drawdownDays} dias)</small></div>
                    <div><dt>Recuperação dessa queda</dt><dd>${st.recoveryDays === null ? 'Ainda não voltou ao topo' : `${st.recoveryDays} dias`}</dd></div>
                    <div><dt>Volatilidade anual</dt><dd>${fmt.number(st.annualVol, 0)}%</dd>${raw(btc ? html`<small class="muted">${fmt.number(st.annualVol / btc.annualVol, 1)}× a do Bitcoin</small>` : '')}</div>
                </dl>
                <div class="table-wrap">
                    <table class="hm-table">
                        <thead><tr><th>Ano</th>${raw(MONTHS.map((m) => `<th>${m}</th>`).join(''))}<th>Ano</th></tr></thead>
                        <tbody>
                            ${raw(years.slice().reverse().map((y) => {
                                const ms = MONTHS.map((_, i) => byKey.get(`${y}-${String(i + 1).padStart(2, '0')}`));
                                const present = ms.filter(Boolean);
                                const yearRet = present.length ? (present.reduce((a, m) => a * (1 + m.ret / 100), 1) - 1) * 100 : null;
                                return `<tr><th>${y}</th>${ms.map((m) => cell(m?.ret, m?.partial ? 'title="Mês em andamento"' : '')).join('')}${cell(yearRet, 'class="hm hm-year"')}</tr>`;
                            }).join(''))}
                        </tbody>
                        <tfoot><tr><th>Média</th>${raw(avg.map((a) => (a ? cell(a.v, `title="Subiu em ${a.up} de ${a.n} anos"`) : '<td class="hm-empty"></td>')).join(''))}<td></td></tr></tfoot>
                    </table>
                </div>
                <p class="footnote">Fechamentos diários na Binance desde ${dfmt(st.firstDay)}. Retorno mensal do último fechamento de um mês ao do seguinte; a linha “Média” ignora o mês em andamento. Passado não garante resultado futuro.</p>`;
        } catch (error) {
            console.error(error);
            if (root) el.innerHTML = '<p class="muted">Não consegui carregar o histórico agora.</p>';
        }
    }

    // ---------- Seletor por lista ----------
    function choosePickerList() {
        const pref = S.settings.analysisList;
        const valid = (id) => id && S.tabs.includes(id);
        if (valid(pref) && App.lists.symbols(pref).includes(symbol)) return pref;
        const containing = S.tabs.find((id) => App.lists.symbols(id).includes(symbol));
        if (containing) return containing;
        return valid(pref) ? pref : S.favoriteTab;
    }

    function renderPicker() {
        const el = $('#picker', root);
        if (!el) return;
        const ids = S.tabs;
        const syms = App.lists.symbols(pickerList);
        const i = syms.indexOf(symbol);
        $('#pickerList', root).innerHTML = ids.map((id) => html`<option value="${id}" ${id === pickerList ? 'selected' : ''}>${App.lists.name(id)} (${App.lists.symbols(id).length})</option>`).join('');
        $('#pickPrev', root).disabled = syms.length < 2 && i >= 0;
        $('#pickNext', root).disabled = syms.length < 2 && i >= 0;
        const strip = $('#pickerStrip', root);
        if (!syms.length) {
            strip.innerHTML = html`<span class="muted small">Lista vazia.</span>`;
            return;
        }
        strip.innerHTML = syms.map((s) => {
            const ch = App.live.prices[s]?.changePct;
            return html`<a class="pchip${s === symbol ? ' is-current' : ''}" href="#/ativo/${s}" style="--coin:${App.coins.meta(s).color}" ${raw(s === symbol ? 'aria-current="page"' : '')}>
                ${raw(App.coins.avatar(s, 20))}<strong>${s}</strong><span class="delta-${toneOf(ch)}" data-pchg="${s}">${Number.isFinite(ch) ? fmt.pct(ch, 1) : ''}</span>
            </a>`;
        }).join('');
        $('.pchip.is-current', strip)?.scrollIntoView({ block: 'nearest', inline: 'center' });
    }

    function updatePickerPrices() {
        $$('[data-pchg]', root).forEach((el) => {
            const ch = App.live.prices[el.dataset.pchg]?.changePct;
            if (!Number.isFinite(ch)) return;
            el.textContent = fmt.pct(ch, 1);
            el.className = `delta-${toneOf(ch)}`;
        });
    }

    function step(delta) {
        const syms = App.lists.symbols(pickerList);
        if (!syms.length) return;
        const i = syms.indexOf(symbol);
        const next = i < 0 ? syms[delta > 0 ? 0 : syms.length - 1] : syms[(i + delta + syms.length) % syms.length];
        if (next && next !== symbol) App.go(`#/ativo/${next}`);
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
        $('#pickerList', root).addEventListener('change', (event) => {
            pickerList = event.target.value;
            S.settings.analysisList = pickerList;
            store.save();
            renderPicker();
            if (pickerList === 'smart:discount') App.lists.ensureSignals(() => root && renderPicker());
        });
        $('#quoteSwitch', root)?.addEventListener('click', (event) => {
            const b = event.target.closest('[data-quote]');
            if (!b || b.dataset.quote === quote) return;
            quote = b.dataset.quote;
            $$('#quoteSwitch button', root).forEach((x) => x.setAttribute('aria-pressed', x === b));
            loadChart();
        });
        $('#calcAmount', root).addEventListener('input', renderCalc);
        $('#calcBuy', root).addEventListener('click', registerCalc);
        $('#pickPrev', root).addEventListener('click', () => step(-1));
        $('#pickNext', root).addEventListener('click', () => step(1));
        const onKey = (event) => {
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]')) return;
            if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
            if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
        };
        document.addEventListener('keydown', onKey);
        offs.push(() => document.removeEventListener('keydown', onKey));
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
            pickerList = choosePickerList();
            quote = 'USDT';
            resetRange = true;
            el.innerHTML = html`
                <nav id="picker" class="picker" aria-label="Escolher cripto pela lista">
                    <label class="sr-only" for="pickerList">Lista</label>
                    <select id="pickerList" class="input input-small"></select>
                    <button id="pickPrev" class="icon-btn icon-btn-lg" type="button" aria-label="Cripto anterior da lista" title="Anterior (←)">‹</button>
                    <div id="pickerStrip" class="picker-strip"></div>
                    <button id="pickNext" class="icon-btn icon-btn-lg" type="button" aria-label="Próxima cripto da lista" title="Próxima (→)">›</button>
                </nav>
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
                            ${raw(symbol === 'BTC' ? '' : html`<div id="quoteSwitch" class="seg" role="group" aria-label="Cotação do gráfico">
                                <button type="button" data-quote="USDT" aria-pressed="true">Em US$</button>
                                <button type="button" data-quote="BTC" aria-pressed="false">Em BTC</button>
                            </div>`)}
                            <div id="indSwitch" class="seg seg-soft seg-wrap" role="group" aria-label="Camadas no gráfico">
                                <button type="button" data-ind="sma" aria-pressed="${S.settings.indicators.sma}">Médias</button>
                                <button type="button" data-ind="bb" aria-pressed="${S.settings.indicators.bb}">Bollinger</button>
                                <button type="button" data-ind="volume" aria-pressed="${S.settings.indicators.volume}">Volume</button>
                                <button type="button" data-ind="cross" aria-pressed="${S.settings.indicators.cross !== false}" title="Golden cross e death cross (SMA 50 × SMA 200)">Cruzamentos</button>
                                <button type="button" data-ind="buys" aria-pressed="${S.settings.indicators.buys !== false}" title="Suas compras e vendas e o seu preço médio">Minhas compras</button>
                                <button type="button" data-ind="levels" aria-pressed="${S.settings.indicators.levels !== false}" title="Suporte, resistência e o preço que você quer pagar">Níveis</button>
                                <button type="button" data-ind="fib" aria-pressed="${!!S.settings.indicators.fib}" title="Retrações de Fibonacci do último grande movimento">Fibonacci</button>
                            </div>
                        </div>
                        <div class="chart-legend">
                            <span><i style="background:var(--sma20)"></i>SMA 20</span>
                            <span><i style="background:var(--sma50)"></i>SMA 50</span>
                            <span><i style="background:var(--coin)"></i>SMA 200</span>
                            <span><b class="mk mk-gold">▲</b>Golden cross</span>
                            <span><b class="mk mk-death">▼</b>Death cross</span>
                            <span><b class="mk mk-buy">●</b>Compra</span>
                            <span><i style="background:var(--brand)"></i>Preço médio</span>
                            <span><i style="background:var(--gold)"></i>Meu preço</span>
                        </div>
                        <p id="quoteNote" class="quote-note" hidden></p>
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
                            <h2 class="panel-title">Simular aporte</h2>
                            <label class="calc-input"><span>Valor em R$</span><input id="calcAmount" class="input" inputmode="decimal" autocomplete="off" value="${S.plan.budgetBrl || 500}"></label>
                            <div id="calcOut"></div>
                            <button id="calcBuy" class="btn btn-primary calc-btn" type="button">Registrar esta compra</button>
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
                </div>
                <section class="panel">
                    <div class="panel-bar"><h2 class="panel-title">Histórico e sazonalidade</h2><span class="muted small">Retorno de cada mês</span></div>
                    <div id="statsBody"><p class="muted">Carregando histórico…</p></div>
                </section>`;
            klineStream = App.api.createStream(`kline-${symbol}`);
            klineStream.onMessage(onKline);
            wire();
            renderHero();
            renderAlerts();
            renderNote();
            renderCalc();
            renderStats();
            renderPicker();
            if (pickerList === 'smart:discount') App.lists.ensureSignals(() => root && renderPicker());
            loadChart();
            renderSignal();
            offs.push(
                bus.on('prices', () => { renderHero(); renderNote(); updatePickerPrices(); renderCalc(); }),
                bus.on('transactions', () => { fillCharts(); renderCalc(); }),
                bus.on('notes', () => fillCharts()),
                bus.on('notes', renderNote),
                bus.on('lists', () => { renderHero(); renderPicker(); }),
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
