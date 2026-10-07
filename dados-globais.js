'use strict';
// ============================================================
// DADOS GLOBAIS — normalização das respostas do Banco Mundial e da Fincept API
// Funções puras: recebem o JSON como veio da fonte e devolvem o formato que o
// Monitor desenha. As rotas e o cache ficam no server.js.
// A Fincept (api.fincept.in) é consumida só por REST, com a chave do próprio
// usuário: nenhum código do FinceptTerminal (AGPL-3.0) entra neste repositório.
// ============================================================

const PAISES_BM = [
  { id: 'BRA', nome: 'Brasil' },
  { id: 'USA', nome: 'EUA' },
  { id: 'CHN', nome: 'China' },
  { id: 'WLD', nome: 'Mundo' },
];

const INDICADORES_BM = [
  { id: 'NY.GDP.MKTP.KD.ZG', nome: 'PIB (crescimento real)', sufixo: '%' },
  { id: 'FP.CPI.TOTL.ZG', nome: 'Inflação ao consumidor', sufixo: '%' },
  { id: 'SL.UEM.TOTL.ZS', nome: 'Desemprego (OIT)', sufixo: '%' },
  { id: 'NY.GDP.PCAP.PP.CD', nome: 'PIB per capita (PPC, US$)', sufixo: '' },
  { id: 'BN.CAB.XOKA.GD.ZS', nome: 'Conta corrente (% do PIB)', sufixo: '%' },
  { id: 'GC.DOD.TOTL.GD.ZS', nome: 'Dívida do governo (% do PIB)', sufixo: '%' },
  { id: 'NE.TRD.GNFS.ZS', nome: 'Comércio exterior (% do PIB)', sufixo: '%' },
];

/** Resposta do Banco Mundial ([meta, linhas]) -> { id, nome, sufixo, valores: { BRA: { valor, ano } } }. */
function normalizarBancoMundial(indicador, resposta) {
  const linhas = Array.isArray(resposta) && Array.isArray(resposta[1]) ? resposta[1] : [];
  const valores = {};
  for (const l of linhas) {
    const pais = l && (l.countryiso3code || (l.country && l.country.id));
    const v = l && l.value;
    if (!pais || v == null || !isFinite(v)) continue;
    const ano = Number(l.date);
    if (!valores[pais] || ano > valores[pais].ano) valores[pais] = { valor: Number(v), ano };
  }
  return { id: indicador.id, nome: indicador.nome, sufixo: indicador.sufixo, valores };
}

// ---------- Fincept ----------

/** A Fincept embrulha tudo em { success, message, data }; aceita também a resposta crua. */
function dadosFincept(j) {
  if (j && typeof j === 'object' && !Array.isArray(j) && j.success === false) {
    const m = typeof j.message === 'string' ? j.message : (j.message && j.message.message) || j.detail || 'erro da Fincept';
    throw new Error(String(m));
  }
  return j && typeof j === 'object' && !Array.isArray(j) && 'data' in j ? j.data : j;
}

/** Primeira lista de objetos dentro da resposta (o nome da chave varia por rota). */
function listaFincept(j) {
  const d = dadosFincept(j);
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') {
    for (const k of ['events', 'results', 'items', 'records', 'rows', 'countries', 'data']) if (Array.isArray(d[k])) return d[k];
    const primeira = Object.values(d).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object');
    if (primeira) return primeira;
  }
  return [];
}

function campo(obj, nomes) {
  for (const n of nomes) if (obj[n] != null && obj[n] !== '') return obj[n];
  return null;
}

