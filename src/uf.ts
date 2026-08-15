/**
 * Dicionário das 27 UFs — docs/arquitetura.md §3A.
 *
 * Estado é o campo duro que mais engana embedding: "editais em São Paulo" e
 * "editais no Rio Grande do Sul" têm cosseno ~0,96 porque a estrutura da frase é
 * idêntica. Aqui ele vira partição, não similaridade.
 */

/** Remove diacríticos. Só para casar alias: "sao paulo" e "são paulo" são o mesmo estado. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/** sigla canônica → nomes por extenso aceitos. */
const UF_NAMES: Record<string, string[]> = {
  AC: ['acre'],
  AL: ['alagoas'],
  AP: ['amapá'],
  AM: ['amazonas'],
  BA: ['bahia'],
  CE: ['ceará'],
  DF: ['distrito federal'],
  ES: ['espírito santo'],
  GO: ['goiás'],
  MA: ['maranhão'],
  MT: ['mato grosso'],
  MS: ['mato grosso do sul'],
  MG: ['minas gerais'],
  PA: ['pará'],
  PB: ['paraíba'],
  PR: ['paraná'],
  PE: ['pernambuco'],
  PI: ['piauí'],
  RJ: ['rio de janeiro'],
  RN: ['rio grande do norte'],
  RS: ['rio grande do sul'],
  RO: ['rondônia'],
  RR: ['roraima'],
  SC: ['santa catarina'],
  SP: ['são paulo'],
  SE: ['sergipe'],
  TO: ['tocantins'],
};

/**
 * Siglas que também são palavra corrente em português. Exigem preposição de lugar
 * antes para contar como UF, senão "se você tem interesse" viraria Sergipe.
 */
const AMBIGUOUS_ACRONYMS = new Set(['se', 'to', 'ma', 'pa', 'go', 'ac', 'al', 'am']);

const PLACE_PREPOSITION = '(?:em|no|na|de|do|da|para|pra|até|ate|-|/)\\s+';

/** Aliases por extenso, do mais longo para o mais curto: "mato grosso do sul" antes de "mato grosso". */
const NAME_ALIASES: ReadonlyArray<{ uf: string; alias: string }> = Object.entries(UF_NAMES)
  .flatMap(([uf, names]) => names.flatMap((alias) => [alias, fold(alias)].map((a) => ({ uf, alias: a }))))
  .filter(({ alias }, i, all) => all.findIndex((o) => o.alias === alias) === i)
  .sort((a, b) => b.alias.length - a.alias.length);

export const UF_CODES: readonly string[] = Object.keys(UF_NAMES);

export interface UfMatch {
  ufs: string[];
  /** Texto com as ocorrências consumidas, para os extratores seguintes não recapturarem. */
  rest: string;
}

/**
 * Extrai UFs de um texto já normalizado (minúsculo). Devolve siglas canônicas
 * ordenadas: "SP" e "são paulo" produzem a mesma partição.
 */
export function extractUfs(normalized: string): UfMatch {
  const found = new Set<string>();
  let rest = normalized;

  for (const { uf, alias } of NAME_ALIASES) {
    const re = new RegExp(`(?<!\\p{L})${escapeRegex(alias)}(?!\\p{L})`, 'giu');
    if (re.test(rest)) {
      found.add(uf);
      rest = rest.replace(new RegExp(`(?<!\\p{L})${escapeRegex(alias)}(?!\\p{L})`, 'giu'), ' ');
    }
  }

  for (const uf of UF_CODES) {
    const sigla = uf.toLowerCase();
    const pattern = AMBIGUOUS_ACRONYMS.has(sigla)
      ? `(?<!\\p{L})(${PLACE_PREPOSITION})${sigla}(?!\\p{L})`
      : `(?<!\\p{L})${sigla}(?!\\p{L})`;
    const re = new RegExp(pattern, 'giu');
    if (re.test(rest)) {
      found.add(uf);
      rest = rest.replace(new RegExp(pattern, 'giu'), ' ');
    }
  }

  return { ufs: [...found].sort(), rest };
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
