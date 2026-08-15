import { describe, it } from 'vitest';

/**
 * Invalidação — docs/arquitetura.md §8.
 *
 * Precisa de banco (pgvector + as migrations aplicadas), então roda contra um
 * Supabase de teste, não em unit test puro. Ver CLAUDE.md antes de ativar.
 */

describe('invalidação global por corpus_version', () => {
  it.todo('bump de versão faz entrada antiga parar de dar match imediatamente');
  it.todo('bump não deleta linha: purge físico é do cron');
  it.todo('entrada gravada após o bump usa a versão nova');
});

describe('invalidação seletiva por source_chunk_ids', () => {
  it.todo('remove só as entradas que citam os chunks alterados');
  it.todo('lista vazia de chunks é no-op');
});

describe('isolamento por tenant', () => {
  it.todo('bump em um tenant não afeta o cache de outro');
  it.todo('lookup nunca atravessa tenant, mesmo com query_hash idêntico');
});
