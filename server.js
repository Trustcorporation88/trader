'use strict';
// ============================================================
// AGENTE TRADER — servidor (Express + Claude)
// Análise de trade EDUCACIONAL com os 100 códigos do guia. A chave da API vive
// só aqui; o navegador nunca a vê. Uma rota de chat com streaming, anexos
// (imagem do gráfico, PDF, planilha/CSV/TXT) e busca na web do próprio Claude.
// ============================================================
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
const janelas = new Map();
function limitar(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
  const agora = Date.now();
  const recentes = (janelas.get(ip) || []).filter((t) => agora - t < 60_000);
  if (recentes.length >= RATE_LIMIT) return res.status(429).json({ erro: 'Muitas requisições. Aguarde um minuto.' });
  recentes.push(agora);
  janelas.set(ip, recentes);
  next();
}
setInterval(() => {
  const corte = Date.now() - 60_000;
  for (const [ip, j] of janelas) { const vivos = j.filter((t) => t > corte); if (vivos.length) janelas.set(ip, vivos); else janelas.delete(ip); }
}, 5 * 60_000).unref();

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

app.get('/api/cotacoes', (_req, res) => {
  const simbolos = SIMBOLOS_COTACOES.join(',');
  const url = `https://query1.finance.yahoo.com/v8/finance/quote?symbols=${encodeURIComponent(simbolos)}&fields=regularMarketPrice,regularMarketChangePercent,shortName,marketState`;
  const opts = { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 8000 };
  let respondeu = false;
  const req2 = https.get(url, opts, (r) => {
    let data = '';
    r.on('data', (c) => { data += c; });
    r.on('end', () => {
      if (respondeu) return; respondeu = true;
      try {
        res.setHeader('Cache-Control', 'public, max-age=55');
        res.json(JSON.parse(data));
      } catch {
        res.status(502).json({ erro: 'Falha ao processar cotações.' });
      }
    });
  });
  req2.on('timeout', () => { req2.destroy(); if (!respondeu) { respondeu = true; res.status(504).json({ erro: 'Timeout ao buscar cotações.' }); } });
  req2.on('error', () => { if (!respondeu) { respondeu = true; res.status(502).json({ erro: 'Falha ao buscar cotações.' }); } });
});

app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
app.use('/api', (_req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Agente Trader na porta ${PORT} · modelo ${MODEL} · effort ${EFFORT} · ${CODIGOS_TRADER.length} códigos`);
    if (!client) console.warn('ANTHROPIC_API_KEY ausente: o site abre, mas o chat responde 503.');
    validarModelo();
  });
}

module.exports = { app, blocosDosAnexos, podarAnexosAntigos, ferramentaBuscaWeb, mensagemErroAnthropic };
