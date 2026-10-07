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
const monitor = require('./monitor');
const carteira = require('./carteira');
const simulador = require('./simulador');
const dadosGlobais = require('./dados-globais');

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
// O painel ao vivo pergunta uma vez por segundo. Contador separado: o limitarDados (40/min) recusaria isso.
// 180/min cabe dois monitores abertos no mesmo IP, com folga para recarregar a página.
const limitarPainelAoVivo = criarLimitador(180);

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
  finnhub: !!FINNHUB_KEY, fred: !!FRED_KEY, brapi: !!BRAPI_KEY, exa: !!EXA_KEY, fincept: !!FINCEPT_KEY,
  monitor: { dadosPersistentes: !!process.env.DADOS_DIR, gravando: monitorStore.saudavel(), email: emailDisponivel },
}));

app.get('/api/codigos', (_req, res) => res.json({
  categorias: CATEGORIAS_TRADER.map((c) => ({ nome: c.nome, codigos: c.codigos.map(([codigo, descricao]) => ({ codigo, descricao })) })),
}));

app.post('/api/acesso', limitar, exigirSenha, (_req, res) => res.json({ ok: true }));

// Traduz títulos e resumos de notícia sob demanda. O calendário e os indicadores
// já saem em português em dados-globais.js; aqui só entra texto livre, e só quando
// a pessoa pede, para não gastar a chave da IA a cada atualização.
app.post('/api/traduzir', limitar, exigirSenha, async (req, res) => {
  if (!client) return res.status(503).json({ erro: 'Tradução indisponível: ANTHROPIC_API_KEY não configurada no servidor.' });
  const lista = Array.isArray(req.body && req.body.textos) ? req.body.textos : null;
  if (!lista || !lista.length) return res.status(400).json({ erro: 'Envie os textos para traduzir.' });
  if (lista.length > 40) return res.status(400).json({ erro: 'No máximo 40 textos por vez.' });
  const textos = lista.map((t) => String(t || '').slice(0, 700));
  const chave = 'trad:' + crypto.createHash('sha256').update(textos.join('\n---\n')).digest('hex');
  const cache = cacheGet(chave, 21_600_000, false); // 6 h: a mesma lista não paga de novo
  if (cache) return res.json(cache);
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: 'Traduza cada item para português do Brasil. Mantenha números, siglas, tickers e nomes próprios. Não comente, não explique e não dê recomendação de investimento. Responda somente um JSON array de strings, na mesma quantidade e na mesma ordem.',
      messages: [{ role: 'user', content: JSON.stringify(textos) }],
    });
    const bruto = ((resp && resp.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const traduzidos = JSON.parse(bruto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim());
    if (!Array.isArray(traduzidos) || traduzidos.length !== textos.length) throw new Error('resposta fora do formato');
    const data = { textos: traduzidos.map((t) => String(t).slice(0, 900)) };
    cacheSet(chave, data);
    res.json(data);
  } catch (e) {
    log('erro', 'traduzir:', e.message);
    res.status(502).json({ erro: 'Não consegui traduzir agora. Tente de novo em instantes.' });
  }
});

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
  { id: 'CPIAUCSL', nome: 'Inflação ao consumidor (CPI)', sufixo: '' },
  { id: 'DGS10',    nome: 'Juro do Tesouro dos EUA, 10 anos', sufixo: '%' },
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

// ============================================================
// MONITOR — painel de acompanhamento (public/monitor.html)
// Busca por nome/ticker e histórico para o gráfico, ambos do Yahoo (sem chave).
// Watchlist e alertas vivem no localStorage do navegador; nada é gravado aqui.
// ============================================================
const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
};
const SIMBOLO_VALIDO = /^[A-Za-z0-9.^=\-]{1,20}$/;
const TIPOS_BUSCA = new Set(['EQUITY', 'ETF', 'INDEX', 'CURRENCY', 'CRYPTOCURRENCY', 'MUTUALFUND']);

