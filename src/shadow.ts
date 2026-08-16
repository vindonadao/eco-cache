import { CACHE_CONFIG } from './config.js';
import type { CacheHit, Citation, RagResult } from './types.js';

/**
 * Comparação do shadow mode — docs/arquitetura.md §9.
 *
 * Shadow mode existe para produzir um número: a taxa de divergência entre o que o cache
 * teria servido e o que o pipeline realmente responde. Sem essa comparação, a semana de
 * shadow roda e não entrega nada, e o threshold acaba calibrado no olho, que é como se
 * descobre três meses depois que 4% das respostas estavam erradas.
 *
 * O documento não define COMO comparar. Aqui a comparação é determinística e barata,
 * pelos dois sinais disponíveis no hit: o texto e as citações. Nada de LLM juiz, pelo
 * mesmo motivo da §11: chamar um modelo para julgar destrói o propósito do cache.
 *
 * O que a RPC devolve não inclui `source_chunk_ids`, então a comparação de fundamentação
 * é feita pelas citações.
 */

export interface ShadowComparison {
  mismatch: boolean;
  /** Jaccard sobre os tokens das duas respostas. 1 é texto equivalente. */
  textSimilarity: number;
  /** As duas respostas se apoiam nas mesmas citações? */
  citationsMatch: boolean;
}

export function compareShadow(hit: CacheHit, fresh: RagResult): ShadowComparison {
  const textSimilarity = jaccard(tokenize(hit.answerText), tokenize(fresh.answerText));
  const citationsMatch = canonicalCitations(hit.citations) === canonicalCitations(fresh.citations);

  return {
    textSimilarity,
    citationsMatch,
    // Citação diferente é divergência mesmo com texto parecido: a resposta mudou de base.
    mismatch: !citationsMatch || textSimilarity < CACHE_CONFIG.shadowMismatchFloor,
  };
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .normalize('NFKC')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** Citações comparáveis independentemente da ordem das chaves e dos itens. */
function canonicalCitations(citations: Citation[]): string {
  const normalized = citations.map((citation) => {
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(citation).sort()) ordered[key] = citation[key];
    return JSON.stringify(ordered);
  });
  return JSON.stringify([...normalized].sort());
}
