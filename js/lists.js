// Listas compartilhadas entre Mercado e Análise: manuais (do usuário) e
// automáticas (carteira, desconto pelo sinal, alertas ativos).
window.App = window.App || {};

(function (App) {
    const store = App.store;
    const S = store.state;

    // Cache de sinais (leitura do gráfico diário) por símbolo, preenchido por quem carregar os dados.
    App.signals = App.signals || {};

    const SMART = {
        'smart:portfolio': { name: 'Na carteira', hint: 'Criptos em que você tem posição. Atualiza sozinha.' },
        'smart:discount': { name: 'Com desconto', hint: 'Das suas listas e da carteira, as que o sinal diário marca como “Aportar reforçado”.' },
        'smart:alerts': { name: 'Com alerta', hint: 'Criptos com alerta de preço ativo.' },
    };

    const isSmart = (id) => String(id).startsWith('smart:');

    function name(id) {
        return isSmart(id) ? SMART[id]?.name ?? '' : store.getList(id)?.name ?? '';
    }

    function color(id) {
        return isSmart(id) ? null : store.getList(id)?.color ?? null;
    }

    function held() {
        return store.positions().filter((p) => p.qty > 0);
    }

    function symbols(id) {
        if (id === 'smart:portfolio') {
            const price = (s) => App.priceOf(s) ?? 0;
            return held().sort((a, b) => b.qty * price(b.asset) - a.qty * price(a.asset)).map((p) => p.asset);
        }
        if (id === 'smart:discount') {
            return discountPool().filter((s) => App.signals[s]?.action === 'Aportar reforçado');
        }
        if (id === 'smart:alerts') {
            return [...new Set(S.alerts.filter((a) => !a.triggeredAt).map((a) => a.asset))];
        }
        return store.getList(id)?.symbols ?? [];
    }

    function discountPool() {
        return [...new Set([...S.watchlist, ...held().map((p) => p.asset)])];
    }

    // Garante que os sinais das criptos usadas pela lista "Com desconto" estejam calculados.
    let loading = null;
    function ensureSignals(onUpdate) {
        const missing = discountPool().filter((s) => !(s in App.signals));
        if (!missing.length || loading) return loading;
        loading = (async () => {
            const queue = [...missing];
            const worker = async () => {
                while (queue.length) {
                    const s = queue.shift();
                    try { App.signals[s] = App.ind.analyze(await App.api.klines(s, '1d', 1000)); } catch { App.signals[s] = null; }
                }
            };
            await Promise.all([worker(), worker(), worker()]);
            loading = null;
            onUpdate?.();
        })();
        return loading;
    }

    App.lists = { SMART, isSmart, name, color, symbols, ensureSignals };
})(window.App);