async function buscarAtivos(termo) {
  const j = await fetchJson(
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(termo)}&quotesCount=10&newsCount=0&lang=pt-BR&region=BR`,
    { headers: YAHOO_HEADERS },
  );
  const quotes = ((j && j.quotes) || []).filter((q) => q.symbol && TIPOS_BUSCA.has(q.quoteType));
  // sort estável: papéis da B3 sobem, o resto mantém a relevância do Yahoo
  quotes.sort((a, b) => (/\.SA$/.test(b.symbol) ? 1 : 0) - (/\.SA$/.test(a.symbol) ? 1 : 0));
  return quotes
    .map((q) => ({
      symbol: q.symbol,
      nome: (q.longname || q.shortname || q.symbol).replace(/\s{2,}/g, ' ').trim(),
      bolsa: q.exchDisp || q.exchange || null,
      tipo: q.quoteType,
    }));
}

app.get('/api/monitor/busca', limitarDados, async (req, res) => {
  const termo = String(req.query.q || '').trim().slice(0, 40);
  if (termo.length < 1) return res.status(400).json({ erro: 'Informe ?q= com o nome ou ticker.' });
  const chave = `busca:${termo.toLowerCase()}`;
  const cache = cacheGet(chave, 600_000, false); // 10 min
  if (cache) { res.setHeader('Cache-Control', 'public, max-age=600'); return res.json(cache); }
  try {
    const data = { result: await buscarAtivos(termo) };
    cacheSet(chave, data);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.json(data);
  } catch (e) {
    log('erro', 'monitor/busca:', e.message);
    res.status(502).json({ erro: 'Falha na busca de ativos.' });
  }
});

// range -> intervalo das velas e tempo de cache
const RANGES_HISTORICO = {
  '1d': { intervalo: '5m', ttl: 60_000 },
  '5d': { intervalo: '30m', ttl: 300_000 },
  '1mo': { intervalo: '1d', ttl: 600_000 },
  '6mo': { intervalo: '1d', ttl: 1_800_000 },
  '1y': { intervalo: '1d', ttl: 3_600_000 },
  '5y': { intervalo: '1wk', ttl: 3_600_000 },
};

async function fetchHistorico(simbolo, range) {
  const { intervalo } = RANGES_HISTORICO[range];
  const j = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(simbolo)}?range=${range}&interval=${intervalo}`,
    { headers: YAHOO_HEADERS },
  );
  const r0 = j && j.chart && j.chart.result && j.chart.result[0];
  const meta = r0 && r0.meta;
  if (!meta || meta.regularMarketPrice == null) throw new Error(`sem dados para ${simbolo}`);
  const ts = r0.timestamp || [];
  const fech = (r0.indicators && r0.indicators.quote && r0.indicators.quote[0] && r0.indicators.quote[0].close) || [];
  const pontos = [];
  ts.forEach((t, i) => { if (fech[i] != null) pontos.push([t * 1000, fech[i]]); });
  const anterior = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;
  return {
    symbol: simbolo,
    nome: meta.longName || meta.shortName || simbolo,
    moeda: meta.currency || null,
    bolsa: meta.fullExchangeName || meta.exchangeName || null,
    preco: meta.regularMarketPrice,
    anterior: anterior != null ? anterior : null,
    gmtoffset: Number(meta.gmtoffset) || 0, // segundos; o dia do candle é no fuso da bolsa
    maxima52: meta.fiftyTwoWeekHigh != null ? meta.fiftyTwoWeekHigh : null,
    minima52: meta.fiftyTwoWeekLow != null ? meta.fiftyTwoWeekLow : null,
    range,
    pontos,
  };
}

app.get('/api/monitor/historico', limitarDados, async (req, res) => {
  const simbolo = String(req.query.symbol || '').trim().toUpperCase();
  const range = String(req.query.range || '1mo');
  if (!SIMBOLO_VALIDO.test(simbolo)) return res.status(400).json({ erro: 'Informe ?symbol= com um ticker válido (ex.: PETR4.SA).' });
  if (!RANGES_HISTORICO[range]) return res.status(400).json({ erro: `range inválido. Use: ${Object.keys(RANGES_HISTORICO).join(', ')}.` });
  try {
    const data = await historicoComCache(simbolo, range);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(data);
  } catch (e) {
    log('erro', `monitor/historico ${simbolo}:`, e.message);
    res.status(502).json({ erro: 'Falha ao buscar o histórico do ativo.' });
  }
});

/** Histórico com o cache por range; se o Yahoo falhar, devolve a última cópia mesmo vencida. */
async function historicoComCache(simbolo, range) {
  const chave = `hist:${simbolo}:${range}`;
  const cache = cacheGet(chave, RANGES_HISTORICO[range].ttl, false);
  if (cache) return cache;
  try {
    const data = await fetchHistorico(simbolo, range);
    cacheSet(chave, data);
    return data;
  } catch (e) {
    const c = _euaCache.get(chave);
    if (c) return c.data;
    throw e;
  }
}

// ---------- Painel de mercados (Ibovespa, câmbio, S&P 500, Dow Jones) ----------
const PAINEL_MERCADO = [
  { symbol: '^BVSP', nome: 'Ibovespa', tipo: 'indice' },
  { symbol: 'USDBRL=X', nome: 'Real/Dólar', tipo: 'cambio' },
  { symbol: '^GSPC', nome: 'S&P 500', tipo: 'indice' },
  { symbol: '^DJI', nome: 'Dow Jones', tipo: 'indice' },
];

/** Reduz a série para no máximo n pontos, mantendo o primeiro e o último. */
function amostrar(valores, n) {
  if (valores.length <= n) return valores.slice();
  const passo = (valores.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => valores[Math.round(i * passo)]);
}

/** Histórico do Yahoo -> card do painel. Índice sai em pontos; câmbio carrega a moeda. */
function montarCardMercado(def, historico) {
  const preco = historico && historico.preco;
  if (preco == null || !isFinite(preco)) return null;
  // O "anterior" do Yahoo num gráfico de 6 meses é o começo do período, não o pregão de ontem.
  // A variação do dia sai dos dois últimos fechamentos diários.
  const closes = ((historico && historico.pontos) || []).map((p) => p[1]).filter((v) => v != null && isFinite(v));
  const ontem = closes.length >= 2 ? closes[closes.length - 2] : null;
  return {
    symbol: def.symbol,
    nome: def.nome,
    tipo: def.tipo,
    moeda: def.tipo === 'cambio' ? (historico.moeda || 'BRL') : null,
    preco,
    variacao: ontem ? ((preco - ontem) / ontem) * 100 : null,
    variacaoPontos: ontem != null ? preco - ontem : null,
    pontos: amostrar(closes, 48),
  };
}

