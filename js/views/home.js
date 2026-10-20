// Início: o resumo do dia. Quanto você tem, o que aportar nesta semana, o que precisa
// de atenção e como está o mercado. Cada bloco leva à tela de detalhe.
window.App = window.App || {};
App.views = App.views || {};

(function (App) {
    const { $, html, raw, fmt, bus, toneOf, localIso, parseIso } = App.util;
    const store = App.store;
    const S = store.state;
    let root = null;
    let offs = [];

    function onchainTotal() {
        let total = 0;
        let any = false;
        let at = null;
        S.wallets.forEach((w) => {
            const r = App.walletResults?.get(w.id);
            const last = (S.walletSnapshots[w.id] ?? []).slice(-1)[0];
            const v = r?.lines ? r.total : last?.usd;
            if (Number.isFinite(v)) { total += v; any = true; at = Math.max(at ?? 0, r?.at ?? last?.t ?? 0); }
        });
        return any ? { total, at } : null;
    }

    function weekNow() {
        const key = localIso().slice(0, 7);
        const plan = App.monthly?.plan(key);
        if (!plan) return null;
        const pending = plan.weeks.find((w) => (w.state === 'today' || w.state === 'late') && w.items.some((i) => !i.tx));
        return pending ?? plan.weeks.find((w) => w.state === 'future') ?? null;
    }

    function attention() {
        const out = [];
        S.wallets.forEach((w) => {
            const r = App.walletResults?.get(w.id);
            r?.parts?.forEach((p) => {
                const chain = App.web3.CHAINS[p.chain]?.name ?? p.chain;
                p.uni?.forEach((u) => {
                    if (!u.symbol0 || !u.priceLower) return;
                    const pos = (Math.log(u.priceNow) - Math.log(u.priceLower)) / (Math.log(u.priceUpper) - Math.log(u.priceLower));
                    if (pos < 0 || pos > 1) out.push({ tone: 'down', text: `${u.symbol0}/${u.symbol1} fora da faixa`, sub: `${w.name} · ${chain} · ${u.dex ?? ''}`, href: '#/pools' });
                    else if (pos < 0.12 || pos > 0.88) out.push({ tone: 'warn', text: `${u.symbol0}/${u.symbol1} perto da borda`, sub: `${w.name} · ${chain}`, href: '#/pools' });
                });
                if (p.aave && p.aave.debt > 0 && p.aave.healthFactor < 1.5) out.push({ tone: p.aave.healthFactor < 1.2 ? 'down' : 'warn', text: `Aave com fator de saúde ${fmt.number(p.aave.healthFactor, 2)}`, sub: `${w.name} · ${chain}`, href: '#/patrimonio' });
            });
        });
        const day = Date.now() - 24 * 3600 * 1000;
        S.alerts.filter((a) => a.triggeredAt && a.triggeredAt > day).forEach((a) => out.push({ tone: 'flat', text: `${a.asset} ${a.condition === 'above' ? 'passou de' : 'caiu abaixo de'} ${fmt.money(a.price)}`, sub: 'Alerta de preço disparado', href: `#/ativo/${a.asset}` }));
        const wk = weekNow();
        if (wk?.state === 'late') out.push({ tone: 'warn', text: `Aporte da semana ${wk.index + 1} pendente`, sub: `${wk.items.filter((i) => !i.tx).length} compra(s) por fazer`, href: '#/aportes' });
        return out;
    }

    // No dia do aporte (ou se está atrasado), um guia de três passos.
    function guide(wk, pending) {
        if (wk.state !== 'today' && wk.state !== 'late') return '';
        const key = wk.date.slice(0, 7);
        const log = S.monthly?.log?.[key]?.[wk.index] ?? {};
        const bought = wk.items.filter((i) => i.tx);
        const converted = Boolean(log.usdReceived) || bought.length > 0;
        const wallet = S.wallets.find((w) => w.id === S.monthly?.walletId);
        const lastBuy = Math.max(0, ...bought.map((i) => Date.parse(i.tx.date)));
        const read = wallet ? App.walletResults?.get(wallet.id) : null;
        const checked = Boolean(wallet && read?.at && pending.length === 0 && read.at > lastBuy);
        const steps = [
            { done: converted, text: `Converter ${fmt.money(wk.brl, 'BRL', 2)} em USDT e informar quanto chegou` },
            { done: pending.length === 0, text: pending.length ? `Comprar ${pending.length} cripto(s) e marcar no plano` : 'Compras feitas' },
            { done: checked, text: wallet ? `Conferir o saldo em ${wallet.name}` : 'Conferir o saldo na carteira' },
        ];
        return html`<ol class="hm-guide">${raw(steps.map((x) => html`<li class="${x.done ? 'is-done' : ''}">${x.text}</li>`).join(''))}</ol>`;
    }

    function render() {
        if (!root) return;
        const snap = App.portfolioSnapshot?.();
        const reg = snap?.value ?? 0;
        const oc = onchainTotal();
        const prev = snap ? snap.value - snap.change24 : 0;
        const pct24 = prev ? (snap.change24 / prev) * 100 : null;

        $('#hmWealth', root).innerHTML = html`
            <p class="pf-label">Patrimônio</p>
            <p class="price-xl">${App.money(reg + (oc?.total ?? 0), { priv: true, digits: 2 })}</p>
            <div class="hm-split">
                <span><span class="muted">Registrado</span> ${App.money(reg, { priv: true, digits: 2 })} ${raw(pct24 !== null && snap.value ? html`<span class="delta-${toneOf(pct24)}">${fmt.pct(pct24)} 24h</span>` : '')}</span>
                <span><span class="muted">On-chain</span> ${oc ? App.money(oc.total, { priv: true, digits: 2 }) : (S.wallets.length ? 'lendo…' : '—')}</span>
            </div>
            <p class="muted small">Registrado e on-chain podem se sobrepor se você lança as compras das carteiras. A tela Patrimônio mostra a conferência.</p>
            <a class="btn btn-small" href="#/patrimonio">Ver patrimônio</a>`;

        const wk = weekNow();
        const pending = wk ? wk.items.filter((i) => !i.tx) : [];
        $('#hmWeek', root).innerHTML = wk ? html`
            <p class="pf-label">Aporte da semana</p>
            <p class="hm-big">${wk.state === 'today' ? 'Hoje' : wk.state === 'late' ? `Pendente desde ${new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' }).format(parseIso(wk.date))}` : new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'short' }).format(parseIso(wk.date))}</p>
            <p class="muted">${fmt.money(wk.brl, 'BRL', 2)} · ${pending.length ? `${pending.length} de ${wk.items.length} compras por fazer` : 'tudo comprado'}</p>
            ${raw(guide(wk, pending))}
            <ul class="hm-chips">${raw(pending.slice(0, 7).map((i) => html`<li>${raw(App.coins.avatar(i.symbol, 18))}${i.symbol} <span class="muted">${i.usd ? fmt.money(i.usd, 'USD', 2) : ''}</span></li>`).join(''))}</ul>
            <a class="btn btn-small btn-primary" href="#/aportes">Ir para Aportes</a>` : html`
            <p class="pf-label">Aporte da semana</p>
            <p class="muted">Monte seu plano mensal: valor por mês, semanas e criptos. O painel diz quanto comprar de cada uma.</p>
            <a class="btn btn-small btn-primary" href="#/aportes">Montar plano</a>`;

        const att = attention();
        $('#hmAttention', root).innerHTML = html`<div class="panel-bar"><h2 class="panel-title">Precisa de atenção</h2>${raw(S.wallets.length ? '<button class="btn btn-small btn-ghost" type="button" data-hm="read">Atualizar carteiras</button>' : '')}</div>
            ${raw(att.length ? html`<ul class="hm-att">${raw(att.map((a) => html`<li class="hm-att-${a.tone}"><a href="${a.href}"><strong>${a.text}</strong><span class="muted small">${a.sub}</span></a></li>`).join(''))}</ul>` : html`<p class="muted">${S.wallets.length ? 'Tudo em ordem: nenhuma pool fora da faixa, nenhum empréstimo em risco, nenhum aporte atrasado.' : 'Cadastre suas carteiras em Configurações para acompanhar pools e empréstimos aqui.'}</p>`)}`;

        const list = (S.lists.find((l) => l.id === S.favoriteTab) ?? S.lists[0])?.symbols ?? [];
        const quotes = list.map((s) => ({ s, ch: App.live.prices[s]?.changePct })).filter((x) => Number.isFinite(x.ch)).sort((a, b) => b.ch - a.ch);
        const discount = S.watchlist.filter((s) => App.signals?.[s]?.action === 'Aportar reforçado');
        const row = (x) => html`<li><a href="#/ativo/${x.s}">${raw(App.coins.avatar(x.s, 20))}<strong>${x.s}</strong><span class="delta-${toneOf(x.ch)}">${fmt.pct(x.ch)}</span></a></li>`;
        $('#hmMarket', root).innerHTML = html`<div class="panel-bar"><h2 class="panel-title">Mercado hoje</h2><a class="btn btn-small btn-ghost" href="#/mercado">Ver mercado</a></div>
            ${raw(quotes.length ? html`<div class="hm-movers"><div><p class="muted small">Maiores altas</p><ul>${raw(quotes.slice(0, 3).map(row).join(''))}</ul></div><div><p class="muted small">${quotes[quotes.length - 1].ch < 0 ? 'Maiores quedas' : 'Menores altas'}</p><ul>${raw(quotes.slice(-3).reverse().map(row).join(''))}</ul></div></div>` : '<p class="muted">Carregando cotações…</p>')}
            ${raw(discount.length ? html`<p class="small">Com desconto pelo sinal: ${raw(discount.map((s) => html`<a href="#/ativo/${s}">${s}</a>`).join(', '))}</p>` : '')}`;

        const steps = [
            !S.wallets.length && { text: 'Cadastre suas carteiras (0x… ou Solana)', href: '#/config' },
            !S.transactions.length && { text: 'Registre sua primeira compra ou marque um aporte do plano', href: '#/aportes' },
            !Object.keys(S.monthly?.log ?? {}).length && { text: 'Revise o plano mensal (valor, semanas e criptos)', href: '#/aportes' },
        ].filter(Boolean);
        const st = $('#hmSteps', root);
        st.hidden = !steps.length;
        st.innerHTML = html`<h2 class="panel-title">Primeiros passos</h2><ol class="hm-steps">${raw(steps.map((x) => html`<li><a href="${x.href}">${x.text}</a></li>`).join(''))}</ol>`;
    }

    App.views.inicio = {
        title: 'Início',
        mount(el) {
            root = el;
            const hour = new Date().getHours();
            el.innerHTML = html`
                <header class="page-head"><div><h1>${hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite'}</h1><p class="lede">${new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</p></div></header>
                <section class="panel hm-steps-panel" id="hmSteps" hidden></section>
                <div class="hm-grid">
                    <section class="panel" id="hmWealth"></section>
                    <section class="panel" id="hmWeek"></section>
                </div>
                <section class="panel" id="hmAttention"></section>
                <section class="panel" id="hmMarket"></section>`;
            el.addEventListener('click', (e) => {
                if (e.target.closest('[data-hm="read"]')) S.wallets.forEach((w) => App.refreshWallet(w.id));
            });
            render();
            // Lê as carteiras sem leitura recente para montar os avisos.
            S.wallets.forEach((w) => {
                const r = App.walletResults?.get(w.id);
                if (!r || Date.now() - r.at > 10 * 60 * 1000) App.refreshWallet(w.id);
            });
            let last = 0;
            offs = [
                bus.on('prices', () => { if (Date.now() - last > 2000) { last = Date.now(); render(); } }),
                bus.on('wallet-read', render),
                bus.on('transactions', render),
                bus.on('monthly', render),
                bus.on('settings', render),
            ];
        },
        unmount() {
            offs.forEach((o) => o());
            offs = [];
            root = null;
        },
    };
})(window.App);
