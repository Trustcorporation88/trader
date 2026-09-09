'use strict';
// ============================================================
// AGENTE TRADER — servidor (Express + Claude)
// Análise de trade EDUCACIONAL com os 100 códigos do guia. A chave da API vive
// só aqui; o navegador nunca a vê. Uma rota de chat com streaming, anexos
// (imagem do gráfico, PDF, planilha/CSV/TXT) e busca na web do próprio Claude.
// ============================================================
require('dotenv').config(); // carrega variáveis do arquivo .env (ex.: ANTHROPIC_API_KEY)
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { AGENTE_TRADER, CODIGOS_TRADER, CATEGORIAS_TRADER, mensagemInvocaTrader } = require('./trader');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.CLAUDE_MODEL || 'claude-opus-5').trim() || 'claude-opus-5';
const EFFORT = (process.env.CLAUDE_EFFORT || 'high').trim();
const TIMEOUT_MS = Number(process.env.TIMEOUT_IA_MS) || 300_000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT_POR_MINUTO) || 20;
const SENHA_ACESSO = (process.env.SENHA_ACESSO || '').trim();
const MAX_TOKENS = 16_000;
const MAX_HISTORICO = 40;         // turnos enviados ao modelo
const MAX_CHARS_MENSAGEM = 30_000;
const MAX_CHARS_HISTORICO = 400_000; // total de chars no histórico enviado ao modelo
const MAX_ANEXOS = 5;
const MAX_ANEXO_MB = 20;          // por arquivo (a API limita o pedido inteiro em ~32MB)
const TURNOS_COM_ANEXO = 2;       // anexos dos N turnos mais recentes seguem visíveis

const app = express();
app.set('trust proxy', 1);
app.use('/api/chat', express.json({ limit: '40mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, caminho) => { if (caminho.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate'); }
}));

const client = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY, timeout: TIMEOUT_MS, maxRetries: 1 }) : null;

// ---------- Diagnóstico: o modelo existe na conta? ----------
let modeloValido = null; // null = não conferido; true/false depois do boot
async function validarModelo() {
  if (!client) return;
  try {
    const ids = [];
    for await (const m of client.models.list()) ids.push(m.id);
    modeloValido = ids.includes(MODEL);
    if (!modeloValido) console.error(`MODELO INVÁLIDO: "${MODEL}" não existe nesta conta. Disponíveis: ${ids.join(', ')}`);
  } catch (e) {
    console.error('Não consegui listar os modelos da Anthropic:', e.message);
  }
}

// ---------- Logging básico ----------
function log(nivel, ...args) {
  const ts = new Date().toISOString();
  (nivel === 'erro' ? console.error : console.log)(`[${ts}] [${nivel.toUpperCase()}]`, ...args);
}

// ---------- Rate limit simples por IP ----------
/** Cria um middleware de limite por IP com janela de 1 minuto e contador próprio. */
function criarLimitador(maxPorMinuto) {
  const janelas = new Map();
  setInterval(() => {
    const corte = Date.now() - 60_000;
    for (const [ip, j] of janelas) { const vivos = j.filter((t) => t > corte); if (vivos.length) janelas.set(ip, vivos); else janelas.delete(ip); }
  }, 5 * 60_000).unref();
  return function (req, res, next) {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    const agora = Date.now();
    const recentes = (janelas.get(ip) || []).filter((t) => agora - t < 60_000);
    if (recentes.length >= maxPorMinuto) return res.status(429).json({ erro: 'Muitas requisições. Aguarde um minuto.' });
    recentes.push(agora);
    janelas.set(ip, recentes);
    next();
  };
}
const limitar = criarLimitador(RATE_LIMIT);
// Rotas que consomem cota de terceiros a cada chamada (Yahoo, Finnhub, FRED, brapi).
const limitarDados = criarLimitador(Math.max(10, RATE_LIMIT * 2));
// Busca da Exa: cobrada por requisição, então o limite é bem menor.
const limitarBusca = criarLimitador(Math.max(3, Math.ceil(RATE_LIMIT / 4)));

// ---------- Senha única opcional ----------
function exigirSenha(req, res, next) {
  if (!SENHA_ACESSO) return next();
  const enviada = String(req.headers['x-senha-acesso'] || '');
  const a = Buffer.from(enviada), b = Buffer.from(SENHA_ACESSO);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  return res.status(401).json({ erro: 'Senha de acesso inválida.' });
}