app.get('/api/monitor/painel', limitarDados, async (_req, res) => {
  const cache = cacheGet('painel-mercado', 60_000, false);
  if (cache) { res.setHeader('Cache-Control', 'public, max-age=30'); return res.json(cache); }
  const resumos = await Promise.all(PAINEL_MERCADO.map(async (def) => {
    try { return montarCardMercado(def, await historicoComCache(def.symbol, '6mo')); }
    catch (e) { log('erro', `painel ${def.symbol}:`, e.message); return null; }
  }));
  const itens = resumos.filter(Boolean);
  if (!itens.length) return res.status(502).json({ erro: 'Falha ao buscar os índices.' });
  const data = { itens, fonte: 'Yahoo Finance' };
  cacheSet('painel-mercado', data);
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.json(data);
});

/** Cotação de 1 dia do Yahoo -> preço e variação do card. Sem desenho: o de 6 meses fica no /painel. */
function cotacaoParaCard(def, cotacao) {
  const preco = cotacao && cotacao.regularMarketPrice;
  if (preco == null || !isFinite(preco)) return null;
  const variacao = cotacao.regularMarketChangePercent;
  const varOk = variacao != null && isFinite(variacao);
  const anterior = varOk && variacao > -100 ? preco / (1 + variacao / 100) : null;
  return {
    symbol: def.symbol,
    nome: def.nome,
    tipo: def.tipo,
    moeda: def.tipo === 'cambio' ? 'BRL' : null,
    preco,
    variacao: varOk ? variacao : null,
    variacaoPontos: anterior != null ? preco - anterior : null,
  };
}

// Uma consulta ao Yahoo para todo mundo, e só enquanto alguém está com o monitor aberto.
// Não passa pela Fincept: crédito de lá continua só no clique do GARCH.
let _painelAoVivo = { itens: [], atualizadoEm: null, fonte: 'Yahoo Finance' };
let _painelBuscando = false;
let _ultimoPedidoPainel = 0;
let _painelTimer = null;
let _painelErroEm = 0;

async function cicloPainelAoVivo() {
  if (_painelBuscando) return;
  if (Date.now() - _ultimoPedidoPainel > 6_000) {
    if (_painelTimer) { clearInterval(_painelTimer); _painelTimer = null; }
    return;
  }
  _painelBuscando = true;
  try {
    const data = await fetchCotacoes(PAINEL_MERCADO.map((d) => d.symbol));
    const porSimbolo = new Map((data.quoteResponse.result || []).map((q) => [q.symbol, q]));
    const anteriores = new Map((_painelAoVivo.itens || []).map((c) => [c.symbol, c]));
    const itens = PAINEL_MERCADO.map((def) => {
      const q = porSimbolo.get(def.symbol);
      return (q && cotacaoParaCard(def, q)) || anteriores.get(def.symbol) || null;
    }).filter(Boolean);
    if (itens.length) _painelAoVivo = { itens, atualizadoEm: new Date().toISOString(), fonte: 'Yahoo Finance' };
  } catch (e) {
    const agora = Date.now();
    if (agora - _painelErroEm > 60_000) { _painelErroEm = agora; log('erro', 'painel ao vivo:', e.message); }
  } finally {
    _painelBuscando = false;
  }
}

function pedirPainelAoVivo() {
  _ultimoPedidoPainel = Date.now();
  if (_painelTimer) return;
  _painelTimer = setInterval(cicloPainelAoVivo, 1000);
  _painelTimer.unref();
  cicloPainelAoVivo();
}

app.get('/api/monitor/painel/agora', limitarPainelAoVivo, (_req, res) => {
  pedirPainelAoVivo();
  res.setHeader('Cache-Control', 'no-store');
  res.json(_painelAoVivo);
});

// ---------- Macro Brasil (Banco Central, SGS — sem chave) ----------
const SERIES_BCB = [
  { id: 432, nome: 'Selic (meta)', sufixo: '% a.a.' },
  { id: 4389, nome: 'CDI (anualizado)', sufixo: '% a.a.' },
  { id: 13522, nome: 'IPCA em 12 meses', sufixo: '%' },
  { id: 433, nome: 'IPCA do mês', sufixo: '%' },
  { id: 1, nome: 'Dólar PTAX (venda)', sufixo: '', prefixo: 'R$ ' },
  { id: 24369, nome: 'Desemprego (PNAD)', sufixo: '%' },
];

function dataBCB(s) { const [d, m, a] = String(s).split('/'); return `${a}-${m}-${d}`; }

