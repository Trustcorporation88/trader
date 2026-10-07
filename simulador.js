'use strict';
// ============================================================
// SIMULADOR DE ORDENS (paper trading educacional)
// Funções puras: validam as ordens hipotéticas, reconstroem posições pelo preço
// médio e medem as operações encerradas. Nenhuma ordem chega a uma corretora.
// Só posições compradas: venda acima da posição é ignorada (com aviso), não vira venda a descoberto.
// ============================================================

const MAX_ORDENS = 300;
const SIMBOLO = /^[A-Z0-9.^=\-]{1,20}$/;
const ID_ORDEM = /^[a-z0-9]{4,24}$/;
const MOEDA = /^[A-Z]{3}$/;
const LADOS = new Set(['compra', 'venda']);
const EPS = 1e-9;

/** Valida a lista enviada pelo navegador e devolve em ordem cronológica. Lança Error com mensagem amigável. */
function normalizarOrdens(lista) {
  if (!Array.isArray(lista)) throw new Error('ordens deve ser uma lista.');
  if (lista.length > MAX_ORDENS) throw new Error(`O simulador guarda até ${MAX_ORDENS} ordens. Exclua as mais antigas.`);
  const ids = new Set();
  return lista.map((o) => {
    const id = String((o && o.id) || '');
    const symbol = String((o && o.symbol) || '').trim().toUpperCase();
    const quantidade = Number(o && o.quantidade);
    const preco = Number(o && o.preco);
    const custo = o && o.custo != null && o.custo !== '' ? Number(o.custo) : 0;
    const ts = Number(o && o.ts);
    const moeda = o && o.moeda ? String(o.moeda).trim().toUpperCase() : null;
    if (!ID_ORDEM.test(id) || ids.has(id)) throw new Error('Ordem com identificador inválido.');
    ids.add(id);
    if (!SIMBOLO.test(symbol)) throw new Error(`Ticker inválido na ordem: ${symbol || '(vazio)'}.`);
    if (!LADOS.has(o.lado)) throw new Error('Lado da ordem deve ser "compra" ou "venda".');
    if (!(quantidade > 0) || !isFinite(quantidade) || quantidade > 1e9) throw new Error(`Quantidade inválida na ordem de ${symbol}.`);
    if (!(preco > 0) || !isFinite(preco)) throw new Error(`Preço inválido na ordem de ${symbol}.`);
    if (!(custo >= 0) || !isFinite(custo)) throw new Error(`Custo inválido na ordem de ${symbol}.`);
    if (!(ts > 0) || !isFinite(ts)) throw new Error(`Data inválida na ordem de ${symbol}.`);
    if (moeda != null && !MOEDA.test(moeda)) throw new Error(`Moeda inválida na ordem de ${symbol}.`);
    const nota = o.nota ? String(o.nota).slice(0, 200) : '';
    return { id, symbol, lado: o.lado, quantidade, preco, custo, ts, moeda, nota };
  }).sort((a, b) => a.ts - b.ts);
}

/**
 * Reconstrói as posições pelo método do preço médio. Custos de compra entram no preço
 * médio; custos de venda saem do resultado realizado. Cada venda é uma operação encerrada.
 */
function consolidarOrdens(ordens) {
  const porAtivo = new Map();
  const fechadas = [];
  const avisos = [];
  for (const o of ordens) {
    const p = porAtivo.get(o.symbol) || { symbol: o.symbol, moeda: o.moeda, quantidade: 0, custoTotal: 0, realizado: 0, custos: 0, ordens: 0 };
    if (o.moeda && !p.moeda) p.moeda = o.moeda;
    if (o.lado === 'compra') {
      p.quantidade += o.quantidade;
      p.custoTotal += o.quantidade * o.preco + o.custo;
      p.custos += o.custo;
      p.ordens++;
    } else {
      if (o.quantidade > p.quantidade + EPS) {
        avisos.push(`Venda de ${o.quantidade} ${o.symbol} sem posição suficiente (havia ${+p.quantidade.toFixed(8)}): ordem ignorada nas contas.`);
        porAtivo.set(o.symbol, p);
        continue;
      }
      const pm = p.custoTotal / p.quantidade;
      const resultado = (o.preco - pm) * o.quantidade - o.custo;
      p.realizado += resultado;
      p.custos += o.custo;
      p.custoTotal -= pm * o.quantidade;
      p.quantidade -= o.quantidade;
      if (p.quantidade < EPS) { p.quantidade = 0; p.custoTotal = 0; }
      p.ordens++;
      fechadas.push({ id: o.id, symbol: o.symbol, moeda: p.moeda, ts: o.ts, quantidade: o.quantidade, precoMedio: pm, precoSaida: o.preco, resultado, retorno: resultado / (pm * o.quantidade) });
    }
    porAtivo.set(o.symbol, p);
  }
  const posicoes = [...porAtivo.values()].map((p) => ({
    symbol: p.symbol, moeda: p.moeda, quantidade: p.quantidade,
    precoMedio: p.quantidade > 0 ? p.custoTotal / p.quantidade : null,
    custoAberto: p.custoTotal, realizado: p.realizado, custos: p.custos, ordens: p.ordens,
  }));
  return { posicoes, fechadas, estatisticas: estatisticasOperacoes(fechadas), avisos };
}

