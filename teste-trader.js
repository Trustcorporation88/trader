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

console.log('\nteste-trader: todos os cenários passaram.');