// Frases do calendário econômico (Trading Economics e similares), da mais longa para a mais curta.
// A sigla original fica entre parênteses quando o mercado a usa no dia a dia.
const TERMOS_ECONOMICOS = [
  ['harmonised inflation rate', 'inflação harmonizada'],
  ['harmonized inflation rate', 'inflação harmonizada'],
  ['core inflation rate', 'núcleo da inflação'],
  ['consumer inflation expectations', 'expectativa de inflação do consumidor'],
  ['inflation rate', 'taxa de inflação'],
  ['consumer price index', 'índice de preços ao consumidor'],
  ['producer price index', 'índice de preços ao produtor'],
  ['ppi ex food, energy and trade', 'inflação ao produtor, sem alimentos, energia e comércio'],
  ['core ppi', 'núcleo da inflação ao produtor'],
  ['core cpi', 'núcleo da inflação (CPI)'],
  ['initial jobless claims', 'pedidos iniciais de seguro-desemprego'],
  ['continuing jobless claims', 'pedidos contínuos de seguro-desemprego'],
  ['jobless claims 4-week average', 'média de 4 semanas dos pedidos de seguro-desemprego'],
  ['jobless claims', 'pedidos de seguro-desemprego'],
  ['non farm payrolls', 'criação de empregos, exceto o campo'],
  ['nonfarm payrolls', 'criação de empregos, exceto o campo'],
  ['unemployment rate', 'taxa de desemprego'],
  ['participation rate', 'taxa de participação'],
  ['employment change', 'variação do emprego'],
  ['full time employment chg', 'variação do emprego em tempo integral'],
  ['part time employment chg', 'variação do emprego em tempo parcial'],
  ['interest rate decision', 'decisão de juros'],
  ['interest rate', 'taxa de juros'],
  ['cash reserve ratio', 'compulsório'],
  ['foreign exchange reserves', 'reservas internacionais'],
  ['balance of trade', 'balança comercial'],
  ['trade balance', 'balança comercial'],
  ['current account', 'conta corrente'],
  ['industrial production', 'produção industrial'],
  ['manufacturing production', 'produção da indústria de transformação'],
  ['mining production', 'produção da mineração'],
  ['capacity utilization', 'uso da capacidade'],
  ['retail sales', 'vendas no varejo'],
  ['wholesale prices', 'preços no atacado'],
  ['consumer confidence', 'confiança do consumidor'],
  ['business confidence', 'confiança empresarial'],
  ['building permits', 'licenças de construção'],
  ['housing starts', 'inícios de construção'],
  ['private house approvals', 'aprovações de casas'],
  ['existing home sales', 'vendas de imóveis usados'],
  ['house price index', 'índice de preços de imóveis'],
  ['new car registrations', 'emplacamento de carros novos'],
  ['used car prices', 'preços de carros usados'],
  ['vehicle sales', 'vendas de veículos'],
  ['auto exports', 'exportação de veículos'],
  ['auto production', 'produção de veículos'],
  ['crude oil stocks change', 'variação dos estoques de petróleo'],
  ['crude oil inventories', 'estoques de petróleo'],
  ['gasoline stocks change', 'variação dos estoques de gasolina'],
  ['gasoline production change', 'variação da produção de gasolina'],
  ['distillate stocks change', 'variação dos estoques de destilados'],
  ['distillate fuel production change', 'variação da produção de destilados'],
  ['natural gas stocks change', 'variação dos estoques de gás natural'],
  ['heating oil stocks change', 'variação dos estoques de óleo combustível'],
  ['crude oil imports change', 'variação da importação de petróleo'],
  ['refinery crude runs change', 'variação do processamento nas refinarias'],
  ['oil rig count', 'contagem de sondas de petróleo'],
  ['total rigs count', 'contagem total de sondas'],
  ['foreign bond investment', 'investimento estrangeiro em títulos'],
  ['stock investment by foreigners', 'investimento estrangeiro em ações'],
  ['gdp growth rate', 'crescimento do PIB'],
  ['gross domestic product', 'PIB'],
  ['leading economic index', 'índice antecedente da economia'],
  ['coincident index', 'índice coincidente'],
  ['household spending', 'gasto das famílias'],
  ['machinery orders', 'encomendas de máquinas'],
  ['export prices', 'preços de exportação'],
  ['import prices', 'preços de importação'],
  ['non-oil exports', 'exportações exceto petróleo'],
  ['mortgage applications', 'pedidos de hipoteca'],
  ['mortgage market index', 'índice do mercado de hipotecas'],
  ['mortgage refinance index', 'índice de refinanciamento de hipotecas'],
  ['purchase index', 'índice de compras de imóveis'],
  ['mortgage rate', 'taxa de hipoteca'],
  ['treasury cash balance', 'caixa do Tesouro'],
  ['fed balance sheet', 'balanço do Fed'],
  ['bill auction', 'leilão de títulos curtos'],
  ['bond auction', 'leilão de títulos'],
  ['gilt auction', 'leilão de títulos públicos'],
  ['bund auction', 'leilão de títulos alemães'],
  ['central bank', 'banco central'],
  ['exports', 'exportações'],
  ['imports', 'importações'],
  ['auction', 'leilão'],
  ['speech', 'discurso'],
  ['cpi', 'inflação (CPI)'],
  ['ppi', 'inflação ao produtor (PPI)'],
  ['pmi', 'PMI (gerentes de compras)'],
  ['gdpnow', 'projeção do PIB (GDPNow)'],
  ['gdp', 'PIB'],
  ['mom', 'no mês'],
  ['yoy', 'em 12 meses'],
  ['qoq', 'no trimestre'],
  ['final', '(final)'],
  ['prel', '(preliminar)'],
  ['preliminary', '(preliminar)'],
  ['flash', '(prévia)'],
  ['revised', '(revisado)'],
  ['adv', '(prévia)'],
  ['stable', 'estável'],
  ['negative', 'negativa'],
  ['positive', 'positiva'],
  ['outlook', 'perspectiva'],
];

