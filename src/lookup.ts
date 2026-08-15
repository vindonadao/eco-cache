import type { SupabaseClient } from '@supabase/supabase-js';
import type { CacheHit, Citation } from './types.js';

/**
 * Consulta ao cache — docs/arquitetura.md §5.
 * Uma ida ao banco: a RPC `cache_lookup` resolve L0 e, se falhar, L1.
 *
 * O entity guard (§3B) é aplicado por quem chama, em `index.ts`, sobre o hit
 * retornado aqui. Este módulo não decide servir, só devolve o candidato.
 */

interface LookupRow {
  hit_level: 'L0' | 'L1';
  id: string;
  answer_text: string;
  answer_citations: Citation[];
  entity_tokens: string[];
  similarity: number;
}

export interface LookupInput {
  client: SupabaseClient;
  tenantId: string;
  queryHash: string;
  partitionKey: string;
  embedding: number[];
  corpusVersion: number;
  threshold: number;
}

export async function lookup(input: LookupInput): Promise<CacheHit | null> {
  const { data, error } = await input.client.rpc('cache_lookup', {
    p_tenant_id: input.tenantId,
    p_query_hash: input.queryHash,
    p_partition_key: input.partitionKey,
    p_embedding: input.embedding,
    p_corpus_version: input.corpusVersion,
    p_threshold: input.threshold,
  });

  if (error) throw new Error(`[eco] cache_lookup falhou: ${error.message}`);

  const row = (data as LookupRow[] | null)?.[0];
  return row ? toHit(row) : null;
}

/**
 * L0 puro, sem embedding. Caminho de degradação quando `embed()` estoura o
 * timeout: o cache continua servindo repetição literal em vez de sumir.
 */
export async function lookupExact(input: {
  client: SupabaseClient;
  tenantId: string;
  queryHash: string;
  corpusVersion: number;
}): Promise<CacheHit | null> {
  const { data, error } = await input.client
    .from('rag_cache')
    .select('id, answer_text, answer_citations, entity_tokens')
    .eq('tenant_id', input.tenantId)
    .eq('query_hash', input.queryHash)
    .eq('corpus_version', input.corpusVersion)
    .gt('expires_at', new Date().toISOString())
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[eco] lookupExact falhou: ${error.message}`);
  if (!data) return null;

  return toHit({
    hit_level: 'L0',
    id: data.id as string,
    answer_text: data.answer_text as string,
    answer_citations: (data.answer_citations ?? []) as Citation[],
    entity_tokens: (data.entity_tokens ?? []) as string[],
    similarity: 1,
  });
}

/** Telemetria de hit. Disparada sem await: nunca segura a resposta do usuário. */
export async function touch(client: SupabaseClient, id: string): Promise<void> {
  await client.rpc('cache_touch', { p_id: id });
}

/** Versão corrente do corpus do tenant. Entrada com versão antiga não dá match. */
export async function getCorpusVersion(client: SupabaseClient, tenantId: string): Promise<number> {
  const { data, error } = await client
    .from('corpus_state')
    .select('corpus_version')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error) throw new Error(`[eco] getCorpusVersion falhou: ${error.message}`);
  return (data?.corpus_version as number | undefined) ?? 1;
}

function toHit(row: LookupRow): CacheHit {
  return {
    hitLevel: row.hit_level,
    id: row.id,
    answerText: row.answer_text,
    citations: row.answer_citations ?? [],
    entityTokens: row.entity_tokens ?? [],
    similarity: row.similarity,
  };
}
