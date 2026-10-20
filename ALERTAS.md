# Alertas de pools no Telegram

Uma tarefa agendada do GitHub Actions (`.github/workflows/alertas-pools.yml`)
roda a cada hora, lê as posições de liquidez das suas carteiras e o fator de
saúde do Aave v3 e manda mensagem no Telegram quando:

- uma posição sai da faixa (e lembra a cada 24 h enquanto continuar fora);
- uma posição fica perto da borda (menos de 12% da faixa sobrando);
- uma posição volta para a faixa;
- o fator de saúde do Aave fica abaixo de 1,5 (ou de 1,2, crítico).

Apps verificados:

- Endereços 0x…: Uniswap v3 (Ethereum, Arbitrum, Base, Optimism, Polygon,
  BNB Chain e zkSync Era), PancakeSwap v3 (BNB Chain, Ethereum, Arbitrum e Base, incluindo
  posições em farm), Aerodrome Slipstream (Base, incluindo posições em staking)
  e Aave v3.
- Endereços Solana: Orca (Whirlpools), Raydium (CLMM) e Meteora (DLMM).

Só lê dados públicos da blockchain. Nada de chave privada.

## 1. Criar o bot

1. No Telegram, abra uma conversa com **@BotFather** e envie `/newbot`.
2. Escolha um nome e um usuário para o bot (o usuário precisa terminar em `bot`).
3. O BotFather responde com o **token** (algo como `123456:ABC-DEF...`). Guarde.

## 2. Descobrir o seu chat id

1. Abra uma conversa com o seu bot e mande qualquer mensagem (ex.: `oi`).
2. No navegador, abra `https://api.telegram.org/botSEU_TOKEN/getUpdates`
   (troque `SEU_TOKEN` pelo token, mantendo o `bot` na frente).
3. Procure `"chat":{"id":` na resposta. O número logo depois é o **chat id**.

## 3. Criar os segredos no GitHub

No repositório: **Settings → Secrets and variables → Actions → New repository secret**.

| Nome | Valor |
|---|---|
| `TELEGRAM_BOT_TOKEN` | o token do BotFather |
| `TELEGRAM_CHAT_ID` | o número do chat id |
| `WALLETS` | endereços públicos separados por vírgula, 0x… e Solana misturados (a aba Pools do painel gera esse valor) |

Opcionais:

| Nome | Para quê |
|---|---|
| `RPC_ETHEREUM`, `RPC_ARBITRUM`, `RPC_BASE`, `RPC_OPTIMISM`, `RPC_POLYGON`, `RPC_BNB`, `RPC_ZKSYNC`, `RPC_SOLANA` (segredos) | URL de RPC própria se os RPCs públicos falharem. Para a Meteora, um RPC próprio de Solana costuma ser necessário |
| `BLOCKSCOUT_KEY` (segredo) | chave gratuita do Blockscout; ajuda a achar posições do Aerodrome em staking |
| `CHAINS` (em *Variables*) | redes a verificar, ex.: `arbitrum,base,bnb,zksync,solana` (padrão: todas) |
| `EDGE_PCT` (em *Variables*) | quanto da faixa conta como “perto da borda” (padrão 12) |
| `HF_MIN` (em *Variables*) | fator de saúde mínimo do Aave (padrão 1.5) |

Os endereços ficam nos segredos, não no código, então não aparecem no
repositório público.

## 4. Testar

1. Aba **Actions** do repositório → **Alertas de pools** → **Run workflow**.
2. Deixe marcado “Enviar também uma mensagem de teste” e rode.
3. Em menos de um minuto chega uma mensagem com o resumo das posições.

Se aparecer erro, abra a execução na aba Actions e veja o passo
“Verificar pools e Aave”.

## Observações

- O horário do agendamento é em UTC e o GitHub pode atrasar alguns minutos.
- O GitHub pausa tarefas agendadas em repositórios sem nenhuma atividade por
  60 dias. Qualquer commit reativa (ou clique em *Enable workflow* na aba Actions).
- Para mudar a frequência, edite a linha `cron` no arquivo do workflow
  (ex.: `'*/30 * * * *'` para a cada 30 minutos).