async function fetchSerieBCB(s) {
  // por intervalo de datas: a série da meta Selic já vem preenchida até a próxima
  // reunião do Copom, então "últimos N" traria só datas futuras
  const br = (d) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const agora = new Date();
  const inicio = new Date(agora.getTime() - 120 * 24 * 3600_000);
  const j = await fetchJson(
    `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${s.id}/dados?formato=json&dataInicial=${br(inicio)}&dataFinal=${br(agora)}`,
    { timeout: 15_000 },
  );
  if (!Array.isArray(j)) throw new Error(`resposta inválida da série ${s.id}`);
  const hoje = agora.toISOString().slice(0, 10);
  const pontos = j.map((p) => ({ data: dataBCB(p.data), valor: Number(p.valor) }))
    .filter((p) => p.data <= hoje && isFinite(p.valor));
  if (!pontos.length) throw new Error(`sem dados para a série ${s.id}`);
  const ult = pontos[pontos.length - 1];
  const ant = pontos.length > 1 ? pontos[pontos.length - 2] : null;
  return { id: s.id, nome: s.nome, sufixo: s.sufixo, prefixo: s.prefixo || '', valor: ult.valor, data: ult.data, anterior: ant ? ant.valor : null, dataAnterior: ant ? ant.data : null };
}

async function macroBR() {
  const cache = cacheGet('macro-br', 3_600_000, false); // 1 h
  if (cache) return cache;
  const res = await Promise.allSettled(SERIES_BCB.map(fetchSerieBCB));
  const result = res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!result.length) {
    const c = _euaCache.get('macro-br');
    if (c) return c.data;
    throw new Error('nenhuma série do Banco Central disponível');
  }
  const data = { result, fonte: 'Banco Central do Brasil (SGS)' };
  cacheSet('macro-br', data);
  return data;
}

app.get('/api/monitor/macro-br', limitarDados, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.json(await macroBR());
  } catch (e) {
    log('erro', 'monitor/macro-br:', e.message);
    res.status(502).json({ erro: 'Falha ao buscar os indicadores do Banco Central.' });
  }
});

// ---------- Fundamentos de empresas dos EUA (Finnhub) ----------
const INDICADORES_FUNDAMENTOS = [
  { id: 'pl', nome: 'P/L', chaves: ['peTTM', 'peBasicExclExtraTTM', 'peExclExtraTTM'], formato: 'x' },
  { id: 'pvp', nome: 'P/VP', chaves: ['pbQuarterly', 'pbAnnual'], formato: 'x' },
  { id: 'psr', nome: 'Preço/Receita', chaves: ['psTTM', 'psAnnual'], formato: 'x' },
  { id: 'dy', nome: 'Dividend yield', chaves: ['dividendYieldIndicatedAnnual', 'currentDividendYieldTTM'], formato: '%' },
  { id: 'mb', nome: 'Margem bruta', chaves: ['grossMarginTTM', 'grossMarginAnnual'], formato: '%' },
  { id: 'mo', nome: 'Margem operacional', chaves: ['operatingMarginTTM', 'operatingMarginAnnual'], formato: '%' },
  { id: 'ml', nome: 'Margem líquida', chaves: ['netProfitMarginTTM', 'netProfitMarginAnnual'], formato: '%' },
  { id: 'roe', nome: 'ROE', chaves: ['roeTTM', 'roeRfy'], formato: '%' },
  { id: 'roa', nome: 'ROA', chaves: ['roaTTM', 'roaRfy'], formato: '%' },
  { id: 'cresc', nome: 'Receita (cresc. 12m)', chaves: ['revenueGrowthTTMYoy'], formato: '%' },
  { id: 'div', nome: 'Dívida/Patrimônio', chaves: ['totalDebt/totalEquityQuarterly', 'totalDebt/totalEquityAnnual'], formato: 'x' },
  { id: 'lc', nome: 'Liquidez corrente', chaves: ['currentRatioQuarterly', 'currentRatioAnnual'], formato: 'x' },
  { id: 'lpa', nome: 'LPA (12m)', chaves: ['epsTTM', 'epsBasicExclExtraItemsTTM'], formato: 'moeda' },
  { id: 'beta', nome: 'Beta', chaves: ['beta'], formato: 'x' },
];

function montarFundamentos(simbolo, perfil, metricas) {
  const m = (metricas && metricas.metric) || {};
  const indicadores = INDICADORES_FUNDAMENTOS.map((ind) => {
    const chave = ind.chaves.find((k) => m[k] != null && isFinite(m[k]));
    return chave ? { id: ind.id, nome: ind.nome, valor: Number(m[chave]), formato: ind.formato } : null;
  }).filter(Boolean);
  const p = perfil || {};
  if (!p.name && !indicadores.length) return null;
  return {
    symbol: simbolo,
    nome: p.name || simbolo,
    setor: p.finnhubIndustry || null,
    pais: p.country || null,
    bolsa: p.exchange || null,
    moeda: p.currency || null,
    logo: p.logo || null,
    site: p.weburl || null,
    ipo: p.ipo || null,
    valorMercadoMilhoes: p.marketCapitalization != null ? Number(p.marketCapitalization) : null,
    indicadores,
  };
}

