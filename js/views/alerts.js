// Tela "Alertas": avisos quando uma cripto passa de um preço.
window.App = window.App || {};
App.views = App.views || {};

(function (App) {
    const { $, html, raw, fmt, bus, toast } = App.util;
    const store = App.store;
    const S = store.state;
    let root = null;
    let offs = [];

    function render() {
        if (!root) return;
        const active = S.alerts.filter((a) => !a.triggeredAt);
        const done = S.alerts.filter((a) => a.triggeredAt).sort((a, b) => b.triggeredAt - a.triggeredAt);
        const row = (a) => {
            const price = App.priceOf(a.asset);
            const gap = price ? ((a.price - price) / price) * 100 : null;
            return html`<li class="alert-row${a.triggeredAt ? ' is-done' : ''}" style="--coin:${App.coins.meta(a.asset).color}">
                <a class="coin-inline" href="#/ativo/${a.asset}">${raw(App.coins.avatar(a.asset, 28))}<strong>${a.asset}</strong></a>
                <span>${a.condition === 'above' ? 'Subir acima de' : 'Cair abaixo de'} <strong>${fmt.money(a.price)}</strong></span>
                <span class="muted">${a.triggeredAt
                    ? `Disparou em ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(a.triggeredAt)} a ${fmt.money(a.triggeredPrice)}`
                    : (gap === null ? 'Aguardando preço' : `Falta ${fmt.pct(gap).replace(/^[+−]/, '')} · agora ${fmt.money(price)}`)}</span>
                <button class="icon-btn" type="button" data-del="${a.id}" aria-label="Apagar alerta de ${a.asset}">✕</button>
            </li>`;
        };
        $('#alertsActive', root).innerHTML = active.length ? active.map(row).join('') : '<li class="empty-cell">Nenhum alerta ativo.</li>';
        $('#alertsDone', root).innerHTML = done.length ? done.map(row).join('') : '<li class="empty-cell">Nenhum alerta disparado ainda.</li>';
        const perm = 'Notification' in window ? Notification.permission : 'unsupported';
        const note = $('#notifyState', root);
        note.innerHTML = perm === 'granted'
            ? 'Notificações do navegador ativadas. Os alertas só são verificados com o painel aberto.'
            : perm === 'denied'
                ? 'O navegador bloqueou as notificações. Os alertas aparecem só dentro do painel, que precisa estar aberto.'
                : perm === 'unsupported'
                    ? 'Este navegador não mostra notificações aqui (abrir pelo arquivo local limita isso). Os alertas aparecem dentro do painel.'
                    : html`Os alertas são verificados enquanto o painel está aberto. ${raw('<button class="btn btn-small" type="button" id="askNotify">Ativar notificações</button>')}`;
        $('#askNotify', root)?.addEventListener('click', async () => {
            await Notification.requestPermission();
            render();
        });
    }

    App.views.alertas = {
        title: 'Alertas',
        mount(el, params = [], opts = {}) {
            root = el;
            el.innerHTML = html`
                ${raw(opts.embedded ? '<p class="muted small" id="notifyState"></p>' : '<header class="page-head"><div><h1>Alertas de preço</h1><p class="lede" id="notifyState"></p></div></header>')}
                <section class="panel">
                    <h2 class="panel-title">Novo alerta</h2>
                    <form id="newAlert" class="sim-form">
                        <label>Cripto<select id="naAsset" class="input">${raw(S.watchlist.map((a) => html`<option>${a}</option>`).join(''))}</select></label>
                        <label>Quando<select id="naCond" class="input"><option value="above">Subir acima de</option><option value="below">Cair abaixo de</option></select></label>
                        <label>Preço (US$)<input id="naPrice" class="input" inputmode="decimal" autocomplete="off" required></label>
                        <button class="btn btn-primary" type="submit">Criar alerta</button>
                    </form>
                    <p id="naHint" class="footnote"></p>
                </section>
                <section class="panel"><h2 class="panel-title">Ativos</h2><ul id="alertsActive" class="alert-rows"></ul></section>
                <section class="panel"><h2 class="panel-title">Disparados</h2><ul id="alertsDone" class="alert-rows"></ul></section>`;
            const hint = () => {
                const p = App.priceOf($('#naAsset', el).value);
                $('#naHint', el).textContent = p ? `Preço atual de ${$('#naAsset', el).value}: ${fmt.money(p)}` : '';
            };
            $('#naAsset', el).addEventListener('change', hint);
            $('#newAlert', el).addEventListener('submit', (event) => {
                event.preventDefault();
                const raw = $('#naPrice', el).value.trim();
                const price = Number(raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw);
                if (!(price > 0)) { toast('Informe um preço maior que zero.', 'bad'); return; }
                store.addAlert({ asset: $('#naAsset', el).value, condition: $('#naCond', el).value, price });
                App.askNotifications();
                $('#naPrice', el).value = '';
                toast('Alerta criado.', 'up');
            });
            el.addEventListener('click', (event) => {
                const id = event.target.closest('[data-del]')?.dataset.del;
                if (id) store.removeAlert(id);
            });
            render();
            hint();
            offs = [bus.on('alerts', render), bus.on('prices', () => { render(); hint(); })];
        },
        unmount() {
            offs.forEach((o) => o());
            offs = [];
            root = null;
        },
    };
})(window.App);
