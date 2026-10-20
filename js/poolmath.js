// Matemática de liquidez concentrada (estilo Uniswap v3). Preços sempre em
// "token B por token A" (ex.: USDC por ETH). Funções puras, sem rede.
window.App = window.App || {};

(function (App) {
    // Distribuição normal acumulada (aproximação de Abramowitz–Stegun).
    function normCdf(x) {
        const t = 1 / (1 + 0.2316419 * Math.abs(x));
        const d = 0.3989423 * Math.exp(-x * x / 2);
        const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
        return x > 0 ? 1 - p : p;
    }

    // Volatilidade diária (desvio-padrão dos retornos logarítmicos), em fração.
    function dailyVol(closes, lookback = 90) {
        const s = closes.slice(-lookback - 1);
        const r = [];
        for (let i = 1; i < s.length; i += 1) if (s[i] > 0 && s[i - 1] > 0) r.push(Math.log(s[i] / s[i - 1]));
        if (r.length < 10) return null;
        const mean = r.reduce((a, b) => a + b, 0) / r.length;
        return Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
    }

    // Chance de o preço (movimento browniano sem tendência, partindo do centro) não tocar
    // nenhuma das bordas ±k·σ·√T durante todo o período. Série exata da dupla barreira.
    function stayProbability(k) {
        if (k <= 0) return 0;
        let sum = 0;
        for (let n = 0; n < 60; n += 1) {
            const m = 2 * n + 1;
            sum += ((n % 2 ? -1 : 1) / m) * Math.exp(-(m * m * Math.PI * Math.PI) / (8 * k * k));
        }
        return Math.min(1, Math.max(0, (4 / Math.PI) * sum));
    }

    // Faixa simétrica em escala logarítmica: P·e^(±k·σ·√T).
    function rangeFor(price, vol, days, k) {
        const w = k * vol * Math.sqrt(days);
        const probEnd = 2 * normCdf(k) - 1;
        const probStay = stayProbability(k);
        return { lower: price * Math.exp(-w), upper: price * Math.exp(w), widthPct: (Math.exp(w) - 1) * 100, probEnd, probStay };
    }

    const PROFILES = [
        { key: 'cons', label: 'Conservadora', k: 2, hint: 'Larga: fica na faixa quase sempre, rende menos por real investido.' },
        { key: 'eq', label: 'Equilibrada', k: 1.2, hint: 'Meio-termo entre rendimento e frequência de remontagem.' },
        { key: 'agr', label: 'Agressiva', k: 0.6, hint: 'Estreita: rende mais enquanto está na faixa, mas sai com frequência.' },
    ];

    function profiles(price, vol, days) {
        return PROFILES.map((p) => ({ ...p, ...rangeFor(price, vol, days, p.k) }));
    }

    // Quantidade de cada token por unidade de liquidez L no preço P.
    function perL(P, a, b) {
        const sp = Math.sqrt(P);
        const sa = Math.sqrt(a);
        const sb = Math.sqrt(b);
        if (P <= a) return { x: (sb - sa) / (sa * sb), y: 0 };
        if (P >= b) return { x: 0, y: sb - sa };
        return { x: (sb - sp) / (sp * sb), y: sp - sa };
    }

    // Divide o capital (em B) entre os dois tokens para a faixa [a, b].
    function deposit(P, a, b, capital) {
        const u = perL(P, a, b);
        const valuePerL = u.x * P + u.y;
        const L = valuePerL > 0 ? capital / valuePerL : 0;
        const qtyA = u.x * L;
        const qtyB = u.y * L;
        return { L, qtyA, qtyB, valueA: qtyA * P, valueB: qtyB, shareA: capital ? (qtyA * P) / capital : 0 };
    }

    // Quantas vezes mais liquidez que uma pool "faixa cheia" (v2) com o mesmo capital.
    function efficiency(P, a, b) {
        const u = perL(P, a, b);
        const v3 = u.x * P + u.y;
        const v2 = 2 * Math.sqrt(P);
        return v3 > 0 ? v2 / v3 : 0;
    }

    function valueAt(L, Pnew, a, b) {
        const u = perL(Pnew, a, b);
        return { value: (u.x * Pnew + u.y) * L, qtyA: u.x * L, qtyB: u.y * L };
    }

    // Resultado da pool (sem taxas) contra segurar os tokens depositados.
    function simulate(P, a, b, capital, moves = [-50, -25, -10, 10, 25, 50]) {
        const d = deposit(P, a, b, capital);
        return moves.map((m) => {
            const Pn = P * (1 + m / 100);
            const lp = valueAt(d.L, Pn, a, b);
            const hold = d.qtyA * Pn + d.qtyB;
            return { move: m, price: Pn, lp: lp.value, hold, diffPct: hold ? ((lp.value - hold) / hold) * 100 : 0, qtyA: lp.qtyA, qtyB: lp.qtyB, inRange: Pn > a && Pn < b };
        });
    }

    // Posição do preço dentro da faixa (0 = borda de baixo, 1 = borda de cima), em escala log.
    function positionInRange(P, a, b) {
        return (Math.log(P) - Math.log(a)) / (Math.log(b) - Math.log(a));
    }

    // Faixa de um lado só: abaixo do preço (só token B: compra gradual) ou acima (só token A: venda gradual).
    function rangeOrder(P, side, nearPct, farPct) {
        const near = side === 'buy' ? P * (1 - nearPct / 100) : P * (1 + nearPct / 100);
        const far = side === 'buy' ? P * (1 - farPct / 100) : P * (1 + farPct / 100);
        const a = Math.min(near, far);
        const b = Math.max(near, far);
        return { lower: a, upper: b, avgPrice: Math.sqrt(a * b) };
    }

    App.poolmath = { normCdf, stayProbability, dailyVol, rangeFor, profiles, PROFILES, perL, deposit, efficiency, valueAt, simulate, positionInRange, rangeOrder };
})(window.App);
