// Verifica as posições da Uniswap v3 e o fator de saúde do Aave v3 das carteiras
// configuradas e avisa no Telegram. Roda no GitHub Actions (ver ALERTAS.md).
// Só lê dados públicos da blockchain; nunca usa chaves privadas.
import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';

const env = process.env;
const ALL_WALLETS = (env.WALLETS || '').split(/[\s,;]+/).map((w) => w.trim()).filter(Boolean);
// Endereços 0x… são verificados nas redes EVM; endereços Solana, na Solana (Orca, Raydium, Meteora).
const isEvm = (w) => /^0x[0-9a-fA-F]{40}$/.test(w);
const isSolana = (w) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w);
const WALLETS = ALL_WALLETS.filter(isEvm);
const SOLANA = ALL_WALLETS.filter((w) => !isEvm(w) && isSolana(w));
const INVALID = ALL_WALLETS.filter((w) => !isEvm(w) && !isSolana(w));
const TOKEN = env.TELEGRAM_BOT_TOKEN;
const CHAT = env.TELEGRAM_CHAT_ID;
const TG_API = env.TELEGRAM_API || 'https://api.telegram.org';
const EDGE = Number(env.EDGE_PCT || 12) / 100;
const HF_MIN = Number(env.HF_MIN || 1.5);
const REMIND_HOURS = Number(env.REMIND_HOURS || 24);
const STATE_FILE = env.STATE_FILE || '.alert-state/state.json';
const TEST = String(env.TESTE || '').toLowerCase() === 'true';