const PAISES_NOME = {
  br: 'Brasil', bra: 'Brasil', brazil: 'Brasil',
  us: 'EUA', usa: 'EUA', 'united states': 'EUA', 'united states of america': 'EUA',
  cn: 'China', chn: 'China', china: 'China',
  de: 'Alemanha', deu: 'Alemanha', germany: 'Alemanha',
  gb: 'Reino Unido', uk: 'Reino Unido', gbr: 'Reino Unido', 'united kingdom': 'Reino Unido',
  jp: 'Japão', jpn: 'Japão', japan: 'Japão',
  mx: 'México', mex: 'México', mexico: 'México',
  fr: 'França', fra: 'França', france: 'França',
  it: 'Itália', ita: 'Itália', italy: 'Itália',
  es: 'Espanha', esp: 'Espanha', spain: 'Espanha',
  ca: 'Canadá', can: 'Canadá', canada: 'Canadá',
  au: 'Austrália', aus: 'Austrália', australia: 'Austrália',
  in: 'Índia', ind: 'Índia', india: 'Índia',
  kr: 'Coreia do Sul', kor: 'Coreia do Sul', 'south korea': 'Coreia do Sul',
  eu: 'Zona do euro', ea: 'Zona do euro', 'euro area': 'Zona do euro', eurozone: 'Zona do euro',
  ar: 'Argentina', arg: 'Argentina', argentina: 'Argentina',
  cl: 'Chile', chl: 'Chile', chile: 'Chile',
  wld: 'Mundo', world: 'Mundo',
};

const TERMOS_ORDENADOS = TERMOS_ECONOMICOS.slice().sort((a, b) => b[0].length - a[0].length);

function capitalizarFrase(s) {
  return String(s).replace(/^(\s*)(\p{L})/u, (_, espaco, letra) => espaco + letra.toUpperCase());
}

