// Verifica as posições da Uniswap v3 e o fator de saúde do Aave v3 das carteiras
// configuradas e avisa no Telegram. Roda no GitHub Actions (ver ALERTAS.md).
// Só lê dados públicos da blockchain; nunca usa chaves privadas.
import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';

const env = process.env;
const ALL_WALLETS = (env.WALLETS || '').split(/[\s,;]+/).map((w) => w.trim()).filter(Boolean);
// Por enquanto só redes compatíveis com Ethereum (0x…). Endereços Solana são reconhecidos e
// pulados com aviso, sem derrubar a verificação das outras carteiras.
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

const CHAINS = {
    ethereum: { name: 'Ethereum', rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'], aave: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', npm: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88', factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984' },
    arbitrum: { name: 'Arbitrum', rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'], aave: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', npm: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88', factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984' },
    base: { name: 'Base', rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'], aave: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', npm: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1', factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' },
    optimism: { name: 'Optimism', rpcs: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'], aave: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', npm: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88', factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984' },
    polygon: { name: 'Polygon', rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'], aave: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', npm: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88', factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984' },
};
const ONLY = (env.CHAINS || '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const STABLE = /^(USDC|USDT|DAI|USDE|USDC\.E|USDBC|FDUSD|USDS|GHO|LUSD|FRAX|USDT0)$/i;

const I = {
    mc: new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])']),
    erc20: new ethers.Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']),
    aave: new ethers.Interface(['function getUserAccountData(address user) view returns (uint256,uint256,uint256,uint256,uint256,uint256)']),
    npm: new ethers.Interface([
        'function balanceOf(address owner) view returns (uint256)',
        'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
        'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
    ]),
    factory: new ethers.Interface(['function getPool(address,address,uint24) view returns (address)']),
    pool: new ethers.Interface(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)']),
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
    const raw = await rpc(chainKey, 'eth_call', [{ to: MULTICALL3, data }, 'latest']);
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

