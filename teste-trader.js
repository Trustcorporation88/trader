'use strict';
const assert = require('assert');
const { AGENTE_TRADER, CODIGOS_TRADER, CATEGORIAS_TRADER, mensagemInvocaTrader } = require('./trader');
const { blocosDosAnexos, podarAnexosAntigos, ferramentaBuscaWeb, mensagemErroAnthropic } = require('./server');

// 1. Catálogo: 100 códigos, 10 categorias de 10, todos únicos e no formato /a-b
assert.strictEqual(CODIGOS_TRADER.length, 100, '100 códigos');
assert.strictEqual(CATEGORIAS_TRADER.length, 10, '10 categorias');
CATEGORIAS_TRADER.forEach((c) => assert.strictEqual(c.codigos.length, 10, `categoria "${c.nome}" com 10 códigos`));
assert.strictEqual(new Set(CODIGOS_TRADER.map((c) => c.codigo)).size, 100, 'códigos únicos');
CODIGOS_TRADER.forEach((c) => {
  assert.ok(/^\/[a-z0-9]+(-[a-z0-9]+)*$/.test(c.codigo), `formato do código ${c.codigo}`);
  assert.ok(c.descricao.length > 20, `descrição de ${c.codigo}`);
});
console.log('1. catálogo OK (100 códigos, 10 categorias, únicos)');

// 2. Todos os códigos aparecem no system prompt e as regras educacionais estão lá
CODIGOS_TRADER.forEach((c) => assert.ok(AGENTE_TRADER.system.includes(c.codigo + ' — '), `prompt contém ${c.codigo}`));
assert.ok(/NUNCA diz "compre", "venda"/.test(AGENTE_TRADER.system), 'regra de não recomendação');
assert.ok(/CVM/.test(AGENTE_TRADER.system), 'aviso CVM');
console.log('2. system prompt OK (100 códigos, regras educacionais)');

// 3. Reconhecimento de código/atalho no início da mensagem
CODIGOS_TRADER.forEach((c) => {
  assert.ok(mensagemInvocaTrader(c.codigo), `${c.codigo} sozinho`);
  assert.ok(mensagemInvocaTrader(`${c.codigo} WINFUT 15min, dados: ...`), `${c.codigo} com texto`);
  assert.ok(mensagemInvocaTrader(`${c.codigo.toUpperCase()}\nativo: PETR4`), `${c.codigo} maiúsculo`);
});
['/trader', 'trader', 'chamar trader', '/trader: analise PETR4', '/daytrade WDOFUT'].forEach((m) => assert.ok(mensagemInvocaTrader(m), `atalho "${m}"`));
assert.strictEqual(mensagemInvocaTrader('o trader da corretora me ligou'), false, 'palavra no meio não conta');
assert.strictEqual(mensagemInvocaTrader('/risco'), false, 'código incompleto');
assert.strictEqual(mensagemInvocaTrader(''), false, 'vazio');
console.log('3. reconhecimento de códigos OK');

// 4. Anexos: imagem, PDF, CSV; rejeições de formato, tamanho e quantidade
const b64 = (s) => Buffer.from(s).toString('base64');
const ok = blocosDosAnexos([
  { nome: 'grafico.PNG', dataB64: 'data:image/png;base64,' + b64('png') },
  { nome: 'relatorio.pdf', dataB64: b64('%PDF-1.4') },
  { nome: 'trades.csv', dataB64: b64('data,ativo,resultado\n2026-09-01,WIN,-120') },
]);
assert.strictEqual(ok.binarios.length, 2, 'imagem + PDF viram blocos binários');
assert.strictEqual(ok.binarios[0].type, 'image');
assert.strictEqual(ok.binarios[0].source.media_type, 'image/png');
assert.strictEqual(ok.binarios[1].type, 'document');
assert.strictEqual(ok.textos.length, 1, 'CSV vira texto');
assert.ok(ok.textos[0].includes('WIN,-120'));
assert.throws(() => blocosDosAnexos([{ nome: 'planilha.xlsx', dataB64: b64('x') }]), /não suportado/, 'xlsx rejeitado');
assert.throws(() => blocosDosAnexos(Array.from({ length: 6 }, () => ({ nome: 'a.txt', dataB64: b64('a') }))), /máximo 5/, 'mais de 5 rejeitado');
assert.throws(() => blocosDosAnexos([{ nome: 'vazio.txt', dataB64: '' }]), /vazio/, 'anexo vazio rejeitado');
assert.throws(() => blocosDosAnexos([{ nome: 'grande.png', dataB64: 'A'.repeat(21 * 1024 * 1024 * 4 / 3 + 4) }]), /limite é 20MB/, 'imagem >20MB rejeitada');
console.log('4. anexos OK');

