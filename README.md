# AGENTE TRADER — site + backend (Railway)

Análise de trade **educacional** com IA: o Claude organiza cenários, estrutura de preço, indicadores, setups, risco e tamanho, gestão da operação, diário, backtest, psicologia e relatórios, seguindo os **100 códigos de análise de trade** do guia da @thaysfreire.ia. A chave da API vive só no servidor.

O agente **não recomenda compra ou venda** e não promete retorno. Toda entrada, alvo e stop é tratado como hipotético ou simulado, e a análise termina com o aviso de que não é recomendação de investimento (Resolução CVM 20/2021).

## Arquitetura

```
Navegador (público/index.html)
      │  nenhuma chave trafega aqui
      ▼
Backend Express (server.js)
      ├── POST /api/chat     → API da Anthropic (streaming, anexos, busca na web)
      ├── GET  /api/codigos  → os 100 códigos em 10 categorias (lista lateral)
      ├── POST /api/acesso   → valida a senha única, se configurada
      └── GET  /api/saude    → chave presente, modelo, validade do modelo
```

- `trader.js`: catálogo dos 100 códigos, system prompt do agente e reconhecimento de código no início da mensagem.
- `server.js`: chat com streaming, anexos (imagem do gráfico, PDF, CSV/TXT), busca na web do próprio Claude, rate limit, senha opcional.
- `public/index.html`: chat, lista pesquisável dos 100 códigos (clique insere o código), anexo por botão, Ctrl+V ou arrastar, histórico salvo no navegador.
- `teste-trader.js`: cobertura do catálogo, do prompt, do reconhecimento de códigos, dos anexos e dos erros.

## Deploy no Railway

1. No Railway: **New Project → Deploy from GitHub repo** e selecione este repositório. O Railway detecta Node e roda `npm start`.
2. Em **Variables**, adicione `ANTHROPIC_API_KEY` (console.anthropic.com). Opcionais: `CLAUDE_MODEL`, `CLAUDE_EFFORT`, `SENHA_ACESSO` (veja `.env.example`).
3. Em **Settings → Networking**, clique em **Generate Domain**.
4. Abra `https://SEU-DOMINIO/api/saude`. Deve responder `{"ok":true,"chave":true,"modelo":"claude-opus-5","modeloValido":true,...}`.

## Rodando localmente

```bash
npm install
cp .env.example .env   # preencha a chave
node --env-file=.env server.js
# abra http://localhost:3000
```

No Windows/PowerShell:

```powershell
npm install
Copy-Item .env.example .env
node --env-file=.env server.js
```

## Como usar

Comece a mensagem com um dos 100 códigos e dê contexto. Exemplos:

```
/painel-trade WINFUT 15 min. Abriu em gap de alta, rompeu a máxima de ontem em 128.500 e devolveu metade. Objetivo: organizar cenário base, invalidação e o que acompanhar.
```

```
/risco-posicao Capital de simulação R$ 20.000, risco por operação 1%, entrada hipotética 34,20, invalidação 33,60 em PETR4.
```

```
/diario-trade Hoje: 3 operações simuladas no WDO, 2 fora do plano, entrei na terceira por revanche. Resultado líquido -R$ 180 simulados.
```

```
/resumo-grafico   (anexe a imagem do gráfico pelo 📎, Ctrl+V ou arrastando)
```

Sem código, o agente identifica qual dos 100 se aplica, diz qual está usando e executa. `trader` ou `listar códigos` faz o agente se apresentar e listar as 10 categorias. A lista completa está em [docs/CODIGOS.md](docs/CODIGOS.md) e na barra lateral do site.

## Regras que o agente segue

