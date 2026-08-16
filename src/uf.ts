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
 * Termos que também são palavra corrente em português e por isso exigem preposição de
 * lugar antes para contar como UF.
 *
 * Sem isso, "se você tem interesse" vira Sergipe. O caso mais traiçoeiro é `para`:
 * `fold('pará')` produz exatamente a preposição mais comum do idioma, então "como faço
 * para me cadastrar" era lido como uma pergunta sobre o estado do Pará e ia para outra
 * partição. Descoberto rodando o ciclo completo contra Postgres, não em teste unitário.
 */
const AMBIGUOUS_TERMS = new Set(['se', 'to', 'ma', 'pa', 'go', 'ac', 'al', 'am', 'para']);

const PLACE_PREPOSITION = '(?:em|no|na|de|do|da|até|ate|-|/)\\s+';

/** Termo ambíguo só conta como UF se vier depois de preposição de lugar. */
function patternFor(term: string): string {
  const escaped = escapeRegex(term);
  return AMBIGUOUS_TERMS.has(term)
    ? `(?<!\\p{L})${PLACE_PREPOSITION}${escaped}(?!\\p{L})`
    : `(?<!\\p{L})${escaped}(?!\\p{L})`;
}

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

  const match = (uf: string, term: string) => {
    const pattern = patternFor(term);
    if (new RegExp(pattern, 'iu').test(rest)) {
      found.add(uf);
      rest = rest.replace(new RegExp(pattern, 'giu'), ' ');
    }
  };

  // Nome por extenso primeiro: o dicionário casa o alias mais longo antes do mais curto.
  for (const { uf, alias } of NAME_ALIASES) match(uf, alias);
  for (const uf of UF_CODES) match(uf, uf.toLowerCase());

  return { ufs: [...found].sort(), rest };
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