// ---------- Busca na web (ferramenta do próprio Claude) ----------
function ferramentaBuscaWeb(modelo) {
  const atual = /sonnet-5|opus-5|opus-4-[678]|sonnet-4-6|fable/.test(String(modelo));
  return { type: atual ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 5 };
}

function mensagemErroAnthropic(err) {
  const status = err && err.status;
  const msg = String((err && err.message) || '').toLowerCase();
  if (msg.includes('could not process pdf') || msg.includes('invalid pdf')) return 'Não consegui processar este PDF. Pode estar protegido por senha ou corrompido.';
  if (status === 413 || msg.includes('too large') || (msg.includes('maximum') && msg.includes('page'))) return 'Arquivo grande demais ou com páginas demais. Envie um arquivo menor.';
  if (status === 402 || msg.includes('credit') || msg.includes('billing')) return 'Cota da Anthropic esgotada ou cobrança pendente.';
  if (status === 429) return 'Limite de uso da Anthropic atingido. Aguarde um minuto.';
  if (status === 401 || msg.includes('authentication')) return 'ANTHROPIC_API_KEY inválida ou expirada.';
  if (status === 404 && msg.includes('model')) return `Modelo "${MODEL}" não encontrado na conta. Ajuste CLAUDE_MODEL.`;
  if (status === 529 || msg.includes('overloaded')) return 'Anthropic sobrecarregada. Tente de novo em instantes.';
  if (msg.includes('web search') && (msg.includes('not enabled') || msg.includes('disabled'))) return 'Busca na web desabilitada na organização da Anthropic.';
  return err && err.message ? `Falha na Anthropic: ${String(err.message).slice(0, 200)}` : 'Claude indisponível.';
}

// ---------- Anexos ----------
const IMAGENS = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const TEXTOS = new Set(['txt', 'csv', 'md', 'json', 'tsv']);

/** Converte os anexos enviados pelo navegador em blocos da API. Lança Error com mensagem amigável. */
function blocosDosAnexos(arquivos) {
  if (!Array.isArray(arquivos) || !arquivos.length) return { binarios: [], textos: [] };
  if (arquivos.length > MAX_ANEXOS) throw new Error(`No máximo ${MAX_ANEXOS} anexos por mensagem.`);
  const binarios = [], textos = [];
  for (const a of arquivos) {
    const nome = String((a && a.nome) || 'arquivo');
    const dataB64 = String((a && a.dataB64) || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
    if (!dataB64) throw new Error(`Anexo "${nome}" veio vazio.`);
    const mb = (dataB64.length * 3) / 4 / 1024 / 1024;
    if (mb > MAX_ANEXO_MB) throw new Error(`"${nome}" tem ${mb.toFixed(1)}MB; o limite é ${MAX_ANEXO_MB}MB por arquivo.`);
    const ext = nome.split('.').pop().toLowerCase();
    if (IMAGENS[ext]) {
      binarios.push({ type: 'image', source: { type: 'base64', media_type: IMAGENS[ext], data: dataB64 } });
    } else if (ext === 'pdf') {
      binarios.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: dataB64 }, title: nome });
    } else if (TEXTOS.has(ext)) {
      const texto = Buffer.from(dataB64, 'base64').toString('utf8');
      if (texto.length > 200_000) throw new Error(`"${nome}" é grande demais (limite de 200 mil caracteres de texto).`);
      textos.push(`[ARQUIVO ${nome}]\n${texto}\n[FIM DE ${nome}]`);
    } else {
      throw new Error(`Formato de "${nome}" não suportado. Envie imagem (PNG/JPG/WEBP), PDF, CSV, TXT, JSON ou MD.`);
    }
  }
  return { binarios, textos };
}

/** Mantém os blocos de imagem/PDF só nos turnos mais recentes; os antigos viram aviso textual. */
function podarAnexosAntigos(historico) {
  let vistos = 0;
  for (let i = historico.length - 1; i >= 0; i--) {
    const m = historico[i];
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    if (!m.content.some((b) => b.type === 'image' || b.type === 'document')) continue;
    vistos++;
    if (vistos <= TURNOS_COM_ANEXO) continue;
    const texto = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const nomes = m.content.filter((b) => b.type !== 'text').map((b) => (b.type === 'image' ? 'imagem' : b.title || 'PDF'));
    m.content = `[Anexos deste turno removidos do contexto por economia: ${nomes.join(', ')}. Peça o reenvio se precisar.]\n${texto}`;
  }
}

