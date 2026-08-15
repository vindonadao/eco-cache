import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Invalidação — docs/arquitetura.md §8.
 *
 * Global é o padrão: reindexou o corpus, bump da versão. Toda entrada antiga
 * para de dar match no mesmo instante. Zero delete, zero lock. O purge físico
 * vem depois, por cron.
 */
export async function bumpCorpusVersion(
  client: SupabaseClient,
  tenantId: string,
): Promise<number> {
  const { data: current, error: readError } = await client
    .from('corpus_state')
    .select('corpus_version')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (readError) throw new Error(`[eco] bumpCorpusVersion (leitura) falhou: ${readError.message}`);

  const next = ((current?.corpus_version as number | undefined) ?? 1) + 1;

  const { error } = await client.from('corpus_state').upsert(
    { tenant_id: tenantId, corpus_version: next, updated_at: new Date().toISOString() },
    { onConflict: 'tenant_id' },
  );

  if (error) throw new Error(`[eco] bumpCorpusVersion falhou: ${error.message}`);
  return next;
}

/**
 * Invalidação seletiva (fase 2). Só vale a pena se a reindexação for incremental
 * e frequente o bastante para o hit rate despencar com o bump global. Meça antes.
 */
export async function invalidateByChunks(
  client: SupabaseClient,
  tenantId: string,
  chunkIds: string[],
): Promise<void> {
  if (chunkIds.length === 0) return;

  const { error } = await client
    .from('rag_cache')
    .delete()
    .eq('tenant_id', tenantId)
    .overlaps('source_chunk_ids', chunkIds);

  if (error) throw new Error(`[eco] invalidateByChunks falhou: ${error.message}`);
}
