// Tela "Web3": carteiras cadastradas por endereço público, com tokens,
// empréstimos no Aave, posições de liquidez na Uniswap e alertas.
window.App = window.App || {};
App.views = App.views || {};

(function (App) {
    const { $, $$, html, raw, fmt, bus, toneOf, toast } = App.util;
    const store = App.store;
    const S = store.state;
    const W3 = () => App.web3;

    const results = App.walletResults = App.walletResults || new Map();
    const loading = new Set();
    let root = null;
    let offs = [];
    let open = new Set();

    const money = (usd, opts = {}) => App.money(usd, { priv: true, digits: 2, ...opts });

    // ---------- Leitura ----------
    async function refresh(walletId) {
        const wallet = S.wallets.find((w) => w.id === walletId);
        if (!wallet || loading.has(walletId)) return;
        loading.add(walletId);
        render();
        try {
            const res = await W3().readWallet(wallet);
            const prev = (S.walletSnapshots[walletId] ?? []).slice(-1)[0];
            res.prev = prev ?? null;
            results.set(walletId, res);
            store.addSnapshot(walletId, res.total);
            bus.emit('wallet-read', { walletId, result: res });
        } catch (error) {
            console.error(error);
            results.set(walletId, { error: error.message, at: Date.now() });
            toast(`Não consegui ler “${wallet.name}”: ${error.message}`, 'bad', 7000);
        }
        loading.delete(walletId);
        render();
    }
    App.refreshWallet = refresh;

    function refreshAll() {
        S.wallets.forEach((w) => refresh(w.id));
    }

    // ---------- Agregados ----------
    // Exposição por ativo: soma ETH + WETH + stETH etc., saldo aplicado no Aave e dívidas.
    function exposure() {
        const map = new Map();
        S.wallets.forEach((w) => {
            const r = results.get(w.id);
            if (!r?.lines) return;
            r.lines.forEach((l) => {
                if (l.reputation !== 'ok' || !Number.isFinite(l.usd) || l.kind === 'lp-token') return;
                const key = W3().underlying(l.base ?? l.symbol);
                const sign = l.kind === 'aave-debt' ? -1 : 1;
                const e = map.get(key) || { asset: key, usd: 0, qty: 0 };
                e.usd += sign * l.usd;
                e.qty += sign * l.amount;
                map.set(key, e);
            });
            r.parts.forEach((p) => p.uni.forEach((u) => {
                if (!u.symbol0 || !u.usd) return;
                [[u.symbol0, u.amount0 + u.owed0], [u.symbol1, u.amount1 + u.owed1]].forEach(([sym, qty]) => {
                    const key = W3().underlying(sym);
                    const price = key === 'USD' ? 1 : App.priceOf(key);
                    const e = map.get(key) || { asset: key, usd: 0, qty: 0 };
                    e.qty += qty;
                    e.usd += price ? qty * price : 0;
                    map.set(key, e);
                });
            }));
        });
        return [...map.values()].filter((e) => Math.abs(e.usd) >= 0.5).sort((a, b) => b.usd - a.usd);
    }

    function alerts() {
        const out = [];
        S.wallets.forEach((w) => {
            const r = results.get(w.id);
            if (!r?.parts) return;
            r.parts.forEach((p) => {
                const chain = W3().CHAINS[p.chain];
                if (p.aave && p.aave.debt > 0 && p.aave.healthFactor < 1.5) {
                    out.push({ tone: p.aave.healthFactor < 1.2 ? 'down' : 'warn', text: `${w.name} · ${chain.name}: fator de saúde do Aave em ${fmt.number(p.aave.healthFactor, 2)}. Abaixo de 1 a posição pode ser liquidada.` });
                }
                const hasTokens = p.tokens.some((t) => t.kind === 'token' && t.amount > 0);
                const nativeUsd = p.native * (App.priceOf(chain.native) ?? 0);
                if (hasTokens && nativeUsd < (p.chain === 'ethereum' ? 10 : 1)) {
                    out.push({ tone: 'warn', text: `${w.name} · ${chain.name}: pouco ${chain.native} para pagar gás (${fmt.money(nativeUsd, 'USD', 2)}).` });
                }
                p.uni.forEach((u) => {
                    if (u.symbol0 && !u.inRange) out.push({ tone: 'warn', text: `${w.name} · ${chain.name}: pool ${u.symbol0}/${u.symbol1} fora da faixa, sem render taxas.` });
                });
            });
        });
        return out;
    }

    // Compara o que está on-chain com o registrado na Carteira (por ativo).
    function reconcile() {
        const exp = new Map(exposure().map((e) => [e.asset, e]));
        const registered = store.positions().filter((p) => p.qty > 0);
        const assets = new Set([...registered.map((p) => p.asset), ...[...exp.keys()].filter((k) => k !== 'USD')]);
        return [...assets].map((asset) => {
            const onchain = exp.get(asset)?.qty ?? 0;
            const reg = registered.find((p) => p.asset === asset)?.qty ?? 0;
            return { asset, onchain, reg, diff: onchain - reg };
        }).filter((r) => r.onchain || r.reg).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    }

    // ---------- Render ----------
    function render() {
        if (!root) return;
        const any = S.wallets.length;
        const read = S.wallets.map((w) => results.get(w.id)).filter((r) => r?.lines);
        const total = read.reduce((a, r) => a + r.total, 0);
        const prevTotal = read.reduce((a, r) => a + (r.prev?.usd ?? r.total), 0);
        const delta = total - prevTotal;
        const exp = exposure();
        const al = alerts();
        const expTotal = exp.reduce((a, e) => a + Math.max(0, e.usd), 0);

        $('#w3Summary', root).innerHTML = !any ? html`
            <div class="empty-state">
                <p>Cadastre o endereço público de cada carteira (começa com 0x). O painel lê saldos, empréstimos no Aave e pools da Uniswap em Ethereum, Arbitrum, Base, Optimism e Polygon.</p>
                <button class="btn btn-primary" type="button" data-w3="add">Adicionar carteira</button>
            </div>` : html`
            <div class="pf-summary">
                <div class="pf-main">
                    <p class="pf-label">Total on-chain (${S.wallets.length} ${S.wallets.length === 1 ? 'carteira' : 'carteiras'})</p>
                    <p class="price-xl">${read.length ? money(total) : '—'}</p>
                    <p class="pf-sub">${raw(read.length && Math.abs(delta) >= 0.01 ? html`<span class="delta delta-${toneOf(delta)}">${App.signedMoney(delta, { priv: true })}</span> <span class="muted">desde a leitura anterior</span>` : '<span class="muted">Valor líquido: tokens, pools e Aave (colateral menos dívida).</span>')}</p>
                </div>
                <div>
                    ${raw(exp.length ? html`<div class="alloc-track" role="img" aria-label="Exposição por ativo">${raw(exp.filter((e) => e.usd > 0).map((e) => html`<span style="flex:${Math.max(e.usd / expTotal * 100, 0.6)};background:${e.asset === 'USD' ? 'var(--ink-3)' : App.coins.meta(e.asset).color}" title="${e.asset === 'USD' ? 'Dólar (stablecoins)' : e.asset}"></span>`).join(''))}</div>
                    <ul class="alloc-legend">${raw(exp.slice(0, 12).map((e) => html`<li><i style="background:${e.asset === 'USD' ? 'var(--ink-3)' : App.coins.meta(e.asset).color}"></i>${e.asset === 'USD' ? 'Stablecoins' : e.asset} <span class="muted">${S.settings.privacy ? '' : App.money(e.usd, { compact: true })}</span></li>`).join(''))}</ul>` : '<p class="muted">Atualize as carteiras para ver a exposição por ativo.</p>')}
                </div>
            </div>
            ${raw(al.length ? html`<ul class="w3-alerts">${raw(al.map((a) => html`<li class="w3-alert w3-alert-${a.tone}">${a.text}</li>`).join(''))}</ul>` : '')}`;

        $('#w3List', root).innerHTML = S.wallets.map(walletCard).join('');
        renderReconcile();
    }

    function chainBadge(key) {
        const c = W3().CHAINS[key];
        return html`<span class="chain-badge" style="--c:${c.color}" title="${c.name}">${c.name}</span>`;
    }

    function walletCard(w) {
        const r = results.get(w.id);
        const busy = loading.has(w.id);
        const snaps = S.walletSnapshots[w.id] ?? [];
        const last = snaps[snaps.length - 1];
        const delta = r?.lines && r.prev ? r.total - r.prev.usd : null;
        const isOpen = open.has(w.id);
        const chains = (w.chains?.length ? w.chains : Object.keys(W3().CHAINS));
        return html`<article class="panel w3-wallet" style="--wc:${w.color}" data-wallet="${w.id}">
            <header class="w3-head">
                <div class="w3-id">
                    <span class="w3-dot"></span>
                    <div>
                        <h2>${w.name}</h2>
                        <p class="muted small"><button class="link-btn mono-addr" type="button" data-copy="${w.address}" title="Copiar endereço">${W3().shortAddress(w.address)}</button> · ${raw(chains.map(chainBadge).join(' '))}</p>
                    </div>
                </div>
                <div class="w3-total">
                    <p class="w3-value">${r?.lines ? money(r.total) : (last ? money(last.usd) : '—')}</p>
                    <p class="muted small">${raw(busy ? 'Lendo a blockchain…' : r?.error ? html`<span class="delta-down">Erro na leitura</span>` : r?.lines ? html`${delta !== null && Math.abs(delta) >= 0.01 ? raw(html`<span class="delta-${toneOf(delta)}">${App.signedMoney(delta, { priv: true })}</span> · `) : ''}lido às ${fmt.time(new Date(r.at))}` : last ? html`última leitura ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(last.t)}` : 'Ainda não lida')}</p>
                </div>
                <div class="w3-actions">
                    <button class="btn btn-small" type="button" data-w3="refresh" ${busy ? 'disabled' : ''}>${busy ? 'Atualizando…' : 'Atualizar'}</button>
                    <button class="btn btn-small btn-ghost" type="button" data-w3="edit">Editar</button>
                    ${raw(r?.lines ? html`<button class="btn btn-small btn-ghost" type="button" data-w3="toggle" aria-expanded="${isOpen}">${isOpen ? 'Ocultar detalhes' : 'Ver detalhes'}</button>` : '')}
                </div>
            </header>
            ${raw(r?.lines && isOpen ? walletDetails(w, r) : '')}
        </article>`;
    }

    function walletDetails(w, r) {
        const showSmall = S.web3Settings.showSmall;
        const lines = r.lines.filter((l) => l.kind !== 'aave-supply' && l.kind !== 'aave-debt');
        const visible = lines.filter((l) => showSmall || (l.reputation === 'ok' && l.usd >= 1));
        const hidden = lines.length - visible.length;
        const priv = S.settings.privacy;
        const tokens = visible.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1)).map((l) => html`<tr>
            <td><span class="coin-inline">${raw(App.coins.avatar(W3().underlying(l.symbol) === 'USD' ? l.symbol : W3().underlying(l.symbol), 22))}<span><strong>${l.symbol}</strong>${raw(l.kind === 'lp-token' ? ' <span class="chip chip-flat">LP</span>' : l.kind === 'native' ? ' <span class="chip chip-flat">gás</span>' : '')}</span></span></td>
            <td>${raw(chainBadge(l.chain))}</td>
            <td class="col-num">${priv ? '•••' : fmt.qty(l.amount)}</td>
            <td class="col-num">${l.price ? fmt.money(l.price) : '—'}</td>
            <td class="col-num"><strong>${l.usd === null ? 'sem preço' : money(l.usd)}</strong></td>
        </tr>`).join('');

        const aaveParts = r.parts.filter((p) => p.aave);
        const aaveHtml = aaveParts.map((p) => {
            const a = p.aave;
            const supplies = r.lines.filter((l) => l.chain === p.chain && l.kind === 'aave-supply');
            const debts = r.lines.filter((l) => l.chain === p.chain && l.kind === 'aave-debt');
            const hf = a.healthFactor;
            const hfTone = hf === Infinity || hf >= 2 ? 'up' : hf >= 1.5 ? 'flat' : hf >= 1.2 ? 'warn' : 'down';
            const used = a.collateral ? (a.debt / (a.collateral * a.liquidationThreshold / 100)) * 100 : 0;
            return html`<div class="w3-aave">
                <div class="w3-sub-head">${raw(chainBadge(p.chain))} <strong>Aave v3</strong></div>
                <dl class="w3-kpis">
                    <div><dt>Depositado</dt><dd>${money(a.collateral)}</dd></div>
                    <div><dt>Emprestado</dt><dd class="${a.debt ? 'delta-down' : ''}">${money(a.debt)}</dd></div>
                    <div><dt>Ainda pode pegar</dt><dd>${money(a.available)}</dd></div>
                    <div><dt>Fator de saúde</dt><dd class="hf hf-${hfTone}">${hf === Infinity ? '∞ (sem dívida)' : fmt.number(hf, 2)}</dd></div>
                </dl>
                ${raw(a.debt ? html`<div class="hf-bar" title="Quanto do limite de liquidação já está usado"><i style="width:${Math.min(100, used)}%"></i></div><p class="muted small">${fmt.number(used, 0)}% do limite de liquidação usado (liquidação em ${fmt.number(a.liquidationThreshold, 0)}% do colateral).</p>` : '')}
                ${raw(supplies.length || debts.length ? html`<ul class="w3-aave-list">${raw([...supplies.map((l) => html`<li><span>Depósito ${l.base}</span><span>${priv ? '•••' : fmt.qty(l.amount)} · ${money(l.usd)}</span></li>`), ...debts.map((l) => html`<li class="delta-down"><span>Dívida ${l.base}</span><span>${priv ? '•••' : fmt.qty(l.amount)} · ${money(l.usd)}</span></li>`)].join(''))}</ul>` : '')}
            </div>`;
        }).join('');

        const pools = r.parts.flatMap((p) => p.uni.map((u) => ({ ...u, chain: p.chain })));
        const closed = pools.filter((u) => u.closedCount).reduce((a, u) => a + u.closedCount, 0);
        const poolHtml = pools.filter((u) => u.symbol0).map((u) => html`<tr>
            <td><strong>${u.symbol0}/${u.symbol1}</strong> <span class="muted small">${fmt.number(u.fee / 10000, 2)}%</span></td>
            <td>${raw(chainBadge(u.chain))}</td>
            <td><span class="chip chip-${u.inRange ? 'up' : 'warn'}">${u.inRange ? 'Na faixa' : 'Fora da faixa'}</span></td>
            <td class="col-num">${priv ? '•••' : `${fmt.qty(u.amount0)} ${u.symbol0}`}<small class="muted">${priv ? '' : `${fmt.qty(u.amount1)} ${u.symbol1}`}</small></td>
            <td class="col-num">${priv ? '•••' : (u.owed0 || u.owed1 ? `${fmt.qty(u.owed0)} / ${fmt.qty(u.owed1)}` : '—')}</td>
            <td class="col-num"><strong>${u.priced ? money(u.usd) : 'sem preço'}</strong></td>
        </tr>`).join('');

        const errors = r.parts.flatMap((p) => p.errors.map((e) => `${W3().CHAINS[p.chain].name}: ${e}`));
        const listMode = r.parts.filter((p) => p.discovery === 'lista').map((p) => W3().CHAINS[p.chain].name);

        return html`<div class="w3-details">
            <section>
                <h3 class="w3-h3">Tokens</h3>
                ${raw(tokens ? html`<div class="table-wrap"><table class="data-table"><thead><tr><th>Token</th><th>Rede</th><th class="col-num">Quantidade</th><th class="col-num">Preço</th><th class="col-num">Valor</th></tr></thead><tbody>${raw(tokens)}</tbody></table></div>` : '<p class="muted">Nenhum token com valor.</p>')}
                ${raw(hidden ? html`<p class="footnote">${hidden} token(s) escondidos por valer menos de US$ 1, não ter preço ou serem suspeitos. <button class="link-btn" type="button" data-w3="small">${showSmall ? 'Esconder' : 'Mostrar todos'}</button></p>` : '')}
                ${raw(listMode.length ? html`<p class="footnote">Em ${listMode.join(', ')} a descoberta automática não respondeu; foram lidos só os tokens conhecidos e os que você adicionou nas configurações.</p>` : '')}
            </section>
            ${raw(aaveHtml ? html`<section><h3 class="w3-h3">Empréstimos e depósitos</h3>${raw(aaveHtml)}</section>` : '')}
            ${raw(poolHtml || closed ? html`<section><h3 class="w3-h3">Pools de liquidez (Uniswap v3)</h3>
                ${raw(poolHtml ? html`<div class="table-wrap"><table class="data-table"><thead><tr><th>Par</th><th>Rede</th><th>Status</th><th class="col-num">Na pool</th><th class="col-num">Taxas a coletar</th><th class="col-num">Valor</th></tr></thead><tbody>${raw(poolHtml)}</tbody></table></div>` : '')}
                ${raw(closed ? html`<p class="footnote">${closed} posição(ões) encerrada(s), sem liquidez.</p>` : '')}
                <p class="footnote">“Taxas a coletar” mostra o valor registrado na última interação com a posição; a Uniswap pode ter acumulado mais desde então.</p>
            </section>` : '')}
            ${raw(errors.length ? html`<details class="w3-errors"><summary>${errors.length} aviso(s) de leitura</summary><ul>${raw(errors.map((e) => html`<li>${e}</li>`).join(''))}</ul></details>` : '')}
            <p class="footnote">Ver no explorador: ${raw((w.chains?.length ? w.chains : Object.keys(W3().CHAINS)).map((c) => html`<a href="${W3().CHAINS[c].explorer}/address/${w.address}" target="_blank" rel="noopener">${W3().CHAINS[c].name}</a>`).join(' · '))}</p>
        </div>`;
    }

    function renderReconcile() {
        const el = $('#w3Reconcile', root);
        const rows = reconcile();
        if (!rows.length || !S.wallets.some((w) => results.get(w.id)?.lines)) { el.hidden = true; return; }
        el.hidden = false;
        const priv = S.settings.privacy;
        $('#w3RecBody', root).innerHTML = rows.map((r) => {
            const pct = r.reg ? (r.diff / r.reg) * 100 : null;
            const ok = Math.abs(r.diff) <= Math.max(Math.abs(r.reg), Math.abs(r.onchain)) * 0.01;
            return html`<tr>
                <td><span class="coin-inline">${raw(App.coins.avatar(r.asset, 20))}${r.asset}</span></td>
                <td class="col-num">${priv ? '•••' : fmt.qty(r.onchain)}</td>
                <td class="col-num">${priv ? '•••' : fmt.qty(r.reg)}</td>
                <td class="col-num">${raw(ok ? '<span class="chip chip-up">Confere</span>' : html`<span class="delta-${toneOf(r.diff)}">${priv ? '•••' : fmt.qty(r.diff)}</span>${raw(pct !== null ? html`<small class="muted">${fmt.pct(pct, 1)}</small>` : '')}`)}</td>
            </tr>`;
        }).join('');
    }

    // ---------- Diálogo da carteira ----------
    function openWalletDialog(id = null) {
        const dlg = $('#walletDialog');
        const w = id ? S.wallets.find((x) => x.id === id) : null;
        dlg.dataset.id = w?.id ?? '';
        $('#walletTitle').textContent = w ? 'Editar carteira' : 'Adicionar carteira';
        $('#walletName').value = w?.name ?? '';
        $('#walletAddress').value = w?.address ?? '';
        $('#walletDelete').hidden = !w;
        const chosen = w?.chains?.length ? w.chains : Object.keys(App.web3.CHAINS);
        $('#walletChains').innerHTML = Object.entries(App.web3.CHAINS).map(([k, c]) => html`<label class="chain-check" style="--c:${c.color}"><input type="checkbox" value="${k}" ${chosen.includes(k) ? 'checked' : ''}><span>${c.name}</span></label>`).join('');
        dlg.showModal();
        (w ? $('#walletName') : $('#walletAddress')).focus();
    }

    function wireWalletDialog() {
        const dlg = $('#walletDialog');
        if (dlg.dataset.wired) return;
        dlg.dataset.wired = '1';
        $('#walletCancel').addEventListener('click', () => dlg.close());
        $('#walletDelete').addEventListener('click', () => {
            const w = S.wallets.find((x) => x.id === dlg.dataset.id);
            if (!w || !window.confirm(`Remover a carteira “${w.name}” do painel? Nada muda na blockchain; só deixa de ser acompanhada.`)) return;
            store.removeWallet(w.id);
            results.delete(w.id);
            dlg.close();
        });
        $('#walletForm').addEventListener('submit', (event) => {
            event.preventDefault();
            const address = $('#walletAddress').value.trim();
            if (!App.web3.isAddress(address)) { toast('Endereço inválido: precisa começar com 0x e ter 42 caracteres.', 'bad'); return; }
            if (/^(0x)?[0-9a-f]{64}$/i.test(address)) { toast('Isso parece uma chave privada. Nunca cole chaves; use só o endereço público.', 'bad'); return; }
            const dup = S.wallets.find((x) => x.address.toLowerCase() === address.toLowerCase() && x.id !== dlg.dataset.id);
            if (dup) { toast(`Esse endereço já está cadastrado como “${dup.name}”.`, 'bad'); return; }
            const chains = $$('#walletChains input:checked').map((i) => i.value);
            if (!chains.length) { toast('Escolha pelo menos uma rede.', 'bad'); return; }
            const saved = store.saveWallet({ id: dlg.dataset.id || null, name: $('#walletName').value.trim() || `Carteira ${S.wallets.length + 1}`, address, chains });
            dlg.close();
            toast(`Carteira “${saved.name}” salva.`, 'up');
            refresh(saved.id);
        });
        // Bloqueia colar frase-semente por engano no campo de endereço.
        $('#walletAddress').addEventListener('input', (event) => {
            const words = event.target.value.trim().split(/\s+/);
            if (words.length >= 12) {
                event.target.value = '';
                toast('Isso parece uma frase-semente. Nunca digite essas palavras em nenhum site. Use só o endereço público (0x…).', 'bad', 9000);
            }
        });
    }

    // ---------- Configurações ----------
    function renderSettings() {
        const st = S.web3Settings;
        $('#w3Rpc', root).innerHTML = Object.entries(App.web3.CHAINS).map(([k, c]) => html`<label>${c.name}<input class="input input-small" data-rpc="${k}" placeholder="${c.rpcs[0]}" value="${st.rpc?.[k] ?? ''}" autocomplete="off" spellcheck="false"></label>`).join('');
        $('#w3Key', root).value = st.blockscoutKey ?? '';
        $('#w3Custom', root).innerHTML = (st.customTokens ?? []).length
            ? st.customTokens.map((t, i) => html`<li><span>${raw(chainBadge(t.chain))} <strong>${t.symbol}</strong> <span class="muted mono-addr">${App.web3.shortAddress(t.address)}</span></span><button class="icon-btn" type="button" data-rm-token="${i}" aria-label="Remover ${t.symbol}">✕</button></li>`).join('')
            : '<li class="muted">Nenhum token extra.</li>';
        $('#w3TokChain', root).innerHTML = Object.entries(App.web3.CHAINS).map(([k, c]) => html`<option value="${k}">${c.name}</option>`).join('');
    }

    async function addCustomToken() {
        const chain = $('#w3TokChain', root).value;
        const address = $('#w3TokAddr', root).value.trim();
        if (!App.web3.isAddress(address)) { toast('Endereço do contrato inválido.', 'bad'); return; }
        try {
            const info = (await App.web3.tokenInfo(chain, [address]))[address.toLowerCase()];
            if (!info || info.symbol === '?') throw new Error('não parece um token ERC-20');
            S.web3Settings.customTokens = [...(S.web3Settings.customTokens ?? []), { chain, address, symbol: info.symbol, decimals: info.decimals }];
            store.commit('web3');
            $('#w3TokAddr', root).value = '';
            toast(`${info.symbol} adicionado. Atualize as carteiras para ler o saldo.`, 'up');
            renderSettings();
        } catch (error) {
            toast(`Não consegui ler esse contrato: ${error.message}`, 'bad');
        }
    }

    // ---------- Eventos ----------
    function onClick(event) {
        const t = event.target;
        const copy = t.closest('[data-copy]')?.dataset.copy;
        if (copy) {
            navigator.clipboard?.writeText(copy).then(() => toast('Endereço copiado.'), () => toast(copy));
            return;
        }
        const act = t.closest('[data-w3]')?.dataset.w3;
        const card = t.closest('[data-wallet]');
        const id = card?.dataset.wallet;
        if (act === 'add') openWalletDialog();
        if (act === 'refresh-all') refreshAll();
        if (act === 'refresh' && id) refresh(id);
        if (act === 'edit' && id) openWalletDialog(id);
        if (act === 'toggle' && id) { if (open.has(id)) open.delete(id); else open.add(id); render(); }
        if (act === 'small') { S.web3Settings.showSmall = !S.web3Settings.showSmall; store.save(); render(); }
        if (act === 'add-token') addCustomToken();
        const rm = t.closest('[data-rm-token]')?.dataset.rmToken;
        if (rm !== undefined) {
            S.web3Settings.customTokens.splice(Number(rm), 1);
            store.commit('web3');
            renderSettings();
        }
    }

    function onChange(event) {
        const rpcInput = event.target.closest('[data-rpc]');
        if (rpcInput) {
            const v = rpcInput.value.trim();
            if (v && !/^https:\/\//.test(v)) { toast('O RPC precisa começar com https://', 'bad'); return; }
            S.web3Settings.rpc[rpcInput.dataset.rpc] = v;
            store.save();
            toast('RPC salvo neste navegador.');
        }
        if (event.target.id === 'w3Key') {
            S.web3Settings.blockscoutKey = event.target.value.trim();
            store.save();
            toast('Chave salva só neste navegador.');
        }
    }

    App.views.web3 = {
        title: 'Web3',
        mount(el) {
            root = el;
            el.innerHTML = html`
                <header class="page-head">
                    <div>
                        <h1>Carteiras Web3</h1>
                        <p class="lede">Leitura pública pelo endereço: nenhuma conexão de carteira, nenhuma assinatura. Nunca digite sua frase-semente ou chave privada aqui.</p>
                    </div>
                    <div class="toolbar">
                        <button class="btn" type="button" data-w3="refresh-all" ${S.wallets.length ? '' : 'disabled'}>Atualizar todas</button>
                        <button class="btn btn-primary" type="button" data-w3="add">Adicionar carteira</button>
                    </div>
                </header>
                <section class="panel pf-hero" id="w3Summary"></section>
                <div id="w3List" class="w3-list"></div>
                <section class="panel" id="w3Reconcile" hidden>
                    <h2 class="panel-title">On-chain × registrado na Carteira</h2>
                    <p class="muted small">Soma de todas as carteiras por ativo (ETH inclui WETH e stETH; depósitos no Aave somam, dívidas subtraem) comparada às compras registradas.</p>
                    <div class="table-wrap"><table class="data-table"><thead><tr><th>Ativo</th><th class="col-num">On-chain</th><th class="col-num">Registrado</th><th class="col-num">Diferença</th></tr></thead><tbody id="w3RecBody"></tbody></table></div>
                </section>
                <details class="panel w3-settings">
                    <summary><h2 class="panel-title">Configurações de leitura</h2></summary>
                    <p class="muted small">Os RPCs públicos podem limitar acessos. Se uma rede falhar com frequência, cole aqui uma URL de RPC sua (Alchemy, Infura etc.); ela fica salva só neste navegador.</p>
                    <div id="w3Rpc" class="w3-rpc"></div>
                    <label class="w3-key">Chave da API do Blockscout (opcional, gratuita)<input id="w3Key" class="input input-small" type="password" autocomplete="off" spellcheck="false" placeholder="Usada se a descoberta de tokens sem chave deixar de funcionar"></label>
                    <h3 class="w3-h3">Tokens extras</h3>
                    <p class="muted small">Para tokens que não aparecem sozinhos. Cole o endereço do contrato.</p>
                    <div class="inline-form"><select id="w3TokChain" class="input input-small"></select><input id="w3TokAddr" class="input input-small" placeholder="0x… do contrato" autocomplete="off" spellcheck="false"><button class="btn btn-small" type="button" data-w3="add-token">Adicionar</button></div>
                    <ul id="w3Custom" class="w3-custom"></ul>
                </details>`;
            wireWalletDialog();
            el.addEventListener('click', onClick);
            el.addEventListener('change', onChange);
            renderSettings();
            render();
            // Lê automaticamente as carteiras sem leitura recente (mais de 5 minutos).
            S.wallets.forEach((w) => {
                const r = results.get(w.id);
                if (!r || Date.now() - r.at > 5 * 60 * 1000) refresh(w.id);
            });
            offs = [
                bus.on('wallets', render),
                bus.on('settings', render),
                bus.on('transactions', renderReconcile),
                bus.on('prices', App.util.debounce(() => { if (root && !root.contains(document.activeElement)) render(); }, 3000)),
            ];
        },
        unmount() {
            offs.forEach((o) => o());
            offs = [];
            root = null;
        },
    };
})(window.App);