// ---------- Rotas ----------
app.get('/api/saude', (_req, res) => res.json({
  ok: true, chave: !!client, modelo: MODEL, modeloValido, effort: EFFORT, senha: !!SENHA_ACESSO, codigos: CODIGOS_TRADER.length,
  // conferir depois do deploy se as Variables chegaram
  finnhub: !!FINNHUB_KEY, fred: !!FRED_KEY, brapi: !!BRAPI_KEY, exa: !!EXA_KEY,
}));

app.get('/api/codigos', (_req, res) => res.json({
  categorias: CATEGORIAS_TRADER.map((c) => ({ nome: c.nome, codigos: c.codigos.map(([codigo, descricao]) => ({ codigo, descricao })) })),
}));

app.post('/api/acesso', limitar, exigirSenha, (_req, res) => res.json({ ok: true }));

app.post('/api/chat', limitar, exigirSenha, async (req, res) => {
  if (!client) return res.status(503).json({ erro: 'ANTHROPIC_API_KEY não configurada no servidor.' });
  const brutos = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
  if (!brutos.length) return res.status(400).json({ erro: 'Envie ao menos uma mensagem.' });

  // Histórico: só texto vindo do navegador (os blocos binários são montados aqui).
  const historico = [];
  for (const m of brutos.slice(-MAX_HISTORICO)) {
    const role = m && m.role === 'assistant' ? 'assistant' : 'user';
    let content = m && m.content;
    if (Array.isArray(content)) content = content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
    content = String(content || '').slice(0, MAX_CHARS_MENSAGEM);
    if (!content.trim() && role === 'assistant') continue;
    historico.push({ role, content: content || '(vazio)' });
  }
  if (historico[0].role !== 'user') historico.unshift({ role: 'user', content: 'Olá.' });
  if (historico[historico.length - 1].role !== 'user') return res.status(400).json({ erro: 'A última mensagem precisa ser sua.' });

  // Trunca histórico antigo se ultrapassar o limite total de caracteres
  let totalChars = historico.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
  while (historico.length > 2 && totalChars > MAX_CHARS_HISTORICO) {
    const removido = historico.shift();
    if (historico[0] && historico[0].role === 'assistant') historico.shift(); // remove par
    totalChars = historico.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
    void removido;
  }
  if (historico[0].role !== 'user') historico.unshift({ role: 'user', content: 'Olá.' });

  let anexos;
  try { anexos = blocosDosAnexos(req.body.arquivos); } catch (e) { return res.status(400).json({ erro: e.message }); }
  if (anexos.binarios.length || anexos.textos.length) {
    const ultima = historico[historico.length - 1];
    const temImagem = anexos.binarios.some((b) => b.type === 'image');
    const instrucao = temImagem
      ? 'Se a imagem for um gráfico, descreva primeiro os fatos visuais (ativo e tempo gráfico se legíveis, últimas candles, topos e fundos, indicadores, volume) e só depois interprete; se for documento ou planilha, transcreva os dados relevantes antes de analisar. '
      : '';
    const textoFinal = (anexos.textos.length ? anexos.textos.join('\n\n') + '\n\n' : '') + instrucao + (ultima.content || 'Analise o material anexado.');
    ultima.content = [...anexos.binarios, { type: 'text', text: textoFinal }];
  }
  podarAnexosAntigos(historico);

  const ultimaTexto = typeof historico[historico.length - 1].content === 'string'
    ? historico[historico.length - 1].content
    : historico[historico.length - 1].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  res.setHeader('X-Trader-Codigo', mensagemInvocaTrader(ultimaTexto) ? '1' : '0');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
  const inicio = Date.now();
  log('info', `chat ip=${ip} turnos=${historico.length} modelo=${MODEL}`);

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: AGENTE_TRADER.system, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: EFFORT },
    tools: [ferramentaBuscaWeb(MODEL)],
    messages: historico,
  });
  // Cliente desistiu (fechou a aba): aborta a geração para não pagar tokens à toa.
  // É no `res`, não no `req`: o 'close' do req dispara assim que o corpo foi lido.
  res.on('close', () => { if (!res.writableFinished) { try { stream.controller.abort(); } catch (_) { /* já encerrado */ } } });

  let escreveu = false;
  let avisouBusca = false;
  try {
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        if (!escreveu) { res.flushHeaders(); escreveu = true; }
        res.write(ev.delta.text);
      } else if (ev.type === 'content_block_start' && ev.content_block.type === 'server_tool_use' && !avisouBusca) {
        avisouBusca = true;
        if (!escreveu) { res.flushHeaders(); escreveu = true; }
        res.write('🔎 [consultando fontes na web…]\n\n');
      } else if (ev.type === 'message_delta' && ev.delta.stop_reason === 'max_tokens') {
        res.write('\n\n⏸ **[Análise extensa: atingi o limite desta resposta. Envie "continue" e prossigo do ponto exato.]**');
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      res.write((escreveu ? '\n\n' : '') + 'Não posso ajudar com esse pedido específico. Reformule dentro do escopo educacional do Trader.');
    }
    const uso = final.usage || {};
    log('info', `chat ok ip=${ip} dur=${Date.now()-inicio}ms in=${uso.input_tokens||'?'} out=${uso.output_tokens||'?'}`);
    res.end();
  } catch (err) {
    if (res.destroyed || (err && err.name === 'AbortError')) return res.end();
    const amigavel = mensagemErroAnthropic(err);
    log('erro', `chat ip=${ip} dur=${Date.now()-inicio}ms status=${err && err.status} msg=${err && err.message}`);
    if (!escreveu && !res.headersSent) return res.status(err && err.status >= 400 && err.status < 600 ? err.status : 502).json({ erro: amigavel });
    res.write(`\n\n⚠️ ${amigavel}`);
    res.end();
  }
});