1. Educacional, nunca recomendação: não diz "compre" ou "venda" nem indica ativo para investir.
2. Não inventa cotação, volume, indicador, evento ou resultado de backtest. Trabalha com os dados enviados; a busca na web serve só para contexto público (calendário econômico, juros, notícias), sempre com data e fonte.
3. Separa FATO, PREMISSA, ESTIMATIVA e HIPÓTESE.
4. Toda tese tem invalidação explícita e um cenário contrário.
5. Probabilidades subjetivas em faixa, nunca número seco.
6. Risco primeiro: perda máxima, distância até a invalidação, tamanho compatível e cenário de gap antes de falar em alvo. Suportes e resistências são faixas.
7. Pede os dados que faltam antes de analisar.
8. Indicador é contexto, não sinal automático; aponta redundância entre indicadores.
9. Separa processo de resultado.
10. Fecha com "Nível de Confiança: X/10" e o aviso CVM em análises de ativo concreto.
11. Recusa manipulação de mercado, informação privilegiada, "lucro garantido" e alavancagem para recuperar perdas; se detectar revanche ou FOMO, aplica `/check-emocional` antes da análise técnica.
12. Menores de 18 anos e iniciantes: só estudo e simulação.

## Variáveis de ambiente

- `ANTHROPIC_API_KEY` (obrigatória).
- `CLAUDE_MODEL` (padrão `claude-opus-5`, o mais capaz; `claude-sonnet-5` custa menos). O servidor confere no boot se o ID existe na conta e escreve "MODELO INVÁLIDO" no log se não existir.
- `CLAUDE_EFFORT` (padrão `high`; `low`, `medium`, `xhigh`, `max`).
- `SENHA_ACESSO`: senha única pedida pelo site. Sem ela, o site fica aberto a quem tiver a URL.
- `RATE_LIMIT_POR_MINUTO` (padrão 20 por IP) e `TIMEOUT_IA_MS` (padrão 5 min).

## Monitor (`/monitor`)

Painel de acompanhamento: no topo, Ibovespa, Real/Dólar, Bitcoin, Brent, S&P 500 e Dow Jones. Com a página aberta, o preço e a variação do dia atualizam a cada segundo pelo Yahoo Finance — os seis cards, a faixa, a watchlist, os alertas e o preço do ativo aberto. É uma consulta no servidor para todos os visitantes; a bolsa pode publicar com atraso. O desenho de 6 meses recarrega a cada 10 minutos. Isso não usa a Fincept API — crédito da Fincept só sai no clique do GARCH. Abaixo: busca por nome ou ticker, gráfico do ativo (linha simples com dados do Yahoo ou gráfico completo do TradingView), watchlist, alertas de preço-alvo, visão de mercado, heatmap e notícias. O botão 📈 Monitor no topo do chat leva até ele.