// 5. Poda de anexos antigos: só os 2 turnos mais recentes com anexo mantêm os blocos
const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } };
const hist = [
  { role: 'user', content: [img, { type: 'text', text: 'turno 1' }] }, { role: 'assistant', content: 'r1' },
  { role: 'user', content: [img, { type: 'text', text: 'turno 2' }] }, { role: 'assistant', content: 'r2' },
  { role: 'user', content: [img, { type: 'text', text: 'turno 3' }] },
];
podarAnexosAntigos(hist);
assert.strictEqual(typeof hist[0].content, 'string', 'turno 1 perde a imagem');
assert.ok(hist[0].content.includes('turno 1'), 'texto do turno 1 preservado');
assert.ok(Array.isArray(hist[2].content) && Array.isArray(hist[4].content), 'turnos 2 e 3 mantêm a imagem');
console.log('5. poda de anexos antigos OK');

// 6. Ferramenta de busca por geração do modelo e mensagens de erro amigáveis
assert.strictEqual(ferramentaBuscaWeb('claude-opus-5').type, 'web_search_20260209');
assert.strictEqual(ferramentaBuscaWeb('claude-sonnet-5').type, 'web_search_20260209');
assert.strictEqual(ferramentaBuscaWeb('claude-haiku-4-5').type, 'web_search_20250305');
assert.match(mensagemErroAnthropic({ status: 401, message: 'authentication_error' }), /ANTHROPIC_API_KEY/);
assert.match(mensagemErroAnthropic({ status: 429, message: 'rate_limit' }), /Aguarde/);
assert.match(mensagemErroAnthropic({ status: 404, message: 'model: not found' }), /CLAUDE_MODEL/);
assert.match(mensagemErroAnthropic({ status: 529, message: 'overloaded_error' }), /sobrecarregada/);
console.log('6. busca na web e erros OK');

