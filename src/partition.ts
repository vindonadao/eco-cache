import { sha256 } from './normalize.js';
import type { PartitionResult } from './types.js';
import { extractUfs } from './uf.js';

/**
 * Extração determinística dos campos que NÃO podem ser interpolados por
 * similaridade — docs/arquitetura.md §3A. Regex + dicionário, sem LLM, sem rede.
 *
 * A busca vetorial só acontece dentro da mesma `partition_key`, então São Paulo e
 * Rio Grande do Sul nunca se encontram, mesmo com cosseno 0,99.
 *
 * A ordem dos extratores importa: cada um consome o trecho que casou antes de
 * passar o resto adiante, senão um CNPJ vira data e um valor vira CNAE.
 */

const MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'marco',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

const RECENCY_TERMS = [
  'hoje',
  'ontem',
  'amanhã',
  'agora',
  'esta semana',
  'nesta semana',
  'semana passada',
  'este mês',
  'neste mês',
  'mês passado',
  'mais recentes',
  'mais recente',
  'últimos',
  'últimas',
  'último',
  'última',
  'recentes',
];

const MULTIPLIERS: Record<string, number> = {
  mil: 1e3,
  milhão: 1e6,
  milhao: 1e6,
  milhões: 1e6,
  milhoes: 1e6,
  mi: 1e6,
  bilhão: 1e9,
  bilhao: 1e9,
  bilhões: 1e9,
  bilhoes: 1e9,
  bi: 1e9,
};

/** Campos duros da query. Chaves ordenadas e arrays ordenados formam o JSON canônico. */
interface HardFields {
  cnae: string[];
  cnpj: string[];
  date: string[];
  id: string[];
  money: number[];
  uf: string[];
}

export function extractPartition(normalized: string): PartitionResult {
  const fields: HardFields = { cnae: [], cnpj: [], date: [], id: [], money: [], uf: [] };
  let rest = normalized;

  // 1. CNPJ, antes de tudo: contém pontos, barra e hífen que confundem os outros.
  rest = consume(rest, /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|(?<!\d)\d{14}(?!\d)/g, (match) => {
    fields.cnpj.push(digitsOf(match));
  });

  // 2. Data numérica, antes do identificador: "15/08/2026" não é edital 08/2026.
  rest = consume(rest, /(?<!\d)\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?!\d)/g, (match) => {
    fields.date.push(match.replace(/\s+/g, ''));
  });

  // 3. Valores e limiares, antes do CNAE: "R$ 1.000.000" tem forma de código.
  rest = consume(
    rest,
    /r\$\s*[\d.,]+(?:\s*(?:mil|milhão|milhao|milhões|milhoes|mi|bilhão|bilhao|bilhões|bilhoes|bi))?|(?<![\d,.])\d[\d.,]*\s*(?:mil|milhão|milhao|milhões|milhoes|bilhão|bilhao|bilhões|bilhoes)(?!\p{L})/giu,
    (match) => {
      const value = parseMoney(match);
      if (value !== null) fields.money.push(value);
    },
  );

  // 4. CNAE. Exige separador ou a própria palavra: \d{4}...\d{2} solto casa valor puro.
  rest = consume(
    rest,
    /cnae\s*n?º?\s*[\d][\d./-]*|(?<!\d)\d{4}-\d(?:\/\d{2})?(?!\d)|(?<!\d)\d{4}\/\d{2}(?!\d)/gi,
    (match) => {
      const code = digitsOf(match);
      if (code.length >= 5) fields.cnae.push(code);
    },
  );

  // 5. Identificadores: número de edital, processo, protocolo.
  rest = consume(rest, /(?<!\d)\d{1,6}\/\d{4}(?!\d)|(?<!\d)\d{6,}(?!\d)/g, (match) => {
    fields.id.push(match);
  });

  // 6. Recência, mês e ano. "hoje" e "janeiro" respondem coisas diferentes.
  rest = consume(rest, buildTermRegex([...RECENCY_TERMS, ...MONTHS]), (match) => {
    fields.date.push(match.trim());
  });
  rest = consume(rest, /(?<!\d)(?:19|20)\d{2}(?!\d)/g, (match) => {
    fields.date.push(match);
  });

  // 7. UF, por último: o dicionário casa nome por extenso, que sobrou intacto.
  const uf = extractUfs(rest);
  fields.uf = uf.ufs;
  rest = uf.rest;

  return {
    partitionKey: sha256(canonicalJson(fields)),
    entityTokens: residualEntityTokens(rest),
  };
}

/**
 * Entity guard (pós-filtro) — docs/arquitetura.md §3B.
 * Divergiu um token duro, rejeita o hit e cai para L2, independente da similaridade.
 *
 * Falso negativo custa uma chamada de LLM. Falso positivo custa uma resposta errada
 * entregue com confiança. A assimetria manda: na dúvida, não serve.
 */
export function passesEntityGuard(
  queryTokens: readonly string[],
  cachedTokens: readonly string[],
): boolean {
  const a = new Set(queryTokens);
  const b = new Set(cachedTokens);
  if (a.size !== b.size) return false;
  for (const token of a) if (!b.has(token)) return false;
  return true;
}

/**
 * Tokens duros que escaparam da partição: qualquer resíduo que contenha dígito.
 *
 * Só dígito, de propósito. Sigla alfabética não entra: "editais de TI" e "editais de
 * tecnologia" precisam dar hit, e o par está na tabela obrigatória da §7. Estado,
 * código e valor já foram capturados pela partição, que é a rede de verdade.
 */
function residualEntityTokens(rest: string): string[] {
  const tokens = rest
    .split(/[^\p{L}\p{N}$/.,-]+/u)
    .map((token) => token.replace(/^[.,-]+|[.,-]+$/g, ''))
    .filter((token) => /\d/.test(token));
  return [...new Set(tokens)].sort();
}

/** Aplica o regex, coleta os matches e devolve o texto sem eles. */
function consume(text: string, pattern: RegExp, onMatch: (match: string) => void): string {
  return text.replace(pattern, (match) => {
    onMatch(match);
    return ' ';
  });
}

function buildTermRegex(terms: readonly string[]): RegExp {
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  return new RegExp(`(?<!\\p{L})(?:${sorted.join('|')})(?!\\p{L})`, 'giu');
}

function digitsOf(input: string): string {
  return input.replace(/\D/g, '');
}

/** Converte "R$ 100 mil", "1,5 milhão" e "34.900,00" em número. */
function parseMoney(raw: string): number | null {
  const cleaned = raw.toLowerCase().replace(/r\$/g, '').trim();
  const match = /^([\d.,]+)\s*(\p{L}+)?$/u.exec(cleaned);
  if (!match) return null;

  const [, digits, suffix] = match;
  if (!digits) return null;

  // Português: ponto é milhar, vírgula é decimal.
  const numeric = Number(digits.replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(numeric)) return null;

  const multiplier = suffix ? (MULTIPLIERS[suffix] ?? null) : 1;
  if (multiplier === null) return null;

  return numeric * multiplier;
}

/** JSON com chaves e arrays ordenados: mesma informação sempre gera a mesma string. */
function canonicalJson(fields: HardFields): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(fields).sort()) {
    const value = fields[key as keyof HardFields];
    ordered[key] = [...new Set(value.map(String))].sort();
  }
  return JSON.stringify(ordered);
}
