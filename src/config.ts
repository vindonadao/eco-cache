/**
 * Único ponto de leitura de env do módulo.
 * Nada de process.env espalhado — docs/arquitetura.md §0.3.
 */
export const CACHE_CONFIG = {
  enabled: process.env.CACHE_ENABLED !== 'false',
  embeddingModel: 'voyage-3-lite',
  embeddingDims: 512,
  embeddingTimeoutMs: 800,
  defaultThreshold: 0.94,
  defaultTtlSeconds: 60 * 60 * 24 * 7,
  volatileTtlSeconds: 60 * 15,
  shadowMode: process.env.CACHE_SHADOW_MODE === 'true',
  /**
   * Abaixo desta semelhança textual, o shadow mode conta divergência. Não é threshold de
   * cache: nada é servido ou recusado por causa dele. Existe só para dar um corte inicial
   * à medição, e o evento carrega o número medido para reanálise com outro corte.
   */
  shadowMismatchFloor: Number(process.env.CACHE_SHADOW_MISMATCH_FLOOR ?? 0.9),
  publicTenantId: '00000000-0000-0000-0000-000000000000',
} as const;

/** Chave da API de embedding. Lida aqui e em nenhum outro lugar. */
export const EMBEDDING_API_KEY = process.env.VOYAGE_API_KEY ?? '';

/** Endpoint da API de embedding. Override existe para teste e para proxy interno. */
export const EMBEDDING_ENDPOINT =
  process.env.EMBEDDING_ENDPOINT ?? 'https://api.voyageai.com/v1/embeddings';
