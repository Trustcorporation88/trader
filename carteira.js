'use strict';
// ============================================================
// CARTEIRA SIMULADA — métricas de risco e retorno (educacional)
// Funções puras: recebem os históricos já baixados e devolvem números.
// Tudo em reais: ativos em dólar são convertidos pelo câmbio de cada dia.
// Os pesos são os de hoje aplicados ao passado (rebalanceamento diário), então
// o resultado descreve "como esta combinação teria oscilado", não um histórico real.
// ============================================================

const DIAS_UTEIS_ANO = 252;
const MIN_RETORNOS = 20;
const MAX_POSICOES = 20;
const SIMBOLO = /^[A-Z0-9.^=\-]{1,20}$/;
const MOEDAS = new Set(['BRL', 'USD']);
const Z95 = 1.6448536269514722; // quantil 95% da normal padrão

/** Valida a lista enviada pelo navegador. Lança Error com mensagem amigável. */
function normalizarPosicoes(lista) {
  if (!Array.isArray(lista)) throw new Error('carteira deve ser uma lista de posições.');
  if (lista.length > MAX_POSICOES) throw new Error(`A carteira aceita até ${MAX_POSICOES} posições.`);
  const vistos = new Set();
  return lista.map((p) => {
    const symbol = String((p && p.symbol) || '').trim().toUpperCase();
    const quantidade = Number(p && p.quantidade);
    const pm = p && p.precoMedio != null && p.precoMedio !== '' ? Number(p.precoMedio) : null;
    if (!SIMBOLO.test(symbol)) throw new Error(`Ticker inválido na carteira: ${symbol || '(vazio)'}.`);
    if (vistos.has(symbol)) throw new Error(`${symbol} aparece duas vezes na carteira.`);
    vistos.add(symbol);
    if (!(quantidade > 0) || !isFinite(quantidade) || quantidade > 1e9) throw new Error(`Quantidade inválida para ${symbol}.`);
    if (pm != null && (!(pm > 0) || !isFinite(pm))) throw new Error(`Preço médio inválido para ${symbol}.`);
    return { symbol, quantidade, precoMedio: pm };
  });
}

/**
 * Converte a série do Yahoo em Map dia -> valor. O dia é o do fuso da bolsa: o candle
 * diário do câmbio, por exemplo, vem marcado às 23h UTC do dia anterior.
 */
function porDia(serie) {
  const m = new Map();
  const off = ((serie && serie.gmtoffset) || 0) * 1000;
  for (const [ts, v] of (serie && serie.pontos) || []) {
    if (v != null && isFinite(v)) m.set(new Date(ts + off).toISOString().slice(0, 10), v);
  }
  return m;
}

/**
 * Junta séries com calendários diferentes (B3, EUA, câmbio). O calendário é a união
 * dos dias das séries-base (os ativos); as demais, como o câmbio, só acompanham.
 * Em feriado de um mercado repete o último valor conhecido. Começa no primeiro dia
 * em que todas as séries já têm valor.
 */
function alinhar(mapas, nBase = mapas.length) {
  const datas = [...new Set(mapas.slice(0, nBase).flatMap((m) => [...m.keys()]))].sort();
  const ultimo = mapas.map(() => null);
  const linhas = [];
  for (const d of datas) {
    mapas.forEach((m, i) => { if (m.has(d)) ultimo[i] = m.get(d); });
    if (ultimo.every((v) => v != null)) linhas.push({ dia: d, valores: ultimo.slice() });
  }
  return linhas;
}

