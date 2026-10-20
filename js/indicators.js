// Indicadores técnicos e a leitura de aporte (mesma lógica para qualquer cripto).
window.App = window.App || {};

(function (App) {
    function sma(data, period, key = 'close') {
        const out = [];
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
            sum += data[i][key];
            if (i >= period) sum -= data[i - period][key];
            if (i >= period - 1) out.push({ time: data[i].time, value: sum / period });
        }
        return out;
    }

    function emaValues(values, period) {
        const k = 2 / (period + 1);
        const out = new Array(values.length).fill(null);
        if (values.length < period) return out;
        let seed = 0;
        for (let i = 0; i < period; i += 1) seed += values[i];
        let e = seed / period;
        out[period - 1] = e;
        for (let i = period; i < values.length; i += 1) {
            e = (values[i] - e) * k + e;
            out[i] = e;
        }
        return out;
    }

    function rsi(data, period = 14) {
        if (data.length <= period) return [];
        const out = [];
        let gain = 0;
        let loss = 0;
        for (let i = 1; i <= period; i += 1) {
            const d = data[i].close - data[i - 1].close;
            if (d > 0) gain += d; else loss -= d;
        }
        let ag = gain / period;
        let al = loss / period;
        const val = () => (al === 0 ? 100 : 100 - 100 / (1 + ag / al));
        out.push({ time: data[period].time, value: val() });
        for (let i = period + 1; i < data.length; i += 1) {
            const d = data[i].close - data[i - 1].close;
            ag = (ag * (period - 1) + Math.max(d, 0)) / period;
            al = (al * (period - 1) + Math.max(-d, 0)) / period;
            out.push({ time: data[i].time, value: val() });
        }
        return out;
    }

    function macd(data, fast = 12, slow = 26, signalPeriod = 9) {
        const closes = data.map((d) => d.close);
        const ef = emaValues(closes, fast);
        const es = emaValues(closes, slow);
        const line = closes.map((_, i) => (ef[i] !== null && es[i] !== null ? ef[i] - es[i] : null));
        const idx = [];
        const vals = [];
        line.forEach((v, i) => { if (v !== null) { idx.push(i); vals.push(v); } });
        const sig = emaValues(vals, signalPeriod);
        const macdLine = [];
        const signalLine = [];
        const histogram = [];
        idx.forEach((i, j) => {
            macdLine.push({ time: data[i].time, value: line[i] });
            if (sig[j] !== null) {
                signalLine.push({ time: data[i].time, value: sig[j] });
                histogram.push({ time: data[i].time, value: line[i] - sig[j] });
            }
        });
        return { macdLine, signalLine, histogram };
    }

    function bollinger(data, period = 20, mult = 2) {
        const upper = [];
        const lower = [];
        for (let i = period - 1; i < data.length; i += 1) {
            let sum = 0;
            for (let j = i - period + 1; j <= i; j += 1) sum += data[j].close;
            const mean = sum / period;
            let sq = 0;
            for (let j = i - period + 1; j <= i; j += 1) sq += (data[j].close - mean) ** 2;
            const sd = Math.sqrt(sq / period);
            upper.push({ time: data[i].time, value: mean + mult * sd });
            lower.push({ time: data[i].time, value: mean - mult * sd });
        }
        return { upper, lower };
    }

    function pivots(data, side = 3, lookback = 90) {
        const sample = data.slice(-lookback);
        const current = sample[sample.length - 1]?.close ?? 0;
        const highs = [];
        const lows = [];
        for (let i = side; i < sample.length - side; i += 1) {
            let isHigh = true;
            let isLow = true;
            for (let o = 1; o <= side; o += 1) {
                if (sample[i].high <= sample[i - o].high || sample[i].high <= sample[i + o].high) isHigh = false;
                if (sample[i].low >= sample[i - o].low || sample[i].low >= sample[i + o].low) isLow = false;
            }
            if (isHigh) highs.push(sample[i].high);
            if (isLow) lows.push(sample[i].low);
        }
        const support = lows.filter((v) => v < current).sort((a, b) => b - a)[0] ?? Math.min(...sample.map((d) => d.low));
        const resistance = highs.filter((v) => v > current).sort((a, b) => a - b)[0] ?? Math.max(...sample.map((d) => d.high));
        return { support, resistance };
    }

    // Volatilidade diária (desvio-padrão dos retornos) nos últimos 90 candles, em %.
    function volatility(data, lookback = 90) {
        const s = data.slice(-lookback - 1);
        const r = [];
        for (let i = 1; i < s.length; i += 1) r.push(Math.log(s[i].close / s[i - 1].close));
        if (r.length < 10) return null;
        const mean = r.reduce((a, b) => a + b, 0) / r.length;
        const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
        return Math.sqrt(variance) * 100;
    }

    const last = (arr) => arr[arr.length - 1];
    const dist = (from, to) => (from ? ((to - from) / from) * 100 : 0);

    // Referência de volatilidade diária "típica do BTC". Criptos mais voláteis
    // precisam se afastar mais da média longa para contar como desconto/esticada.
    const BASE_VOL = 2.5;
    const RULES = { discount: -8, deepDiscount: -12, stretched: 12, veryStretched: 15, rsiHot: 68, rsiCool: 50, levelBand: 2.5 };

    function analyze(data) {
        if (!data || data.length < 60) return null;
        const close = last(data).close;
        const s20 = last(sma(data, 20))?.value;
        const s50 = last(sma(data, 50))?.value;
        const s200v = data.length >= 200 ? last(sma(data, 200))?.value : null;
        const r = last(rsi(data))?.value;
        const m = macd(data);
        const macdUp = last(m.macdLine)?.value > last(m.signalLine)?.value;
        const lv = pivots(data);
        const vol = volatility(data);
        const factor = vol ? Math.min(2.5, Math.max(0.8, vol / BASE_VOL)) : 1;
        const t = {
            discount: RULES.discount * factor,
            deepDiscount: RULES.deepDiscount * factor,
            stretched: RULES.stretched * factor,
            veryStretched: RULES.veryStretched * factor,
        };
        const longRef = s200v ?? s50;
        const longLabel = s200v ? 'SMA 200' : 'SMA 50';
        const dLong = dist(longRef, close);
        const nearSupport = Math.abs(dist(close, lv.support)) <= RULES.levelBand;
        const nearResistance = Math.abs(dist(close, lv.resistance)) <= RULES.levelBand;
        const aboveShort = close > s20 && close > s50;

        const overheated = (r >= RULES.rsiHot && dLong >= t.stretched)
            || (nearResistance && r >= 60)
            || (aboveShort && dLong >= t.veryStretched && macdUp);
        const attractive = (dLong <= t.discount && r <= RULES.rsiCool)
            || (nearSupport && r <= 55)
            || (dLong <= t.deepDiscount && !macdUp);

        const pos = [dLong <= t.discount, nearSupport, r <= 55, !macdUp].filter(Boolean).length;
        const neg = [r >= RULES.rsiHot, nearResistance, dLong >= t.stretched, macdUp].filter(Boolean).length;
        const confidence = (n) => (n >= 3 ? 'Alta' : n >= 2 ? 'Moderada' : 'Baixa');

        let action = 'Aporte normal';
        let tone = 'flat';
        let summary = 'Cenário intermediário. Siga o plano sem aumentar o valor.';
        let conf = confidence(Math.max(pos, neg));
        if (overheated) {
            action = 'Esperar recuo';
            tone = 'down';
            summary = 'Preço esticado. Melhor manter disciplina e evitar reforçar agora.';
            conf = confidence(neg);
        } else if (attractive) {
            action = 'Aportar reforçado';
            tone = 'up';
            summary = 'Há desconto relativo ou suporte por perto. Momento favorável para acumular.';
            conf = confidence(pos);
        }

        let trend = 'Transição';
        if (s200v) {
            if (close > s20 && s20 > s50 && s50 > s200v) trend = 'Alta forte';
            else if (close < s20 && s20 < s50 && s50 < s200v) trend = 'Baixa forte';
            else trend = close > s200v ? 'Alta moderada' : 'Baixa moderada';
        }

        return {
            action, tone, summary, confidence: conf, trend,
            close, rsi: r, macdUp, distLong: dLong, longLabel,
            support: lv.support, resistance: lv.resistance, nearSupport, nearResistance,
            volatility: vol, factor, thresholds: t,
            reasons: [
                { title: `Preço vs ${longLabel}`, text: `${App.util.fmt.pct(dLong)} da média longa. Desconto a partir de ${App.util.fmt.pct(t.discount, 1)}, esticado acima de ${App.util.fmt.pct(t.stretched, 1)}.` },
                { title: 'Momentum', text: `RSI ${App.util.fmt.number(r, 1)} e MACD ${macdUp ? 'acima' : 'abaixo'} da linha de sinal.` },
                { title: 'Níveis', text: nearSupport ? 'Preço encostado no suporte.' : nearResistance ? 'Preço perto da resistência.' : 'Preço entre suporte e resistência.' },
            ],
        };
    }

    // Cruzamentos da SMA 50 com a SMA 200. O marcador fica no candle em que o cruzamento se confirma.
    function crosses(data, fast = 50, slow = 200) {
        if (data.length < slow + 1) return [];
        const f = new Map(sma(data, fast).map((p) => [p.time, p.value]));
        const sl = sma(data, slow);
        const out = [];
        for (let i = 1; i < sl.length; i += 1) {
            const t0 = sl[i - 1].time;
            const t1 = sl[i].time;
            const d0 = f.get(t0) - sl[i - 1].value;
            const d1 = f.get(t1) - sl[i].value;
            if (d0 <= 0 && d1 > 0) out.push({ time: t1, type: 'golden', price: f.get(t1) });
            else if (d0 >= 0 && d1 < 0) out.push({ time: t1, type: 'death', price: f.get(t1) });
        }
        return out;
    }

    // Retrações de Fibonacci do maior movimento da amostra: da mínima à máxima
    // (alta, níveis medidos a partir do topo) ou da máxima à mínima (queda,
    // níveis medidos a partir do fundo). Movimentos menores que 15% são ignorados.
    function fibonacci(data) {
        if (data.length < 120) return null;
        let hi = 0;
        let lo = 0;
        data.forEach((d, i) => {
            if (d.high > data[hi].high) hi = i;
            if (d.low < data[lo].low) lo = i;
        });
        const high = data[hi].high;
        const low = data[lo].low;
        if ((high - low) / high < 0.15) return null;
        const up = lo < hi;
        return [0.236, 0.382, 0.5, 0.618, 0.786].map((r) => ({ ratio: r, price: up ? high - (high - low) * r : low + (high - low) * r, up }));
    }

    // Estatísticas do histórico diário: maior queda, recuperação, volatilidade e retornos mensais.
    function stats(daily) {
        if (!daily || daily.length < 30) return null;
        let peak = daily[0].close;
        let peakDay = daily[0].day;
        let maxDd = 0;
        let ddPeakDay = peakDay;
        let ddTroughDay = peakDay;
        daily.forEach((d) => {
            if (d.close > peak) { peak = d.close; peakDay = d.day; }
            const dd = (d.close - peak) / peak;
            if (dd < maxDd) { maxDd = dd; ddPeakDay = peakDay; ddTroughDay = d.day; }
        });
        const peakPrice = daily.find((d) => d.day === ddPeakDay).close;
        const recovered = daily.find((d) => d.day > ddTroughDay && d.close >= peakPrice);
        const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
        const ath = Math.max(...daily.map((d) => d.close));
        const last = daily[daily.length - 1].close;
        const rets = [];
        for (let i = 1; i < daily.length; i += 1) rets.push(Math.log(daily[i].close / daily[i - 1].close));
        const recent = rets.slice(-365);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const sd = Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / (recent.length - 1));
        const yearAgo = daily[daily.length - 366];
        const months = [];
        let prevClose = daily[0].open;
        let current = null;
        daily.forEach((d) => {
            const key = d.day.slice(0, 7);
            if (!current || current.key !== key) {
                if (current) { current.ret = (current.close / prevClose - 1) * 100; prevClose = current.close; months.push(current); }
                current = { key, close: d.close };
            } else current.close = d.close;
        });
        if (current) { current.ret = (current.close / prevClose - 1) * 100; current.partial = true; months.push(current); }
        return {
            maxDrawdown: maxDd * 100,
            ddPeakDay,
            ddTroughDay,
            recoveryDays: recovered ? dayDiff(ddTroughDay, recovered.day) : null,
            drawdownDays: dayDiff(ddPeakDay, ddTroughDay),
            fromAth: (last / ath - 1) * 100,
            annualVol: sd * Math.sqrt(365) * 100,
            yearReturn: yearAgo ? (last / yearAgo.close - 1) * 100 : null,
            firstDay: daily[0].day,
            months,
        };
    }

    App.ind = { sma, rsi, macd, bollinger, pivots, volatility, analyze, crosses, fibonacci, stats, RULES, BASE_VOL };
})(window.App);
