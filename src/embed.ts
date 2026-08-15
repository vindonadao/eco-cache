import { CACHE_CONFIG } from './config.js';

/**
 * Embedding da query com voyage-3-lite (512d) — docs/arquitetura.md §6.
 * Retry curto e timeout de 800 ms.
 *
 * Falha aqui NUNCA derruba o produto: quem chama degrada para L0-only e, no pior
 * caso, roda o RAG completo. O cache é sempre opcional no caminho crítico.
 *
 * Sem SDK: `fetch` nativo, zero dependência externa.
 *
 * @remarks NÃO IMPLEMENTADO — Sprint 2 (docs/arquitetura.md §10).
 * @throws quando a API falha ou estoura `CACHE_CONFIG.embeddingTimeoutMs`.
 */
export async function embed(_normalized: string): Promise<number[]> {
  void CACHE_CONFIG.embeddingModel;
  throw new Error('[eco] embed: não implementado — Sprint 2 (arquitetura.md §6)');
}
