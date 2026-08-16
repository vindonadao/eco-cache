import type { SupabaseClient } from '@supabase/supabase-js';
import { CACHE_CONFIG } from './config.js';
import { embed } from './embed.js';
import { getCorpusVersion, lookup, lookupExact, touch } from './lookup.js';
import { metrics } from './metrics.js';
import { normalize, queryHashOf } from './normalize.js';
import { extractPartition, passesEntityGuard } from './partition.js';
import { classify } from './policy.js';
import { compareShadow } from './shadow.js';
import { store } from './store.js';
import type { CacheHit, CachedAnswer, HitLevel, RagResult } from './types.js';

export { CACHE_CONFIG } from './config.js';
export { supabaseEventSink, useSupabaseEvents } from './events.js';
export { bumpCorpusVersion, invalidateByChunks } from './invalidate.js';
export { metrics } from './metrics.js';
export { compareShadow, type ShadowComparison } from './shadow.js';
export type * from './types.js';

/**
 * Contrato público do Eco — docs/arquitetura.md §6.
 *
 * `client` não está no input original do documento e é obrigatório aqui: a RLS
 * de `rag_cache` é resolvida por `auth.jwt() ->> 'tenant_id'`, então o cache tem
 * que usar o client da request, com o JWT do usuário. Um singleton dentro do
 * pacote leria o tenant errado e viraria vazamento cross-tenant. Ver CLAUDE.md.
 */
export async function answerWithCache(input: {
  client: SupabaseClient;
  tenantId: string;
  query: string;
  runRag: () => Promise<RagResult>;
}): Promise<CachedAnswer> {
  const { client, tenantId, query, runRag } = input;

  if (!CACHE_CONFIG.enabled) return toCached(await runRag(), 'BYPASS');

  const normalized = normalize(query);
  const { partitionKey, entityTokens } = extractPartition(normalized);
  const policy = classify(normalized);

  if (!policy.cacheable) return toCached(await runRag(), 'SKIP');

  const corpusVersion = await getCorpusVersion(client, tenantId);
  const queryHash = queryHashOf(normalized, partitionKey);

  // Falha de embedding degrada para L0-only. Nunca derruba o produto.
  const embedding = await tryEmbed(normalized);

  const hit = embedding
    ? await lookup({
        client,
        tenantId,
        queryHash,
        partitionKey,
        embedding,
        corpusVersion,
        threshold: policy.threshold,
      })
    : await lookupExact({ client, tenantId, queryHash, corpusVersion });

  /** Hit aprovado pelo guard que o shadow mode impediu de servir. */
  let withheld: CacheHit | null = null;

  if (hit) {
    if (passesEntityGuard(entityTokens, hit.entityTokens)) {
      void touch(client, hit.id);
      metrics.emit(
        hit.hitLevel === 'L0' ? { type: 'hit_l0' } : { type: 'hit_l1', similarity: hit.similarity },
      );

      if (!CACHE_CONFIG.shadowMode) {
        return {
          answerText: hit.answerText,
          citations: hit.citations,
          cached: true,
          hitLevel: hit.hitLevel,
          similarity: hit.similarity,
        };
      }
      withheld = hit;
    } else {
      metrics.emit({ type: 'guard_reject', similarity: hit.similarity });
    }
  }

  const fresh = await runRag();

  if (withheld) {
    // O cache acertou e foi impedido de servir. Comparar aqui é grátis: o pipeline já
    // rodou, e é exatamente esta divergência que a semana de shadow existe para medir.
    const comparison = compareShadow(withheld, fresh);
    if (comparison.mismatch) {
      metrics.emit({
        type: 'shadow_mismatch',
        similarity: withheld.similarity,
        hitLevel: withheld.hitLevel,
        textSimilarity: comparison.textSimilarity,
        citationsMatch: comparison.citationsMatch,
      });
    }

    // Não regrava: a entrada existe e acabou de ser contabilizada como hit.
    return toCached(fresh, 'SHADOW');
  }

  metrics.emit({ type: 'miss' });

  void store({
    client,
    tenantId,
    query,
    normalized,
    queryHash,
    partitionKey,
    entityTokens,
    embedding,
    corpusVersion,
    ttlSeconds: policy.ttlSeconds,
    result: fresh,
  });

  return toCached(fresh, 'MISS');
}

/**
 * Embedding com falha absorvida. Timeout ou erro da API não podem derrubar o
 * produto: sem vetor, o fluxo cai para L0-only e, no pior caso, roda o RAG.
 */
async function tryEmbed(normalized: string): Promise<number[] | null> {
  try {
    return await embed(normalized);
  } catch (error) {
    metrics.emit({ type: 'embed_fail', error: (error as Error).message });
    return null;
  }
}

function toCached(result: RagResult, hitLevel: HitLevel): CachedAnswer {
  return {
    answerText: result.answerText,
    citations: result.citations,
    cached: false,
    hitLevel,
  };
}
