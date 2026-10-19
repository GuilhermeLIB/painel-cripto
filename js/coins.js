// Metadados das criptos mais conhecidas. Qualquer outro par USDT da Binance
// também funciona: recebe o próprio símbolo como nome e uma cor derivada dele.
window.App = window.App || {};

(function (App) {
    const KNOWN = {
        BTC: { name: 'Bitcoin', color: '#F7931A' },
        ETH: { name: 'Ethereum', color: '#8C8CF6' },
        SOL: { name: 'Solana', color: '#14F195' },
        BNB: { name: 'BNB', color: '#F3BA2F' },
        XRP: { name: 'XRP', color: '#7EA6C9' },
        ADA: { name: 'Cardano', color: '#3C7BF0' },
        DOGE: { name: 'Dogecoin', color: '#C2A633' },
        AVAX: { name: 'Avalanche', color: '#E84142' },
        LINK: { name: 'Chainlink', color: '#4A7CF7' },
        DOT: { name: 'Polkadot', color: '#E6007A' },
        TRX: { name: 'TRON', color: '#FF4D4D' },
        LTC: { name: 'Litecoin', color: '#A6B4C8' },
        TON: { name: 'Toncoin', color: '#0098EA' },
        SUI: { name: 'Sui', color: '#6FBCF0' },
        SHIB: { name: 'Shiba Inu', color: '#FFA409' },
        UNI: { name: 'Uniswap', color: '#FF007A' },
        ATOM: { name: 'Cosmos', color: '#8C93C7' },
        NEAR: { name: 'NEAR', color: '#59D8A8' },
        APT: { name: 'Aptos', color: '#41D1B4' },
        ARB: { name: 'Arbitrum', color: '#28A0F0' },
        OP: { name: 'Optimism', color: '#FF0420' },
        PEPE: { name: 'Pepe', color: '#4C9A2A' },
        FET: { name: 'Fetch.ai', color: '#5A6BF5' },
        POL: { name: 'Polygon', color: '#8247E5' },
        HBAR: { name: 'Hedera', color: '#9AA3B5' },
        XLM: { name: 'Stellar', color: '#A0A8C0' },
        BCH: { name: 'Bitcoin Cash', color: '#0AC18E' },
        ETC: { name: 'Ethereum Classic', color: '#3AB83A' },
        RENDER: { name: 'Render', color: '#E8443A' },
        INJ: { name: 'Injective', color: '#25A3F2' },
        AAVE: { name: 'Aave', color: '#B6509E' },
        FIL: { name: 'Filecoin', color: '#0090FF' },
    };

    // Ícones do pacote cryptocurrency-icons (versão fixa). Os que não existem caem no avatar com a inicial.
    const ICON_SET = new Set(['btc', 'eth', 'sol', 'bnb', 'xrp', 'ada', 'doge', 'avax', 'link', 'dot', 'trx', 'ltc', 'uni', 'atom', 'matic', 'xlm', 'bch', 'etc', 'aave', 'fil', 'hbar', 'shib', 'near', 'usdt']);
    const ICON_BASE = 'https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color/';

    const DEFAULT_WATCHLIST = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'LINK', 'AVAX', 'DOT'];

    function hashColor(symbol) {
        let h = 0;
        for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) % 360;
        return `hsl(${h} 70% 62%)`;
    }

    function meta(symbol) {
        const known = KNOWN[symbol];
        return {
            symbol,
            name: known?.name ?? symbol,
            color: known?.color ?? hashColor(symbol),
            icon: ICON_SET.has(symbol.toLowerCase()) ? `${ICON_BASE}${symbol.toLowerCase()}.svg` : null,
        };
    }

    function avatar(symbol, size = 32) {
        const m = meta(symbol);
        const initial = App.util.escapeHtml(symbol.slice(0, 1));
        const style = `--coin:${m.color};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px`;
        if (m.icon) {
            return `<span class="coin-avatar" style="${style}"><img src="${m.icon}" alt="" loading="lazy" onerror="this.remove()"><span>${initial}</span></span>`;
        }
        return `<span class="coin-avatar" style="${style}"><span>${initial}</span></span>`;
    }

    App.coins = { meta, avatar, DEFAULT_WATCHLIST, KNOWN };
})(window.App);
