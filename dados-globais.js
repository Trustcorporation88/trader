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

const PAISES_FINCEPT = [
  { slug: 'brazil', nome: 'Brasil' },
  { slug: 'united-states', nome: 'EUA' },
  { slug: 'china', nome: 'China' },
  { slug: 'germany', nome: 'Alemanha' },
  { slug: 'mexico', nome: 'México' },
];

// rótulo em português para as colunas do resumo por país (World Government Bonds)
const CAMPOS_PAIS = [
  { re: /cds/i, rotulo: 'CDS 5 anos (pb)' },
  { re: /default|(^|_)pd($|_)/i, rotulo: 'Prob. de default' },
  { re: /(central|cb_|^cb|policy)/i, rotulo: 'Juro do banco central' },
  { re: /(10y|10_y|ten_year|yield)/i, rotulo: 'Juro 10 anos' },
  { re: /s&p|sp_|snp/i, rotulo: 'Rating S&P' },
  { re: /moody/i, rotulo: "Rating Moody's" },
  { re: /fitch/i, rotulo: 'Rating Fitch' },
  { re: /rating/i, rotulo: 'Rating' },
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
      campos.push({ rotulo: regra.rotulo, valor: num != null ? num : String(v).slice(0, 40), numero: num != null });
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
    return {
      pais: String(campo(e, ['country', 'country_code', 'currency']) || pais || ''),
      evento: String(evento).slice(0, 140),
      categoria: campo(e, ['category']) ? String(e.category).slice(0, 80) : null,
      data: String(data),
      importancia: imp == null ? null : String(imp),
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
};
