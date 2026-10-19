// Camada de dados de mercado (API pública da Binance, sem chave).
// Tudo é cotado em USDT; a conversão para reais usa o par USDT/BRL.
window.App = window.App || {};

(function (App) {
    const REST = 'https://data-api.binance.vision/api/v3';
    const WS = 'wss://data-stream.binance.vision';
    const DAY_MS = 24 * 60 * 60 * 1000;

    const cache = new Map();

    async function getJson(url) {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) {
            const error = new Error(`HTTP ${response.status} em ${url}`);
            error.status = response.status;
            throw error;
        }
        return response.json();
    }

    // Cache em memória com validade, e deduplicação de requisições simultâneas.
    function cached(key, ttlMs, loader) {
        const hit = cache.get(key);
        const now = Date.now();
        if (hit && (hit.pending || now - hit.at < ttlMs)) {
            return hit.pending ?? Promise.resolve(hit.value);
        }
        const pending = loader()
            .then((value) => {
                cache.set(key, { value, at: Date.now() });
                return value;
            })
            .catch((error) => {
                cache.delete(key);
                throw error;
            });
        cache.set(key, { pending, at: now });
        return pending;
    }

    const pair = (symbol) => `${symbol}USDT`;

    function normalizeKline(k) {
        return {
            time: Math.floor(k[0] / 1000),
            day: App.util.utcDay(k[0]),
            open: Number(k[1]),
            high: Number(k[2]),
            low: Number(k[3]),
            close: Number(k[4]),
            volume: Number(k[5]),
            quoteVolume: Number(k[7]),
        };
    }

    function klines(symbol, interval, limit = 500) {
        return cached(`k:${symbol}:${interval}:${limit}`, 60 * 1000, async () => {
            const raw = await getJson(`${REST}/klines?symbol=${pair(symbol)}&interval=${interval}&limit=${limit}`);
            return raw.map(normalizeKline);
        });
    }

    // Histórico diário completo a partir de uma data (paginado de 1000 em 1000).
    function dailyHistory(symbol, startIso) {
        const startMs = Date.UTC(...startIso.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
        return cached(`h:${symbol}:${startIso}`, 10 * 60 * 1000, async () => {
            const symbolPair = symbol === 'USDTBRL' ? 'USDTBRL' : pair(symbol);
            const out = [];
            let cursor = startMs;
            for (let page = 0; page < 12; page += 1) {
                const batch = await getJson(`${REST}/klines?symbol=${symbolPair}&interval=1d&limit=1000&startTime=${cursor}`);
                out.push(...batch);
                if (batch.length < 1000) break;
                cursor = batch[batch.length - 1][0] + DAY_MS;
            }
            return out.map(normalizeKline);
        });
    }

    function tickers(symbols) {
        if (!symbols.length) return Promise.resolve({});
        const list = [...new Set(symbols)].sort();
        return cached(`t:${list.join(',')}`, 20 * 1000, async () => {
            const encoded = encodeURIComponent(JSON.stringify(list.map(pair)));
            let raw;
            try {
                raw = await getJson(`${REST}/ticker/24hr?symbols=${encoded}`);
            } catch (error) {
                // Um único símbolo inexistente (ou deslistado) derruba o lote inteiro.
                // Nesse caso, busca um por um e ignora os inválidos.
                if (error.status !== 400) throw error;
                const results = await Promise.all(list.map((s) => getJson(`${REST}/ticker/24hr?symbol=${pair(s)}`).catch(() => null)));
                raw = results.filter(Boolean);
            }
            const out = {};
            raw.forEach((t) => {
                const symbol = t.symbol.replace(/USDT$/, '');
                out[symbol] = {
                    price: Number(t.lastPrice),
                    open: Number(t.openPrice),
                    high: Number(t.highPrice),
                    low: Number(t.lowPrice),
                    changePct: Number(t.priceChangePercent),
                    quoteVolume: Number(t.quoteVolume),
                };
            });
            return out;
        });
    }

    // Lista de todos os pares XXX/USDT negociados, ordenada por volume. Usada na busca.
    const EXCLUDE = /^(USDC|FDUSD|TUSD|BUSD|DAI|USDP|EUR|GBP|AEUR|EURI|USD1|PAXG|XUSD|BFUSD)$/;
    function universe() {
        return cached('universe', 30 * 60 * 1000, async () => {
            const raw = await getJson(`${REST}/ticker/24hr?type=MINI`);
            return raw
                .filter((t) => t.symbol.endsWith('USDT') && Number(t.quoteVolume) > 0)
                .map((t) => ({ symbol: t.symbol.replace(/USDT$/, ''), price: Number(t.lastPrice), quoteVolume: Number(t.quoteVolume) }))
                .filter((t) => t.symbol && !EXCLUDE.test(t.symbol) && !/(UP|DOWN|BULL|BEAR)$/.test(t.symbol))
                .sort((a, b) => b.quoteVolume - a.quoteVolume);
        });
    }

    // Fechamento do candle diário (UTC) de uma data. pairName é o par completo, ex.: BTCUSDT, USDTBRL.
    function closeOn(pairName, iso) {
        return cached(`c:${pairName}:${iso}`, 6 * 60 * 60 * 1000, async () => {
            const [y, m, d] = iso.split('-').map(Number);
            const start = Date.UTC(y, m - 1, d);
            const raw = await getJson(`${REST}/klines?symbol=${pairName}&interval=1d&limit=1&startTime=${start}`);
            const k = raw[0];
            if (!k || App.util.utcDay(k[0]) !== iso) return null;
            return Number(k[4]);
        });
    }

    function fxNow() {
        return cached('fx-now', 60 * 1000, async () => Number((await getJson(`${REST}/ticker/price?symbol=USDTBRL`)).price));
    }

    // ---- Streams em tempo real ----
    // Um WebSocket combinado e reconexão com espera crescente.
    function createStream(name) {
        let socket = null;
        let streams = [];
        let attempts = 0;
        let retryTimer = null;
        let lastMessage = 0;
        let healthTimer = null;
        const handlers = new Set();
        let status = 'offline';

        function setStatus(next) {
            if (status === next) return;
            status = next;
            App.util.bus.emit('stream-status', { name, status });
        }

        function open() {
            clearTimeout(retryTimer);
            if (socket) {
                const old = socket;
                socket = null;
                old.close();
            }
            if (!streams.length) {
                clearInterval(healthTimer);
                setStatus('offline');
                return;
            }
            setStatus('connecting');
            const ws = new WebSocket(`${WS}/stream?streams=${streams.join('/')}`);
            socket = ws;
            ws.addEventListener('open', () => {
                if (socket !== ws) return;
                attempts = 0;
                lastMessage = Date.now();
                setStatus('online');
            });
            ws.addEventListener('message', (event) => {
                if (socket !== ws) return;
                lastMessage = Date.now();
                if (status !== 'online') setStatus('online');
                try {
                    const payload = JSON.parse(event.data);
                    handlers.forEach((fn) => fn(payload.data ?? payload));
                } catch (error) {
                    console.error(error);
                }
            });
            ws.addEventListener('close', () => {
                if (socket !== ws) return;
                socket = null;
                scheduleRetry();
            });
            ws.addEventListener('error', () => {
                if (socket !== ws) return;
                setStatus('error');
            });
            clearInterval(healthTimer);
            healthTimer = setInterval(() => {
                if (socket && status === 'online' && Date.now() - lastMessage > 60000) {
                    setStatus('stale');
                    open();
                }
            }, 10000);
        }

        function scheduleRetry() {
            if (!streams.length) return;
            const delay = Math.min(30000, 1500 * 2 ** attempts);
            attempts += 1;
            setStatus('reconnecting');
            retryTimer = setTimeout(open, delay);
        }

        return {
            set(next) {
                const sorted = [...new Set(next)].sort();
                if (sorted.join('/') === streams.join('/') && socket) return;
                streams = sorted;
                open();
            },
            onMessage(fn) {
                handlers.add(fn);
                return () => handlers.delete(fn);
            },
            get status() { return status; },
        };
    }

    App.api = { klines, dailyHistory, tickers, universe, fxNow, closeOn, createStream, pair };
})(window.App);
