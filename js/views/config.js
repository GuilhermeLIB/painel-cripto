// Configurações: tudo que se ajusta uma vez fica aqui, fora das telas do dia a dia.
window.App = window.App || {};
App.views = App.views || {};

(function (App) {
    const { $, html, raw, fmt, bus, toast } = App.util;
    const store = App.store;
    const S = store.state;
    let root = null;
    let offs = [];

    function renderWallets() {
        const el = $('#cfgWallets', root);
        if (!el) return;
        el.innerHTML = S.wallets.length ? html`<ul class="cfg-list">${raw(S.wallets.map((w) => {
            const sol = App.web3.isSolanaAddress(w.address);
            const chains = sol ? ['solana'] : (w.chains?.length ? w.chains : App.web3.EVM_CHAINS);
            return html`<li>
                <span class="w3-dot" style="--wc:${w.color}"></span>
                <span class="cfg-main"><strong>${w.name}</strong><span class="muted small mono-addr">${App.web3.shortAddress(w.address)}</span></span>
                <span class="cfg-chains">${raw(chains.map((c) => html`<span class="chain-badge" style="--c:${App.web3.CHAINS[c]?.color}">${App.web3.CHAINS[c]?.name}</span>`).join(' '))}</span>
                <button class="btn btn-small btn-ghost" type="button" data-wallet-edit="${w.id}">Editar</button>
            </li>`;
        }).join(''))}</ul>` : '<p class="muted">Nenhuma carteira cadastrada. Adicione o endereço público (0x… ou Solana) para ver saldos, pools e empréstimos.</p>';
        renderTelegram();
    }

    function renderTelegram() {
        const el = $('#cfgTelegram', root);
        if (!el) return;
        const addrs = S.wallets.map((w) => w.address).join(',');
        el.innerHTML = html`
            <p class="muted">Uma tarefa agendada no seu repositório do GitHub confere as pools e o Aave das carteiras a cada hora e avisa no Telegram, mesmo com o computador desligado. Passo a passo completo no arquivo ALERTAS.md do projeto.</p>
            <ol class="pl-steps">
                <li>No Telegram, fale com <strong>@BotFather</strong>, crie um bot e guarde o token.</li>
                <li>Mande uma mensagem para o seu bot e descubra o seu chat id (ver ALERTAS.md).</li>
                <li>No GitHub: Settings → Secrets and variables → Actions → <strong>Secrets</strong>: crie <code>TELEGRAM_BOT_TOKEN</code>, <code>TELEGRAM_CHAT_ID</code> e <code>WALLETS</code>.</li>
                <li>Em Actions → “Alertas de pools”, rode “Run workflow” uma vez para testar.</li>
            </ol>
            ${raw(addrs ? html`<label class="w3-key">Valor para o segredo WALLETS<span class="inline-form"><input class="input input-small mono-addr" readonly value="${addrs}"><button class="btn btn-small" type="button" data-copy="${addrs}">Copiar</button></span></label>` : '')}`;
    }

    App.views.config = {
        title: 'Configurações',
        mount(el) {
            root = el;
            el.innerHTML = html`
                <header class="page-head"><div><h1>Configurações</h1><p class="lede">Carteiras, alertas, fontes de dados e backup. Os dados ficam só neste navegador.</p></div></header>
                <section class="panel">
                    <div class="panel-bar"><h2 class="panel-title">Carteiras</h2><button class="btn btn-small btn-primary" type="button" data-cfg="add-wallet">Adicionar carteira</button></div>
                    <div id="cfgWallets"></div>
                </section>
                <section class="panel">
                    <h2 class="panel-title">Alertas de preço</h2>
                    <div id="cfgAlerts"></div>
                </section>
                <details class="panel fold">
                    <summary><span class="panel-title">Alertas no Telegram</span><span class="muted small">Avisos de pools e do Aave com o painel fechado</span></summary>
                    <div id="cfgTelegram"></div>
                </details>
                <details class="panel fold">
                    <summary><span class="panel-title">Fontes de dados</span><span class="muted small">RPC próprio, chave do Blockscout e tokens extras</span></summary>
                    <div id="cfgSources"></div>
                </details>
                <section class="panel">
                    <h2 class="panel-title">Backup e importação</h2>
                    <p class="muted">Leve tudo (listas, plano, operações, carteiras e alertas) para outro navegador ou celular. Também aceita o backup do Dashboard Bitcoin antigo.</p>
                    <div class="toolbar">
                        <button class="btn" type="button" data-cfg="backup">Fazer backup</button>
                        <label class="btn" for="cfgImport">Importar backup</label>
                        <input id="cfgImport" type="file" accept="application/json,.json" hidden>
                    </div>
                </section>`;
            el.addEventListener('click', (event) => {
                const act = event.target.closest('[data-cfg]')?.dataset.cfg;
                if (act === 'add-wallet') App.openWalletDialog();
                if (act === 'backup') App.downloadBackup();
                const edit = event.target.closest('[data-wallet-edit]')?.dataset.walletEdit;
                if (edit) App.openWalletDialog(edit);
                const copy = event.target.closest('[data-copy]')?.dataset.copy;
                if (copy) navigator.clipboard?.writeText(copy).then(() => toast('Copiado.'));
            });
            $('#cfgImport', el).addEventListener('change', async (e) => {
                const [file] = e.target.files ?? [];
                if (file) await App.importBackupFile(file);
                e.target.value = '';
            });
            renderWallets();
            App.views.alertas.mount($('#cfgAlerts', el), [], { embedded: true });
            App.w3Settings.mount($('#cfgSources', el));
            offs = [bus.on('wallets', renderWallets)];
        },
        unmount() {
            offs.forEach((o) => o());
            offs = [];
            App.views.alertas.unmount();
            App.w3Settings.unmount();
            root = null;
        },
    };
})(window.App);
