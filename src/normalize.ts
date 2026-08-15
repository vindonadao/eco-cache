import { createHash } from 'node:crypto';

/**
 * Normalização da query antes de hash e embedding — docs/arquitetura.md §6.
 * NFKC, lowercase, colapso de espaço, strip de pontuação final.
 *
 * Determinística e sem rede: duas queries que só diferem em espaço, caixa ou
 * ponto final precisam produzir o mesmo `query_hash`, senão o L0 nunca acerta.
 */
export function normalize(query: string): string {
  return query
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?¿¡,;:]+$/u, '')
    .trim();
}

/** sha256 em hex. Usado para `query_hash` e `partition_key`. */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** `query_hash` do L0: sha256(query normalizada + partition_key). */
export function queryHashOf(normalized: string, partitionKey: string): string {
  return sha256(`${normalized}::${partitionKey}`);
}