// ---------- Cotações (proxy Yahoo Finance — evita CORS no navegador) ----------
const https = require('https');
const SIMBOLOS_COTACOES = ['^BVSP', 'USDBRL=X', 'BTC-USD', 'BZ=F', '^GSPC', '^DJI'];

// Cache em memória para não bater na API a cada requisição
let _cotCache = null;
let _cotCacheTs = 0;
const COT_TTL = 55_000; // 55 segundos

// Busca uma cotação via endpoint público v8/chart do Yahoo (sem crumb/cookie, estável).
function fetchCotacao(simbolo) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'query1.finance.yahoo.com',
      path: `/v8/finance/chart/${encodeURIComponent(simbolo)}?range=1d&interval=1d`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'application/json',
      },
      timeout: 8000,
    };
    const r = https.get(opts, (resp) => {
      let data = '';
      resp.on('data', (c) => { data += c; });
      resp.on('end', () => {
        try {
          const j = JSON.parse(data);
          const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
          if (!meta || meta.regularMarketPrice == null) return reject(new Error(`sem dados para ${simbolo}`));
          const preco = meta.regularMarketPrice;
          const anterior = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;
          const variacao = anterior ? ((preco - anterior) / anterior) * 100 : null;
          resolve({
            symbol: simbolo,
            shortName: meta.shortName || simbolo,
            regularMarketPrice: preco,
            regularMarketChangePercent: variacao,
            marketState: meta.marketState || null,
          });
        } catch (e) { reject(e); }
      });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error(`timeout ${simbolo}`)); });
    r.on('error', reject);
  });
}

// Busca todas as cotações em paralelo; símbolos que falharem são omitidos.
async function fetchCotacoes(simbolos) {
  const resultados = await Promise.allSettled(simbolos.map((s) => fetchCotacao(s)));
  const result = resultados.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!result.length) throw new Error('nenhuma cotação disponível');
  return { quoteResponse: { result } };
}

app.get('/api/cotacoes', limitarDados, async (req, res) => {
  try {
    const forcar = /^(1|true|sim)$/i.test(String(req.query.force || ''));
    const agora = Date.now();
    if (!forcar && _cotCache && agora - _cotCacheTs < COT_TTL) {
      res.setHeader('Cache-Control', 'public, max-age=55');
      return res.json(_cotCache);
    }
    const data = await fetchCotacoes(SIMBOLOS_COTACOES);
    _cotCache = data;
    _cotCacheTs = Date.now();
    res.setHeader('Cache-Control', forcar ? 'no-store' : 'public, max-age=55');
    res.json(data);
  } catch (e) {
    log('erro', 'cotacoes:', e.message);
    if (_cotCache) { res.setHeader('Cache-Control', 'public, max-age=10'); return res.json(_cotCache); }
    res.status(502).json({ erro: 'Falha ao buscar cotações.' });
  }
});