/** Traduz nome de indicador, evento ou valor curto em inglês. Siglas do dia a dia ficam entre parênteses. */
function traduzirEconomico(texto) {
  let s = String(texto == null ? '' : texto);
  s = s.replace(/\b(\d+)\s*-\s*year\b/gi, '$1 anos');
  s = s.replace(/\b(\d+)\s*-\s*month\b/gi, '$1 meses');
  s = s.replace(/\b(\d+)\s*-\s*week\b/gi, '$1 semanas');
  // marca o que já foi traduzido para uma sigla dentro da tradução (CPI) não ser traduzida de novo
  const marcas = [];
  for (const [en, pt] of TERMOS_ORDENADOS) {
    s = s.replace(new RegExp(`\\b${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), () => `\u0000${marcas.push(pt) - 1}\u0000`);
  }
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => marcas[Number(i)]);
  s = s.replace(/\b(\d+ (?:anos|meses|semanas)) (leilão de .+?)(?=$|[.(])/gi, '$2 de $1');
  s = s.replace(/^(.*?) discurso$/i, 'discurso de $1');
  s = s.replace(/\s{2,}/g, ' ').replace(/\s+([),])/g, '$1').trim();
  return capitalizarFrase(s);
}

/** Código ou nome de país como veio da fonte -> nome em português. O que não estiver na lista volta capitalizado. */
function traduzirPais(texto) {
  const chave = String(texto == null ? '' : texto).trim().toLowerCase();
  if (!chave) return '';
  return PAISES_NOME[chave] || capitalizarFrase(String(texto).trim());
}

function traduzirImportancia(valor) {
  const chave = String(valor == null ? '' : valor).trim().toLowerCase();
  const mapa = { high: 'alta', medium: 'média', med: 'média', low: 'baixa', holiday: 'feriado', '3': 'alta', '2': 'média', '1': 'baixa' };
  return mapa[chave] || (chave ? traduzirEconomico(valor) : null);
}

const PAISES_FINCEPT = [
  { slug: 'brazil', nome: 'Brasil' },
  { slug: 'united-states', nome: 'EUA' },
  { slug: 'china', nome: 'China' },
  { slug: 'germany', nome: 'Alemanha' },
  { slug: 'mexico', nome: 'México' },
];

// rótulo em português para as colunas do resumo por país (World Government Bonds)
const CAMPOS_PAIS = [
  { re: /cds/i, rotulo: 'CDS de 5 anos (pontos)' },
  { re: /default|(^|_)pd($|_)/i, rotulo: 'Probabilidade de calote' },
  { re: /(central|cb_|^cb|policy)/i, rotulo: 'Juro do banco central' },
  { re: /(10y|10_y|ten_year|yield)/i, rotulo: 'Juro 10 anos' },
  { re: /s&p|sp_|snp/i, rotulo: 'Nota S&P' },
  { re: /moody/i, rotulo: "Nota Moody's" },
  { re: /fitch/i, rotulo: 'Nota Fitch' },
  { re: /rating/i, rotulo: 'Nota de crédito' },
];
const CHAVES_NOME = ['country', 'country_slug', 'slug', 'country_name', 'name'];

/** Resumo por país da Fincept -> só os países do PAISES_FINCEPT, na mesma ordem. */
function normalizarPaisesFincept(j) {
  const lista = listaFincept(j);
  const saida = [];
  for (const alvo of PAISES_FINCEPT) {
    const item = lista.find((it) => {
      const nome = String(campo(it || {}, CHAVES_NOME) || '').toLowerCase().replace(/\s+/g, '-');
      return nome === alvo.slug || nome === alvo.slug.replace('-', ' ');
    });
    if (!item) continue;
    const campos = [];
    const usados = new Set();
    for (const [k, v] of Object.entries(item)) {
      if (CHAVES_NOME.includes(k) || v == null || v === '' || typeof v === 'object') continue;
      const regra = CAMPOS_PAIS.find((c) => c.re.test(k));
      if (!regra || usados.has(regra.rotulo)) continue;
      usados.add(regra.rotulo);
      const num = typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null);
      const texto = num != null ? null : traduzirEconomico(String(v).slice(0, 80));
      campos.push({ rotulo: regra.rotulo, valor: num != null ? num : texto, numero: num != null });
    }
    if (campos.length) saida.push({ pais: alvo.nome, slug: alvo.slug, campos });
  }
  return saida;
}

/** Agenda da Trading Economics via Fincept -> eventos ordenados por data. */
function normalizarAgendaFincept(j, pais) {
  return listaFincept(j).map((e) => {
    const evento = campo(e, ['event', 'event_name', 'title', 'name', 'category']);
    const data = campo(e, ['date', 'datetime', 'event_datetime', 'event_date', 'time']);
    if (!evento || !data) return null;
    const imp = campo(e, ['importance', 'impact']);
    const nomePais = campo(e, ['country', 'country_code', 'currency']) || pais || '';
    return {
      pais: traduzirPais(nomePais),
      evento: traduzirEconomico(String(evento).slice(0, 180)).slice(0, 160),
      categoria: campo(e, ['category']) ? traduzirEconomico(String(e.category).slice(0, 100)).slice(0, 90) : null,
      data: String(data),
      importancia: imp == null ? null : traduzirImportancia(imp),
      atual: campo(e, ['actual']),
      previsao: campo(e, ['forecast', 'consensus', 'te_forecast', 'teforecast']),
      anterior: campo(e, ['previous', 'prior']),
    };
  }).filter(Boolean).sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
}

/** Retornos diários (em %) a partir dos fechamentos: escala que o ajuste de GARCH costuma esperar. */
function retornosPercentuais(pontos) {
  const r = [];
  for (let i = 1; i < pontos.length; i++) {
    const a = pontos[i - 1][1], b = pontos[i][1];
    if (a > 0 && b > 0) r.push(100 * Math.log(b / a));
  }
  return r;
}

/**
 * Previsão GARCH da Fincept -> volatilidade diária e anualizada (em fração) por passo.
 * Aceita a previsão como volatilidade ou variância; os retornos foram enviados em %.
 */
function normalizarGarchFincept(j) {
  const d = dadosFincept(j);
  const procurar = (obj, re) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const [k, v] of Object.entries(obj)) {
      if (re.test(k) && Array.isArray(v) && v.length && v.every((x) => typeof x === 'number' && isFinite(x))) return v;
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) { const achou = procurar(v, re); if (achou) return achou; }
    }
    return null;
  };
  let vols = procurar(d, /vol|sigma|std/i);
  if (!vols) { const vars = procurar(d, /var/i); if (vars) vols = vars.map((v) => Math.sqrt(Math.max(v, 0))); }
  if (!vols) throw new Error('resposta da Fincept sem previsão de volatilidade');
  const diaria = vols.map((v) => v / 100);
  const params = {};
  const fonte = d && typeof d === 'object' ? (d.params || d.parameters || d) : {};
  for (const [k, v] of Object.entries(fonte || {})) if (/^(omega|alpha|beta|mu)/i.test(k) && typeof v === 'number') params[k] = v;
  return {
    passos: diaria.length,
    diaria,
    anual: diaria.map((v) => v * Math.sqrt(252)),
    parametros: params,
  };
}

module.exports = {
  PAISES_BM, INDICADORES_BM, PAISES_FINCEPT,
  normalizarBancoMundial, dadosFincept, listaFincept,
  normalizarPaisesFincept, normalizarAgendaFincept, retornosPercentuais, normalizarGarchFincept,
  traduzirEconomico, traduzirPais, traduzirImportancia,
};
