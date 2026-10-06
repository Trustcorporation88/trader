'use strict';
// ============================================================
// MONITOR — contas sincronizadas, alertas no servidor e e-mail
// Sem login: cada navegador gera um "código do monitor" aleatório; quem tem o
// código lê e grava a mesma watchlist/alertas. No disco fica só o hash do código.
// Persistência em um arquivo JSON (no Railway, um Volume montado em DADOS_DIR).
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizarPosicoes } = require('./carteira');
const { normalizarOrdens } = require('./simulador');

const MAX_WL = 15;
const MAX_ALERTAS = 30;
const MAX_CONTAS = Number(process.env.MONITOR_MAX_CONTAS) || 500;
const MAX_TENTATIVAS_EMAIL = 3;
const JANELA_EMAIL_MS = 6 * 60 * 60 * 1000;
const SIMBOLO = /^[A-Z0-9.^=\-]{1,20}$/;
const EMAIL = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[A-Za-z]{2,}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
const ID_ALERTA = /^[a-z0-9]{4,24}$/;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function tokenValido(token) { return TOKEN.test(String(token || '')); }

/** Valida o corpo enviado pelo navegador. Lança Error com mensagem amigável. */
function normalizarConta(corpo) {
  const c = corpo && typeof corpo === 'object' ? corpo : {};
  if (!Array.isArray(c.watchlist)) throw new Error('watchlist deve ser uma lista de tickers.');
  if (!Array.isArray(c.alertas)) throw new Error('alertas deve ser uma lista.');
  const watchlist = [...new Set(c.watchlist.map((s) => String(s || '').trim().toUpperCase()).filter((s) => SIMBOLO.test(s)))];
  if (watchlist.length > MAX_WL) throw new Error(`A watchlist aceita até ${MAX_WL} ativos.`);
  if (c.alertas.length > MAX_ALERTAS) throw new Error(`No máximo ${MAX_ALERTAS} alertas.`);
  const ids = new Set();
  const alertas = c.alertas.map((a) => {
    const id = String((a && a.id) || '');
    const symbol = String((a && a.symbol) || '').trim().toUpperCase();
    const alvo = Number(a && a.alvo);
    if (!ID_ALERTA.test(id) || ids.has(id)) throw new Error('Alerta com identificador inválido.');
    ids.add(id);
    if (!SIMBOLO.test(symbol)) throw new Error(`Ticker inválido no alerta: ${symbol || '(vazio)'}.`);
    if (a.tipo !== 'acima' && a.tipo !== 'abaixo') throw new Error('Tipo de alerta deve ser "acima" ou "abaixo".');
    if (!(alvo > 0) || !isFinite(alvo)) throw new Error(`Preço-alvo inválido no alerta de ${symbol}.`);
    const disparado = Number(a.disparado) > 0 ? Number(a.disparado) : null;
    return { id, symbol, tipo: a.tipo, alvo, criado: Number(a.criado) > 0 ? Number(a.criado) : Date.now(), disparado };
  });
  const email = String(c.email || '').trim().toLowerCase();
  if (email && (email.length > 254 || !EMAIL.test(email))) throw new Error('E-mail inválido.');
  // ausente = navegador antigo, que não conhece a carteira: o servidor mantém a que já tem
  const posicoes = c.carteira === undefined ? undefined : normalizarPosicoes(c.carteira);
  const ordens = c.ordens === undefined ? undefined : normalizarOrdens(c.ordens);
  return { watchlist, alertas, email, carteira: posicoes, ordens };
}

/**
 * Junta o que o navegador mandou com o que o servidor já sabe. A lista do navegador
 * manda (inclusões e exclusões), mas um disparo registrado de um lado não se perde,
 * e o controle de e-mail enviado é sempre do servidor.
 */
function mesclarAlertas(doServidor, doCliente) {
  const porId = new Map((doServidor || []).map((a) => [a.id, a]));
  return doCliente.map((a) => {
    const s = porId.get(a.id);
    if (!s || s.symbol !== a.symbol || s.tipo !== a.tipo || s.alvo !== a.alvo) return { ...a, notificado: null, precoDisparo: null, tentativas: 0 };
    return {
      ...a,
      disparado: s.disparado || a.disparado || null,
      precoDisparo: s.precoDisparo != null ? s.precoDisparo : null,
      notificado: s.notificado || null,
      tentativas: s.tentativas || 0,
    };
  });
}

/** Visão da conta que volta para o navegador (sem campos internos). */
function contaPublica(conta) {
  return {
    watchlist: conta.watchlist,
    alertas: conta.alertas.map(({ id, symbol, tipo, alvo, criado, disparado, precoDisparo, notificado }) =>
      ({ id, symbol, tipo, alvo, criado, disparado, precoDisparo: precoDisparo != null ? precoDisparo : null, emailEnviado: notificado > 0 ? notificado : null })),
    email: conta.email,
    carteira: conta.carteira || [],
    ordens: conta.ordens || [],
    atualizado: conta.atualizado,
  };
}

