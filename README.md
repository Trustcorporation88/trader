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
