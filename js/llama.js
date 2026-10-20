// DefiLlama (API gratuita, sem chave): rendimentos das pools, fluxo de capital
// (TVL e stablecoins), volume e taxas por app e preços de tokens fora da Binance.
window.App = window.App || {};

(function (App) {
    const BASES = {
        main: ['https://api.llama.fi'],
        yields: ['https://yields.llama.fi', 'https://api.llama.fi'],
        coins: ['https://coins.llama.fi', 'https://api.llama.fi'],
        stable: ['https://stablecoins.llama.fi', 'https://api.llama.fi'],
    };
    // Nomes de cada rede na DefiLlama (variam entre endpoints).
    const CHAIN_NAMES = {
        ethereum: ['Ethereum'], arbitrum: ['Arbitrum'], base: ['Base'], optimism: ['OP Mainnet', 'Optimism'],
        polygon: ['Polygon'], bnb: ['BSC', 'Binance'], zksync: ['zkSync Era', 'ZKsync Era', 'Era'], solana: ['Solana'],
    };
    const CHAIN_SLUGS = { ethereum: ['ethereum'], arbitrum: ['arbitrum'], base: ['base'], optimism: ['optimism', 'op-mainnet'], polygon: ['polygon'], bnb: ['bsc'], zksync: ['era', 'zksync-era'], solana: ['solana'] };
    const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const NAME_TO_KEY = new Map(Object.entries(CHAIN_NAMES).flatMap(([k, names]) => names.map((n) => [norm(n), k])));
    const chainKeyOf = (name) => NAME_TO_KEY.get(norm(name)) ?? null;

    // Fila com intervalo: a API gratuita limita consultas por minuto.
    let last = 0;
    const GAP = window.__llamaGap ?? 900;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function get(kind, path) {
        let lastError;
        for (const base of BASES[kind]) {
            const wait = last + GAP - Date.now();
            if (wait > 0) await sleep(wait);
            last = Date.now();
            try {
                const r = await fetch(`${base}${path}`, { headers: { accept: 'application/json' } });
                if (r.status === 429) { await sleep(window.__llamaRetry ?? 15000); continue; }
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return await r.json();
            } catch (error) { lastError = error; }
        }
        throw new Error(`DefiLlama: ${lastError?.message ?? 'sem resposta'}`);
    }

    // Cache em localStorage, com validade.
    function cached(key, ttl, loader) {
        try {
            const hit = JSON.parse(localStorage.getItem(`llama:${key}`) || 'null');
            if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.value);
        } catch { /* sem cache */ }
        return loader().then((value) => {
            try { localStorage.setItem(`llama:${key}`, JSON.stringify({ at: Date.now(), value })); } catch { /* cheio */ }
            return value;
        });
    }

    const HOUR = 3600 * 1000;
    const ours = Object.keys(CHAIN_NAMES);

    // ---------- Rendimentos (yields) ----------
    function yieldPools() {
        return cached('pools', 3 * HOUR, async () => {
            const body = await get('yields', '/pools');
            // Só o que interessa (as redes do painel e pools com liquidez), para caber no navegador.
            return (body.data ?? []).map((p) => ({ ...p, key: chainKeyOf(p.chain) }))
                .filter((p) => p.key && p.tvlUsd >= 100000)
                .map((p) => ({
                    id: p.pool, chain: p.key, project: p.project, symbol: p.symbol, tvl: p.tvlUsd,
                    apy: p.apy, apyBase: p.apyBase, apyReward: p.apyReward, apyMean30d: p.apyMean30d,
                    vol1d: p.volumeUsd1d ?? null, il7d: p.il7d ?? null, ilRisk: p.ilRisk, stable: p.stablecoin,
                    exposure: p.exposure, meta: p.poolMeta ?? '', outlook: p.predictions?.predictedClass ?? null,
                    tokens: p.underlyingTokens ?? [],
                }));
        });
    }

    function poolHistory(id) {
        return cached(`chart:${id}`, 6 * HOUR, async () => {
            const body = await get('yields', `/chart/${id}`);
            return (body.data ?? []).map((d) => ({ t: Date.parse(d.timestamp), apy: d.apy, apyBase: d.apyBase, tvl: d.tvlUsd }));
        });
    }

    // ---------- Fluxo de capital ----------
    async function chainTvlNow() {
        return cached('chains', HOUR, async () => {
            const list = await get('main', '/v2/chains');
            const out = {};
            list.forEach((c) => { const k = chainKeyOf(c.name); if (k) out[k] = c.tvl; });
            return out;
        });
    }

    async function stablesNow() {
        return cached('stablechains', HOUR, async () => {
            const list = await get('stable', '/stablecoinchains');
            const out = {};
            list.forEach((c) => { const k = chainKeyOf(c.name); if (k) out[k] = c.totalCirculatingUSD?.peggedUSD ?? c.totalCirculating?.peggedUSD ?? null; });
            return out;
        });
    }

    function changeFrom(series, getV) {
        if (!series?.length) return null;
        const lastPt = series[series.length - 1];
        const at = (days) => {
            const target = lastPt.date - days * 86400;
            for (let i = series.length - 1; i >= 0; i -= 1) if (series[i].date <= target) return series[i];
            return null;
        };
        const v = getV(lastPt);
        const d7 = at(7);
        const d30 = at(30);
        return { now: v, ch7: d7 && getV(d7) ? ((v - getV(d7)) / getV(d7)) * 100 : null, ch30: d30 && getV(d30) ? ((v - getV(d30)) / getV(d30)) * 100 : null };
    }

    async function tryNames(key, fn) {
        let lastError;
        for (const name of [...CHAIN_NAMES[key], ...CHAIN_SLUGS[key]]) {
            try { return await fn(name); } catch (e) { lastError = e; }
        }
        throw lastError;
    }

    // Variação de 7 e 30 dias do TVL e das stablecoins de uma rede.
    function chainFlow(key) {
        return cached(`flow:${key}`, 6 * HOUR, async () => {
            const [tvl, st] = await Promise.all([
                tryNames(key, (n) => get('main', `/v2/historicalChainTvl/${encodeURIComponent(n)}`)).then((s) => changeFrom(s.map((x) => ({ date: Number(x.date), v: x.tvl })), (p) => p.v)).catch(() => null),
                tryNames(key, (n) => get('stable', `/stablecoincharts/${encodeURIComponent(n)}`)).then((s) => changeFrom(s.map((x) => ({ date: Number(x.date), v: x.totalCirculatingUSD?.peggedUSD ?? x.totalCirculating?.peggedUSD })), (p) => p.v)).catch(() => null),
            ]);
            return { tvl, stables: st };
        });
    }

    // Protocolos que mais ganharam (ou perderam) TVL na semana, por rede.
    function protocols() {
        return cached('protocols', 3 * HOUR, async () => {
            const list = await get('main', '/protocols');
            return list.filter((p) => p.tvl >= 5e6 && p.category !== 'CEX').map((p) => ({
                name: p.name, slug: p.slug, category: p.category, tvl: p.tvl, ch1: p.change_1d, ch7: p.change_7d,
                chains: Object.fromEntries(Object.entries(p.chainTvls ?? {}).map(([n, v]) => [chainKeyOf(n), v]).filter(([k]) => k)),
            }));
        });
    }

    // ---------- Volume e taxas por app ----------
    function overview(type) {
        return cached(`overview:${type}`, HOUR, async () => {
            const body = await get('main', `/overview/${type}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true${type === 'fees' ? '&dataType=dailyFees' : ''}`);
            return (body.protocols ?? []).map((p) => {
                const byChain = {};
                Object.entries(p.breakdown24h ?? {}).forEach(([chain, versions]) => {
                    const k = chainKeyOf(chain);
                    if (!k) return;
                    byChain[k] = (byChain[k] ?? 0) + Object.values(versions ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
                });
                return { name: p.displayName || p.name, slug: p.slug ?? p.module, total24h: p.total24h, total7d: p.total7d, total30d: p.total30d, ch1: p.change_1d, ch7: p.change_7d, chains: (p.chains ?? []).map(chainKeyOf).filter(Boolean), byChain };
            }).filter((p) => p.total24h > 0);
        });
    }

    // ---------- Preços de tokens fora da Binance ----------
    // Referências "rede:contrato" aprendidas ao ver tokens nas carteiras, nas pools e nos tokens extras.
    const REF_KEY = 'llama:refs';
    let refs = {};
    try { refs = JSON.parse(localStorage.getItem(REF_KEY) || '{}'); } catch { refs = {}; }
    const LLAMA_CHAIN = { ethereum: 'ethereum', arbitrum: 'arbitrum', base: 'base', optimism: 'optimism', polygon: 'polygon', bnb: 'bsc', zksync: 'era', solana: 'solana' };

    function learn(symbol, chainKey, address) {
        const s = String(symbol ?? '').toUpperCase();
        if (!s || !address || !LLAMA_CHAIN[chainKey] || refs[s]) return;
        if (!/^[A-Z0-9.$_-]{1,15}$/.test(s)) return;
        refs[s] = `${LLAMA_CHAIN[chainKey]}:${address}`;
        try { localStorage.setItem(REF_KEY, JSON.stringify(refs)); } catch { /* cheio */ }
    }
    const refOf = (symbol) => refs[String(symbol).toUpperCase()] ?? null;

    const priceCache = {};
    async function currentPrices(symbols) {
        const want = symbols.filter((s) => refOf(s));
        if (!want.length) return {};
        const out = {};
        const body = await get('coins', `/prices/current/${want.map(refOf).join(',')}`).catch(() => ({ coins: {} }));
        want.forEach((s) => {
            const c = body.coins?.[refOf(s)] ?? Object.entries(body.coins ?? {}).find(([k]) => k.toLowerCase() === refOf(s).toLowerCase())?.[1];
            if (c?.price) { out[s] = c.price; priceCache[s] = c.price; }
        });
        return out;
    }

    // Fechamentos diários (para gráfico, volatilidade e evolução da carteira).
    function dailyCloses(symbol, days = 365) {
        const ref = refOf(symbol);
        if (!ref) return Promise.resolve(null);
        return cached(`hist:${ref}:${days}`, 6 * HOUR, async () => {
            const start = Math.floor(Date.now() / 1000) - days * 86400;
            const body = await get('coins', `/chart/${ref}?start=${start}&span=${days + 1}&period=1d`);
            const coin = Object.values(body.coins ?? {})[0];
            return (coin?.prices ?? []).map((p) => ({ time: p.timestamp, close: p.price }));
        });
    }

    async function priceOn(symbol, iso) {
        const ref = refOf(symbol);
        if (!ref) return null;
        const [y, m, d] = iso.split('-').map(Number);
        const ts = Math.floor(Date.UTC(y, m - 1, d, 23, 59) / 1000);
        const body = await get('coins', `/prices/historical/${ts}/${ref}`).catch(() => null);
        return Object.values(body?.coins ?? {})[0]?.price ?? null;
    }

    App.llama = { yieldPools, poolHistory, chainTvlNow, stablesNow, chainFlow, protocols, overview, learn, refOf, currentPrices, dailyCloses, priceOn, priceCache, chainKeyOf, ours };
})(window.App);