- **Sincronização sem login:** cada navegador gera um código do monitor. Colando esse código em "Usar o código de outro aparelho", o outro navegador passa a ver e editar a mesma watchlist e os mesmos alertas. No servidor fica só o hash do código. Se `SENHA_ACESSO` estiver definida, salvar no servidor também exige a senha.
- **Alertas com a página fechada:** o servidor confere os alertas ativos a cada 5 minutos (`MONITOR_INTERVALO_MS`) com preços do Yahoo e, se houver e-mail cadastrado e SMTP configurado, manda um e-mail por disparo.
- **Onde ficam os dados:** em `DADOS_DIR/monitor.json`. No Railway o disco do container é apagado a cada deploy, então crie um **Volume** (serviço → Settings → Volumes), monte em `/data` e defina `DADOS_DIR=/data`. Sem isso o monitor funciona, mas as listas salvas somem no próximo deploy.
- **E-mail (SMTP):** `SMTP_HOST`, `SMTP_PORT` (587 ou 465), `SMTP_USER`, `SMTP_PASS` e `SMTP_FROM`. Serve qualquer provedor SMTP. No Gmail, use `smtp.gmail.com`, porta 587 e uma [senha de app](https://myaccount.google.com/apppasswords), não a senha da conta. Sem SMTP, os disparos aparecem só na tela.
- Conferência depois do deploy: `GET /api/saude` traz `monitor.dadosPersistentes`, `monitor.gravando` e `monitor.email`.
- **Carteira simulada:** posições hipotéticas (ticker, quantidade e, se quiser, preço médio). O servidor (`carteira.js`) calcula, em reais, retorno de 1 ano, volatilidade, Sharpe e Sortino contra a Selic, VaR de 95% em 1 dia (histórico e paramétrico), CVaR, drawdown máximo, beta contra o Ibovespa e a correlação entre os ativos. Com dois ou mais ativos, simula 3 mil combinações de pesos (só compradas) e mostra a fronteira eficiente com a carteira atual, a de mínima variância e a de máximo Sharpe. Os pesos de hoje são aplicados ao último ano; ativos em dólar são convertidos pelo câmbio de cada dia. A carteira sincroniza junto com a watchlist.
- **Simulador de ordens (paper trading):** registra compras e vendas hipotéticas (preço preenchido pela cotação e editável, custos opcionais). O `simulador.js` reconstrói as posições pelo preço médio, separa resultado aberto e realizado e mede as operações encerradas: taxa de acerto, payoff, expectativa por operação e maior sequência de perdas. Só posições compradas; nenhuma ordem sai do site. As ordens (até 300) sincronizam com o código do monitor.
- **Macro:** Selic, CDI, IPCA, dólar PTAX e desemprego do Banco Central (SGS, sem chave), ao lado dos indicadores do FRED, e uma tabela do Banco Mundial (sem chave) com PIB, inflação, desemprego, PIB per capita, conta corrente, dívida e comércio exterior de Brasil, EUA, China e mundo. Nomes de país, de indicador e da agenda econômica chegam em português; a sigla internacional (CPI, PMI) fica entre parênteses.
- **Notícias:** o botão "Traduzir para português" manda os títulos e resumos da aba atual para a IA (uma vez; o resultado fica em cache por 6 horas). O mesmo botão fica nas notícias do Painel EUA, no chat. Sem `ANTHROPIC_API_KEY` o botão responde que a tradução está indisponível.
- **Fincept API (opcional, `FINCEPT_API_KEY`):** juro de 10 anos, juro do banco central, rating e CDS por país, agenda econômica de 7 dias de Brasil e EUA (Trading Economics) e, por clique no ativo, previsão de volatilidade GARCH(1,1). A conta gratuita em [fincept.in](https://fincept.in) vem com 350 créditos que não renovam, então as respostas ficam em cache (12 h, 3 h e 24 h) e há um teto diário de chamadas (`FINCEPT_CHAMADAS_POR_DIA`, padrão 40). A integração é só por REST: nenhum código do FinceptTerminal (AGPL-3.0) entra no repositório.
- **Empresa:** P/L, P/VP, dividend yield, margens, ROE, dívida e beta do Finnhub, para ações dos EUA.
- **Analisar no chat:** leva o ativo, a carteira ou o macro para o chat já com um dos 100 códigos (`/painel-trade`, `/risco-carteira`, `/contexto-macro` e outros). O texto só aparece no campo do chat; quem envia é a pessoa.

## Proteções incluídas

- Rate limit por IP, limite de tamanho de mensagem, de histórico e de anexos (5 por mensagem, 20MB cada).
- Anexos antigos saem do contexto após 2 turnos (economia de tokens).
- Chave nunca exposta ao navegador; `.env` fora do git; `robots.txt` bloqueando indexação.

## Custos estimados

Cada resposta usa até 16 mil tokens de saída e o system prompt (os 100 códigos e as regras) fica em cache de prompt, então uso pessoal custa centavos por análise no Sonnet e alguns centavos a mais no Opus. Imagens de gráfico e PDFs longos pesam mais. Acompanhe o consumo no painel da Anthropic.

## Testes

```bash
npm test      # teste-trader.js
npm run check # node --check nos arquivos
```

## Avisos

Este material é educacional. A IA pode errar, omitir riscos ou usar dados desatualizados. Não trate as respostas como recomendação de investimento. Para menores de 18 anos, use somente em estudos e simulações, com acompanhamento de um responsável.