// ---------- Dados reais de um ativo (topo/fundo/preço) para o Painel Guiado ----------
// Busca histórico diário recente e devolve preço atual, topo e fundo reais do período.
// Isso permite que o site sugira faixas dentro da realidade do ativo, sem inventar preço.
function fetchAtivoDetalhe(simbolo) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'query1.finance.yahoo.com',
      path: `/v8/finance/chart/${encodeURIComponent(simbolo)}?range=1mo&interval=1d`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'application/json',
      },
      timeout: 8000,
    };
    const r = https.get(opts, (resp) => {
      let data = '';
      resp.on('data', (c) => { data += c; });
      resp.on('end', () => {
        try {
          const j = JSON.parse(data);
          const r0 = j && j.chart && j.chart.result && j.chart.result[0];
          const meta = r0 && r0.meta;
          if (!meta || meta.regularMarketPrice == null) return reject(new Error(`sem dados para ${simbolo}`));
          const q = (r0.indicators && r0.indicators.quote && r0.indicators.quote[0]) || {};
          const highs = (q.high || []).filter((v) => v != null);
          const lows = (q.low || []).filter((v) => v != null);
          const preco = meta.regularMarketPrice;
          const anterior = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;
          resolve({
            symbol: simbolo,
            shortName: meta.shortName || simbolo,
            preco,
            anterior: anterior != null ? anterior : null,
            variacao: anterior ? ((preco - anterior) / anterior) * 100 : null,
            topo: highs.length ? Math.max(...highs) : null,       // máxima real do período
            fundo: lows.length ? Math.min(...lows) : null,        // mínima real do período
            pregoes: highs.length,
            moeda: meta.currency || null,
          });
        } catch (e) { reject(e); }
      });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error(`timeout ${simbolo}`)); });
    r.on('error', reject);
  });
}

const _ativoCache = new Map(); // symbol -> { data, ts }
app.get('/api/ativo', limitarDados, async (req, res) => {
  const simbolo = String(req.query.symbol || '').trim();
  if (!simbolo) return res.status(400).json({ erro: 'Informe ?symbol=' });
  try {
    const cache = _ativoCache.get(simbolo);
    if (cache && Date.now() - cache.ts < COT_TTL) {
      res.setHeader('Cache-Control', 'public, max-age=55');
      return res.json(cache.data);
    }
    const data = await fetchAtivoDetalhe(simbolo);
    _ativoCache.set(simbolo, { data, ts: Date.now() });
    res.setHeader('Cache-Control', 'public, max-age=55');
    res.json(data);
  } catch (e) {
    log('erro', 'ativo:', e.message);
    const cache = _ativoCache.get(simbolo);
    if (cache) { res.setHeader('Cache-Control', 'public, max-age=10'); return res.json(cache.data); }
    res.status(502).json({ erro: 'Falha ao buscar dados do ativo.' });
  }
});

// ============================================================
// PAINEL EUA — notícias (Finnhub), indicadores macro (FRED) e cotações de ações (Finnhub)
// As chaves ficam só no servidor e vêm exclusivamente do ambiente (.env local,
// Variables no Railway). Sem elas as rotas /api/eua/* respondem 503 e o resto do
// app segue funcionando normalmente.
// ============================================================
const FRED_KEY = (process.env.FRED_API_KEY || '').trim();
const FINNHUB_KEY = (process.env.FINNHUB_API_KEY || '').trim();

/** Responde 503 e devolve true quando a chave da API não está configurada. */
function faltaChave(chave, nome, res) {
  if (chave) return false;
  res.status(503).json({ erro: `${nome} não configurada no servidor.` });
  return true;
}