app.get('/api/monitor/fundamentos', limitarDados, async (req, res) => {
  if (faltaChave(FINNHUB_KEY, 'FINNHUB_API_KEY', res)) return;
  const simbolo = String(req.query.symbol || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(simbolo) || /\.SA$/.test(simbolo)) {
    return res.status(400).json({ erro: 'Fundamentos disponíveis só para ações dos EUA (ex.: AAPL).' });
  }
  const chave = `fund:${simbolo}`;
  const cache = cacheGet(chave, 21_600_000, false); // 6 h
  if (cache) { res.setHeader('Cache-Control', 'public, max-age=3600'); return res.json(cache); }
  try {
    const t = encodeURIComponent(FINNHUB_KEY), s = encodeURIComponent(simbolo);
    const [perfil, metricas] = await Promise.all([
      fetchJson(`https://finnhub.io/api/v1/stock/profile2?symbol=${s}&token=${t}`, { timeout: 15_000 }),
      fetchJson(`https://finnhub.io/api/v1/stock/metric?symbol=${s}&metric=all&token=${t}`, { timeout: 15_000 }),
    ]);
    const data = montarFundamentos(simbolo, perfil, metricas);
    if (!data) return res.status(404).json({ erro: `O Finnhub não tem fundamentos para ${simbolo}.` });
    cacheSet(chave, data);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(data);
  } catch (e) {
    log('erro', `monitor/fundamentos ${simbolo}:`, e.message);
    const c = _euaCache.get(chave);
    if (c) return res.json(c.data);
    res.status(502).json({ erro: 'Falha ao buscar os fundamentos da empresa.' });
  }
});

// ---------- Carteira simulada ----------
app.post('/api/monitor/carteira', limitar, async (req, res) => {
  let posicoes;
  try { posicoes = carteira.normalizarPosicoes(req.body && req.body.posicoes); } catch (e) { return res.status(400).json({ erro: e.message }); }
  if (!posicoes.length) return res.status(400).json({ erro: 'Adicione ao menos uma posição à carteira.' });
  const historicos = {};
  await Promise.allSettled(posicoes.map(async (p) => { historicos[p.symbol] = await historicoComCache(p.symbol, '1y'); }));
  const [cambio, referencia, macro] = await Promise.allSettled([
    historicoComCache('USDBRL=X', '1y'), historicoComCache('^BVSP', '1y'), macroBR(),
  ]);
  const selic = macro.status === 'fulfilled' ? macro.value.result.find((s) => s.id === 432) : null;
  try {
    const analise = carteira.analisarCarteira({
      posicoes, historicos,
      cambio: cambio.status === 'fulfilled' ? cambio.value : null,
      referencia: referencia.status === 'fulfilled' ? referencia.value : null,
      taxaLivre: selic ? selic.valor / 100 : null,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...analise, referencia: 'Ibovespa', taxaLivreFonte: selic ? `Selic meta de ${selic.valor.toLocaleString('pt-BR')}% a.a. (Banco Central)` : null });
  } catch (e) {
    res.status(422).json({ erro: e.message });
  }
});

// ---------- Simulador de ordens (paper trading) ----------
app.post('/api/monitor/simulador', limitar, async (req, res) => {
  let ordens;
  try { ordens = simulador.normalizarOrdens(req.body && req.body.ordens); } catch (e) { return res.status(400).json({ erro: e.message }); }
  const consolidado = simulador.consolidarOrdens(ordens);
  const abertas = consolidado.posicoes.filter((p) => p.quantidade > 0).map((p) => p.symbol);
  const cotacoes = {};
  await Promise.allSettled(abertas.map(async (s) => {
    const h = await historicoComCache(s, '1d');
    cotacoes[s] = { preco: h.preco, moeda: h.moeda, nome: h.nome };
  }));
  const precisaCambio = consolidado.posicoes.some((p) => (p.moeda || (cotacoes[p.symbol] || {}).moeda) === 'USD');
  let cambio = null;
  if (precisaCambio) { try { cambio = (await historicoComCache('USDBRL=X', '1d')).preco; } catch (_) {} }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...simulador.avaliarSimulador(consolidado, cotacoes, cambio), cambio });
});

// ---------- Indicadores globais (Banco Mundial, sem chave) ----------
async function mundoBM() {
  const cache = cacheGet('mundo-bm', 86_400_000, false); // 24 h: dados anuais
  if (cache) return cache;
  const paises = dadosGlobais.PAISES_BM.map((p) => p.id).join(';');
  const res = await Promise.allSettled(dadosGlobais.INDICADORES_BM.map(async (ind) => {
    const j = await fetchJson(`https://api.worldbank.org/v2/country/${paises}/indicator/${ind.id}?format=json&mrnev=1&per_page=50`, { timeout: 20_000 });
    return dadosGlobais.normalizarBancoMundial(ind, j);
  }));
  const result = res.filter((r) => r.status === 'fulfilled' && Object.keys(r.value.valores).length).map((r) => r.value);
  if (!result.length) {
    const c = _euaCache.get('mundo-bm');
    if (c) return c.data;
    throw new Error('nenhum indicador do Banco Mundial disponível');
  }
  const data = { paises: dadosGlobais.PAISES_BM, result, fonte: 'Banco Mundial (World Development Indicators)' };
  cacheSet('mundo-bm', data);
  return data;
}

