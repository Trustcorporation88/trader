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

  console.log('\nteste-trader: todos os cenários passaram.');
})().catch((e) => { console.error(e); process.exit(1); });
