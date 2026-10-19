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

## Estrutura

- `index.html`: casca da aplicação e diálogos.
- `assets/app.css`: visual (tema claro e escuro, responsivo).
- `js/util.js`: formatação, datas, eventos.
- `js/coins.js`: nomes, cores e ícones das criptos.
- `js/api.js`: API pública da Binance e streams em tempo real.
- `js/store.js`: dados salvos e cálculo de posições (custo médio).
- `js/indicators.js`: médias, RSI, MACD, Bollinger, suporte e resistência,
  e a leitura de aporte ajustada à volatilidade de cada cripto.
- `js/views/`: telas Mercado, Análise, Carteira e Alertas.

Cotações e gráficos: API pública da Binance. Gráficos: Lightweight Charts
(TradingView). Ícones: cryptocurrency-icons. Informação, não recomendação de
investimento.