/** Taxa de acerto, payoff e expectativa por operação, em % (as moedas podem ser diferentes). */
function estatisticasOperacoes(fechadas) {
  const n = fechadas.length;
  if (!n) return { operacoes: 0 };
  const ganhos = fechadas.filter((f) => f.resultado > 0).map((f) => f.retorno);
  const perdas = fechadas.filter((f) => f.resultado <= 0).map((f) => f.retorno);
  const med = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const taxaAcerto = ganhos.length / n;
  const ganhoMedio = med(ganhos), perdaMedia = med(perdas);
  let sequenciaPerdas = 0, atual = 0;
  for (const f of fechadas) { atual = f.resultado <= 0 ? atual + 1 : 0; sequenciaPerdas = Math.max(sequenciaPerdas, atual); }
  return {
    operacoes: n,
    acertos: ganhos.length,
    taxaAcerto,
    ganhoMedio,
    perdaMedia,
    payoff: ganhoMedio != null && perdaMedia ? ganhoMedio / Math.abs(perdaMedia) : null,
    expectativa: taxaAcerto * (ganhoMedio || 0) + (1 - taxaAcerto) * (perdaMedia || 0),
    melhor: Math.max(...fechadas.map((f) => f.retorno)),
    pior: Math.min(...fechadas.map((f) => f.retorno)),
    sequenciaPerdas,
  };
}

/**
 * Marca as posições a mercado e soma tudo em reais pelo câmbio de hoje.
 * cotacoes: { [symbol]: { preco, moeda, nome } }; cambio: preço do USDBRL.
 */
function avaliarSimulador(consolidado, cotacoes, cambio) {
  const avisos = consolidado.avisos.slice();
  const fator = (moeda) => (moeda === 'BRL' ? 1 : moeda === 'USD' && cambio ? cambio : null);
  let valor = 0, naoRealizado = 0, realizado = 0, custos = 0;
  const posicoes = consolidado.posicoes.map((p) => {
    const c = cotacoes[p.symbol] || {};
    const moeda = p.moeda || c.moeda || null;
    const f = fator(moeda);
    const aberta = p.quantidade > 0;
    const preco = c.preco != null && isFinite(c.preco) ? c.preco : null;
    const nr = aberta && preco != null ? p.quantidade * preco - p.custoAberto : null;
    if (f == null) avisos.push(moeda === 'USD' ? `${p.symbol}: sem câmbio USD/BRL agora; fora da soma em reais.` : `${p.symbol}: cotado em ${moeda || 'moeda desconhecida'}; fora da soma em reais.`);
    else {
      realizado += p.realizado * f;
      custos += p.custos * f;
      if (aberta && preco != null) { valor += p.quantidade * preco * f; naoRealizado += nr * f; }
    }
    if (aberta && preco == null) avisos.push(`${p.symbol}: sem cotação agora; posição aberta fora do valor de mercado.`);
    return { ...p, moeda, nome: c.nome || p.symbol, preco, valor: aberta && preco != null ? p.quantidade * preco : null, naoRealizado: nr, retornoAberto: nr != null && p.custoAberto ? nr / p.custoAberto : null };
  });
  return {
    posicoes,
    fechadas: consolidado.fechadas,
    estatisticas: consolidado.estatisticas,
    totais: { valor, naoRealizado, realizado, custos, resultado: realizado + naoRealizado },
    avisos,
  };
}

module.exports = { MAX_ORDENS, normalizarOrdens, consolidarOrdens, estatisticasOperacoes, avaliarSimulador };