// Helper genérico: GET JSON com timeout. Aceita URL completa.
function fetchJson(url, { timeout = 8000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = https.get(url, {
      headers: { 'User-Agent': 'agente-trader', 'Accept': 'application/json', ...headers },
      timeout,
    }, (resp) => {
      let data = '';
      resp.on('data', (c) => { data += c; });
      resp.on('end', () => {
        if (resp.statusCode < 200 || resp.statusCode >= 300) return reject(new Error(`HTTP ${resp.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
  });
}

// Helper genérico: POST JSON com timeout. Usado pela Exa, que só aceita POST.
function postJson(url, corpo, { timeout = 15_000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(corpo);
    const u = new URL(url);
    const r = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'User-Agent': 'agente-trader',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
      timeout,
    }, (resp) => {
      let data = '';
      resp.on('data', (c) => { data += c; });
      resp.on('end', () => {
        if (resp.statusCode < 200 || resp.statusCode >= 300) return reject(new Error(`HTTP ${resp.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

// Cache em memória simples (por chave) para não estourar os limites das APIs.
const _euaCache = new Map(); // chave -> { data, ts }
function cacheGet(chave, ttl, forcar) {
  if (forcar) return null;
  const c = _euaCache.get(chave);
  return c && Date.now() - c.ts < ttl ? c.data : null;
}
// Teto de entradas: /api/br/noticias usa uma chave por ticker, então sem isso um
// caller poderia inflar o Map indefinidamente variando o símbolo.
const MAX_CACHE_ENTRADAS = 200;
function cacheSet(chave, data) {
  if (!_euaCache.has(chave) && _euaCache.size >= MAX_CACHE_ENTRADAS) {
    _euaCache.delete(_euaCache.keys().next().value); // Map mantém ordem de inserção: sai a mais antiga
  }
  _euaCache.set(chave, { data, ts: Date.now() });
}
function ehForce(req) { return /^(1|true|sim)$/i.test(String(req.query.force || '')); }

// ---------- Cotações de ações dos EUA (Finnhub) ----------
const ACOES_EUA = [
  { symbol: 'AAPL', nome: 'Apple' },
  { symbol: 'MSFT', nome: 'Microsoft' },
  { symbol: 'NVDA', nome: 'NVIDIA' },
  { symbol: 'AMZN', nome: 'Amazon' },
  { symbol: 'GOOGL', nome: 'Alphabet' },
  { symbol: 'META', nome: 'Meta' },
  { symbol: 'TSLA', nome: 'Tesla' },
];
async function fetchAcaoEUA(a) {
  const j = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(a.symbol)}&token=${FINNHUB_KEY}`);
  if (!j || j.c == null || j.c === 0) throw new Error(`sem dados para ${a.symbol}`);
  return { symbol: a.symbol, nome: a.nome, preco: j.c, variacao: j.dp, anterior: j.pc, alta: j.h, baixa: j.l };
}

app.get('/api/eua/cotacoes', limitarDados, async (req, res) => {
  if (faltaChave(FINNHUB_KEY, 'FINNHUB_API_KEY', res)) return;
  const forcar = ehForce(req);
  const cache = cacheGet('acoes', 30_000, forcar);
  if (cache) { res.setHeader('Cache-Control', 'public, max-age=30'); return res.json(cache); }
  try {
    const resultados = await Promise.allSettled(ACOES_EUA.map((a) => fetchAcaoEUA(a)));
    const result = resultados.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!result.length) throw new Error('nenhuma cotação EUA disponível');
    const data = { result };
    cacheSet('acoes', data);
    res.setHeader('Cache-Control', forcar ? 'no-store' : 'public, max-age=30');
    res.json(data);
  } catch (e) {
    log('erro', 'eua/cotacoes:', e.message);
    const c = _euaCache.get('acoes');
    if (c) { res.setHeader('Cache-Control', 'public, max-age=10'); return res.json(c.data); }
    res.status(502).json({ erro: 'Falha ao buscar cotações dos EUA.' });
  }
});

// ---------- Notícias dos EUA (Finnhub) ----------
async function fetchNoticiasEUA() {
  // Timeout maior que o padrão: esta resposta passa de 60KB e já foi medida entre
  // 3s e 16s em produção; com os 8s padrão a rota falhava de forma intermitente.
  const j = await fetchJson(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}`, { timeout: 25_000 });
  if (!Array.isArray(j)) throw new Error('resposta de notícias inválida');
  return j.slice(0, 15).map((n) => ({
    titulo: n.headline, resumo: n.summary, fonte: n.source, url: n.url,
    data: n.datetime ? n.datetime * 1000 : null, imagem: n.image || null,
  })).filter((n) => n.titulo && n.url);
}

app.get('/api/eua/noticias', limitarDados, async (req, res) => {
  if (faltaChave(FINNHUB_KEY, 'FINNHUB_API_KEY', res)) return;
  const forcar = ehForce(req);
  const cache = cacheGet('noticias', 300_000, forcar); // 5 min
  if (cache) { res.setHeader('Cache-Control', 'public, max-age=300'); return res.json(cache); }
  try {
    const result = await fetchNoticiasEUA();
    const data = { result };
    cacheSet('noticias', data);
    res.setHeader('Cache-Control', forcar ? 'no-store' : 'public, max-age=300');
    res.json(data);
  } catch (e) {
    log('erro', 'eua/noticias:', e.message);
    const c = _euaCache.get('noticias');
    if (c) { res.setHeader('Cache-Control', 'public, max-age=30'); return res.json(c.data); }
    res.status(502).json({ erro: 'Falha ao buscar notícias dos EUA.' });
  }
});

// ---------- Indicadores macro dos EUA (FRED) ----------
const FRED_SERIES = [
  { id: 'FEDFUNDS', nome: 'Juros do Fed (Fed Funds)', sufixo: '%' },
  { id: 'UNRATE',   nome: 'Desemprego (EUA)',          sufixo: '%' },
  { id: 'CPIAUCSL', nome: 'CPI (índice de preços)',    sufixo: '' },
  { id: 'DGS10',    nome: 'Treasury 10 anos',          sufixo: '%' },
  { id: 'GDP',      nome: 'PIB (US$ bi)',              sufixo: '' },
];
async function fetchIndicadorFred(s) {
  const j = await fetchJson(`https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(s.id)}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=1`);
  const o = j && j.observations && j.observations[0];
  if (!o || o.value == null || o.value === '.') throw new Error(`sem dados para ${s.id}`);
  return { id: s.id, nome: s.nome, valor: Number(o.value), data: o.date, sufixo: s.sufixo };
}

app.get('/api/eua/indicadores', limitarDados, async (req, res) => {
  if (faltaChave(FRED_KEY, 'FRED_API_KEY', res)) return;
  const forcar = ehForce(req);
  const cache = cacheGet('indicadores', 3_600_000, forcar); // 1 h
  if (cache) { res.setHeader('Cache-Control', 'public, max-age=3600'); return res.json(cache); }
  try {
    const resultados = await Promise.allSettled(FRED_SERIES.map((s) => fetchIndicadorFred(s)));
    const result = resultados.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!result.length) throw new Error('nenhum indicador disponível');
    const data = { result };
    cacheSet('indicadores', data);
    res.setHeader('Cache-Control', forcar ? 'no-store' : 'public, max-age=3600');
    res.json(data);
  } catch (e) {
    log('erro', 'eua/indicadores:', e.message);
    const c = _euaCache.get('indicadores');
    if (c) { res.setHeader('Cache-Control', 'public, max-age=60'); return res.json(c.data); }
    res.status(502).json({ erro: 'Falha ao buscar indicadores dos EUA.' });
  }
});

// ============================================================
// PAINEL BRASIL — cotações da B3 (brapi) e notícias por ativo (Exa)
// Rotas independentes do Yahoo: /api/cotacoes e /api/ativo seguem intactos.
// Mesmo padrão do painel EUA: chaves só do ambiente, cache em memória, 503 sem chave.
// ============================================================
const BRAPI_KEY = (process.env.BRAPI_API_KEY || '').trim();
const EXA_KEY = (process.env.EXA_API_KEY || '').trim();

const ACOES_BR = ['PETR4', 'VALE3', 'ITUB4', 'BBDC4', 'ABEV3', 'B3SA3', 'WEGE3', 'MGLU3'];

// Uma requisição por ticker: o plano free da brapi recusa lote ("no máximo 1 ativo
// por requisição", HTTP 400 QUOTES_PER_REQUEST_EXCEEDED). Mesmo desenho do Finnhub.
async function fetchAcaoBR(ticker) {
  const j = await fetchJson(
    `https://brapi.dev/api/quote/${encodeURIComponent(ticker)}?token=${encodeURIComponent(BRAPI_KEY)}`,
    { timeout: 15_000 },
  );
  const q = j && j.results && j.results[0];
  if (!q || q.regularMarketPrice == null) throw new Error(`sem dados para ${ticker}`);
  return {
    symbol: q.symbol || ticker,
    nome: q.longName || q.shortName || ticker,
    preco: q.regularMarketPrice,
    variacao: q.regularMarketChangePercent,
    anterior: q.regularMarketPreviousClose,
    alta: q.regularMarketDayHigh,
    baixa: q.regularMarketDayLow,
    moeda: q.currency || 'BRL',
  };
}

async function fetchAcoesBR() {
  const resultados = await Promise.allSettled(ACOES_BR.map((t) => fetchAcaoBR(t)));
  const result = resultados.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!result.length) throw new Error('nenhuma cotação BR disponível');
  return result;
}

app.get('/api/br/cotacoes', limitarDados, async (req, res) => {
  if (faltaChave(BRAPI_KEY, 'BRAPI_API_KEY', res)) return;
  const forcar = ehForce(req);
  const cache = cacheGet('br-acoes', 60_000, forcar);
  if (cache) { res.setHeader('Cache-Control', 'public, max-age=60'); return res.json(cache); }
  try {
    const data = { result: await fetchAcoesBR() };
    cacheSet('br-acoes', data);
    res.setHeader('Cache-Control', forcar ? 'no-store' : 'public, max-age=60');
    res.json(data);
  } catch (e) {
    log('erro', 'br/cotacoes:', e.message);
    const c = _euaCache.get('br-acoes');
    if (c) { res.setHeader('Cache-Control', 'public, max-age=10'); return res.json(c.data); }
    res.status(502).json({ erro: 'Falha ao buscar cotações da B3.' });
  }
});

// ---------- Notícias de um ativo específico (Exa) ----------
const DIAS_NOTICIA = 14; // janela de publicação considerada "recente"

async function fetchNoticiasAtivo(ticker) {
  const desde = new Date(Date.now() - DIAS_NOTICIA * 24 * 60 * 60 * 1000).toISOString();
  const j = await postJson('https://api.exa.ai/search', {
    query: `notícias recentes sobre a empresa e a ação ${ticker} na bolsa brasileira`,
    category: 'news',
    numResults: 10,
    startPublishedDate: desde,
    contents: { text: { maxCharacters: 400 } },
  }, { timeout: 25_000, headers: { 'x-api-key': EXA_KEY } });
  const itens = (j && j.results) || [];
  return itens.map((n) => ({
    titulo: n.title,
    resumo: (n.text || '').trim().slice(0, 300) || null,
    fonte: n.author || (() => { try { return new URL(n.url).hostname.replace(/^www\./, ''); } catch (_) { return null; } })(),
    url: n.url,
    data: n.publishedDate ? Date.parse(n.publishedDate) || null : null,
    imagem: n.image || null,
  })).filter((n) => n.titulo && n.url);
}

app.get('/api/br/noticias', limitarBusca, async (req, res) => {
  if (faltaChave(EXA_KEY, 'EXA_API_KEY', res)) return;
  // Ticker curto e alfanumérico: evita mandar texto livre do usuário para a Exa.
  const ticker = String(req.query.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{2,12}$/.test(ticker)) return res.status(400).json({ erro: 'Informe ?symbol= com um ticker válido (ex.: PETR4).' });
  const forcar = ehForce(req);
  const chave = `br-news:${ticker}`;
  const cache = cacheGet(chave, 900_000, forcar); // 15 min por ativo
  if (cache) { res.setHeader('Cache-Control', 'public, max-age=900'); return res.json(cache); }
  try {
    const data = { ticker, result: await fetchNoticiasAtivo(ticker) };
    cacheSet(chave, data);
    res.setHeader('Cache-Control', forcar ? 'no-store' : 'public, max-age=900');
    res.json(data);
  } catch (e) {
    log('erro', `br/noticias ${ticker}:`, e.message);
    const c = _euaCache.get(chave);
    if (c) { res.setHeader('Cache-Control', 'public, max-age=30'); return res.json(c.data); }
    res.status(502).json({ erro: 'Falha ao buscar notícias do ativo.' });
  }
});

app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
app.use('/api', (_req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Agente Trader na porta ${PORT} · modelo ${MODEL} · effort ${EFFORT} · ${CODIGOS_TRADER.length} códigos`);
    if (!client) console.warn('ANTHROPIC_API_KEY ausente: o site abre, mas o chat responde 503.');
    if (!FINNHUB_KEY) console.warn('FINNHUB_API_KEY ausente: /api/eua/cotacoes e /api/eua/noticias respondem 503.');
    if (!FRED_KEY) console.warn('FRED_API_KEY ausente: /api/eua/indicadores responde 503.');
    if (!BRAPI_KEY) console.warn('BRAPI_API_KEY ausente: /api/br/cotacoes responde 503.');
    if (!EXA_KEY) console.warn('EXA_API_KEY ausente: /api/br/noticias responde 503.');
    validarModelo();
  });
}

module.exports = { app, blocosDosAnexos, podarAnexosAntigos, ferramentaBuscaWeb, mensagemErroAnthropic };