async function positions(chainKey, owner) {
    const c = CHAINS[chainKey];
    const [countRaw] = await multicall(chainKey, [{ target: c.npm, data: I.npm.encodeFunctionData('balanceOf', [owner]) }]);
    const count = countRaw ? Math.min(50, Number(I.npm.decodeFunctionResult('balanceOf', countRaw)[0])) : 0;
    if (!count) return [];
    const ids = (await multicall(chainKey, Array.from({ length: count }, (_, i) => ({ target: c.npm, data: I.npm.encodeFunctionData('tokenOfOwnerByIndex', [owner, i]) }))))
        .filter(Boolean).map((r) => I.npm.decodeFunctionResult('tokenOfOwnerByIndex', r)[0]);
    const pos = (await multicall(chainKey, ids.map((id) => ({ target: c.npm, data: I.npm.encodeFunctionData('positions', [id]) }))))
        .map((r, i) => (r ? { id: ids[i].toString(), ...I.npm.decodeFunctionResult('positions', r).toObject() } : null))
        .filter((p) => p && p.liquidity > 0n);
    if (!pos.length) return [];
    const pools = (await multicall(chainKey, pos.map((p) => ({ target: c.factory, data: I.factory.encodeFunctionData('getPool', [p.token0, p.token1, p.fee]) }))))
        .map((r) => (r ? I.factory.decodeFunctionResult('getPool', r)[0] : null));
    const slots = await multicall(chainKey, pools.map((p) => ({ target: p ?? MULTICALL3, data: I.pool.encodeFunctionData('slot0', []) })));
    const meta = await tokenMeta(chainKey, [...new Set(pos.flatMap((p) => [p.token0, p.token1]))]);
    return pos.map((p, i) => {
        if (!slots[i]) return null;
        const { tick } = I.pool.decodeFunctionResult('slot0', slots[i]);
        const m0 = meta[p.token0.toLowerCase()];
        const m1 = meta[p.token1.toLowerCase()];
        const scale = 10 ** (m0.decimals - m1.decimals);
        const lower = Number(p.tickLower);
        const upper = Number(p.tickUpper);
        const t = Number(tick);
        let a = m0.symbol, b = m1.symbol;
        let pl = 1.0001 ** lower * scale, pu = 1.0001 ** upper * scale, pn = 1.0001 ** t * scale;
        if (STABLE.test(a) && !STABLE.test(b)) { [a, b] = [b, a]; [pl, pu, pn] = [1 / pu, 1 / pl, 1 / pn]; }
        const frac = (t - lower) / (upper - lower);
        const status = t < lower || t >= upper ? 'fora' : (frac < EDGE || frac > 1 - EDGE) ? 'borda' : 'ok';
        return { key: `${owner}:${chainKey}:${p.id}`, id: p.id, chain: chainKey, pair: `${a}/${b}`, fee: Number(p.fee) / 10000, lower: pl, upper: pu, price: pn, status, side: t < lower ? 'baixo' : 'cima' };
    }).filter(Boolean);
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

async function main() {
    if (!ALL_WALLETS.length) throw new Error('Configure o segredo WALLETS com os endereços (separados por vírgula).');
    if (!WALLETS.length && !SOLANA.length) throw new Error(`Nenhum endereço válido em WALLETS: ${INVALID.join(', ')}`);
    const chains = Object.keys(CHAINS).filter((c) => !ONLY.length || ONLY.includes(c));
    const prev = loadState();
    const next = {};
    const messages = [];
    const errors = [];
    const now = Date.now();
    const summary = [];

    for (const raw of WALLETS) {
        const owner = ethers.getAddress(raw.toLowerCase());
        for (const chain of chains) {
            try {
                const [pos, hf] = await Promise.all([positions(chain, owner), aave(chain, owner)]);
                for (const p of pos) {
                    const before = prev[p.key];
                    const remind = p.status === 'fora' && before?.status === 'fora' && now - (before.notifiedAt ?? 0) > REMIND_HOURS * 3600000;
                    const changed = !before || before.status !== p.status;
                    let notifiedAt = before?.notifiedAt ?? 0;
                    if ((changed && (p.status !== 'ok' || before)) || remind) {
                        const head = p.status === 'fora' ? `🔴 <b>${esc(p.pair)}</b> saiu da faixa por ${p.side}` : p.status === 'borda' ? `🟡 <b>${esc(p.pair)}</b> perto da borda` : `🟢 <b>${esc(p.pair)}</b> voltou para a faixa`;
                        messages.push(`${head}${remind ? ' (lembrete: continua fora)' : ''}\n${CHAINS[chain].name} · taxa ${p.fee.toLocaleString('pt-BR')}% · posição #${p.id} · ${short(owner)}\nFaixa: ${esc(fmtP(p.lower, p.pair))} – ${esc(fmtP(p.upper, p.pair))}\nAgora: ${esc(fmtP(p.price, p.pair))}`);
                        notifiedAt = now;
                    }
                    next[p.key] = { status: p.status, notifiedAt, since: changed ? now : (before?.since ?? now) };
                    summary.push(`${p.pair} (${CHAINS[chain].name}): ${{ ok: 'na faixa', borda: 'perto da borda', fora: 'fora da faixa' }[p.status]}`);
                }
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

    if (SOLANA.length) console.log(`Carteiras Solana ignoradas (ainda não suportadas): ${SOLANA.join(', ')}`);
    if (INVALID.length) errors.push(`Endereço(s) não reconhecido(s) em WALLETS: ${INVALID.join(', ')}`);
    if (TEST) {
        const notes = [
            SOLANA.length ? `${SOLANA.length} carteira(s) Solana ainda não são verificadas: ${SOLANA.map(short).join(', ')}` : '',
        ].filter(Boolean).join('\n');
        messages.unshift(`✅ <b>Alertas de pools ativos</b>\n${WALLETS.length} carteira(s) EVM, ${chains.length} rede(s).${notes ? `\n${esc(notes)}` : ''}\n${summary.length ? esc(summary.join('\n')) : 'Nenhuma pool com liquidez ou dívida no Aave encontrada.'}${errors.length ? `\n\nAvisos de leitura:\n${esc(errors.join('\n'))}` : ''}`);
    }
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