app.get('/api/monitor/mundo', limitarDados, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(await mundoBM());
  } catch (e) {
    log('erro', 'monitor/mundo:', e.message);
    res.status(502).json({ erro: 'Falha ao buscar os indicadores do Banco Mundial.' });
  }
});

// ---------- Fincept API (opcional, chave do próprio usuário) ----------
// Cobra créditos por chamada (350 grátis no cadastro, sem renovação), então tudo tem
// cache longo, o GARCH só roda por clique e há um teto diário de chamadas.
const FINCEPT_KEY = (process.env.FINCEPT_API_KEY || '').trim();
const FINCEPT_CHAMADAS_DIA = Number(process.env.FINCEPT_CHAMADAS_POR_DIA) || 40;
const _finceptUso = { dia: '', chamadas: 0 };
async function fincept(caminho, { metodo = 'GET', corpo } = {}) {
  const hoje = new Date().toISOString().slice(0, 10);
  if (_finceptUso.dia !== hoje) { _finceptUso.dia = hoje; _finceptUso.chamadas = 0; }
  if (_finceptUso.chamadas >= FINCEPT_CHAMADAS_DIA) throw Object.assign(new Error('limite diário de chamadas à Fincept atingido'), { limite: true });
  _finceptUso.chamadas++;
  const headers = { 'X-API-Key': FINCEPT_KEY };
  const url = `https://api.fincept.in${caminho}`;
  return metodo === 'POST' ? postJson(url, corpo, { timeout: 30_000, headers }) : fetchJson(url, { timeout: 20_000, headers });
}
function erroFincept(res, rotulo, e, chave) {
  log('erro', `fincept/${rotulo}:`, e.message);
  const c = chave && _euaCache.get(chave);
  if (c) return res.json(c.data);
  if (e.limite) return res.status(429).json({ erro: 'O teto diário de chamadas à Fincept foi atingido (FINCEPT_CHAMADAS_POR_DIA). Tente amanhã.' });
  if (/HTTP 40[12]/.test(e.message)) return res.status(502).json({ erro: 'A Fincept recusou a chave ou não há créditos: confira FINCEPT_API_KEY e o saldo em fincept.in.' });
  res.status(502).json({ erro: 'Falha ao consultar a Fincept API.' });
}

app.get('/api/fincept/paises', limitarDados, async (_req, res) => {
  if (faltaChave(FINCEPT_KEY, 'FINCEPT_API_KEY', res)) return;
  const chave = 'fincept:paises';
  const cache = cacheGet(chave, 43_200_000, false); // 12 h
  if (cache) { res.setHeader('Cache-Control', 'public, max-age=3600'); return res.json(cache); }
  try {
    const result = dadosGlobais.normalizarPaisesFincept(await fincept('/macro/wgb/country-detail'));
    if (!result.length) throw new Error('resumo por país sem os países esperados');
    const data = { result, fonte: 'Fincept API (World Government Bonds)' };
    cacheSet(chave, data);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(data);
  } catch (e) { erroFincept(res, 'paises', e, chave); }
});

app.get('/api/fincept/agenda', limitarDados, async (_req, res) => {
  if (faltaChave(FINCEPT_KEY, 'FINCEPT_API_KEY', res)) return;
  const chave = 'fincept:agenda';
  const cache = cacheGet(chave, 10_800_000, false); // 3 h
  if (cache) { res.setHeader('Cache-Control', 'public, max-age=1800'); return res.json(cache); }
  const dia = (d) => d.toISOString().slice(0, 10);
  const de = new Date(), ate = new Date(Date.now() + 7 * 86_400_000);
  try {
    const res2 = await Promise.allSettled(['BR', 'US'].map(async (pais) => dadosGlobais.normalizarAgendaFincept(
      await fincept(`/macro/upcoming-events?country=${pais}&start_date=${dia(de)}&end_date=${dia(ate)}&limit=60`), pais)));
    const ok = res2.filter((r) => r.status === 'fulfilled');
    if (!ok.length) throw res2[0].reason;
    const result = ok.flatMap((r) => r.value).sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
    const data = { result, fonte: 'Fincept API (Trading Economics)', de: dia(de), ate: dia(ate) };
    cacheSet(chave, data);
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.json(data);
  } catch (e) { erroFincept(res, 'agenda', e, chave); }
});

