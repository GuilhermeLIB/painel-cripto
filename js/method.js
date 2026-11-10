// Método simples de pool: avalia automaticamente as regras combinadas
// (semáforo da faixa, tempo em cada cor, ação do dia e sugestão de remontagem).
// Funções puras: recebem os números e devolvem o diagnóstico.
window.App = window.App || {};

(function (App) {
    const HOUR = 3600 * 1000;
    const DAY = 24 * HOUR;
    const BIG = new Set(['ETH', 'WETH', 'BTC', 'WBTC', 'CBBTC', 'BTCB', 'TBTC', 'SOL', 'WSOL', 'BNB', 'WBNB', 'USDC', 'USDT', 'DAI', 'USDC.E', 'USDBC', 'USDS', 'USDE', 'FDUSD', 'USDG', 'STETH', 'WSTETH', 'WEETH', 'CBETH', 'RETH', 'JITOSOL', 'MSOL']);
    const CHEAP = new Set(['base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'zksync', 'solana']);

    const posOf = (price, lower, upper) => (Math.log(price) - Math.log(lower)) / (Math.log(upper) - Math.log(lower));
    const zoneOf = (pos) => (pos < 0 || pos > 1 ? 'red' : pos < 0.2 || pos > 0.8 ? 'yellow' : 'green');
    const sideOf = (pos) => (pos < 0.5 ? 'baixo' : 'cima');

    // Meia largura da faixa em escala logarítmica (±% aproximado = e^w − 1).
    const halfWidth = (lower, upper) => Math.log(upper / lower) / 2;

    // Divide um capital (em B) entre A e B para uma faixa em volta do preço.
    function split(price, lower, upper, capitalB) {
        const sp = Math.sqrt(price), sa = Math.sqrt(lower), sb = Math.sqrt(upper);
        if (sp <= sa) return { qtyA: capitalB / price, qtyB: 0 };
        if (sp >= sb) return { qtyA: 0, qtyB: capitalB };
        const x = (sb - sp) / (sp * sb), y = sp - sa;
        const L = capitalB / (x * price + y);
        return { qtyA: L * x, qtyB: L * y };
    }

    /**
     * m: { a, b, price, lower, upper, qtyA, qtyB, chain }
     * hist: [{ t, price, valueB, feesB }] em ordem de tempo (orientado B por A)
     * dep: { qtyA, qtyB, start } ou null · tvlUsd: liquidez da pool (opcional)
     */
    function evaluate({ m, hist = [], dep = null, tvlUsd = null, now = Date.now() }) {
        const pos = posOf(m.price, m.lower, m.upper);
        const zone = zoneOf(pos);
        // Desde quando está na cor atual (pelo histórico de leituras).
        let since = now;
        for (let i = hist.length - 1; i >= 0; i -= 1) {
            if (zoneOf(posOf(hist[i].price, m.lower, m.upper)) !== zone) break;
            since = hist[i].t;
        }
        const inZone = now - since;
        // Saídas da faixa nos últimos 7 dias, com o lado.
        const exits = [];
        let prev = null;
        hist.filter((h) => h.t >= now - 7 * DAY).forEach((h) => {
            const z = zoneOf(posOf(h.price, m.lower, m.upper));
            if (z === 'red' && prev && prev !== 'red') exits.push(sideOf(posOf(h.price, m.lower, m.upper)));
            prev = z;
        });
        if (zone === 'red' && (!hist.length || zoneOf(posOf(hist[hist.length - 1].price, m.lower, m.upper)) !== 'red')) exits.push(sideOf(pos));
        const sameSideTwice = ['baixo', 'cima'].some((s) => exits.filter((e) => e === s).length >= 2);
        const age = dep?.start ? now - Date.parse(`${dep.start}T12:00:00`) : hist.length ? now - hist[0].t : null;
        const justMounted = age !== null && age < DAY;

        // Ação do dia pelas regras.
        let action;
        if (justMounted) action = { level: 'wait', text: 'Recém-montada: não mexer nas primeiras 24 horas.' };
        else if (zone === 'green') action = { level: 'ok', text: 'Nada a fazer.' };
        else if (zone === 'yellow') {
            const left = 3 * DAY - inZone;
            action = left > 0
                ? { level: 'wait', text: `Perto da borda de ${sideOf(pos)}. Recentralizar se continuar assim até ${fmtWhen(now + left)}.`, until: now + left }
                : { level: 'act', kind: 'recenter', text: 'Há mais de 3 dias perto da borda: recentralizar.' };
        } else {
            const left = DAY - inZone;
            action = left > 0
                ? { level: 'wait', text: `Fora da faixa, por ${sideOf(pos)}. Remontar se continuar fora até ${fmtWhen(now + left)}.`, until: now + left }
                : { level: 'act', kind: 'remount', text: 'Fora da faixa há mais de 24 horas: remontar.' };
        }
        if (sameSideTwice && action.level === 'act') action.text += ' Saiu 2 vezes para o mesmo lado na semana: use uma faixa 50% mais larga.';

        // Sugestão de remontagem com o preço atual.
        let suggestion = null;
        if (action.level === 'act' || zone !== 'green') {
            const w = halfWidth(m.lower, m.upper) * (sameSideTwice ? 1.5 : 1);
            const capitalB = m.qtyA * m.price + m.qtyB;
            const half = capitalB / 2;
            const cLo = m.price * Math.exp(-w), cHi = m.price * Math.exp(w);
            const centered = { lower: cLo, upper: cHi, ...split(m.price, cLo, cHi, half) };
            // Metade de um lado só com o token que está sobrando (sem swap).
            const moreA = m.qtyA * m.price > m.qtyB;
            const oneSide = moreA
                ? { lower: m.price * 1.003, upper: m.price * Math.exp(w), qtyA: half / m.price, qtyB: 0, token: m.a, note: `só ${m.a}, logo acima do preço: vende aos poucos se o preço voltar a subir` }
                : { lower: m.price * Math.exp(-w), upper: m.price * 0.997, qtyA: 0, qtyB: half, token: m.b, note: `só ${m.b}, logo abaixo do preço: compra aos poucos se o preço voltar a cair` };
            const haveA = m.qtyA, haveB = m.qtyB;
            const needA = centered.qtyA + oneSide.qtyA, needB = centered.qtyB + oneSide.qtyB;
            const swap = needA > haveA
                ? { from: m.b, to: m.a, amountB: (needA - haveA) * m.price }
                : { from: m.a, to: m.b, amountB: (haveA - needA) * m.price };
            suggestion = { halfPct: (Math.exp(w) - 1) * 100, widened: sameSideTwice, centered, oneSide, swap, capitalB };
        }

        // Resultado contra só segurar em 7, 14 e 21 dias atrás (regra das 3 semanas).
        const weekly = [];
        if (dep && Number.isFinite(dep.qtyA)) {
            [21, 14, 7, 0].forEach((d) => {
                const target = now - d * DAY;
                const h = d === 0 ? { price: m.price, valueB: m.qtyA * m.price + m.qtyB, feesB: hist.length ? hist[hist.length - 1].feesB : 0 } : nearest(hist, target, DAY);
                if (h) weekly.push({ days: d, resultB: h.valueB + h.feesB - (dep.qtyA * h.price + dep.qtyB) });
            });
        }
        const last3 = weekly.slice(-3);
        const threeNegative = last3.length === 3 && last3.every((w) => w.resultB < 0);

        const checks = [
            { ok: BIG.has(String(m.a).toUpperCase()) && BIG.has(String(m.b).toUpperCase()), text: 'Tokens grandes (ETH, BTC, SOL, BNB, stablecoins)' },
            { ok: tvlUsd === null ? null : tvlUsd >= 5e6, text: 'Liquidez da pool acima de US$ 5 milhões' },
            { ok: CHEAP.has(m.chain), text: 'Rede barata para remontar' },
            { ok: Boolean(dep), text: 'Depósito inicial registrado' },
            { ok: Boolean(dep?.start), text: 'Data de montagem registrada' },
            { ok: zone === 'green', warn: zone === 'yellow', text: zone === 'green' ? 'Preço no miolo da faixa (20% a 80%)' : zone === 'yellow' ? 'Preço perto da borda (último quinto)' : 'Preço fora da faixa' },
            { ok: !sameSideTwice, text: 'Não saiu 2 vezes para o mesmo lado na semana' },
            { ok: weekly.length < 3 ? null : !threeNegative, text: 'Resultado contra só segurar não ficou negativo 3 semanas seguidas' },
        ];
        return { pos, zone, since, inZone, exits, sameSideTwice, action, suggestion, checks, weekly, profile: (Math.exp(halfWidth(m.lower, m.upper)) - 1) * 100 };
    }

    function nearest(hist, target, tol) {
        let best = null;
        hist.forEach((h) => { if (Math.abs(h.t - target) <= tol && (!best || Math.abs(h.t - target) < Math.abs(best.t - target))) best = h; });
        return best;
    }

    function fmtWhen(t) {
        return new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
    }

    function duration(ms) {
        const h = Math.max(0, Math.floor(ms / HOUR));
        if (h < 1) return 'menos de 1 h';
        if (h < 48) return `${h} h`;
        return `${Math.floor(h / 24)} dias e ${h % 24} h`;
    }

    App.method = { evaluate, zoneOf, posOf, duration, split };
})(window.App);
