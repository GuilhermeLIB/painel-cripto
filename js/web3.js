// Leitura pública de carteiras Web3 (somente leitura, só pelo endereço).
// Fontes, todas sem chave: RPCs públicos (com Multicall3), Blockscout para
// descobrir tokens, DefiLlama e Binance para preços. Nunca pede chave privada.
window.App = window.App || {};

(function (App) {
    const ETHERS_URL = 'https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js';
    const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
    const MAX_UINT = 2n ** 256n - 1n;

    // Gerenciadores de posições de liquidez concentrada (endereços dos deploys oficiais).
    const UNI = (npm, factory) => ({ name: 'Uniswap v3', kind: 'v3', npm, factory });
    const PANCAKE = (masterchef = null) => ({ name: 'PancakeSwap v3', kind: 'v3', npm: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', masterchef });
    const PANCAKE_MASTERCHEF = '0x556B9306565093C855AEA9AE92A594704c2Cd59e';
    // Aerodrome Slipstream (Base): três deploys, cada um com o seu gerenciador e a sua fábrica.
    const AERO = [
        { name: 'Aerodrome', kind: 'slipstream', npm: '0x827922686190790b37229fd06084350E74485b72', factory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A' },
        { name: 'Aerodrome', kind: 'slipstream', npm: '0xa990C6a764b73BF43cee5Bb40339c3322FB9D55F', factory: '0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a' },
        { name: 'Aerodrome', kind: 'slipstream', npm: '0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53', factory: '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef' },
    ];

    // Tokens conhecidos por rede: garantem a leitura mesmo se a descoberta automática falhar.
    const T = (symbol, address, decimals) => ({ symbol, address, decimals });
    const CHAINS = {
        ethereum: {
            id: 1, name: 'Ethereum', short: 'ETH', native: 'ETH', color: '#8C8CF6', llama: 'ethereum',
            rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://cloudflare-eth.com'],
            blockscout: 'https://eth.blockscout.com', explorer: 'https://etherscan.io',
            aavePool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
            dexes: [UNI('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', '0x1F98431c8aD98523631AE4a59f267346ea31F984'), PANCAKE(PANCAKE_MASTERCHEF)],
            tokens: [
                T('WETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18), T('USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6),
                T('USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6), T('DAI', '0x6B175474E89094C44Da98b954EedeAC495271d0F', 18),
                T('WBTC', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 8), T('UNI', '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', 18),
                T('LINK', '0x514910771AF9Ca656af840dff83E8264EcF986CA', 18), T('AAVE', '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', 18),
                T('ENA', '0x57e114B691Db790C35207b2e685D4A43181e6061', 18), T('EIGEN', '0xec53bF9167f50cDEB3Ae105f56099aaaB9061F83', 18),
                T('USDe', '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3', 18), T('stETH', '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', 18),
                T('wstETH', '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', 18),
            ],
        },
        arbitrum: {
            id: 42161, name: 'Arbitrum', short: 'ARB', native: 'ETH', color: '#28A0F0', llama: 'arbitrum',
            rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
            blockscout: 'https://arbitrum.blockscout.com', explorer: 'https://arbiscan.io',
            aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
            dexes: [UNI('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', '0x1F98431c8aD98523631AE4a59f267346ea31F984'), PANCAKE()],
            tokens: [
                T('WETH', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 18), T('USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6),
                T('USDT', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6), T('DAI', '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 18),
                T('WBTC', '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', 8), T('ARB', '0x912CE59144191C1204E64559FE8253a0e49E6548', 18),
                T('LINK', '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', 18), T('UNI', '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0', 18),
                T('AAVE', '0xba5DdD1f9d7F570dc94a51479a000E3BCE967196', 18),
            ],
        },
        base: {
            id: 8453, name: 'Base', short: 'BASE', native: 'ETH', color: '#3B6CF6', llama: 'base',
            rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
            blockscout: 'https://base.blockscout.com', explorer: 'https://basescan.org',
            aavePool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
            dexes: [UNI('0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1', '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'), ...AERO, PANCAKE()],
            tokens: [
                T('WETH', '0x4200000000000000000000000000000000000006', 18), T('USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6),
                T('DAI', '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', 18), T('cbBTC', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 8),
                T('AERO', '0x940181a94A35A4569E4529A3CDfB74e38FD98631', 18),
            ],
        },
        optimism: {
            id: 10, name: 'Optimism', short: 'OP', native: 'ETH', color: '#FF0420', llama: 'optimism',
            rpcs: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
            blockscout: 'https://optimism.blockscout.com', explorer: 'https://optimistic.etherscan.io',
            aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
            dexes: [UNI('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', '0x1F98431c8aD98523631AE4a59f267346ea31F984')],
            tokens: [
                T('WETH', '0x4200000000000000000000000000000000000006', 18), T('USDC', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6),
                T('USDT', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6), T('OP', '0x4200000000000000000000000000000000000042', 18),
                T('LINK', '0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6', 18),
            ],
        },
        polygon: {
            id: 137, name: 'Polygon', short: 'POL', native: 'POL', color: '#8247E5', llama: 'polygon',
            rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
            blockscout: 'https://polygon.blockscout.com', explorer: 'https://polygonscan.com',
            aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
            dexes: [UNI('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', '0x1F98431c8aD98523631AE4a59f267346ea31F984')],
            tokens: [
                T('WETH', '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 18), T('USDC', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6),
                T('USDT', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6), T('WPOL', '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', 18),
                T('LINK', '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', 18), T('AAVE', '0xD6DF932A45C0f255f85145f286eA0b292B21C90B', 18),
                T('UNI', '0xb33EaAd8d922B1083446DC23f610c2567fB5180f', 18),
            ],
        },
        bnb: {
            id: 56, name: 'BNB Chain', short: 'BNB', native: 'BNB', color: '#F3BA2F', llama: 'bsc',
            rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'],
            blockscout: null, explorer: 'https://bscscan.com',
            aavePool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
            dexes: [PANCAKE(PANCAKE_MASTERCHEF), UNI('0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613', '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7')],
            tokens: [
                T('WBNB', '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 18), T('USDT', '0x55d398326f99059fF775485246999027B3197955', 18),
                T('USDC', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18), T('BTCB', '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', 18),
                T('ETH', '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', 18), T('CAKE', '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', 18),
                T('FDUSD', '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409', 18), T('wstETH', '0x26c5e01524d2E6280A48F2c50fF6De7e52E9611C', 18),
            ],
        },
        solana: {
            id: 'solana', name: 'Solana', short: 'SOL', native: 'SOL', color: '#14F195', llama: 'solana', solana: true,
            rpcs: ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'],
            explorer: 'https://solscan.io/account', tokens: [], dexes: [],
        },
    };

    const EVM_CHAINS = Object.keys(CHAINS).filter((k) => !CHAINS[k].solana);
    const isSolanaAddress = (value) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value).trim()) && !/^0x/i.test(String(value).trim());

    const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDE', 'USDC.E', 'USDBC', 'FDUSD', 'PYUSD', 'USDS', 'GHO', 'LUSD', 'FRAX', 'USDT0', 'USD1', 'USDG']);

    // ---------- ethers (carregado sob demanda) ----------
    let ethersPromise = null;
    function loadEthers() {
        if (window.ethers) return Promise.resolve(window.ethers);
        if (!ethersPromise) {
            ethersPromise = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = ETHERS_URL;
                s.onload = () => (window.ethers ? resolve(window.ethers) : reject(new Error('ethers indisponível')));
                s.onerror = () => { ethersPromise = null; reject(new Error('Não foi possível carregar a biblioteca ethers')); };
                document.head.appendChild(s);
            });
        }
        return ethersPromise;
    }

    let IFACE = null;
    function ifaces(E) {
        if (IFACE) return IFACE;
        IFACE = {
            erc20: new E.Interface([
                'function balanceOf(address) view returns (uint256)',
                'function decimals() view returns (uint8)',
                'function symbol() view returns (string)',
            ]),
            mc: new E.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])']),
            aave: new E.Interface(['function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)']),
            npm: new E.Interface([
                'function balanceOf(address owner) view returns (uint256)',
                'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
                'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
            ]),
            factory: new E.Interface(['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)']),
            // Só os dois primeiros campos de slot0: o restante muda entre Uniswap, PancakeSwap e Aerodrome.
            pool: new E.Interface(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick)', 'function fee() view returns (uint24)']),
            npmSlip: new E.Interface(['function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)']),
            factorySlip: new E.Interface(['function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)']),
            nft: new E.Interface(['function ownerOf(uint256 tokenId) view returns (address)']),
            gauge: new E.Interface(['function stakedContains(address depositor, uint256 tokenId) view returns (bool)']),
        };
        return IFACE;
    }

    // ---------- RPC ----------
    function settings() {
        return App.store.state.web3Settings;
    }

    async function rpc(chainKey, method, params) {
        const chain = CHAINS[chainKey];
        const custom = settings().rpc?.[chainKey];
        const urls = [...(custom ? [custom] : []), ...chain.rpcs];
        let lastError;
        for (const url of urls) {
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const body = await response.json();
                if (body.error) throw new Error(body.error.message || 'erro no RPC');
                return body.result;
            } catch (error) {
                lastError = error;
            }
        }
        throw new Error(`${chain.name}: nenhum RPC respondeu (${lastError?.message ?? 'erro'})`);
    }

    // Executa várias leituras numa só chamada (Multicall3). Falhas individuais viram null.
    async function multicall(chainKey, calls) {
        const E = await loadEthers();
        const I = ifaces(E);
        const out = [];
        for (let i = 0; i < calls.length; i += 120) {
            const chunk = calls.slice(i, i + 120);
            const data = I.mc.encodeFunctionData('aggregate3', [chunk.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))]);
            const raw = await rpc(chainKey, 'eth_call', [{ to: MULTICALL3, data }, 'latest']);
            const [results] = I.mc.decodeFunctionResult('aggregate3', raw);
            results.forEach((r) => out.push(r.success && r.returnData !== '0x' ? r.returnData : null));
        }
        return out;
    }

    // ---------- Descoberta de tokens (Blockscout) ----------
    async function discoverTokens(chainKey, address) {
        const chain = CHAINS[chainKey];
        const key = settings().blockscoutKey?.trim();
        if (!chain.blockscout && !key) throw new Error('sem descoberta automática nesta rede');
        const url = key
            ? `https://api.blockscout.com/${chain.id}/api/v2/addresses/${address}/token-balances?apikey=${encodeURIComponent(key)}`
            : `${chain.blockscout}/api/v2/addresses/${address}/token-balances`;
        const response = await fetch(url, { headers: { accept: 'application/json' } });
        if (response.status === 404) return [];
        if (!response.ok) throw new Error(`Blockscout HTTP ${response.status}`);
        const list = await response.json();
        if (!Array.isArray(list)) throw new Error('Resposta inesperada do Blockscout');
        return list
            .filter((item) => item.token?.type === 'ERC-20' && item.value && item.value !== '0')
            .map((item) => ({
                address: item.token.address_hash ?? item.token.address,
                symbol: item.token.symbol || '?',
                name: item.token.name || '',
                decimals: Number(item.token.decimals ?? 18),
                raw: item.value,
                rate: item.token.exchange_rate ? Number(item.token.exchange_rate) : null,
                reputation: item.token.reputation ?? 'ok',
            }));
    }

    async function readKnownTokens(chainKey, address, extra) {
        const E = await loadEthers();
        const I = ifaces(E);
        const list = [...CHAINS[chainKey].tokens, ...extra];
        const data = I.erc20.encodeFunctionData('balanceOf', [address]);
        const res = await multicall(chainKey, list.map((t) => ({ target: t.address, data })));
        return list.map((t, i) => {
            if (!res[i]) return null;
            const [bal] = I.erc20.decodeFunctionResult('balanceOf', res[i]);
            return bal > 0n ? { address: t.address, symbol: t.symbol, name: t.symbol, decimals: t.decimals, raw: bal.toString(), rate: null, reputation: 'ok' } : null;
        }).filter(Boolean);
    }

    const tokenInfoCache = new Map();
    async function tokenInfo(chainKey, addresses) {
        const E = await loadEthers();
        const I = ifaces(E);
        const missing = addresses.filter((a) => !tokenInfoCache.has(`${chainKey}:${a.toLowerCase()}`));
        if (missing.length) {
            const calls = missing.flatMap((a) => [
                { target: a, data: I.erc20.encodeFunctionData('symbol', []) },
                { target: a, data: I.erc20.encodeFunctionData('decimals', []) },
            ]);
            const res = await multicall(chainKey, calls);
            missing.forEach((a, i) => {
                let symbol = '?';
                let decimals = 18;
                try { [symbol] = I.erc20.decodeFunctionResult('symbol', res[i * 2]); } catch { /* token sem symbol padrão */ }
                try { decimals = Number(I.erc20.decodeFunctionResult('decimals', res[i * 2 + 1])[0]); } catch { /* padrão 18 */ }
                tokenInfoCache.set(`${chainKey}:${a.toLowerCase()}`, { symbol, decimals });
            });
        }
        return Object.fromEntries(addresses.map((a) => [a.toLowerCase(), tokenInfoCache.get(`${chainKey}:${a.toLowerCase()}`)]));
    }

    // ---------- Preços ----------
    function underlying(symbol) {
        const s = String(symbol).toUpperCase();
        if (STABLES.has(s)) return 'USD';
        const map = {
            WETH: 'ETH', STETH: 'ETH', WSTETH: 'ETH', WEETH: 'ETH', CBETH: 'ETH', RETH: 'ETH',
            WBTC: 'BTC', CBBTC: 'BTC', TBTC: 'BTC', BTCB: 'BTC',
            WPOL: 'POL', WMATIC: 'POL', MATIC: 'POL', WBNB: 'BNB',
            WSOL: 'SOL', JITOSOL: 'SOL', MSOL: 'SOL', JUPSOL: 'SOL', BSOL: 'SOL', BNSOL: 'SOL', INF: 'SOL',
        };
        return map[s] ?? s;
    }

    function binancePrice(symbol) {
        const u = underlying(symbol);
        if (u === 'USD') return 1;
        return App.priceOf(u);
    }

    async function llamaPrices(keys) {
        const out = {};
        for (let i = 0; i < keys.length; i += 80) {
            const chunk = keys.slice(i, i + 80);
            try {
                const response = await fetch(`https://coins.llama.fi/prices/current/${chunk.join(',')}`);
                if (!response.ok) continue;
                const body = await response.json();
                Object.entries(body.coins ?? {}).forEach(([k, v]) => { out[k.toLowerCase()] = { price: Number(v.price), symbol: v.symbol, decimals: v.decimals }; });
            } catch { /* segue com outras fontes */ }
        }
        return out;
    }

    // ---------- Aave v3 ----------
    async function aave(chainKey, address) {
        const chain = CHAINS[chainKey];
        if (!chain.aavePool) return null;
        const E = await loadEthers();
        const I = ifaces(E);
        const [res] = await multicall(chainKey, [{ target: chain.aavePool, data: I.aave.encodeFunctionData('getUserAccountData', [address]) }]);
        if (!res) return null;
        const r = I.aave.decodeFunctionResult('getUserAccountData', res);
        const collateral = Number(r[0]) / 1e8;
        const debt = Number(r[1]) / 1e8;
        if (!collateral && !debt) return null;
        return {
            collateral,
            debt,
            available: Number(r[2]) / 1e8,
            liquidationThreshold: Number(r[3]) / 100,
            ltv: Number(r[4]) / 100,
            healthFactor: r[5] >= MAX_UINT / 2n ? Infinity : Number(r[5]) / 1e18,
        };
    }

    // ---------- Uniswap v3 ----------
    function amountsFromLiquidity(liquidity, sqrtPriceX96, tickLower, tickUpper) {
        const L = Number(liquidity);
        const sp = Number(sqrtPriceX96) / 2 ** 96;
        const sa = Math.sqrt(1.0001 ** tickLower);
        const sb = Math.sqrt(1.0001 ** tickUpper);
        if (sp <= sa) return [L * (sb - sa) / (sa * sb), 0];
        if (sp < sb) return [L * (sb - sp) / (sp * sb), L * (sp - sa)];
        return [0, L * (sb - sa)];
    }

    // Lista os NFTs de posição de um contrato "enumerável" (gerenciador ou MasterChef).
    async function enumerate(chainKey, contract, owner) {
        const E = await loadEthers();
        const I = ifaces(E);
        const [countRaw] = await multicall(chainKey, [{ target: contract, data: I.npm.encodeFunctionData('balanceOf', [owner]) }]);
        if (!countRaw) return [];
        const count = Math.min(40, Number(I.npm.decodeFunctionResult('balanceOf', countRaw)[0]));
        if (!count) return [];
        const idsRaw = await multicall(chainKey, Array.from({ length: count }, (_, i) => ({ target: contract, data: I.npm.encodeFunctionData('tokenOfOwnerByIndex', [owner, i]) })));
        return idsRaw.filter(Boolean).map((r) => I.npm.decodeFunctionResult('tokenOfOwnerByIndex', r)[0]);
    }

    // Posições do Aerodrome depositadas em gauge (staking): o NFT sai da carteira.
    // Descobre pelos NFTs que a carteira enviou (Blockscout) e confirma no gauge.
    async function stakedInGauges(chainKey, owner, dex) {
        const chain = CHAINS[chainKey];
        if (!chain.blockscout) return [];
        const key = settings().blockscoutKey?.trim();
        const base = key ? `https://api.blockscout.com/${chain.id}/api/v2` : `${chain.blockscout}/api/v2`;
        const url = `${base}/addresses/${owner}/token-transfers?type=ERC-721&filter=from&token=${dex.npm}${key ? `&apikey=${encodeURIComponent(key)}` : ''}`;
        const response = await fetch(url, { headers: { accept: 'application/json' } });
        if (!response.ok) return [];
        const body = await response.json();
        const ids = [...new Set((body.items ?? []).map((it) => it.total?.token_id ?? it.token_id).filter(Boolean))].slice(0, 40).map((v) => BigInt(v));
        if (!ids.length) return [];
        const E = await loadEthers();
        const I = ifaces(E);
        const owners = await multicall(chainKey, ids.map((id) => ({ target: dex.npm, data: I.nft.encodeFunctionData('ownerOf', [id]) })));
        const candidates = ids.map((id, i) => ({ id, holder: owners[i] ? I.nft.decodeFunctionResult('ownerOf', owners[i])[0] : null }))
            .filter((c) => c.holder && c.holder.toLowerCase() !== owner.toLowerCase());
        if (!candidates.length) return [];
        const checks = await multicall(chainKey, candidates.map((c) => ({ target: c.holder, data: I.gauge.encodeFunctionData('stakedContains', [owner, c.id]) })));
        return candidates.filter((c, i) => checks[i] && I.gauge.decodeFunctionResult('stakedContains', checks[i])[0]).map((c) => c.id);
    }

    // Posições de liquidez concentrada de um app (Uniswap v3, PancakeSwap v3, Aerodrome Slipstream).
    async function readDex(chainKey, owner, dex) {
        const E = await loadEthers();
        const I = ifaces(E);
        const slip = dex.kind === 'slipstream';
        const own = await enumerate(chainKey, dex.npm, owner);
        const stakedIds = [
            ...(dex.masterchef ? await enumerate(chainKey, dex.masterchef, owner).catch(() => []) : []),
            ...(slip ? await stakedInGauges(chainKey, owner, dex).catch(() => []) : []),
        ];
        const all = [...own.map((id) => ({ id, staked: false })), ...stakedIds.map((id) => ({ id, staked: true }))];
        if (!all.length) return [];
        const posAbi = slip ? I.npmSlip : I.npm;
        const posRaw = await multicall(chainKey, all.map((x) => ({ target: dex.npm, data: posAbi.encodeFunctionData('positions', [x.id]) })));
        const positions = posRaw.map((r, i) => {
            if (!r) return null;
            const p = posAbi.decodeFunctionResult('positions', r);
            return { id: all[i].id.toString(), staked: all[i].staked, token0: p[2], token1: p[3], feeOrSpacing: Number(p[4]), tickLower: Number(p[5]), tickUpper: Number(p[6]), liquidity: p[7], owed0: p[10], owed1: p[11] };
        }).filter(Boolean);
        const active = positions.filter((p) => p.liquidity > 0n);
        const closed = positions.length - active.length;
        if (!active.length) return closed ? [{ closedCount: closed, dex: dex.name }] : [];
        const factoryAbi = slip ? I.factorySlip : I.factory;
        const poolRaw = await multicall(chainKey, active.map((p) => ({ target: dex.factory, data: factoryAbi.encodeFunctionData('getPool', [p.token0, p.token1, p.feeOrSpacing]) })));
        const pools = poolRaw.map((r) => (r ? factoryAbi.decodeFunctionResult('getPool', r)[0] : null));
        const slotRaw = await multicall(chainKey, pools.map((pool) => ({ target: pool ?? MULTICALL3, data: I.pool.encodeFunctionData('slot0', []) })));
        const feeRaw = slip ? await multicall(chainKey, pools.map((pool) => ({ target: pool ?? MULTICALL3, data: I.pool.encodeFunctionData('fee', []) }))) : [];
        const infos = await tokenInfo(chainKey, [...new Set(active.flatMap((p) => [p.token0, p.token1]))]);
        const result = active.map((p, i) => {
            if (!slotRaw[i]) return { ...p, error: true };
            const [sqrtPriceX96, tick] = I.pool.decodeFunctionResult('slot0', slotRaw[i]);
            const [a0, a1] = amountsFromLiquidity(p.liquidity, sqrtPriceX96, p.tickLower, p.tickUpper);
            const i0 = infos[p.token0.toLowerCase()];
            const i1 = infos[p.token1.toLowerCase()];
            const scale = 10 ** (i0.decimals - i1.decimals);
            const tickPrice = (t) => 1.0001 ** t * scale;
            const fee = slip ? (feeRaw[i] ? Number(I.pool.decodeFunctionResult('fee', feeRaw[i])[0]) : null) : p.feeOrSpacing;
            return {
                id: p.id, dex: dex.name, staked: p.staked, fee, token0: p.token0, token1: p.token1,
                symbol0: i0.symbol, symbol1: i1.symbol,
                tickLower: p.tickLower, tickUpper: p.tickUpper, tick: Number(tick),
                priceLower: tickPrice(p.tickLower), priceUpper: tickPrice(p.tickUpper), priceNow: (Number(sqrtPriceX96) / 2 ** 96) ** 2 * scale,
                amount0: a0 / 10 ** i0.decimals, amount1: a1 / 10 ** i1.decimals,
                owed0: Number(p.owed0) / 10 ** i0.decimals, owed1: Number(p.owed1) / 10 ** i1.decimals,
                inRange: Number(tick) >= p.tickLower && Number(tick) < p.tickUpper,
            };
        });
        return closed ? [...result, { closedCount: closed, dex: dex.name }] : result;
    }

    async function concentrated(chainKey, owner, errors) {
        const out = [];
        for (const dex of CHAINS[chainKey].dexes ?? []) {
            try {
                out.push(...await readDex(chainKey, owner, dex));
            } catch (error) {
                errors.push(`${dex.name}: ${error.message}`);
            }
        }
        return out;
    }

    // ---------- Leitura completa de uma carteira ----------
    function classify(symbol) {
        const s = String(symbol);
        if (/^(variableDebt|stableDebt)/i.test(s)) return 'aave-debt';
        if (/^a(Eth|Arb|Bas|Opt|Pol|Ava)[A-Z]/.test(s)) return 'aave-supply';
        if (/UNI-V2|SLP|-LP$|^vAMM|^sAMM|^aero/i.test(s)) return 'lp-token';
        return 'token';
    }

    async function readChain(chainKey, address) {
        const chain = CHAINS[chainKey];
        const result = { chain: chainKey, native: 0, tokens: [], aave: null, uni: [], errors: [], discovery: 'blockscout' };
        const E = await loadEthers();
        const extra = (settings().customTokens ?? []).filter((t) => t.chain === chainKey);

        const [nativeRaw, discovered, aaveData, uniData] = await Promise.all([
            rpc(chainKey, 'eth_getBalance', [address, 'latest']).catch((e) => { result.errors.push(e.message); return null; }),
            discoverTokens(chainKey, address).catch(() => null),
            aave(chainKey, address).catch((e) => { result.errors.push(`Aave: ${e.message}`); return null; }),
            concentrated(chainKey, address, result.errors),
        ]);
        result.native = nativeRaw ? Number(E.formatEther(BigInt(nativeRaw))) : 0;
        result.aave = aaveData;
        result.uni = uniData;

        let tokens = discovered;
        if (!tokens) {
            result.discovery = 'lista';
            tokens = await readKnownTokens(chainKey, address, extra).catch((e) => { result.errors.push(e.message); return []; });
        } else if (extra.length) {
            const known = new Set(tokens.map((t) => t.address.toLowerCase()));
            const more = await readKnownTokens(chainKey, address, extra).catch(() => []);
            more.filter((t) => !known.has(t.address.toLowerCase())).forEach((t) => tokens.push(t));
        }
        result.tokens = tokens.map((t) => ({
            ...t,
            amount: Number(E.formatUnits(BigInt(t.raw), t.decimals)),
            kind: classify(t.symbol),
            chain: chainKey,
        }));
        return result;
    }

    async function readWallet(wallet) {
        let parts;
        if (isSolanaAddress(wallet.address)) {
            parts = [await readSolana(String(wallet.address).trim()).catch((e) => ({ chain: 'solana', native: 0, tokens: [], uni: [], aave: null, errors: [e.message] }))];
        } else {
            const E = await loadEthers();
            // Normaliza o endereço (aceita minúsculas ou maiúsculas sem checksum).
            const address = E.getAddress(String(wallet.address).trim().toLowerCase());
            const chains = (wallet.chains?.length ? wallet.chains : EVM_CHAINS).filter((c) => EVM_CHAINS.includes(c));
            parts = await Promise.all(chains.map((c) => readChain(c, address).catch((e) => ({ chain: c, native: 0, tokens: [], uni: [], aave: null, errors: [e.message] }))));
        }

        // Preços: DefiLlama por contrato; Binance por símbolo como reserva.
        const keys = [];
        parts.forEach((p) => {
            p.tokens.forEach((t) => keys.push(`${CHAINS[p.chain].llama}:${t.address}`));
            p.uni.forEach((u) => { if (u.token0) keys.push(`${CHAINS[p.chain].llama}:${u.token0}`, `${CHAINS[p.chain].llama}:${u.token1}`); });
        });
        const llama = await llamaPrices([...new Set(keys)]);
        const priceOf = (chainKey, address, symbol, rate) => llama[`${CHAINS[chainKey].llama}:${String(address).toLowerCase()}`]?.price ?? binancePrice(symbol) ?? rate ?? null;

        let total = 0;
        const lines = [];
        parts.forEach((p) => {
            const chain = CHAINS[p.chain];
            const nativePrice = binancePrice(chain.native);
            if (p.native > 0) {
                const usd = nativePrice ? p.native * nativePrice : null;
                lines.push({ chain: p.chain, symbol: chain.native, name: `${chain.native} nativo`, amount: p.native, price: nativePrice, usd, kind: 'native', address: null, reputation: 'ok' });
            }
            p.tokens.forEach((t) => {
                const base = t.kind === 'aave-supply' ? t.symbol.replace(/^a(Eth|Arb|Bas|Opt|Pol|Ava)/, '') : t.kind === 'aave-debt' ? t.symbol.replace(/^(variable|stable)Debt(Eth|Arb|Bas|Opt|Pol|Ava)?/i, '') : t.symbol;
                const price = priceOf(p.chain, t.address, base, t.rate);
                lines.push({ ...t, base, price, usd: price ? t.amount * price : null });
            });
            p.uni.forEach((u) => {
                if (!u.symbol0) return;
                if (u.amount0 === null || u.amount1 === null) { u.usd = null; u.priced = false; return; }
                const p0 = priceOf(p.chain, u.token0, u.symbol0);
                const p1 = priceOf(p.chain, u.token1, u.symbol1);
                u.usd = (p0 ? (u.amount0 + u.owed0) * p0 : 0) + (p1 ? (u.amount1 + u.owed1) * p1 : 0);
                u.priced = Boolean(p0 && p1);
            });
        });

        // Valor líquido: tokens comuns + nativo + pools + (colateral − dívida no Aave).
        lines.forEach((l) => { if ((l.kind === 'token' || l.kind === 'native' || l.kind === 'lp-token') && l.usd && l.reputation === 'ok') total += l.usd; });
        parts.forEach((p) => {
            p.uni.forEach((u) => { if (u.usd) total += u.usd; });
            if (p.aave) total += p.aave.collateral - p.aave.debt;
        });

        return { at: Date.now(), total, lines, parts };
    }

    // ---------- Solana ----------
    const SOLANA_LIB = 'https://cdn.jsdelivr.net/npm/@solana/web3.js@1.98.0/lib/index.iife.min.js';
    let solanaPromise = null;
    function loadSolana() {
        if (window.solanaWeb3) return Promise.resolve(window.solanaWeb3);
        if (!solanaPromise) {
            solanaPromise = new Promise((resolve, reject) => {
                const sc = document.createElement('script');
                sc.src = SOLANA_LIB;
                sc.onload = () => (window.solanaWeb3 ? resolve(window.solanaWeb3) : reject(new Error('biblioteca Solana indisponível')));
                sc.onerror = () => { solanaPromise = null; reject(new Error('Não foi possível carregar a biblioteca Solana')); };
                document.head.appendChild(sc);
            });
        }
        return solanaPromise;
    }

    async function solRpc(method, params) {
        const custom = settings().rpc?.solana;
        const urls = [...(custom ? [custom] : []), ...CHAINS.solana.rpcs];
        let last;
        for (const url of urls) {
            try {
                const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const body = await r.json();
                if (body.error) throw new Error(body.error.message || 'erro no RPC');
                return body.result;
            } catch (error) { last = error; }
        }
        throw new Error(`Solana: nenhum RPC respondeu (${last?.message ?? 'erro'})`);
    }

    function b64(data) {
        const bin = atob(data);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
        return out;
    }

    async function readSolana(owner) {
        const web3 = await loadSolana();
        const core = window.SolanaCore.create({ rpc: solRpc, PublicKey: web3.PublicKey, decode: b64 });
        const res = await core.readWallet(owner);
        // Símbolos e preços dos mints pela DefiLlama.
        const mints = [...new Set([...res.tokens.map((t) => t.mint), ...res.positions.flatMap((p) => [p.token0, p.token1])])];
        const info = await llamaPrices(mints.map((m) => `solana:${m}`));
        const symbolOf = (mint) => info[`solana:${mint}`.toLowerCase()]?.symbol ?? window.SolanaCore.KNOWN_MINTS[mint] ?? `${mint.slice(0, 4)}…`;
        const tokens = res.tokens.map((t) => {
            const known = info[`solana:${t.mint}`.toLowerCase()];
            const sym = known?.symbol ?? window.SolanaCore.KNOWN_MINTS[t.mint];
            return { address: t.mint, symbol: sym ?? `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}`, name: sym ?? 'Token sem preço', decimals: t.decimals, raw: t.raw, amount: t.amount, rate: null, reputation: sym ? 'ok' : 'unknown', kind: 'token', chain: 'solana' };
        });
        const uni = res.positions.map((p) => ({ ...p, symbol0: symbolOf(p.token0), symbol1: symbolOf(p.token1) }));
        if (res.closedCount) uni.push({ closedCount: res.closedCount, dex: 'Orca/Raydium' });
        return { chain: 'solana', native: res.native, tokens, aave: null, uni, errors: res.errors, discovery: 'rpc' };
    }

    function isAddress(value) {
        return /^0x[0-9a-fA-F]{40}$/.test(String(value).trim()) || isSolanaAddress(value);
    }

    function shortAddress(address) {
        return `${address.slice(0, 6)}…${address.slice(-4)}`;
    }

        async function gasPriceGwei(chainKey) {
        const hex = await rpc(chainKey, 'eth_gasPrice', []);
        return Number(BigInt(hex)) / 1e9;
    }

    App.web3 = { CHAINS, EVM_CHAINS, readWallet, isAddress, isSolanaAddress, shortAddress, underlying, loadEthers, tokenInfo, rpc, gasPriceGwei, STABLES };
})(window.App);
