import type { SupabaseClient } from '@supabase/supabase-js';
import type { RagResult } from './types.js';

/**
 * Grava o resultado do L2 — docs/arquitetura.md §6.
 * Chamada sem await: o usuário já recebeu a resposta.
 *
 * Sem embedding não há linha: `query_embedding` é `not null` no schema. Quando o
 * embedding falhou, o L2 responde e não deixa rastro no cache. Correto por
 * desenho: gravar meia-entrada quebraria o L1 depois.
 */
export interface StoreInput {
  client: SupabaseClient;
  tenantId: string;
  query: string;
  normalized: string;
  queryHash: string;
  partitionKey: string;
  entityTokens: string[];
  embedding: number[] | null;
  corpusVersion: number;
  ttlSeconds: number;
  result: RagResult;
}

export async function store(input: StoreInput): Promise<void> {
  if (!input.embedding) return;

  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();

  const { error } = await input.client.from('rag_cache').upsert(
    {
      tenant_id: input.tenantId,
      partition_key: input.partitionKey,
      query_hash: input.queryHash,
      query_text: input.query,
      query_normalized: input.normalized,
      query_embedding: input.embedding,
      answer_text: input.result.answerText,
      answer_citations: input.result.citations,
      source_chunk_ids: input.result.sourceChunkIds,
      model: input.result.model,
      entity_tokens: input.entityTokens,
      corpus_version: input.corpusVersion,
      expires_at: expiresAt,
    },
    { onConflict: 'tenant_id,query_hash' },
  );

  if (error) throw new Error(`[eco] store falhou: ${error.message}`);
}
