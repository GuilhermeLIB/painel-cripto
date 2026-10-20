// Leitura de carteiras Solana: saldos e posições de liquidez concentrada em
// Orca (Whirlpools), Raydium (CLMM) e Meteora (DLMM). Usado pelo painel e pelo
// script de alertas. Layouts conferidos nos SDKs/IDLs oficiais de cada protocolo.
// Dependências injetadas: rpc(method, params), PublicKey (do @solana/web3.js) e decode(base64).
(function (root) {
    const PROGRAMS = {
        orca: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
        raydium: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
        meteora: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
    };
    const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS5EN5bYYZ7nmBzPSPF6r9q'];
    // Símbolos dos mints mais comuns, usados quando a fonte de preços não responde.
    const KNOWN_MINTS = {
        So11111111111111111111111111111111111111112: 'SOL',
        EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
        Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
    };
    const METEORA_POSITION_V2 = [117, 176, 212, 199, 245, 180, 133, 182];
    const Q64 = 2 ** 64;

    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    function base58(bytes) {
        let n = 0n;
        for (const b of bytes) n = n * 256n + BigInt(b);
        let out = '';
        while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
        for (const b of bytes) { if (b === 0) out = `1${out}`; else break; }
        return out;
    }

    function reader(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return {
            u8: (o) => view.getUint8(o),
            u16: (o) => view.getUint16(o, true),
            u32: (o) => view.getUint32(o, true),
            i32: (o) => view.getInt32(o, true),
            u64: (o) => view.getBigUint64(o, true),
            u128: (o) => view.getBigUint64(o, true) + (view.getBigUint64(o + 8, true) << 64n),
            key: (o) => base58(bytes.slice(o, o + 32)),
            length: bytes.length,
        };
    }

    // Quantidade de cada token (em unidades brutas) para liquidez L entre dois ticks.
    function amounts(L, sqrtP, tickLower, tickUpper) {
        const sa = Math.sqrt(1.0001 ** tickLower);
        const sb = Math.sqrt(1.0001 ** tickUpper);
        if (sqrtP <= sa) return [L * (sb - sa) / (sa * sb), 0];
        if (sqrtP < sb) return [L * (sb - sqrtP) / (sqrtP * sb), L * (sqrtP - sa)];
        return [0, L * (sb - sa)];
    }

    function create({ rpc, PublicKey, decode }) {
        const pda = (mint, program) => PublicKey.findProgramAddressSync([new TextEncoder().encode('position'), new PublicKey(mint).toBytes()], new PublicKey(program))[0].toBase58();

        async function multiple(keys, encoding = 'base64') {
            const out = [];
            for (let i = 0; i < keys.length; i += 100) {
                const res = await rpc('getMultipleAccounts', [keys.slice(i, i + 100), { encoding }]);
                out.push(...(res?.value ?? []));
            }
            return out;
        }

        const bytesOf = (acc) => (acc?.data?.[0] ? decode(acc.data[0]) : null);

        async function balances(owner) {
            const [sol, ...lists] = await Promise.all([
                rpc('getBalance', [owner]),
                ...TOKEN_PROGRAMS.map((programId) => rpc('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed' }]).catch(() => ({ value: [] }))),
            ]);
            const tokens = [];
            lists.forEach((l) => (l?.value ?? []).forEach((a) => {
                const info = a.account?.data?.parsed?.info;
                if (!info) return;
                const t = info.tokenAmount;
                tokens.push({ mint: info.mint, raw: t.amount, decimals: Number(t.decimals), amount: Number(t.uiAmountString ?? t.uiAmount ?? 0) });
            }));
            return { native: Number(sol?.value ?? 0) / 1e9, tokens };
        }

        async function mintDecimals(mints) {
            const accs = await multiple(mints, 'jsonParsed');
            return Object.fromEntries(mints.map((m, i) => [m, Number(accs[i]?.data?.parsed?.info?.decimals ?? NaN)]));
        }

        // Orca e Raydium: cada posição é um NFT na carteira; a conta da posição é um PDA do NFT.
        async function clmmPositions(nftMints, errors) {
            if (!nftMints.length) return [];
            const keys = nftMints.flatMap((m) => [pda(m, PROGRAMS.orca), pda(m, PROGRAMS.raydium)]);
            const accs = await multiple(keys);
            const found = [];
            nftMints.forEach((mint, i) => {
                const orca = accs[i * 2];
                const ray = accs[i * 2 + 1];
                if (orca && orca.owner === PROGRAMS.orca) {
                    const r = reader(bytesOf(orca));
                    found.push({ dex: 'Orca', id: mint, pool: r.key(8), liquidity: r.u128(72), tickLower: r.i32(88), tickUpper: r.i32(92), owedA: r.u64(112), owedB: r.u64(136) });
                } else if (ray && ray.owner === PROGRAMS.raydium) {
                    const r = reader(bytesOf(ray));
                    found.push({ dex: 'Raydium', id: mint, pool: r.key(41), tickLower: r.i32(73), tickUpper: r.i32(77), liquidity: r.u128(81), owedA: r.u64(129), owedB: r.u64(137) });
                }
            });
            if (!found.length) return [];
            const poolKeys = [...new Set(found.map((p) => p.pool))];
            const poolAccs = await multiple(poolKeys);
            const pools = {};
            const configs = new Set();
            poolKeys.forEach((k, i) => {
                const acc = poolAccs[i];
                const bytes = bytesOf(acc);
                if (!bytes) return;
                const r = reader(bytes);
                if (acc.owner === PROGRAMS.orca) {
                    pools[k] = { mintA: r.key(101), mintB: r.key(181), sqrt: Number(r.u128(65)) / Q64, tick: r.i32(81), fee: r.u16(45) };
                } else if (acc.owner === PROGRAMS.raydium) {
                    pools[k] = { mintA: r.key(73), mintB: r.key(105), decA: r.u8(233), decB: r.u8(234), sqrt: Number(r.u128(253)) / Q64, tick: r.i32(269), config: r.key(9) };
                    configs.add(pools[k].config);
                }
            });
            // Taxa da Raydium fica na conta de configuração (trade_fee_rate, em milionésimos).
            if (configs.size) {
                const keysC = [...configs];
                const accC = await multiple(keysC);
                const fees = Object.fromEntries(keysC.map((k, i) => [k, bytesOf(accC[i]) ? reader(bytesOf(accC[i])).u32(47) : null]));
                Object.values(pools).forEach((p) => { if (p.config) p.fee = fees[p.config]; });
            }
            const needDec = [...new Set(Object.values(pools).filter((p) => p.decA === undefined).flatMap((p) => [p.mintA, p.mintB]))];
            const dec = needDec.length ? await mintDecimals(needDec) : {};
            return found.map((p) => {
                const pool = pools[p.pool];
                if (!pool) return null;
                const decA = pool.decA ?? dec[pool.mintA];
                const decB = pool.decB ?? dec[pool.mintB];
                const scale = 10 ** (decA - decB);
                // Conferência do layout: o tick atual precisa bater com o preço da pool.
                const expectedTick = Math.floor(Math.log(pool.sqrt ** 2) / Math.log(1.0001));
                if (!Number.isFinite(decA) || !Number.isFinite(decB) || Math.abs(expectedTick - pool.tick) > 2) {
                    errors.push(`${p.dex}: não consegui interpretar a pool ${p.pool.slice(0, 6)}…`);
                    return null;
                }
                const L = Number(p.liquidity);
                const [a0, a1] = amounts(L, pool.sqrt, p.tickLower, p.tickUpper);
                return {
                    dex: p.dex, id: p.id, closed: L === 0, fee: pool.fee ?? null,
                    token0: pool.mintA, token1: pool.mintB, decimals0: decA, decimals1: decB,
                    priceLower: 1.0001 ** p.tickLower * scale, priceUpper: 1.0001 ** p.tickUpper * scale, priceNow: pool.sqrt ** 2 * scale,
                    inRange: pool.tick >= p.tickLower && pool.tick < p.tickUpper,
                    rangePos: (pool.tick - p.tickLower) / (p.tickUpper - p.tickLower),
                    amount0: a0 / 10 ** decA, amount1: a1 / 10 ** decB,
                    owed0: Number(p.owedA) / 10 ** decA, owed1: Number(p.owedB) / 10 ** decB,
                };
            }).filter(Boolean);
        }

        // Meteora DLMM: posições não são NFTs; busca as contas do programa cujo dono é a carteira.
        async function meteoraPositions(owner, errors) {
            let list;
            try {
                list = await rpc('getProgramAccounts', [PROGRAMS.meteora, {
                    encoding: 'base64',
                    filters: [{ memcmp: { offset: 0, bytes: base58(METEORA_POSITION_V2) } }, { memcmp: { offset: 40, bytes: owner } }],
                }]);
            } catch (error) {
                errors.push(`Meteora: o RPC não permitiu a busca de posições (${error.message}). Use um RPC próprio.`);
                return [];
            }
            const positions = (Array.isArray(list) ? list : list?.value ?? []).map((item) => {
                const bytes = decode(item.account.data[0]);
                if (bytes.length < 7920) return null;
                const r = reader(bytes);
                return { id: item.pubkey, pair: r.key(8), lower: r.i32(7912), upper: r.i32(7916) };
            }).filter(Boolean);
            if (!positions.length) return [];
            const pairKeys = [...new Set(positions.map((p) => p.pair))];
            const accs = await multiple(pairKeys);
            const pairs = {};
            pairKeys.forEach((k, i) => {
                const bytes = bytesOf(accs[i]);
                if (!bytes) return;
                const r = reader(bytes);
                const binStep = r.u16(80);
                const baseFactor = r.u16(8);
                const power = r.u8(34);
                pairs[k] = { active: r.i32(76), binStep, mintX: r.key(88), mintY: r.key(120), feePips: Math.round(baseFactor * binStep * 10 * 10 ** power / 1e9 * 1e6) };
            });
            const dec = await mintDecimals([...new Set(Object.values(pairs).flatMap((p) => [p.mintX, p.mintY]))]);
            return positions.map((p) => {
                const pair = pairs[p.pair];
                if (!pair) return null;
                const scale = 10 ** (dec[pair.mintX] - dec[pair.mintY]);
                const priceAt = (bin) => (1 + pair.binStep / 10000) ** bin * scale;
                return {
                    dex: 'Meteora', id: p.id, fee: pair.feePips,
                    token0: pair.mintX, token1: pair.mintY, decimals0: dec[pair.mintX], decimals1: dec[pair.mintY],
                    priceLower: priceAt(p.lower), priceUpper: priceAt(p.upper + 1), priceNow: priceAt(pair.active),
                    inRange: pair.active >= p.lower && pair.active <= p.upper,
                    rangePos: (pair.active - p.lower) / Math.max(1, p.upper - p.lower + 1),
                    amount0: null, amount1: null, owed0: 0, owed1: 0, bins: true,
                };
            }).filter(Boolean);
        }

        async function readWallet(owner) {
            const errors = [];
            const bal = await balances(owner);
            const nftMints = bal.tokens.filter((t) => t.decimals === 0 && t.raw === '1').map((t) => t.mint);
            const [clmm, dlmm] = await Promise.all([
                clmmPositions(nftMints, errors).catch((e) => { errors.push(`Orca/Raydium: ${e.message}`); return []; }),
                meteoraPositions(owner, errors),
            ]);
            const positionMints = new Set(clmm.map((p) => p.id));
            return {
                native: bal.native,
                tokens: bal.tokens.filter((t) => t.amount > 0 && !positionMints.has(t.mint) && !(t.decimals === 0 && t.raw === '1')),
                positions: [...clmm.filter((p) => !p.closed), ...dlmm],
                closedCount: clmm.filter((p) => p.closed).length,
                errors,
            };
        }

        return { readWallet };
    }

    root.SolanaCore = { create, PROGRAMS, base58, KNOWN_MINTS };
})(typeof window !== 'undefined' ? window : globalThis);
