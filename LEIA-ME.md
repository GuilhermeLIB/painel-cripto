# Painel Cripto

Painel para acompanhar qualquer cripto negociada contra USDT na Binance e
controlar a carteira de aportes. Não precisa de servidor, instalação nem
chave de API.

## Como abrir

- **Direto do computador:** dê dois cliques em `index.html`. Para criar um
  atalho, clique com o botão direito em `index.html`, depois em
  "Enviar para" e em "Área de trabalho (criar atalho)".
- **Por um link (celular, outro PC):** publique a pasta como site estático
  (veja abaixo).

## Publicar com link

### GitHub Pages (grátis)

1. Crie um repositório no GitHub (pode ser privado só em planos pagos; em público,
   apenas o código fica visível, seus dados nunca saem do navegador).
2. Envie o conteúdo desta pasta para a raiz do repositório.
3. No repositório, abra Settings, depois Pages. Em "Build and deployment",
   escolha "Deploy from a branch", branch `main` e pasta `/ (root)`. Salve.
4. Em um ou dois minutos o link aparece no topo dessa página, no formato
   `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

### Netlify Drop (sem conta de Git)

1. Acesse app.netlify.com/drop.
2. Arraste esta pasta inteira para a página.
3. O link sai na hora. Crie uma conta grátis para ele não expirar.

## Onde ficam os dados

Lista de acompanhamento, operações, plano e alertas ficam salvos no
navegador (localStorage), separados por endereço: o arquivo local, o link
do GitHub e o do Netlify têm cada um os seus dados. Para levar os dados de
um lugar para outro, use **Carteira, Fazer backup** em um e **Importar** no
outro. Faça backup de vez em quando.

### Trazer os aportes do Dashboard Bitcoin antigo

Abra o dashboard antigo, vá em Aportes e clique em **Exportar**. Depois, no
Painel Cripto, abra a Carteira e use **Importar** com esse arquivo. Os
aportes entram como compras de BTC, com o valor em reais, a cotação USDT/BRL
e o preço que estavam salvos.

## Listas no Mercado

- Crie listas com nome e cor em **+ Nova lista**; uma cripto pode estar em várias.
- A lista marcada como **favorita** é a que abre primeiro.
- Reordene as listas arrastando as abas (ou pelas setas ← →) e as criptos
  arrastando a alça ⋮⋮ de cada linha (ou focando a alça e usando ↑ ↓).
- **Na carteira**, **Com desconto** e **Com alerta** se montam sozinhas.
- O ✎ de cada linha guarda o preço que você quer pagar e uma nota, e pode
  criar um alerta nesse preço.

## Carteiras Web3

A aba **Web3** lê carteiras pelo endereço público, sem conectar nem assinar
nada. Endereços 0x… são lidos em Ethereum, Arbitrum, Base, Optimism, Polygon e
BNB Chain: tokens, gás, Aave v3 (com fator de saúde) e posições de liquidez da
Uniswap v3, PancakeSwap v3 (inclusive em farm) e Aerodrome (inclusive em
staking). Endereços Solana: tokens e posições da Orca, Raydium e Meteora.

Fontes públicas, sem chave: RPCs públicos (publicnode e oficiais das redes),
Blockscout para descobrir tokens e DefiLlama para preços. Se um RPC público
ficar instável, cole uma URL de RPC sua nas configurações da aba. Nunca
digite frase-semente ou chave privada.

## Pools

A aba **Pools** sugere faixas de liquidez concentrada (conservadora,
equilibrada e agressiva) pela volatilidade real do par, simula o resultado
contra segurar os tokens, compara o custo de gás entre as redes, monitora as
posições das carteiras e as do diário e avisa quando é hora de remontar.

Em **Pools → Descobrir pools**, o painel mostra volume, taxas e liquidez por
rede e por app (dados públicos do GeckoTerminal), destaques automáticos e um
ranking filtrável; “Planejar” leva a pool escolhida para o planejador.

Para receber alertas no Telegram com o painel fechado, veja **ALERTAS.md**.

## Estrutura

- `index.html`: casca da aplicação e diálogos.
- `assets/app.css`: visual (tema claro e escuro, responsivo).
- `js/util.js`: formatação, datas, eventos.
- `js/coins.js`: nomes, cores e ícones das criptos.
- `js/api.js`: API pública da Binance e streams em tempo real.
- `js/store.js`: dados salvos e cálculo de posições (custo médio).
- `js/indicators.js`: médias, RSI, MACD, Bollinger, suporte e resistência,
  e a leitura de aporte ajustada à volatilidade de cada cripto.
- `js/lists.js`: listas manuais e automáticas.
- `js/web3.js`: leitura on-chain (RPC, Multicall3, Aave, Uniswap, PancakeSwap, Aerodrome, preços).
- `js/solana-core.js`: leitura de Solana (Orca, Raydium, Meteora), usada pelo painel e pelos alertas.
- `js/poolmath.js`: matemática de liquidez concentrada (faixas, depósito, perda impermanente).
- `scripts/alertas-pools.mjs` e `.github/workflows/alertas-pools.yml`: alertas agendados no Telegram.
- `js/views/`: telas Mercado, Análise, Carteira (com o plano mensal), Web3 e Alertas.

Cotações e gráficos: API pública da Binance. Gráficos: Lightweight Charts
(TradingView). Ícones: cryptocurrency-icons. Informação, não recomendação de
investimento.