function media(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function desvio(xs) {
  if (xs.length < 2) return 0;
  const m = media(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}
function covariancia(xs, ys) {
  const mx = media(xs), my = media(ys);
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += (xs[i] - mx) * (ys[i] - my);
  return s / (xs.length - 1);
}
function correlacao(xs, ys) {
  const dx = desvio(xs), dy = desvio(ys);
  return dx && dy ? covariancia(xs, ys) / (dx * dy) : null;
}
/** Quantil empírico com interpolação linear (xs não precisa estar ordenado). */
function quantil(xs, q) {
  const o = xs.slice().sort((a, b) => a - b);
  const pos = (o.length - 1) * q, base = Math.floor(pos), resto = pos - base;
  return o[base + 1] !== undefined ? o[base] + resto * (o[base + 1] - o[base]) : o[base];
}
function retornos(precos) {
  const r = [];
  for (let i = 1; i < precos.length; i++) r.push(precos[i] / precos[i - 1] - 1);
  return r;
}
/** Gerador pseudoaleatório com semente (mulberry32): a mesma carteira dá a mesma nuvem. */
function aleatorio(semente) {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fronteira eficiente por simulação (só posições compradas, pesos somando 1).
 * Retorno esperado = média histórica anualizada: descreve o passado, não prevê.
 * retAtivos: retornos diários de cada ativo, alinhados; pesosAtuais: pesos de hoje.
 */
function fronteiraEficiente(retAtivos, { pesosAtuais, taxaLivre, simulacoes = 3000, semente = 7, maxPontos = 400 } = {}) {
  const n = retAtivos.length;
  if (n < 2) return null;
  const mu = retAtivos.map((r) => media(r) * DIAS_UTEIS_ANO);
  const cov = retAtivos.map((ri) => retAtivos.map((rj) => covariancia(ri, rj) * DIAS_UTEIS_ANO));
  const rf = taxaLivre != null ? taxaLivre : 0;
  const avaliar = (w) => {
    let ret = 0, vari = 0;
    for (let i = 0; i < n; i++) {
      ret += w[i] * mu[i];
      for (let j = 0; j < n; j++) vari += w[i] * w[j] * cov[i][j];
    }
    const vol = Math.sqrt(Math.max(vari, 0));
    return { pesos: w, ret, vol, sharpe: vol > 0 ? (ret - rf) / vol : null };
  };
  const rnd = aleatorio(semente);
  // cantos (100% em um ativo) entram na nuvem; o resto vem de uma Dirichlet(1)
  const carteiras = Array.from({ length: n }, (_, i) => avaliar(Array.from({ length: n }, (__, j) => (i === j ? 1 : 0))));
  for (let k = 0; k < simulacoes; k++) {
    const e = Array.from({ length: n }, () => -Math.log(1 - rnd()));
    const s = e.reduce((a, b) => a + b, 0);
    carteiras.push(avaliar(e.map((x) => x / s)));
  }
  let minVar = carteiras[0], maxSharpe = null;
  for (const c of carteiras) {
    if (c.vol < minVar.vol) minVar = c;
    if (c.sharpe != null && (!maxSharpe || c.sharpe > maxSharpe.sharpe)) maxSharpe = c;
  }
  const passo = Math.max(1, Math.ceil(carteiras.length / maxPontos));
  return {
    simulacoes: carteiras.length,
    taxaLivre: rf,
    pontos: carteiras.filter((_, i) => i % passo === 0).map((c) => [c.vol, c.ret]),
    atual: pesosAtuais ? avaliar(pesosAtuais) : null,
    minimaVariancia: minVar,
    maximoSharpe: maxSharpe,
  };
}

function drawdownMaximo(indice, dias) {
  let pico = indice[0], diaPico = dias[0], pior = 0, de = null, ate = null;
  for (let i = 0; i < indice.length; i++) {
    if (indice[i] > pico) { pico = indice[i]; diaPico = dias[i]; }
    const dd = indice[i] / pico - 1;
    if (dd < pior) { pior = dd; de = diaPico; ate = dias[i]; }
  }
  return { valor: pior, de, ate };
}

/**
 * posicoes: [{ symbol, quantidade, precoMedio }]
 * historicos: { [symbol]: { nome, moeda, preco, pontos: [[ts, fechamento]] } }
 * cambio: { preco, pontos } do USDBRL; referencia: { pontos } do Ibovespa (opcional)
 * taxaLivre: taxa anual em fração (ex.: 0.1375 para Selic de 13,75%), opcional
 */
function analisarCarteira({ posicoes, historicos, cambio, referencia, taxaLivre }) {
  if (!posicoes.length) throw new Error('Adicione ao menos uma posição à carteira.');
  const avisos = [];
  const fatorHoje = (moeda) => (moeda === 'USD' ? cambio && cambio.preco : 1);

  const validas = [];
  for (const p of posicoes) {
    const h = historicos[p.symbol];
    if (!h || h.preco == null || !(h.pontos || []).length) { avisos.push(`${p.symbol}: sem histórico disponível, ficou fora das contas.`); continue; }
    const moeda = (h.moeda || 'BRL').toUpperCase();
    if (!MOEDAS.has(moeda)) { avisos.push(`${p.symbol}: cotado em ${moeda}; só real e dólar entram nas contas.`); continue; }
    if (moeda === 'USD' && !(cambio && cambio.preco)) { avisos.push(`${p.symbol}: sem câmbio USD/BRL para converter.`); continue; }
    validas.push({ ...p, h, moeda });
  }
  if (!validas.length) throw new Error('Nenhuma posição tem histórico disponível agora.');

  const posicoesCalc = validas.map((p) => {
    const valor = p.quantidade * p.h.preco * fatorHoje(p.moeda);
    return {
      symbol: p.symbol, nome: p.h.nome || p.symbol, moeda: p.moeda, quantidade: p.quantidade,
      preco: p.h.preco, precoMedio: p.precoMedio, valor,
      resultado: p.precoMedio ? p.h.preco / p.precoMedio - 1 : null,
      resultadoValor: p.precoMedio ? p.quantidade * (p.h.preco - p.precoMedio) * fatorHoje(p.moeda) : null,
    };
  });
  const total = posicoesCalc.reduce((a, p) => a + p.valor, 0);
  posicoesCalc.forEach((p) => { p.peso = p.valor / total; });
  const comCusto = posicoesCalc.filter((p) => p.precoMedio);
  const custo = comCusto.reduce((a, p) => a + p.quantidade * p.precoMedio * fatorHoje(p.moeda), 0);

  // séries diárias em reais, alinhadas
  const precisaCambio = validas.some((p) => p.moeda === 'USD');
  const mapas = validas.map((p) => porDia(p.h));
  const mapaCambio = precisaCambio ? porDia(cambio) : null;
  const mapaRef = referencia && (referencia.pontos || []).length ? porDia(referencia) : null;
  const todas = [...mapas, ...(mapaCambio ? [mapaCambio] : []), ...(mapaRef ? [mapaRef] : [])];
  const linhas = alinhar(todas, mapas.length);
  if (linhas.length - 1 < MIN_RETORNOS) throw new Error('Histórico em comum curto demais para calcular risco (mínimo de 20 pregões).');

  const iCambio = validas.length, iRef = validas.length + (mapaCambio ? 1 : 0);
  const precosBRL = validas.map((p, i) => linhas.map((l) => l.valores[i] * (p.moeda === 'USD' ? l.valores[iCambio] : 1)));
  const retAtivos = precosBRL.map(retornos);
  const pesos = posicoesCalc.map((p) => p.peso);
  const n = retAtivos[0].length;
  const retCarteira = Array.from({ length: n }, (_, t) => retAtivos.reduce((a, r, i) => a + pesos[i] * r[t], 0));

  const dias = linhas.map((l) => l.dia);
  const indice = [100];
  retCarteira.forEach((r) => indice.push(indice[indice.length - 1] * (1 + r)));
  const retornoPeriodo = indice[indice.length - 1] / 100 - 1;
  const retornoAnual = (1 + retornoPeriodo) ** (DIAS_UTEIS_ANO / n) - 1;
  const volAnual = desvio(retCarteira) * Math.sqrt(DIAS_UTEIS_ANO);
  const q05 = quantil(retCarteira, 0.05);
  const cauda = retCarteira.filter((r) => r <= q05);
  const var95 = Math.max(0, -q05);
  const cvar95 = cauda.length ? Math.max(0, -media(cauda)) : var95;
  const var95Parametrico = Math.max(0, -(media(retCarteira) - Z95 * desvio(retCarteira)));
  const dd = drawdownMaximo(indice, dias);

  // Sortino: só os dias abaixo da taxa livre diária contam como risco
  let sortino = null;
  if (taxaLivre != null) {
    const rfDia = (1 + taxaLivre) ** (1 / DIAS_UTEIS_ANO) - 1;
    const desvioBaixa = Math.sqrt(media(retCarteira.map((r) => Math.min(0, r - rfDia) ** 2))) * Math.sqrt(DIAS_UTEIS_ANO);
    sortino = desvioBaixa > 0 ? (retornoAnual - taxaLivre) / desvioBaixa : null;
  }

  let beta = null, correlacaoRef = null, indiceRef = null, retornoRef = null;
  if (mapaRef) {
    const retRef = retornos(linhas.map((l) => l.valores[iRef]));
    const vRef = desvio(retRef) ** 2;
    beta = vRef ? covariancia(retCarteira, retRef) / vRef : null;
    correlacaoRef = correlacao(retCarteira, retRef);
    indiceRef = [100];
    retRef.forEach((r) => indiceRef.push(indiceRef[indiceRef.length - 1] * (1 + r)));
    retornoRef = indiceRef[indiceRef.length - 1] / 100 - 1;
  }

  const correlacoes = validas.map((_, i) => validas.map((__, j) => (i === j ? 1 : correlacao(retAtivos[i], retAtivos[j]))));
  posicoesCalc.forEach((p, i) => {
    p.volAnual = desvio(retAtivos[i]) * Math.sqrt(DIAS_UTEIS_ANO);
    p.retornoPeriodo = precosBRL[i][precosBRL[i].length - 1] / precosBRL[i][0] - 1;
  });

  return {
    total, custo: comCusto.length ? custo : null,
    resultado: comCusto.length ? posicoesCalc.reduce((a, p) => a + (p.resultadoValor || 0), 0) : null,
    posicoes: posicoesCalc,
    periodo: { de: dias[0], ate: dias[dias.length - 1], pregoes: n },
    retornoPeriodo, retornoAnual, volAnual,
    taxaLivre: taxaLivre != null ? taxaLivre : null,
    sharpe: taxaLivre != null && volAnual > 0 ? (retornoAnual - taxaLivre) / volAnual : null,
    sortino,
    var95, var95Valor: var95 * total, cvar95, cvar95Valor: cvar95 * total,
    var95Parametrico, var95ParametricoValor: var95Parametrico * total,
    drawdownMaximo: dd,
    beta, correlacaoRef, retornoRef,
    correlacoes: { simbolos: validas.map((p) => p.symbol), matriz: correlacoes },
    fronteira: fronteiraEficiente(retAtivos, { pesosAtuais: pesos, taxaLivre }),
    serie: dias.map((d, i) => [d, indice[i], indiceRef ? indiceRef[i] : null]),
    avisos,
  };
}

module.exports = { MAX_POSICOES, normalizarPosicoes, analisarCarteira, alinhar, quantil, drawdownMaximo, fronteiraEficiente, porDia };