// 7. Monitor: validação da conta, mesclagem entre aparelhos, disparo e e-mail
(async () => {
  const monitor = require('./monitor');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  assert.ok(monitor.tokenValido('a'.repeat(32)) && !monitor.tokenValido('curto') && !monitor.tokenValido('x'.repeat(31) + '!'));
  assert.notStrictEqual(monitor.hashToken('a'.repeat(32)), 'a'.repeat(32), 'no disco fica o hash, não o código');

  const alerta = (id, extra = {}) => ({ id, symbol: 'petr4.sa', tipo: 'acima', alvo: 50, criado: 1, disparado: null, ...extra });
  const conta = monitor.normalizarConta({ watchlist: ['aapl', 'AAPL', 'PETR4.SA', '<script>'], alertas: [alerta('abcd')], email: ' Eu@Exemplo.com ' });
  assert.deepStrictEqual(conta.watchlist, ['AAPL', 'PETR4.SA'], 'watchlist normalizada, sem duplicata nem lixo');
  assert.strictEqual(conta.alertas[0].symbol, 'PETR4.SA');
  assert.strictEqual(conta.email, 'eu@exemplo.com');
  assert.throws(() => monitor.normalizarConta({ watchlist: [], alertas: [alerta('abcd', { tipo: 'compre' })] }), /Tipo de alerta/);
  assert.throws(() => monitor.normalizarConta({ watchlist: [], alertas: [alerta('abcd', { alvo: -1 })] }), /Preço-alvo/);
  assert.throws(() => monitor.normalizarConta({ watchlist: [], alertas: [alerta('abcd'), alerta('abcd')] }), /identificador/);
  assert.throws(() => monitor.normalizarConta({ watchlist: [], alertas: [], email: 'nao-e-email' }), /E-mail inválido/);
  assert.throws(() => monitor.normalizarConta({ watchlist: Array.from({ length: 16 }, (_, i) => `T${i}`), alertas: [] }), /até 15/);
  assert.throws(() => monitor.normalizarConta({ watchlist: [], alertas: Array.from({ length: 31 }, (_, i) => alerta(`id${i}xx`)) }), /30 alertas/);

  // disparo feito no servidor não se perde quando outro aparelho manda a lista antiga
  const doServidor = [{ ...alerta('abcd'), symbol: 'PETR4.SA', disparado: 1000, precoDisparo: 51, notificado: 2000 }];
  const mescla = monitor.mesclarAlertas(doServidor, [{ ...alerta('abcd'), symbol: 'PETR4.SA' }, { ...alerta('efgh'), symbol: 'VALE3.SA' }]);
  assert.strictEqual(mescla[0].disparado, 1000);
  assert.strictEqual(mescla[0].notificado, 2000);
  assert.strictEqual(mescla[1].notificado, null, 'alerta novo começa sem e-mail');
  assert.strictEqual(monitor.mesclarAlertas(doServidor, []).length, 0, 'exclusão no aparelho vale');
  const editado = monitor.mesclarAlertas(doServidor, [{ ...alerta('abcd'), symbol: 'PETR4.SA', alvo: 60 }]);
  assert.strictEqual(editado[0].disparado, null, 'alvo mudado reinicia o alerta');

  // rotina: dispara pelo preço, manda um e-mail por conta, grava e não repete
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-'));
  const store = monitor.criarStore(path.join(dir, 'monitor.json'));
  const agora = Date.now();
  store.gravar('h1', { watchlist: [], email: 'a@b.com', alertas: [
    { id: 'aaaa', symbol: 'AAPL', tipo: 'acima', alvo: 100, criado: 1, disparado: null },
    { id: 'bbbb', symbol: 'AAPL', tipo: 'abaixo', alvo: 100, criado: 1, disparado: null },
    { id: 'cccc', symbol: 'PETR4.SA', tipo: 'abaixo', alvo: 40, criado: 1, disparado: agora - 7 * 3600_000 },
  ] });
  store.gravar('h2', { watchlist: [], email: '', alertas: [{ id: 'dddd', symbol: 'AAPL', tipo: 'acima', alvo: 1, criado: 1, disparado: null }] });
  const emails = [];
  const rotina = monitor.criarRotina({
    store, intervaloMs: 60_000, urlMonitor: 'https://exemplo/monitor', log: () => {},
    buscarPreco: async (s) => { if (s === 'AAPL') return 150; throw new Error('sem dados'); },
    enviarEmail: async (para, msg) => { emails.push({ para, ...msg }); },
  });
  const r1 = await rotina.ciclo(agora);
  assert.strictEqual(r1.enviados, 1);
  assert.strictEqual(emails.length, 1, 'conta sem e-mail não recebe nada');
  assert.match(emails[0].assunto, /AAPL/);
  assert.match(emails[0].texto, /CVM 20\/2021/, 'e-mail de alerta leva o aviso CVM');
  assert.match(emails[0].texto, /https:\/\/exemplo\/monitor/);
  assert.doesNotMatch(emails[0].texto, /\b(compre|venda agora)\b/i);
  const h1 = store.ler('h1');
  assert.ok(h1.alertas[0].disparado && h1.alertas[0].notificado > 0, 'alerta acima disparou e foi notificado');
  assert.strictEqual(h1.alertas[1].disparado, null, 'alerta abaixo não disparou');
  assert.strictEqual(h1.alertas[2].notificado, -1, 'disparo antigo não gera e-mail atrasado');
  assert.ok(store.ler('h2').alertas[0].disparado, 'conta sem e-mail também registra o disparo');
  await rotina.ciclo(agora + 1000);
  assert.strictEqual(emails.length, 1, 'não repete o e-mail');
  const relido = monitor.criarStore(path.join(dir, 'monitor.json'));
  assert.ok(relido.ler('h1').alertas[0].notificado > 0, 'estado persistido em disco');

  // SMTP falhando: tenta 3 vezes e desiste
  store.gravar('h3', { watchlist: [], email: 'c@d.com', alertas: [{ id: 'eeee', symbol: 'AAPL', tipo: 'acima', alvo: 1, criado: 1, disparado: null }] });
  const falha = monitor.criarRotina({ store, intervaloMs: 60_000, log: () => {}, buscarPreco: async () => 150, enviarEmail: async () => { throw new Error('smtp fora'); } });
  for (let i = 0; i < 4; i++) await falha.ciclo(agora + i);
  assert.strictEqual(store.ler('h3').alertas[0].notificado, -1);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('7. monitor: conta, mesclagem e alertas OK');

  // 8. Carteira simulada e fundamentos
  const carteira = require('./carteira');
  const { montarFundamentos } = require('./server');
  assert.deepStrictEqual(carteira.normalizarPosicoes([{ symbol: 'petr4.sa', quantidade: '10', precoMedio: '' }]),
    [{ symbol: 'PETR4.SA', quantidade: 10, precoMedio: null }]);
  assert.throws(() => carteira.normalizarPosicoes([{ symbol: 'AAPL', quantidade: 0 }]), /Quantidade/);
  assert.throws(() => carteira.normalizarPosicoes([{ symbol: 'AAPL', quantidade: 1 }, { symbol: 'aapl', quantidade: 2 }]), /duas vezes/);
  assert.throws(() => carteira.normalizarPosicoes(Array.from({ length: 21 }, (_, i) => ({ symbol: `T${i}`, quantidade: 1 }))), /até 20/);
  const contaComCarteira = monitor.normalizarConta({ watchlist: [], alertas: [], carteira: [{ symbol: 'aapl', quantidade: 2 }] });
  assert.strictEqual(contaComCarteira.carteira[0].symbol, 'AAPL');
  assert.strictEqual(monitor.normalizarConta({ watchlist: [], alertas: [] }).carteira, undefined, 'navegador antigo não apaga a carteira');

  assert.strictEqual(carteira.quantil([1, 2, 3, 4, 5], 0.5), 3);
  assert.strictEqual(carteira.quantil([0, 10], 0.25), 2.5);
  const dd = carteira.drawdownMaximo([100, 120, 90, 130, 117], ['a', 'b', 'c', 'd', 'e']);
  assert.ok(Math.abs(dd.valor - -0.25) < 1e-12 && dd.de === 'b' && dd.ate === 'c');

  // 40 pregões; o câmbio vem marcado às 23h UTC do dia anterior (gmtoffset de Londres)
  const DIA = 86_400_000, t0 = Date.UTC(2026, 0, 5, 13);
  const serieDe = (fn, { off = 0, deslocar = 0 } = {}) => ({ gmtoffset: off, pontos: Array.from({ length: 40 }, (_, i) => [t0 + i * DIA + deslocar, fn(i)]) });
  const hA = { nome: 'A', moeda: 'BRL', preco: 20, ...serieDe((i) => (i % 2 ? 11 : 10)) };
  const hB = { nome: 'B', moeda: 'USD', preco: 50, ...serieDe(() => 50) };
  const cambio = { preco: 5, ...serieDe(() => 5, { off: 3600, deslocar: -14 * 3600_000 }) };
  const analise = carteira.analisarCarteira({
    posicoes: [{ symbol: 'A', quantidade: 100, precoMedio: 10 }, { symbol: 'B', quantidade: 4, precoMedio: null }],
    historicos: { A: hA, B: hB }, cambio, referencia: null, taxaLivre: 0.10,
  });
  assert.strictEqual(analise.total, 100 * 20 + 4 * 50 * 5, 'ativo em dólar convertido pelo câmbio de hoje');
  assert.strictEqual(analise.posicoes[0].peso, 2000 / 3000);
  assert.strictEqual(analise.periodo.pregoes, 39, 'câmbio alinhado no mesmo dia, sem pregões extras');
  assert.strictEqual(analise.resultado, 100 * (20 - 10), 'resultado só das posições com preço médio');
  assert.strictEqual(analise.posicoes[1].volAnual, 0, 'ativo de preço constante tem volatilidade zero');
  assert.ok(analise.volAnual > 0 && analise.var95 > 0 && analise.cvar95 >= analise.var95);
  assert.ok(Math.abs(analise.var95Valor - analise.var95 * analise.total) < 1e-9);
  assert.ok(analise.drawdownMaximo.valor < 0);
  assert.ok(analise.sharpe != null && analise.beta === null, 'sem referência não há beta');
  assert.strictEqual(analise.correlacoes.matriz[0][1], null, 'correlação com série constante é indefinida');
  assert.strictEqual(analise.serie[0][1], 100);
  assert.throws(() => carteira.analisarCarteira({
    posicoes: [{ symbol: 'A', quantidade: 1 }], historicos: { A: { ...hA, pontos: hA.pontos.slice(0, 10) } }, cambio,
  }), /curto demais/);
  const soEuro = carteira.analisarCarteira({
    posicoes: [{ symbol: 'A', quantidade: 1 }, { symbol: 'E', quantidade: 1 }],
    historicos: { A: hA, E: { ...hB, moeda: 'EUR' } }, cambio,
  });
  assert.match(soEuro.avisos[0], /EUR/, 'moeda não suportada vira aviso, não erro');

  const fund = montarFundamentos('AAPL', { name: 'Apple Inc', finnhubIndustry: 'Technology', marketCapitalization: 3e6 },
    { metric: { peBasicExclExtraTTM: 30.5, dividendYieldIndicatedAnnual: 0.45, netProfitMarginTTM: 24.3, beta: null } });
  assert.deepStrictEqual(fund.indicadores.map((i) => i.id), ['pl', 'dy', 'ml'], 'usa a chave alternativa e ignora nulos');
  assert.strictEqual(montarFundamentos('XYZ', {}, { metric: {} }), null, 'sem perfil nem métricas = sem fundamentos');
  console.log('8. carteira simulada e fundamentos OK');

  // 9. Métricas novas da carteira, simulador de ordens e dados globais
  assert.ok(analise.var95Parametrico > 0 && Math.abs(analise.var95ParametricoValor - analise.var95Parametrico * analise.total) < 1e-9);
  assert.ok(analise.sortino != null && isFinite(analise.sortino), 'Sortino com taxa livre informada');
  assert.strictEqual(soEuro.sortino, null, 'sem taxa livre não há Sortino');
  const fr = analise.fronteira;
  assert.ok(fr && fr.simulacoes > 1000 && fr.pontos.length <= 401, 'fronteira simulada e amostrada para o gráfico');
  for (const c of [fr.atual, fr.minimaVariancia, fr.maximoSharpe]) {
    assert.ok(Math.abs(c.pesos.reduce((a, b) => a + b, 0) - 1) < 1e-9 && c.pesos.every((w) => w >= 0), 'pesos somam 1, só comprados');
  }
  assert.ok(fr.minimaVariancia.vol <= fr.atual.vol + 1e-12, 'mínima variância não tem mais risco que a atual');
  assert.ok(fr.minimaVariancia.pesos[1] > 0.99, 'ativo de preço constante domina a mínima variância');
  assert.deepStrictEqual(carteira.fronteiraEficiente([[0.01, -0.01, 0.02], [0.0, 0.01, -0.01]], { semente: 3 }).pontos,
    carteira.fronteiraEficiente([[0.01, -0.01, 0.02], [0.0, 0.01, -0.01]], { semente: 3 }).pontos, 'mesma semente, mesma nuvem');
  assert.strictEqual(carteira.fronteiraEficiente([[0.01, 0.02]]), null, 'um ativo só não tem fronteira');

  const simulador = require('./simulador');
  const ordem = (id, lado, quantidade, preco, ts, extra = {}) => ({ id, symbol: 'petr4.sa', lado, quantidade, preco, ts, moeda: 'brl', ...extra });
  const ordens = simulador.normalizarOrdens([
    ordem('o003', 'venda', 100, 33, 3, { custo: 5 }),
    ordem('o001', 'compra', 100, 30, 1, { custo: 10 }),
    ordem('o002', 'compra', 100, 32, 2),
    ordem('o004', 'venda', 100, 29, 4),
    ordem('o005', 'venda', 50, 40, 5),
    { id: 'o006', symbol: 'AAPL', lado: 'compra', quantidade: 2, preco: 100, ts: 6, moeda: 'USD' },
  ]);
  assert.deepStrictEqual(ordens.map((o) => o.id), ['o001', 'o002', 'o003', 'o004', 'o005', 'o006'], 'ordens em ordem cronológica');
  assert.strictEqual(ordens[0].symbol, 'PETR4.SA');
  assert.strictEqual(ordens[0].moeda, 'BRL');
  assert.throws(() => simulador.normalizarOrdens([ordem('o001', 'short', 1, 1, 1)]), /Lado/);
  assert.throws(() => simulador.normalizarOrdens([ordem('o001', 'compra', 1, 0, 1)]), /Preço/);
  assert.throws(() => simulador.normalizarOrdens([ordem('o001', 'compra', 1, 1, 1), ordem('o001', 'compra', 1, 1, 2)]), /identificador/);
  assert.throws(() => simulador.normalizarOrdens([ordem('o001', 'compra', 1, 1, 1, { custo: -1 })]), /Custo/);
  assert.throws(() => simulador.normalizarOrdens(Array.from({ length: 301 }, (_, i) => ordem(`id${i}xx`, 'compra', 1, 1, i + 1))), /até 300/);
  const cons = simulador.consolidarOrdens(ordens);
  const petr = cons.posicoes.find((p) => p.symbol === 'PETR4.SA');
  // PM = (100*30 + 10 + 100*32) / 200 = 31,05; venda 1: (33-31,05)*100 - 5 = 190; venda 2: (29-31,05)*100 = -205
  assert.ok(Math.abs(cons.fechadas[0].resultado - 190) < 1e-9 && Math.abs(cons.fechadas[1].resultado - -205) < 1e-9, 'resultado pelo preço médio, com custos');
  assert.strictEqual(petr.quantidade, 0, 'posição zerada');
  assert.ok(Math.abs(petr.realizado - -15) < 1e-9);
  assert.strictEqual(cons.fechadas.length, 2, 'venda sem posição não vira operação');
  assert.match(cons.avisos[0], /sem posição suficiente/, 'venda a descoberto ignorada com aviso');
  const est = cons.estatisticas;
  assert.strictEqual(est.operacoes, 2);
  assert.strictEqual(est.taxaAcerto, 0.5);
  assert.strictEqual(est.sequenciaPerdas, 1);
  assert.ok(Math.abs(est.expectativa - (0.5 * est.ganhoMedio + 0.5 * est.perdaMedia)) < 1e-12);
  assert.deepStrictEqual(simulador.estatisticasOperacoes([]), { operacoes: 0 });
  const av = simulador.avaliarSimulador(cons, { AAPL: { preco: 110, moeda: 'USD', nome: 'Apple' } }, 5);
  assert.strictEqual(av.totais.valor, 2 * 110 * 5, 'posição em dólar convertida pelo câmbio de hoje');
  assert.strictEqual(av.totais.naoRealizado, 2 * 10 * 5);
  assert.ok(Math.abs(av.totais.realizado - -15) < 1e-9);
  const semCambio = simulador.avaliarSimulador(cons, { AAPL: { preco: 110, moeda: 'USD' } }, null);
  assert.ok(semCambio.avisos.some((a) => /câmbio/.test(a)) && semCambio.totais.valor === 0, 'sem câmbio, dólar fica fora da soma');
  const contaComOrdens = monitor.normalizarConta({ watchlist: [], alertas: [], ordens: [ordem('o001', 'compra', 1, 10, 1)] });
  assert.strictEqual(contaComOrdens.ordens[0].symbol, 'PETR4.SA');
  assert.strictEqual(monitor.normalizarConta({ watchlist: [], alertas: [] }).ordens, undefined, 'navegador antigo não apaga as ordens');
  assert.deepStrictEqual(monitor.contaPublica({ watchlist: [], alertas: [], email: '', atualizado: 1 }).ordens, []);

  const dg = require('./dados-globais');
  const bm = dg.normalizarBancoMundial(dg.INDICADORES_BM[0], [{ page: 1 }, [
    { countryiso3code: 'BRA', date: '2024', value: 3.4 }, { countryiso3code: 'BRA', date: '2025', value: 2.3 },
    { countryiso3code: 'USA', date: '2025', value: null }, { country: { id: 'CHN' }, date: '2025', value: 5 },
  ]]);
  assert.deepStrictEqual(bm.valores, { BRA: { valor: 2.3, ano: 2025 }, CHN: { valor: 5, ano: 2025 } }, 'Banco Mundial: ano mais recente, sem nulos');
  assert.deepStrictEqual(dg.normalizarBancoMundial(dg.INDICADORES_BM[0], { message: 'erro' }).valores, {});
  const paises = dg.normalizarPaisesFincept({ success: true, data: [
    { country: 'Brazil', bond_yield_10y: 13.9, cb_rate: '15.00', sp_rating: 'BB', cds_5y: 160.2, default_probability: 2.7, extra: { x: 1 } },
    { country: 'Narnia', bond_yield_10y: 1 },
    { country_slug: 'united-states', yield_10y: 4.1, rating: 'AA+' },
  ] });
  assert.deepStrictEqual(paises.map((p) => p.pais), ['Brasil', 'EUA'], 'só os países escolhidos, na ordem');
  const br = Object.fromEntries(paises[0].campos.map((c) => [c.rotulo, c.valor]));
  assert.strictEqual(br['Juro 10 anos'], 13.9);
  assert.strictEqual(br['Juro do banco central'], 15, 'número em texto vira número');
  assert.strictEqual(br['Nota S&P'], 'BB');
  assert.strictEqual(br['CDS de 5 anos (pontos)'], 160.2);
  assert.strictEqual(br['Probabilidade de calote'], 2.7);
  assert.throws(() => dg.normalizarPaisesFincept({ success: false, message: { error: 'unauthenticated', message: 'API key required' } }), /API key required/);
  const agenda = dg.normalizarAgendaFincept({ success: true, data: { events: [
    { date: '2026-10-08T12:30:00', country: 'United States', event: 'CPI YoY', actual: null, forecast: '2.9%', previous: '3.0%', importance: 3 },
    { date: '2026-10-07T09:00:00', event: 'IPCA', te_forecast: '0.4%' },
    { country: 'BR' },
  ] } }, 'BR');
  assert.deepStrictEqual(agenda.map((e) => e.evento), ['IPCA', 'Inflação (CPI) em 12 meses'], 'agenda em português, ordenada por data');
  assert.strictEqual(agenda[0].pais, 'Brasil', 'país da consulta traduzido quando a fonte não informa');
  assert.strictEqual(agenda[0].previsao, '0.4%');
  assert.strictEqual(agenda[1].importancia, 'alta', 'importância numérica vira texto');
  assert.strictEqual(agenda[1].pais, 'EUA');
  assert.strictEqual(dg.traduzirEconomico('Building Permits MoM Final'), 'Licenças de construção no mês (final)');
  assert.strictEqual(dg.traduzirEconomico('30-Year Bond Auction'), 'Leilão de títulos de 30 anos');
  assert.strictEqual(dg.traduzirEconomico('RBI Interest Rate Decision'), 'RBI decisão de juros');
  assert.strictEqual(dg.traduzirEconomico('Core CPI YoY'), 'Núcleo da inflação (CPI) em 12 meses');
  assert.strictEqual(dg.traduzirPais('united states'), 'EUA');
  assert.strictEqual(dg.traduzirImportancia('Low'), 'baixa');
  const rp = dg.retornosPercentuais([[1, 100], [2, 110], [3, 0], [4, 99]]);
  assert.ok(rp.length === 1 && Math.abs(rp[0] - 100 * Math.log(1.1)) < 1e-12, 'retornos em % ignoram preço zerado');
  const g1 = dg.normalizarGarchFincept({ success: true, data: { forecast_volatility: [2, 2.1], params: { omega: 0.1, alpha: 0.08, beta: 0.9 } } });
  assert.ok(Math.abs(g1.diaria[0] - 0.02) < 1e-12 && Math.abs(g1.anual[0] - 0.02 * Math.sqrt(252)) < 1e-12, 'volatilidade em % vira fração');
  assert.deepStrictEqual(g1.parametros, { omega: 0.1, alpha: 0.08, beta: 0.9 });
  const g2 = dg.normalizarGarchFincept({ data: { forecast: { variance: [4, 9] } } });
  assert.deepStrictEqual(g2.diaria, [0.02, 0.03], 'variância vira volatilidade');
  assert.throws(() => dg.normalizarGarchFincept({ data: { ok: true } }), /sem previsão/);
  console.log('9. fronteira, simulador de ordens e dados globais OK');

  // 10. Cards do painel de mercados
  const { montarCardMercado } = require('./server');
  const card = montarCardMercado({ symbol: '^BVSP', nome: 'Ibovespa', tipo: 'indice' }, {
    preco: 178000, anterior: 100000, moeda: 'BRL',
    pontos: [...Array.from({ length: 98 }, (_, i) => [i, 100 + i]), [98, 177000], [99, 178000]],
  });
  assert.strictEqual(card.moeda, null, 'índice não leva prefixo de moeda');
  assert.ok(Math.abs(card.variacao - (1000 / 177000) * 100) < 1e-9, 'variação do dia, não a de 6 meses');
  assert.strictEqual(card.variacaoPontos, 1000);
  assert.strictEqual(card.pontos.length, 48);
  assert.strictEqual(card.pontos[0], 100);
  assert.strictEqual(card.pontos[47], 178000, 'a amostra guarda o último pregão');
  const dolar = montarCardMercado({ symbol: 'USDBRL=X', nome: 'Real/Dólar', tipo: 'cambio' }, { preco: 5.42, anterior: 5.4, moeda: 'BRL', pontos: [[1, 5.4], [2, 5.42]] });
  assert.strictEqual(dolar.moeda, 'BRL');
  assert.strictEqual(dolar.pontos.length, 2);
  assert.strictEqual(montarCardMercado({ symbol: 'X', nome: 'X', tipo: 'indice' }, { preco: null, pontos: [] }), null);
  console.log('10. painel de mercados OK');

  console.log('\nteste-trader: todos os cenários passaram.');
})().catch((e) => { console.error(e); process.exit(1); });