app.post('/api/fincept/garch', limitar, async (req, res) => {
  if (faltaChave(FINCEPT_KEY, 'FINCEPT_API_KEY', res)) return;
  const simbolo = String((req.body && req.body.symbol) || '').trim().toUpperCase();
  if (!SIMBOLO_VALIDO.test(simbolo)) return res.status(400).json({ erro: 'Informe um ticker válido (ex.: PETR4.SA).' });
  const chave = `fincept:garch:${simbolo}`;
  const cache = cacheGet(chave, 86_400_000, false); // 24 h: o ajuste usa fechamentos diários
  if (cache) return res.json({ ...cache, doCache: true });
  let hist;
  try { hist = await historicoComCache(simbolo, '1y'); } catch (e) { return res.status(502).json({ erro: 'Falha ao buscar o histórico do ativo.' }); }
  const retornos = dadosGlobais.retornosPercentuais(hist.pontos);
  if (retornos.length < 100) return res.status(422).json({ erro: 'Histórico curto demais para ajustar um GARCH (mínimo de 100 pregões).' });
  try {
    const previsao = dadosGlobais.normalizarGarchFincept(await fincept('/quantlib/statistics/timeseries/garch/forecast', {
      metodo: 'POST', corpo: { returns: retornos, p: 1, q: 1, steps: 5 },
    }));
    const ultimos = retornos.slice(-20).map((r) => r / 100);
    const m = ultimos.reduce((a, b) => a + b, 0) / ultimos.length;
    const realizada20 = Math.sqrt(ultimos.reduce((a, r) => a + (r - m) ** 2, 0) / (ultimos.length - 1)) * Math.sqrt(252);
    const data = { symbol: simbolo, nome: hist.nome, pregoes: retornos.length, ...previsao, realizada20, fonte: 'Fincept API (GARCH(1,1))', calculado: Date.now() };
    cacheSet(chave, data);
    res.json(data);
  } catch (e) { erroFincept(res, 'garch', e); }
});

// Notícias de uma empresa dos EUA (Finnhub company-news). Ativos da B3 usam /api/br/noticias.
async function fetchNoticiasEmpresa(simbolo) {
  const ate = new Date();
  const de = new Date(ate.getTime() - DIAS_NOTICIA * 24 * 60 * 60 * 1000);
  const dia = (d) => d.toISOString().slice(0, 10);
  const j = await fetchJson(
    `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(simbolo)}&from=${dia(de)}&to=${dia(ate)}&token=${FINNHUB_KEY}`,
    { timeout: 20_000 },
  );
  if (!Array.isArray(j)) throw new Error('resposta de notícias inválida');
  return j.slice(0, 12).map((n) => ({
    titulo: n.headline, resumo: n.summary || null, fonte: n.source, url: n.url,
    data: n.datetime ? n.datetime * 1000 : null, imagem: n.image || null,
  })).filter((n) => n.titulo && n.url);
}

app.get('/api/monitor/noticias', limitarDados, async (req, res) => {
  if (faltaChave(FINNHUB_KEY, 'FINNHUB_API_KEY', res)) return;
  const simbolo = String(req.query.symbol || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(simbolo)) return res.status(400).json({ erro: 'Informe ?symbol= com um ticker dos EUA (ex.: AAPL).' });
  const chave = `emp-news:${simbolo}`;
  const cache = cacheGet(chave, 600_000, false); // 10 min
  if (cache) { res.setHeader('Cache-Control', 'public, max-age=600'); return res.json(cache); }
  try {
    const data = { symbol: simbolo, result: await fetchNoticiasEmpresa(simbolo) };
    cacheSet(chave, data);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.json(data);
  } catch (e) {
    log('erro', `monitor/noticias ${simbolo}:`, e.message);
    const c = _euaCache.get(chave);
    if (c) return res.json(c.data);
    res.status(502).json({ erro: 'Falha ao buscar notícias da empresa.' });
  }
});

