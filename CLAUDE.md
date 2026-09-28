# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é

Agente Trader: chat de análise de trade **educacional** com IA (Claude) baseado nos "100 códigos de análise de trade". O agente nunca recomenda compra/venda — toda análise é hipotética/simulada e fecha com o aviso da Resolução CVM 20/2021. Esse posicionamento educacional é um invariante do produto (verificado nos testes), não um detalhe de copy.

Todo o código, comentários, mensagens de erro e UI são em português do Brasil. Mantenha esse padrão.

## Comandos

```bash
npm install
npm start                        # roda local e em produção (http://localhost:3000); server.js carrega o .env via dotenv
node --env-file=.env server.js   # alternativa; exige Node 20.6+ (--env-file não existe no Node 18)
npm test                         # roda teste-trader.js (arquivo único de asserts; não há test runner)
npm run check                    # node --check em server.js, trader.js e teste-trader.js
```

`package.json` declara `engines: node >=18`, mas o README sugere `--env-file`, que só existe a partir do Node 20.6 — em Node 18 use `npm start` (o `require('dotenv').config()` no topo do server.js já lê o `.env`), ou eleve a versão mínima declarada.

Não há lint nem framework de testes — `npm test` executa `teste-trader.js` de ponta a ponta (asserts com `node:assert`); não é possível rodar um teste isolado. Deploy é no Railway (`railway.json` + `Procfile`, `npm start`).

## Arquitetura

Três arquivos fazem tudo (fora `node_modules`):

- **server.js** — backend Express inteiro. `POST /api/chat` (streaming de texto puro para o navegador, anexos, busca na web do Claude), `GET /api/codigos`, `POST /api/acesso` (senha única opcional), `GET /api/saude`, além de proxies com cache em memória para dados de mercado: `/api/cotacoes` e `/api/ativo` (Yahoo Finance v8/chart), `/api/eua/*` (Finnhub e FRED). Exporta helpers (`blocosDosAnexos`, `podarAnexosAntigos`, `ferramentaBuscaWeb`, `mensagemErroAnthropic`) e só chama `app.listen` quando `require.main === module` — é assim que o teste importa o server sem subir a porta.
- **trader.js** — definição do agente: as 10 categorias × 10 códigos, o system prompt (catálogo + regras invioláveis) e `mensagemInvocaTrader()` (reconhece código/atalho no início da mensagem). O system prompt vai à API com `cache_control: ephemeral` (cache de prompt), então seu tamanho importa menos que sua estabilidade.
- **public/index.html** — frontend completo em um arquivo (HTML+CSS+JS): chat, barra lateral com os 100 códigos, anexos (botão, Ctrl+V, arrastar), histórico no localStorage. Consome o streaming como texto simples; o agente é instruído a nunca usar tabelas markdown porque o chat não as renderiza.

Fluxos importantes no `/api/chat` (server.js):
- A chave da API nunca vai ao navegador; o histórico chega do cliente como texto e os blocos binários (imagem/PDF) são montados no servidor a cada requisição.
- `podarAnexosAntigos()`: só os 2 turnos mais recentes mantêm imagem/PDF; anexos antigos viram aviso textual (economia de tokens).
- Histórico é truncado por número de turnos (40) e por total de caracteres (400k).
- `ferramentaBuscaWeb()` escolhe a versão da tool de web search conforme a geração do modelo.
- Rate limit por IP e senha opcional (`SENHA_ACESSO`, comparação timing-safe) protegem `/api/chat` e `/api/acesso`.

## Invariantes verificados pelos testes

`teste-trader.js` quebra se você violar: exatamente 100 códigos em 10 categorias de 10, códigos únicos no formato `/kebab-case`, cada código presente no system prompt como `"/codigo — "`, as regras de não-recomendação e o aviso CVM presentes no prompt, o reconhecimento de código/atalho e a poda de anexos antigos.

A cobertura de anexos é **parcial**: os testes exercitam PNG (imagem), PDF, CSV (texto) e as rejeições de anexo vazio, mais de 5 arquivos, arquivo acima de 20MB e extensão não suportada (XLSX). JPG/JPEG, WEBP, GIF, TXT, JSON e MD são aceitos por `blocosDosAnexos` mas não têm teste — mexer neles não quebra a suíte. Ao mexer em `trader.js` ou nos helpers do `server.js`, rode `npm test`.

## Variáveis de ambiente

Ver `.env.example`. `ANTHROPIC_API_KEY` é obrigatória; `CLAUDE_MODEL` (padrão `claude-opus-5`, validado no boot contra `client.models.list()`), `CLAUDE_EFFORT`, `SENHA_ACESSO`, `RATE_LIMIT_POR_MINUTO`, `TIMEOUT_IA_MS` são opcionais.

O Monitor (`/monitor`, `public/monitor.html` + `monitor.js`) grava watchlists e alertas em `DADOS_DIR/monitor.json` (no Railway, precisa de Volume) e envia e-mail de alerta via `SMTP_*` (nodemailer). Sem SMTP os alertas só aparecem na tela; sem `DADOS_DIR` os dados somem a cada deploy. `monitor.js` tem as funções puras (validação, mesclagem entre aparelhos, rotina de alertas) testadas no item 7 do `teste-trader.js`.

`FINNHUB_API_KEY` e `FRED_API_KEY` alimentam o painel EUA e não têm fallback: sem elas, `/api/eua/*` responde 503 (com aviso no boot) e o resto do app funciona. Nenhuma chave deve voltar a ser hardcoded — o repositório é público. `GET /api/saude` expõe `finnhub` e `fred` como booleanos para conferir, depois do deploy, se as Variables do Railway chegaram.