const UNI = (npm, factory) => ({ name: 'Uniswap v3', kind: 'v3', npm, factory });
const PANCAKE = (masterchef = null) => ({ name: 'PancakeSwap v3', kind: 'v3', npm: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', masterchef });
const MC = '0x556B9306565093C855AEA9AE92A594704c2Cd59e';
const AERO = [
    ['0x827922686190790b37229fd06084350E74485b72', '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A'],
    ['0xa990C6a764b73BF43cee5Bb40339c3322FB9D55F', '0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a'],
    ['0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53', '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef'],
].map(([npm, factory]) => ({ name: 'Aerodrome', kind: 'slipstream', npm, factory }));
const CHAINS = {
    ethereum: { id: 1, name: 'Ethereum', rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'], blockscout: 'https://eth.blockscout.com', aave: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', dexes: [UNI('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', '0x1F98431c8aD98523631AE4a59f267346ea31F984'), PANCAKE(MC)] },
    arbitrum: { id: 42161, name: 'Arbitrum', rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'], blockscout: 'https://arbitrum.blockscout.com', aave: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', dexes: [UNI('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', '0x1F98431c8aD98523631AE4a59f267346ea31F984'), PANCAKE()] },
    base: { id: 8453, name: 'Base', rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'], blockscout: 'https://base.blockscout.com', aave: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', dexes: [UNI('0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1', '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'), ...AERO, PANCAKE()] },
    optimism: { id: 10, name: 'Optimism', rpcs: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'], blockscout: 'https://optimism.blockscout.com', aave: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', dexes: [UNI('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', '0x1F98431c8aD98523631AE4a59f267346ea31F984')] },
    polygon: { id: 137, name: 'Polygon', rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'], blockscout: 'https://polygon.blockscout.com', aave: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', dexes: [UNI('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', '0x1F98431c8aD98523631AE4a59f267346ea31F984')] },
    bnb: { id: 56, name: 'BNB Chain', rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'], blockscout: null, aave: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB', dexes: [PANCAKE(MC), UNI('0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613', '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7')] },
    zksync: { id: 324, name: 'zkSync Era', rpcs: ['https://mainnet.era.zksync.io', 'https://zksync.drpc.org'], multicall: '0xF9cda624FBC7e059355ce98a31693d299FACd963', blockscout: null, aave: '0x78e30497a3c7527d953c6B1E3541b021A98Ac43c', dexes: [UNI('0x0616e5762c1E7Dc3723c50663dF10a162D690a86', '0x8FdA5a7a8dCA67BBcDd10F02Fa0649A937215422')] },
};
const SOLANA_RPCS = [env.RPC_SOLANA, 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'].filter(Boolean);
const BLOCKSCOUT_KEY = env.BLOCKSCOUT_KEY || '';
// Resumo de hora em hora (desligue com a variável REPORT=off) e depósitos para "contra só segurar".
const REPORT = (env.REPORT || 'hourly').toLowerCase();
let DEPOSITS = {};
try { DEPOSITS = env.POOL_DEPOSITS ? JSON.parse(env.POOL_DEPOSITS) : {}; } catch { console.log('POOL_DEPOSITS inválido (precisa ser JSON); resumo sem "contra só segurar".'); }
const GT_NET = { ethereum: 'eth', arbitrum: 'arbitrum', base: 'base', optimism: 'optimism', polygon: 'polygon_pos', bnb: 'bsc', zksync: 'zksync', solana: 'solana' };
const ONLY = (env.CHAINS || '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
// Posições "de golpe": NFTs enviados sem pedir, com tokens cujo nome é um site ou um chamado
// para resgatar prêmios. São ignoradas para não poluir os alertas.
const SPAM = /(https?:|www\.|\.(com|org|io|net|xyz|app|finance|site|top|gift)\b|claim|reward|visit|airdrop|voucher|bonus)/i;
const STABLE = /^(USDC|USDT|DAI|USDE|USDC\.E|USDBC|FDUSD|USDS|GHO|LUSD|FRAX|USDT0)$/i;

const I = {
    mc: new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])']),
    erc20: new ethers.Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']),
    aave: new ethers.Interface(['function getUserAccountData(address user) view returns (uint256,uint256,uint256,uint256,uint256,uint256)']),
    npmSlip: new ethers.Interface(['function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)']),
    factorySlip: new ethers.Interface(['function getPool(address,address,int24) view returns (address)']),
    nft: new ethers.Interface(['function ownerOf(uint256) view returns (address)']),
    gauge: new ethers.Interface(['function stakedContains(address,uint256) view returns (bool)']),
    npm: new ethers.Interface([
        'function balanceOf(address owner) view returns (uint256)',
        'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
        'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
    ]),
    factory: new ethers.Interface(['function getPool(address,address,uint24) view returns (address)']),
    pool: new ethers.Interface(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick)', 'function feeGrowthGlobal0X128() view returns (uint256)', 'function feeGrowthGlobal1X128() view returns (uint256)', 'function fee() view returns (uint24)']),
    ticks: new ethers.Interface(['function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128)']),
};

async function rpc(chainKey, method, params) {
    const chain = CHAINS[chainKey];
    const custom = env[`RPC_${chainKey.toUpperCase()}`];
    let last;
    for (const url of [...(custom ? [custom] : []), ...chain.rpcs]) {
        try {
            const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const body = await r.json();
            if (body.error) throw new Error(body.error.message);
            return body.result;
        } catch (e) { last = e; }
    }
    throw new Error(`${chain.name}: nenhum RPC respondeu (${last?.message})`);
}

async function multicall(chainKey, calls) {
    if (!calls.length) return [];
    const data = I.mc.encodeFunctionData('aggregate3', [calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))]);
    const raw = await rpc(chainKey, 'eth_call', [{ to: CHAINS[chainKey].multicall ?? MULTICALL3, data }, 'latest']);
    return I.mc.decodeFunctionResult('aggregate3', raw)[0].map((r) => (r.success && r.returnData !== '0x' ? r.returnData : null));
}

async function tokenMeta(chainKey, addresses) {
    const res = await multicall(chainKey, addresses.flatMap((a) => [{ target: a, data: I.erc20.encodeFunctionData('symbol', []) }, { target: a, data: I.erc20.encodeFunctionData('decimals', []) }]));
    const out = {};
    addresses.forEach((a, i) => {
        let symbol = '?';
        let decimals = 18;
        try { [symbol] = I.erc20.decodeFunctionResult('symbol', res[i * 2]); } catch { /* sem symbol padrão */ }
        try { decimals = Number(I.erc20.decodeFunctionResult('decimals', res[i * 2 + 1])[0]); } catch { /* 18 */ }
        out[a.toLowerCase()] = { symbol, decimals };
    });
    return out;
}

async function enumerate(chainKey, contract, owner) {
    const [countRaw] = await multicall(chainKey, [{ target: contract, data: I.npm.encodeFunctionData('balanceOf', [owner]) }]);
    const total = countRaw ? Number(I.npm.decodeFunctionResult('balanceOf', countRaw)[0]) : 0;
    const count = Math.min(80, total);
    if (!count) return [];
    return (await multicall(chainKey, Array.from({ length: count }, (_, i) => ({ target: contract, data: I.npm.encodeFunctionData('tokenOfOwnerByIndex', [owner, total - 1 - i]) }))))
        .filter(Boolean).map((r) => I.npm.decodeFunctionResult('tokenOfOwnerByIndex', r)[0]);
}

// Posições do Aerodrome em staking: o NFT vai para o gauge. Descobre pelos envios (Blockscout) e confirma no gauge.
async function stakedInGauges(chainKey, owner, dex) {
    const c = CHAINS[chainKey];
    if (!c.blockscout && !BLOCKSCOUT_KEY) return [];
    const base = BLOCKSCOUT_KEY ? `https://api.blockscout.com/${c.id}/api/v2` : `${c.blockscout}/api/v2`;
    const r = await fetch(`${base}/addresses/${owner}/token-transfers?type=ERC-721&filter=from&token=${dex.npm}${BLOCKSCOUT_KEY ? `&apikey=${BLOCKSCOUT_KEY}` : ''}`);
    if (!r.ok) return [];
    const body = await r.json();
    const ids = [...new Set((body.items ?? []).map((it) => it.total?.token_id ?? it.token_id).filter(Boolean))].slice(0, 40).map(BigInt);
    if (!ids.length) return [];
    const owners = await multicall(chainKey, ids.map((id) => ({ target: dex.npm, data: I.nft.encodeFunctionData('ownerOf', [id]) })));
    const cand = ids.map((id, i) => ({ id, holder: owners[i] ? I.nft.decodeFunctionResult('ownerOf', owners[i])[0] : null })).filter((x) => x.holder && x.holder.toLowerCase() !== owner.toLowerCase());
    const checks = await multicall(chainKey, cand.map((x) => ({ target: x.holder, data: I.gauge.encodeFunctionData('stakedContains', [owner, x.id]) })));
    return cand.filter((x, i) => checks[i] && I.gauge.decodeFunctionResult('stakedContains', checks[i])[0]).map((x) => x.id);
}

async function positionsOf(chainKey, owner, dex) {
    const slip = dex.kind === 'slipstream';
    const own = await enumerate(chainKey, dex.npm, owner);
    const staked = [
        ...(dex.masterchef ? await enumerate(chainKey, dex.masterchef, owner).catch(() => []) : []),
        ...(slip ? await stakedInGauges(chainKey, owner, dex).catch(() => []) : []),
    ];
    const ids = [...own, ...staked];
    if (!ids.length) return [];
    const posAbi = slip ? I.npmSlip : I.npm;
    const pos = (await multicall(chainKey, ids.map((id) => ({ target: dex.npm, data: posAbi.encodeFunctionData('positions', [id]) }))))
        .map((r, i) => (r ? { id: ids[i].toString(), ...posAbi.decodeFunctionResult('positions', r).toObject() } : null))
        .filter((p) => p && p.liquidity > 0n);
    if (!pos.length) return [];
    const factoryAbi = slip ? I.factorySlip : I.factory;
    const pools = (await multicall(chainKey, pos.map((p) => ({ target: dex.factory, data: factoryAbi.encodeFunctionData('getPool', [p.token0, p.token1, slip ? p.tickSpacing : p.fee]) }))))
        .map((r) => (r ? factoryAbi.decodeFunctionResult('getPool', r)[0] : null));
    const slots = await multicall(chainKey, pools.map((p) => ({ target: p ?? (CHAINS[chainKey].multicall ?? MULTICALL3), data: I.pool.encodeFunctionData('slot0', []) })));
    const meta = await tokenMeta(chainKey, [...new Set(pos.flatMap((p) => [p.token0, p.token1]))]);
    // Taxas acumuladas (fórmula feeGrowthInside da Uniswap v3); no Aerodrome usa as já registradas.
    const target = (i) => pools[i] ?? (CHAINS[chainKey].multicall ?? MULTICALL3);
    const extra = await multicall(chainKey, pos.flatMap((p, i) => [
        { target: target(i), data: I.pool.encodeFunctionData('feeGrowthGlobal0X128', []) },
        { target: target(i), data: I.pool.encodeFunctionData('feeGrowthGlobal1X128', []) },
        { target: target(i), data: I.ticks.encodeFunctionData('ticks', [p.tickLower]) },
        { target: target(i), data: I.ticks.encodeFunctionData('ticks', [p.tickUpper]) },
        { target: target(i), data: I.pool.encodeFunctionData('fee', []) },
    ])).catch(() => []);
    const MOD = 2n ** 256n;
    const sub = (x, y) => ((x - y) % MOD + MOD) % MOD;
    return pos.map((p, i) => {
        if (!slots[i]) return null;
        if (SPAM.test(meta[p.token0.toLowerCase()]?.symbol ?? '') || SPAM.test(meta[p.token1.toLowerCase()]?.symbol ?? '')) return null;
        const { tick } = I.pool.decodeFunctionResult('slot0', slots[i]);
        const m0 = meta[p.token0.toLowerCase()];
        const m1 = meta[p.token1.toLowerCase()];
        const scale = 10 ** (m0.decimals - m1.decimals);
        const { sqrtPriceX96 } = I.pool.decodeFunctionResult('slot0', slots[i]);
        // Quantidades pela liquidez.
        const L = Number(p.liquidity);
        const sp = Number(sqrtPriceX96) / 2 ** 96, sa = Math.sqrt(1.0001 ** Number(p.tickLower)), sb = Math.sqrt(1.0001 ** Number(p.tickUpper));
        const [r0, r1] = sp <= sa ? [L * (sb - sa) / (sa * sb), 0] : sp < sb ? [L * (sb - sp) / (sp * sb), L * (sp - sa)] : [0, L * (sb - sa)];
        let owed0 = p.tokensOwed0, owed1 = p.tokensOwed1;
        const e = extra.slice(i * 5, i * 5 + 5);
        if (!slip && e[0] && e[1] && e[2] && e[3]) {
            try {
                const g0 = I.pool.decodeFunctionResult('feeGrowthGlobal0X128', e[0])[0];
                const g1 = I.pool.decodeFunctionResult('feeGrowthGlobal1X128', e[1])[0];
                const lo = I.ticks.decodeFunctionResult('ticks', e[2]);
                const up = I.ticks.decodeFunctionResult('ticks', e[3]);
                const t = Number(tick);
                const inside = (g, oLo, oUp) => sub(sub(g, t >= Number(p.tickLower) ? oLo : sub(g, oLo)), t < Number(p.tickUpper) ? oUp : sub(g, oUp));
                owed0 = p.tokensOwed0 + p.liquidity * sub(inside(g0, lo[2], up[2]), p.feeGrowthInside0LastX128) / 2n ** 128n;
                owed1 = p.tokensOwed1 + p.liquidity * sub(inside(g1, lo[3], up[3]), p.feeGrowthInside1LastX128) / 2n ** 128n;
            } catch { /* mantém as taxas registradas */ }
        }
        const feePct = slip ? (e[4] ? Number(I.pool.decodeFunctionResult('fee', e[4])[0]) / 10000 : null) : Number(p.fee) / 10000;
        return describe({ owner, chain: chainKey, chainName: CHAINS[chainKey].name, dex: dex.name, id: p.id, sym0: m0.symbol, sym1: m1.symbol, fee: feePct, lower: 1.0001 ** Number(p.tickLower) * scale, upper: 1.0001 ** Number(p.tickUpper) * scale, price: 1.0001 ** Number(tick) * scale, frac: (Number(tick) - Number(p.tickLower)) / (Number(p.tickUpper) - Number(p.tickLower)), amount0: r0 / 10 ** m0.decimals, amount1: r1 / 10 ** m1.decimals, owed0: Number(owed0) / 10 ** m0.decimals, owed1: Number(owed1) / 10 ** m1.decimals, pool: pools[i] });
    }).filter(Boolean);
}

// Normaliza uma posição (EVM ou Solana) para o formato das mensagens.
function describe(x) {
    let a = x.sym0, b = x.sym1, pl = x.lower, pu = x.upper, pn = x.price;
    if (STABLE.test(a) && !STABLE.test(b)) { [a, b] = [b, a]; [pl, pu, pn] = [1 / pu, 1 / pl, 1 / pn]; }
    const out = x.frac < 0 || x.frac >= 1;
    const status = out ? 'fora' : (x.frac < EDGE || x.frac > 1 - EDGE) ? 'borda' : 'ok';
    // "por baixo"/"por cima" no sentido do preço exibido (token volátil cotado na stablecoin).
    const flipped = a !== x.sym0;
    const below = x.frac < 0;
    const has = Number.isFinite(x.amount0) && Number.isFinite(x.amount1);
    return {
        key: `${x.owner}:${x.chain}:${x.dex}:${x.id}`, id: x.id, chain: x.chain, chainName: x.chainName, dex: x.dex, a, b, pair: `${a}/${b}`, fee: x.fee, lower: pl, upper: pu, price: pn, status, side: (below !== flipped) ? 'baixo' : 'cima',
        frac: Math.max(-1, Math.min(2, x.frac)), pool: x.pool ?? null,
        depKey: `${x.chain}:${String(x.dex).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}:${x.id}`,
        qtyA: has ? (flipped ? x.amount1 : x.amount0) : null, qtyB: has ? (flipped ? x.amount0 : x.amount1) : null,
        feeA: has ? (flipped ? x.owed1 : x.owed0) ?? 0 : null, feeB: has ? (flipped ? x.owed0 : x.owed1) ?? 0 : null,
    };
}

async function positions(chainKey, owner) {
    const out = [];
    for (const dex of CHAINS[chainKey].dexes) out.push(...await positionsOf(chainKey, owner, dex));
    return out;
}

// ---------- Solana (Orca, Raydium, Meteora) ----------
let solanaCore = null;
async function solana() {
    if (solanaCore) return solanaCore;
    let web3;
    try {
        web3 = await import('@solana/web3.js');
    } catch {
        throw new Error('biblioteca @solana/web3.js não instalada. No arquivo .github/workflows/alertas-pools.yml, a linha do npm install precisa terminar com "ethers@6.13.4 @solana/web3.js@1.98.0".');
    }
    await import(new URL('../js/solana-core.js', import.meta.url));
    const rpc = async (method, params) => {
        let last;
        for (const url of SOLANA_RPCS) {
            try {
                const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const body = await r.json();
                if (body.error) throw new Error(body.error.message);
                return body.result;
            } catch (e) { last = e; }
        }
        throw new Error(`Solana: nenhum RPC respondeu (${last?.message})`);
    };
    solanaCore = globalThis.SolanaCore.create({ rpc, PublicKey: web3.PublicKey, decode: (d) => new Uint8Array(Buffer.from(d, 'base64')) });
    return solanaCore;
}

async function symbolsFor(mints) {
    const out = {};
    for (let i = 0; i < mints.length; i += 60) {
        try {
            const r = await fetch(`https://coins.llama.fi/prices/current/${mints.slice(i, i + 60).map((m) => `solana:${m}`).join(',')}`);
            const body = await r.json();
            Object.entries(body.coins ?? {}).forEach(([k, v]) => { out[k.slice(7)] = v.symbol; });
        } catch { /* sem símbolos */ }
    }
    return out;
}

async function solanaPositions(owner, errors) {
    const core = await solana();
    const res = await core.readWallet(owner);
    res.errors.forEach((e) => errors.push(`${short(owner)} · Solana: ${e}`));
    const sym = await symbolsFor([...new Set(res.positions.flatMap((p) => [p.token0, p.token1]))]);
    return res.positions.map((p) => describe({
        owner, chain: 'solana', chainName: 'Solana', dex: p.dex, id: p.id,
        sym0: sym[p.token0] ?? globalThis.SolanaCore.KNOWN_MINTS[p.token0] ?? p.token0.slice(0, 4), sym1: sym[p.token1] ?? globalThis.SolanaCore.KNOWN_MINTS[p.token1] ?? p.token1.slice(0, 4),
        fee: p.fee !== null && p.fee !== undefined ? p.fee / 10000 : null,
        lower: p.priceLower, upper: p.priceUpper, price: p.priceNow, frac: p.rangePos,
        amount0: p.amount0 ?? NaN, amount1: p.amount1 ?? NaN, owed0: p.owed0 ?? 0, owed1: p.owed1 ?? 0,
    }));
}

async function aave(chainKey, owner) {
    const [r] = await multicall(chainKey, [{ target: CHAINS[chainKey].aave, data: I.aave.encodeFunctionData('getUserAccountData', [owner]) }]);
    if (!r) return null;
    const d = I.aave.decodeFunctionResult('getUserAccountData', r);
    if (d[1] === 0n) return null;
    return { key: `${owner}:${chainKey}:aave`, chain: chainKey, debt: Number(d[1]) / 1e8, collateral: Number(d[0]) / 1e8, hf: Number(d[5]) / 1e18 };
}

const fmtP = (v, pair) => {
    const quote = pair.split('/')[1];
    const digits = v >= 1000 ? 2 : v >= 1 ? 4 : 8;
    const n = v.toLocaleString('pt-BR', { maximumFractionDigits: digits });
    return STABLE.test(quote) ? `US$ ${n}` : `${n} ${quote}`;
};
const num = (v, d) => v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function telegram(text) {
    if (!TOKEN || !CHAT) { console.log('[sem Telegram configurado]\n' + text); return; }
    const r = await fetch(`${TG_API}/bot${TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!r.ok) throw new Error(`Telegram respondeu ${r.status}: ${await r.text()}`);
}

function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(state) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function poolApr(p) {
    if (!p.pool || !GT_NET[p.chain] || !p.fee) return null;
    try {
        const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${GT_NET[p.chain]}/pools/${p.pool}`, { headers: { accept: 'application/json' } });
        if (!r.ok) return null;
        const a = (await r.json()).data?.attributes ?? {};
        const tvl = Number(a.reserve_in_usd) || 0;
        const vol = Number(a.volume_usd?.h24) || 0;
        return tvl ? vol * p.fee / 100 / tvl * 365 * 100 : null;
    } catch { return null; }
}

const money = (v) => `US$ ${num(v, 2)}`;
const smoney = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}US$ ${num(Math.abs(v), 2)}`;
const spct = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v), 2)}%`;

function methodLines(p, st, dep) {
    const HOUR = 3600000, DAY = 24 * HOUR, now = Date.now();
    const light = { green: '🟢 Verde', yellow: '🟡 Amarelo', red: '🔴 Vermelho' }[st.zone] ?? '';
    const inZone = now - (st.zoneSince ?? now);
    const dur = inZone < HOUR ? 'menos de 1 h' : inZone < 2 * DAY ? `${Math.floor(inZone / HOUR)} h` : `${Math.floor(inZone / DAY)} dias`;
    const age = dep?.start ? now - Date.parse(`${dep.start}T12:00:00-03:00`) : now - (st.firstSeen ?? now);
    const side = p.frac < 0.5 ? 'baixo' : 'cima';
    const twice = ['baixo', 'cima'].some((sd) => (st.exits ?? []).filter((e) => e.side === sd).length >= 2);
    const when = (t) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
    let action;
    let act = false;
    if (age < DAY) action = 'recém-montada, não mexer nas primeiras 24 h';
    else if (st.zone === 'green') action = 'nada a fazer';
    else if (st.zone === 'yellow') action = inZone < 3 * DAY ? `perto da borda de ${side}; recentralizar se continuar até ${when(st.zoneSince + 3 * DAY)}` : (act = true, '<b>recentralizar</b> (mais de 3 dias perto da borda)');
    else action = inZone < DAY ? `fora por ${side}; remontar se continuar fora até ${when(st.zoneSince + DAY)}` : (act = true, '<b>remontar</b> (fora há mais de 24 h)');
    if (act && twice) action += '; saiu 2 vezes para o mesmo lado na semana: faixa 50% mais larga';
    const lines = [`${light} há ${dur} · Ação: ${action}`];
    if (act && p.qtyA !== null) {
        const w = Math.log(p.upper / p.lower) / 2 * (twice ? 1.5 : 1);
        const lo = p.price * Math.exp(-w), hi = p.price * Math.exp(w);
        const moreA = p.qtyA * p.price > p.qtyB;
        const one = moreA ? `só ${esc(p.a)} de ${esc(fmtP(p.price * 1.003, p.pair))} a ${esc(fmtP(hi, p.pair))}` : `só ${esc(p.b)} de ${esc(fmtP(lo, p.pair))} a ${esc(fmtP(p.price * 0.997, p.pair))}`;
        lines.push(`Sugestão: metade centrada ${esc(fmtP(lo, p.pair))} – ${esc(fmtP(hi, p.pair))} + metade ${one}`);
    }
    return lines;
}

async function hourlyReport(items, next) {
    const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date());
    const blocks = [];
    for (const { p } of items) {
        const usdB = STABLE.test(p.b) ? 1 : null;
        const fmtB = (v) => (usdB ? money(v) : `${num(v, 4)} ${p.b}`);
        const sfmtB = (v) => (usdB ? smoney(v) : `${v >= 0 ? '+' : '−'}${num(Math.abs(v), 4)} ${p.b}`);
        const where = p.frac < 0 ? 'fora, abaixo' : p.frac >= 1 ? 'fora, acima' : p.frac < 0.2 ? 'perto da borda de baixo' : p.frac > 0.8 ? 'perto da borda de cima' : 'centro';
        const lines = [
            `<b>${esc(p.pair)}</b> · ${p.chainName} · ${esc(p.dex)}${p.fee ? ` · ${num(p.fee, 2)}%` : ''}`,
            `Preço ${esc(fmtP(p.price, p.pair))} · ${num(Math.max(-99, Math.min(199, p.frac * 100)), 0)}% da faixa (${where})`,
            `Faixa ${esc(fmtP(p.lower, p.pair))} – ${esc(fmtP(p.upper, p.pair))}`,
        ];
        lines.push(...methodLines(p, next[p.key] ?? {}, DEPOSITS[p.depKey]));
        if (p.qtyA !== null) {
            const valueB = p.qtyA * p.price + p.qtyB;
            const st = next[p.key] ?? {};
            const dep = DEPOSITS[p.depKey];
            const feesB = st.feesB + (dep?.collected && usdB ? dep.collected / usdB : 0);
            lines.push(`Posição ${fmtB(valueB)} (${num(p.qtyA, 4)} ${esc(p.a)} + ${num(p.qtyB, 2)} ${esc(p.b)})`);
            let feeLine = `Taxas ${fmtB(feesB)}`;
            let rate = null;
            if (st.prevFeesB !== null && st.prevFeesAt && st.feesB >= st.prevFeesB) {
                const h = (st.feesAt - st.prevFeesAt) / 3600000;
                if (h > 0.2) { rate = (st.feesB - st.prevFeesB) / h; feeLine += ` (${sfmtB(st.feesB - st.prevFeesB)} desde a última verificação)`; }
            }
            lines.push(feeLine);
            if (dep?.start) {
                const days = Math.round((Date.now() - Date.parse(`${dep.start}T12:00:00-03:00`)) / 86400000);
                lines.push(`Montada em ${dep.start.split('-').reverse().join('/')} · dia ${days}${days > 0 && days % 7 === 0 ? ' · <b>dia de revisão</b>' : ''}`);
            }
            if (dep && Number.isFinite(dep.a) && Number.isFinite(dep.b)) {
                const holdB = dep.a * p.price + dep.b;
                lines.push(`Contra só segurar: <b>${sfmtB(valueB + feesB - holdB)}</b> (${spct((valueB + feesB) / holdB * 100 - 100)})`);
                if (dep.price) {
                    const depB = dep.a * dep.price + dep.b;
                    lines.push(`Contra ter ficado em dólar: ${sfmtB(valueB + feesB - depB)} (${spct((valueB + feesB) / depB * 100 - 100)})`);
                }
            }
            const apr = await poolApr(p);
            const aprReal = rate !== null && valueB ? rate * 24 * 365 / valueB * 100 : null;
            if (apr !== null || aprReal !== null) {
                lines.push([apr !== null ? `APR da pool ${num(apr, 0)}%` : null, aprReal !== null ? `seu ritmo na última hora ${num(aprReal, 0)}%` : null].filter(Boolean).join(' · '));
                if (apr !== null) lines.push(`Expectativa no mês (APR da pool, 70% do tempo na faixa): ${fmtB(valueB * apr * 0.7 / 100 / 12)}`);
            }
        }
        blocks.push(lines.join('\n'));
    }
    return `📊 <b>Resumo das pools</b> · ${hora}\n\n${blocks.join('\n\n')}`;
}

function posMessage(p, head, remind, owner) {
    const fee = p.fee !== null && p.fee !== undefined ? ` · taxa ${p.fee.toLocaleString('pt-BR')}%` : '';
    return `${head}${remind ? ' (lembrete: continua fora)' : ''}\n${p.chainName} · ${esc(p.dex)}${fee} · posição ${esc(String(p.id).length > 12 ? short(String(p.id)) : `#${p.id}`)} · ${short(owner)}\nFaixa: ${esc(fmtP(p.lower, p.pair))} – ${esc(fmtP(p.upper, p.pair))}\nAgora: ${esc(fmtP(p.price, p.pair))}`;
}

async function main() {
    if (!ALL_WALLETS.length) throw new Error('Configure o segredo WALLETS com os endereços (separados por vírgula).');
    if (!WALLETS.length && !SOLANA.length) throw new Error(`Nenhum endereço válido em WALLETS: ${INVALID.join(', ')}`);
    const chains = Object.keys(CHAINS).filter((c) => !ONLY.length || ONLY.includes(c));
    const checkSolana = SOLANA.length && (!ONLY.length || ONLY.includes('solana'));
    const prev = loadState();
    const next = {};
    const messages = [];
    const errors = [];
    const now = Date.now();
    const summary = [];

    const reportItems = [];
    const handle = (pos, owner) => {
        for (const p of pos) {
            reportItems.push({ p, owner });
            const before = prev[p.key];
            const remind = p.status === 'fora' && before?.status === 'fora' && now - (before.notifiedAt ?? 0) > REMIND_HOURS * 3600000;
            const changed = !before || before.status !== p.status;
            let notifiedAt = before?.notifiedAt ?? 0;
            if ((changed && (p.status !== 'ok' || before)) || remind) {
                const head = p.status === 'fora' ? `🔴 <b>${esc(p.pair)}</b> saiu da faixa por ${p.side}` : p.status === 'borda' ? `🟡 <b>${esc(p.pair)}</b> perto da borda` : `🟢 <b>${esc(p.pair)}</b> voltou para a faixa`;
                messages.push(posMessage(p, head, remind, owner));
                notifiedAt = now;
            }
            const feesB = p.qtyA !== null ? (p.feeA ?? 0) * p.price + (p.feeB ?? 0) : null;
            // Semáforo do método: cor atual, desde quando e saídas da faixa na última semana.
            const zone = p.frac < 0 || p.frac > 1 ? 'red' : p.frac < 0.2 || p.frac > 0.8 ? 'yellow' : 'green';
            const zoneSince = before?.zone === zone ? (before.zoneSince ?? now) : now;
            const exits = (before?.exits ?? []).filter((e) => now - e.at < 7 * 86400000);
            if (zone === 'red' && before?.zone && before.zone !== 'red') exits.push({ side: p.frac < 0 ? 'baixo' : 'cima', at: now });
            const firstSeen = before?.firstSeen ?? now;
            next[p.key] = { status: p.status, notifiedAt, since: changed ? now : (before?.since ?? now), feesB, feesAt: now, prevFeesB: before?.feesB ?? null, prevFeesAt: before?.feesAt ?? null, zone, zoneSince, exits, firstSeen };
            summary.push(`${p.pair} (${p.chainName} · ${p.dex}): ${{ ok: 'na faixa', borda: 'perto da borda', fora: 'fora da faixa' }[p.status]}`);
        }
    };

    for (const raw of WALLETS) {
        const owner = ethers.getAddress(raw.toLowerCase());
        for (const chain of chains) {
            try {
                const [pos, hf] = await Promise.all([positions(chain, owner), aave(chain, owner)]);
                handle(pos, owner);
                if (hf) {
                    const before = prev[hf.key];
                    const level = hf.hf < 1.2 ? 'critico' : hf.hf < HF_MIN ? 'baixo' : 'ok';
                    const changed = !before || before.status !== level;
                    let notifiedAt = before?.notifiedAt ?? 0;
                    const remind = level !== 'ok' && now - notifiedAt > REMIND_HOURS * 3600000;
                    if ((changed && (level !== 'ok' || before)) || remind) {
                        messages.push(`${level === 'critico' ? '🔴' : level === 'baixo' ? '🟡' : '🟢'} <b>Aave · ${CHAINS[chain].name}</b> fator de saúde ${num(hf.hf, 2)}\nDívida US$ ${num(hf.debt, 2)} · colateral US$ ${num(hf.collateral, 2)} · ${short(owner)}${level === 'ok' ? '' : '\nAbaixo de 1,0 a posição pode ser liquidada.'}`);
                        notifiedAt = now;
                    }
                    next[hf.key] = { status: level, notifiedAt };
                    summary.push(`Aave ${CHAINS[chain].name}: fator de saúde ${num(hf.hf, 2)}`);
                }
            } catch (e) {
                errors.push(`${short(owner)} · ${CHAINS[chain].name}: ${e.message}`);
            }
        }
    }

    if (checkSolana) {
        for (const owner of SOLANA) {
            try {
                handle(await solanaPositions(owner, errors), owner);
            } catch (e) {
                errors.push(`${short(owner)} · Solana: ${e.message}`);
            }
        }
    }

    if (INVALID.length) errors.push(`Endereço(s) não reconhecido(s) em WALLETS: ${INVALID.join(', ')}`);
    if (TEST) {
        messages.unshift(`✅ <b>Alertas de pools ativos</b>\n${WALLETS.length} carteira(s) EVM em ${chains.length} rede(s)${SOLANA.length ? ` e ${SOLANA.length} carteira(s) Solana` : ''}.\n${summary.length ? esc(summary.join('\n')) : 'Nenhuma pool com liquidez ou dívida no Aave encontrada.'}${errors.length ? `\n\nAvisos de leitura:\n${esc(errors.join('\n'))}` : ''}`);
    }
    if (REPORT !== 'off' && reportItems.length) messages.push(await hourlyReport(reportItems, next));
    for (const m of messages) await telegram(m);
    saveState(next);
    console.log(`Posições verificadas: ${summary.length}. Mensagens enviadas: ${messages.length}.`);
    if (errors.length) console.log(`Avisos:\n${errors.join('\n')}`);
}

main().catch(async (e) => {
    console.error(e);
    try { await telegram(`⚠️ Alertas de pools falharam: ${esc(e.message)}`); } catch { /* sem Telegram */ }
    process.exit(1);
});