/** Arquivo JSON com gravação atômica (tmp + rename). */
function criarStore(arquivo) {
  let contas = {};
  try {
    const bruto = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    if (bruto && typeof bruto.contas === 'object') contas = bruto.contas;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`Monitor: não consegui ler ${arquivo}: ${e.message}`);
  }
  let ok = true;
  function salvar() {
    try {
      fs.mkdirSync(path.dirname(arquivo), { recursive: true });
      const tmp = `${arquivo}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ versao: 1, contas }));
      fs.renameSync(tmp, arquivo);
      ok = true;
    } catch (e) {
      ok = false;
      console.error(`Monitor: falha ao gravar ${arquivo}: ${e.message}`);
      throw new Error('Não consegui salvar os dados do monitor no servidor.');
    }
  }
  return {
    arquivo,
    ler: (hash) => contas[hash] || null,
    gravar: (hash, conta) => { contas[hash] = conta; salvar(); },
    existe: (hash) => Object.prototype.hasOwnProperty.call(contas, hash),
    total: () => Object.keys(contas).length,
    todas: () => Object.entries(contas),
    salvar,
    saudavel: () => ok,
  };
}

/**
 * Marca como disparados os alertas cujo preço cruzou o alvo e devolve, por conta,
 * os alertas disparados que ainda precisam de e-mail. Muta as contas recebidas.
 */
function verificarAlertas(entradas, precos, agora = Date.now()) {
  let mudou = false;
  const pendentes = [];
  for (const [hash, conta] of entradas) {
    for (const a of conta.alertas) {
      if (a.disparado) continue;
      const p = precos[a.symbol];
      if (p == null || !isFinite(p)) continue;
      if ((a.tipo === 'acima' && p >= a.alvo) || (a.tipo === 'abaixo' && p <= a.alvo)) {
        a.disparado = agora;
        a.precoDisparo = p;
        mudou = true;
      }
    }
    if (!conta.email) continue;
    // disparo antigo (ex.: e-mail cadastrado dias depois) não vira e-mail atrasado
    conta.alertas.forEach((a) => {
      if (a.disparado && !a.notificado && agora - a.disparado > JANELA_EMAIL_MS) { a.notificado = -1; mudou = true; }
    });
    const aEnviar = conta.alertas.filter((a) => a.disparado && !a.notificado);
    if (aEnviar.length) pendentes.push({ hash, conta, alertas: aEnviar });
  }
  return { mudou, pendentes };
}

function fmtNumero(v) {
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(v) < 10 ? 4 : 2 });
}

function montarEmail(alertas, urlMonitor) {
  const linhas = alertas.map((a) => {
    const preco = a.precoDisparo != null ? ` (preço observado: ${fmtNumero(a.precoDisparo)})` : '';
    return `• ${a.symbol}: preço ${a.tipo === 'acima' ? '≥' : '≤'} ${fmtNumero(a.alvo)}${preco}`;
  });
  const assunto = alertas.length === 1
    ? `Alerta de preço atingido: ${alertas[0].symbol}`
    : `${alertas.length} alertas de preço atingidos`;
  const texto = [
    'Olá! O Monitor do Agente Trader registrou os alertas de preço abaixo:',
    '',
    ...linhas,
    '',
    urlMonitor ? `Abra o monitor: ${urlMonitor}` : null,
    '',
    'Os preços vêm do Yahoo Finance e podem ter atraso (15 min ou mais fora dos EUA).',
    'Conteúdo educacional e informativo. Alerta de preço não é recomendação de compra, venda ou manutenção de ativos (Resolução CVM 20/2021).',
  ].filter((l) => l != null).join('\n');
  return { assunto, texto };
}

/** Rotina periódica: busca os preços dos alertas ativos, dispara e manda e-mail. */
function criarRotina({ store, buscarPreco, enviarEmail, urlMonitor, intervaloMs, maxSimbolos = 150, log = console.log }) {
  let rodando = false;
  async function ciclo(agora = Date.now()) {
    if (rodando) return { pulado: true };
    rodando = true;
    try {
      const entradas = store.todas();
      const simbolos = [...new Set(entradas.flatMap(([, c]) => c.alertas.filter((a) => !a.disparado).map((a) => a.symbol)))].slice(0, maxSimbolos);
      const precos = {};
      const res = await Promise.allSettled(simbolos.map(async (s) => { precos[s] = await buscarPreco(s); }));
      const falhas = res.filter((r) => r.status === 'rejected').length;
      const { mudou, pendentes } = verificarAlertas(entradas, precos, agora);
      let enviados = 0, mudouEmail = false;
      if (enviarEmail) {
        for (const p of pendentes) {
          try {
            await enviarEmail(p.conta.email, montarEmail(p.alertas, urlMonitor));
            p.alertas.forEach((a) => { a.notificado = Date.now(); });
            enviados++;
          } catch (e) {
            log('erro', `monitor: e-mail para conta ${p.hash.slice(0, 8)} falhou: ${e.message}`);
            // depois de N falhas desiste, para não martelar o SMTP a cada ciclo
            p.alertas.forEach((a) => { a.tentativas = (a.tentativas || 0) + 1; if (a.tentativas >= MAX_TENTATIVAS_EMAIL) a.notificado = -1; });
          }
          mudouEmail = true;
        }
      }
      if (mudou || mudouEmail) { try { store.salvar(); } catch (_) {} }
      return { simbolos: simbolos.length, falhas, enviados };
    } finally {
      rodando = false;
    }
  }
  return {
    ciclo,
    iniciar() {
      const t = setInterval(() => { ciclo().catch((e) => log('erro', 'monitor: ciclo de alertas falhou:', e.message)); }, intervaloMs);
      t.unref();
      return t;
    },
  };
}

module.exports = {
  MAX_WL, MAX_ALERTAS, MAX_CONTAS,
  hashToken, tokenValido, normalizarConta, mesclarAlertas, contaPublica,
  criarStore, verificarAlertas, montarEmail, criarRotina,
};
