import { CACHE_CONFIG, EMBEDDING_API_KEY, EMBEDDING_ENDPOINT } from './config.js';

/**
 * Embedding da query com voyage-3-lite (512d) — docs/arquitetura.md §6.
 *
 * Os 800 ms são orçamento TOTAL, não por tentativa: o retry só acontece se ainda
 * sobrar tempo. Um cache que promete 90 ms não pode gastar 1,6 s tentando duas vezes.
 *
 * Falha aqui nunca derruba o produto. Quem chama absorve a exceção, degrada para
 * L0-only e, no pior caso, roda o RAG completo.
 *
 * Sem SDK: `fetch` nativo, zero dependência de runtime.
 */
export async function embed(normalized: string): Promise<number[]> {
  if (!EMBEDDING_API_KEY) throw new Error('[eco] embed: VOYAGE_API_KEY não configurada');

  const deadline = Date.now() + CACHE_CONFIG.embeddingTimeoutMs;
  let lastError: Error = new Error('[eco] embed: falhou sem erro registrado');

  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    try {
      return await requestEmbedding(normalized, remaining);
    } catch (error) {
      lastError = error as Error;
      if (!isRetryable(error)) break;
    }
  }

  throw lastError;
}

/** Erro que carrega o status HTTP, para decidir se vale tentar de novo. */
class EmbeddingHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'EmbeddingHttpError';
  }
}

async function requestEmbedding(input: string, timeoutMs: number): Promise<number[]> {
  const response = await fetch(EMBEDDING_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${EMBEDDING_API_KEY}`,
    },
    body: JSON.stringify({
      model: CACHE_CONFIG.embeddingModel,
      input: [input],
      input_type: 'query',
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new EmbeddingHttpError(
      `[eco] embed: API respondeu ${response.status}`,
      response.status,
    );
  }

  const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
  const vector = payload.data?.[0]?.embedding;

  if (!Array.isArray(vector)) {
    throw new Error('[eco] embed: resposta sem vetor');
  }

  // Guarda o schema: a coluna é vector(512). Vetor de outra dimensão quebraria o insert
  // longe daqui, com erro do Postgres em vez do erro real.
  if (vector.length !== CACHE_CONFIG.embeddingDims) {
    throw new Error(
      `[eco] embed: esperava ${CACHE_CONFIG.embeddingDims} dimensões, recebeu ${vector.length}`,
    );
  }

  return vector;
}

/** Rede, timeout, 429 e 5xx valem retry. 4xx é configuração errada: insistir não resolve. */
function isRetryable(error: unknown): boolean {
  if (error instanceof EmbeddingHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  return error instanceof TypeError;
}
