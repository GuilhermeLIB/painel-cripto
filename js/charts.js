// Gráficos: minigráficos em SVG e configuração do Lightweight Charts.
window.App = window.App || {};

(function (App) {
    function sparkline(values, { width = 120, height = 36, tone = 'flat' } = {}) {
        if (!values || values.length < 2) return `<svg class="spark" viewBox="0 0 ${width} ${height}" aria-hidden="true"></svg>`;
        const min = Math.min(...values);
        const max = Math.max(...values);
        const span = max - min || 1;
        const step = width / (values.length - 1);
        const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 6)).toFixed(1)}`);
        const area = `0,${height} ${points.join(' ')} ${width},${height}`;
        return `<svg class="spark spark-${tone}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
            <polygon points="${area}" class="spark-area"/>
            <polyline points="${points.join(' ')}" class="spark-line" vector-effect="non-scaling-stroke"/>
        </svg>`;
    }

    function css(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }

    function chartOptions(extra = {}) {
        const text = css('--ink-2');
        const grid = css('--grid');
        const border = css('--line');
        return {
            autoSize: true,
            layout: { background: { type: 'solid', color: 'transparent' }, textColor: text, fontFamily: css('--font-ui'), fontSize: 11, attributionLogo: true },
            grid: { vertLines: { color: grid }, horzLines: { color: grid } },
            rightPriceScale: { borderColor: border },
            timeScale: { borderColor: border, timeVisible: true, secondsVisible: false },
            crosshair: { mode: 0 },
            localization: { locale: 'pt-BR' },
            ...extra,
        };
    }

    function colors() {
        return { up: css('--up'), down: css('--down'), ink: css('--ink'), muted: css('--ink-3'), accent: css('--accent') };
    }

    App.charts = { sparkline, chartOptions, colors, css };
})(window.App);