// ---------- Conta sincronizada, alertas no servidor e e-mail ----------
const DADOS_DIR = (process.env.DADOS_DIR || '').trim() || path.join(__dirname, 'dados');
const monitorStore = monitor.criarStore(path.join(DADOS_DIR, 'monitor.json'));
const SMTP = {
  host: (process.env.SMTP_HOST || '').trim(),
  porta: Number(process.env.SMTP_PORT) || 587,
  usuario: (process.env.SMTP_USER || '').trim(),
  senha: (process.env.SMTP_PASS || '').trim(),
  remetente: (process.env.SMTP_FROM || process.env.SMTP_USER || '').trim(),
};
const emailDisponivel = !!(SMTP.host && SMTP.remetente);
const URL_PUBLICA = (process.env.URL_PUBLICA || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')).trim().replace(/\/+$/, '');
const INTERVALO_ALERTAS_MS = Math.max(60_000, Number(process.env.MONITOR_INTERVALO_MS) || 300_000);
const EMAILS_POR_HORA = Number(process.env.MONITOR_EMAILS_POR_HORA) || 60;

let _transporte = null;
const _emailsEnviados = [];
async function enviarEmail(para, { assunto, texto }) {
  if (!emailDisponivel) throw new Error('SMTP não configurado');
  const corte = Date.now() - 3_600_000;
  while (_emailsEnviados.length && _emailsEnviados[0] < corte) _emailsEnviados.shift();
  if (_emailsEnviados.length >= EMAILS_POR_HORA) throw new Error('limite de e-mails por hora atingido');
  if (!_transporte) {
    _transporte = require('nodemailer').createTransport({
      host: SMTP.host, port: SMTP.porta, secure: SMTP.porta === 465,
      auth: SMTP.usuario ? { user: SMTP.usuario, pass: SMTP.senha } : undefined,
    });
  }
  await _transporte.sendMail({ from: `Agente Trader Monitor <${SMTP.remetente}>`, to: para, subject: assunto, text: texto });
  _emailsEnviados.push(Date.now());
}

async function precoAtual(simbolo) {
  const d = await fetchHistorico(simbolo, '1d');
  return d.preco;
}

/** Lê o código do monitor do cabeçalho; responde 400 e devolve null se faltar. */
function hashDoCodigo(req, res) {
  const token = String(req.headers['x-monitor-token'] || '');
  if (!monitor.tokenValido(token)) { res.status(400).json({ erro: 'Código do monitor ausente ou inválido.' }); return null; }
  return monitor.hashToken(token);
}

app.get('/api/monitor/conta', limitarDados, exigirSenha, (req, res) => {
  const hash = hashDoCodigo(req, res);
  if (!hash) return;
  const conta = monitorStore.ler(hash);
  res.setHeader('Cache-Control', 'no-store');
  if (!conta) return res.status(404).json({ erro: 'Nenhum monitor salvo com este código.', emailDisponivel });
  res.json({ ...monitor.contaPublica(conta), emailDisponivel });
});

app.put('/api/monitor/conta', limitarDados, exigirSenha, (req, res) => {
  const hash = hashDoCodigo(req, res);
  if (!hash) return;
  let dados;
  try { dados = monitor.normalizarConta(req.body); } catch (e) { return res.status(400).json({ erro: e.message }); }
  const anterior = monitorStore.ler(hash);
  if (!anterior && monitorStore.total() >= monitor.MAX_CONTAS) {
    return res.status(507).json({ erro: 'O servidor atingiu o limite de monitores salvos.' });
  }
  const conta = {
    watchlist: dados.watchlist,
    alertas: monitor.mesclarAlertas(anterior ? anterior.alertas : [], dados.alertas),
    email: dados.email,
    carteira: dados.carteira !== undefined ? dados.carteira : (anterior && anterior.carteira) || [],
    ordens: dados.ordens !== undefined ? dados.ordens : (anterior && anterior.ordens) || [],
    criado: anterior ? anterior.criado : Date.now(),
    atualizado: Date.now(),
  };
  try { monitorStore.gravar(hash, conta); } catch (e) { return res.status(500).json({ erro: e.message }); }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...monitor.contaPublica(conta), emailDisponivel });
});

const _ultimoTeste = new Map(); // hash -> ts
app.post('/api/monitor/email-teste', limitar, exigirSenha, async (req, res) => {
  const hash = hashDoCodigo(req, res);
  if (!hash) return;
  if (!emailDisponivel) return res.status(503).json({ erro: 'Envio de e-mail não configurado no servidor (SMTP_HOST/SMTP_FROM).' });
  const conta = monitorStore.ler(hash);
  if (!conta || !conta.email) return res.status(400).json({ erro: 'Salve um e-mail no monitor antes de testar.' });
  const ultimo = _ultimoTeste.get(hash) || 0;
  if (Date.now() - ultimo < 60_000) return res.status(429).json({ erro: 'Aguarde um minuto para enviar outro teste.' });
  _ultimoTeste.set(hash, Date.now());
  try {
    await enviarEmail(conta.email, {
      assunto: 'Teste do Monitor — Agente Trader',
      texto: `Tudo certo: este e-mail vai receber os alertas de preço do Monitor.\n\n${URL_PUBLICA ? `Monitor: ${URL_PUBLICA}/monitor\n\n` : ''}Conteúdo educacional. Alerta de preço não é recomendação de investimento (Resolução CVM 20/2021).`,
    });
    res.json({ ok: true });
  } catch (e) {
    log('erro', 'monitor/email-teste:', e.message);
    res.status(502).json({ erro: 'Não consegui enviar o e-mail de teste. Confira as variáveis SMTP no servidor.' });
  }
});

app.get('/monitor', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'monitor.html'));
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
    if (!FINCEPT_KEY) console.warn('FINCEPT_API_KEY ausente: /api/fincept/* responde 503 (países, agenda e GARCH ficam fora do monitor).');
    if (!process.env.DADOS_DIR) console.warn(`DADOS_DIR ausente: o monitor grava em ${DADOS_DIR}; no Railway isso se perde a cada deploy (monte um Volume e aponte DADOS_DIR para ele).`);
    if (!emailDisponivel) console.warn('SMTP_HOST/SMTP_FROM ausentes: alertas do monitor não enviam e-mail.');
    monitor.criarRotina({
      store: monitorStore, buscarPreco: precoAtual, enviarEmail: emailDisponivel ? enviarEmail : null,
      urlMonitor: URL_PUBLICA ? `${URL_PUBLICA}/monitor` : '', intervaloMs: INTERVALO_ALERTAS_MS, log,
    }).iniciar();
    validarModelo();
  });
}

module.exports = { app, blocosDosAnexos, podarAnexosAntigos, ferramentaBuscaWeb, mensagemErroAnthropic, montarFundamentos, montarCardMercado, cotacaoParaCard };
