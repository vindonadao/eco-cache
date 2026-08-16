import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bumpCorpusVersion, invalidateByChunks } from '../src/invalidate.js';
import { getCorpusVersion, lookup, lookupExact } from '../src/lookup.js';
import {
  clientForTenant,
  databaseAvailable,
  fakeVector,
  serviceClient,
  TENANT_A,
  TENANT_B,
} from './support/db.js';

/**
 * Integração contra Postgres de verdade — docs/arquitetura.md §8.
 *
 * Esta suíte é a única que executa as migrations, a RPC `cache_lookup` e a RLS. Todo o
 * resto do repo roda com client falso, então é aqui que o schema deixa de ser texto.
 *
 * Sem banco disponível, pula. Suba com `supabase start` na raiz do projeto.
 */

const available = await databaseAvailable();
const CHUNK_1 = '10000000-0000-4000-8000-000000000001';
const CHUNK_2 = '10000000-0000-4000-8000-000000000002';

interface SeedInput {
  tenantId: string;
  queryHash: string;
  partitionKey: string;
  corpusVersion: number;
  answer: string;
  seed: number;
  chunkIds?: string[];
  entityTokens?: string[];
  expiresInSeconds?: number;
}

async function seed(input: SeedInput) {
  const { error } = await serviceClient()
    .from('rag_cache')
    .insert({
      tenant_id: input.tenantId,
      partition_key: input.partitionKey,
      query_hash: input.queryHash,
      query_text: `pergunta ${input.seed}`,
      query_normalized: `pergunta ${input.seed}`,
      query_embedding: JSON.stringify(fakeVector(input.seed)),
      answer_text: input.answer,
      answer_citations: [],
      source_chunk_ids: input.chunkIds ?? [],
      model: 'claude-sonnet',
      entity_tokens: input.entityTokens ?? [],
      corpus_version: input.corpusVersion,
      expires_at: new Date(Date.now() + (input.expiresInSeconds ?? 3600) * 1000).toISOString(),
    });
  if (error) throw new Error(`seed falhou: ${error.message}`);
}

/** Linha mínima válida, para o teste de RLS falhar por policy e não por schema. */
function rowFor(tenantId: string, queryHash: string, answer: string) {
  return {
    tenant_id: tenantId,
    partition_key: 'part-1',
    query_hash: queryHash,
    query_text: 'x',
    query_normalized: 'x',
    query_embedding: JSON.stringify(fakeVector(8)),
    answer_text: answer,
    model: 'claude-sonnet',
    corpus_version: 1,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };
}

async function setCorpusVersion(tenantId: string, version: number) {
  const { error } = await serviceClient()
    .from('corpus_state')
    .upsert({ tenant_id: tenantId, corpus_version: version }, { onConflict: 'tenant_id' });
  if (error) throw new Error(`setCorpusVersion falhou: ${error.message}`);
}

async function wipe() {
  const service = serviceClient();
  await service.from('rag_cache').delete().in('tenant_id', [TENANT_A, TENANT_B]);
  await service.from('corpus_state').delete().in('tenant_id', [TENANT_A, TENANT_B]);
}

async function countRows(tenantId: string): Promise<number> {
  const { count, error } = await serviceClient()
    .from('rag_cache')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`countRows falhou: ${error.message}`);
  return count ?? 0;
}

describe.skipIf(!available)('integração com Postgres', () => {
  beforeAll(wipe);
  afterAll(wipe);

  describe('RPC cache_lookup', () => {
    beforeAll(async () => {
      await wipe();
      await setCorpusVersion(TENANT_A, 1);
      await seed({
        tenantId: TENANT_A,
        queryHash: 'hash-l0',
        partitionKey: 'part-1',
        corpusVersion: 1,
        answer: 'resposta do L0',
        seed: 1,
      });
      await seed({
        tenantId: TENANT_A,
        queryHash: 'hash-outro',
        partitionKey: 'part-1',
        corpusVersion: 1,
        answer: 'resposta do L1',
        seed: 2,
      });
    });

    it('L0 responde por hash exato, sem depender de similaridade', async () => {
      const hit = await lookup({
        client: clientForTenant(TENANT_A),
        tenantId: TENANT_A,
        queryHash: 'hash-l0',
        partitionKey: 'part-1',
        embedding: fakeVector(99),
        corpusVersion: 1,
        threshold: 0.94,
      });

      expect(hit?.hitLevel).toBe('L0');
      expect(hit?.answerText).toBe('resposta do L0');
    });

    it('L1 responde por vizinhança quando o hash não bate', async () => {
      const hit = await lookup({
        client: clientForTenant(TENANT_A),
        tenantId: TENANT_A,
        queryHash: 'hash-inexistente',
        partitionKey: 'part-1',
        embedding: fakeVector(2),
        corpusVersion: 1,
        threshold: 0.94,
      });

      expect(hit?.hitLevel).toBe('L1');
      expect(hit?.similarity).toBeGreaterThanOrEqual(0.94);
    });

    it('não atravessa partição, por mais parecido que o vetor seja', async () => {
      const hit = await lookup({
        client: clientForTenant(TENANT_A),
        tenantId: TENANT_A,
        queryHash: 'hash-inexistente',
        partitionKey: 'part-outra',
        embedding: fakeVector(2),
        corpusVersion: 1,
        threshold: 0.94,
      });

      expect(hit).toBeNull();
    });

    it('entrada expirada não é servida', async () => {
      await seed({
        tenantId: TENANT_A,
        queryHash: 'hash-expirado',
        partitionKey: 'part-1',
        corpusVersion: 1,
        answer: 'resposta velha',
        seed: 3,
        expiresInSeconds: -60,
      });

      const hit = await lookupExact({
        client: clientForTenant(TENANT_A),
        tenantId: TENANT_A,
        queryHash: 'hash-expirado',
        corpusVersion: 1,
      });

      expect(hit).toBeNull();
    });
  });

  /**
   * O ciclo que justifica o módulo existir: primeira pergunta paga o pipeline, as
   * seguintes não. Aqui o banco é real; só o embedding é substituído, porque a API da
   * Voyage não entra em suíte de teste.
   */
  describe('ciclo completo contra o banco', () => {
    const PERGUNTA = 'como faço para me cadastrar?';
    const REFORMULADA = 'qual é o processo de cadastro?';

    /**
     * Só o endpoint de embedding é interceptado. O supabase-js também fala por `fetch`,
     * então um stub cego entregaria a resposta da Voyage ao PostgREST. E cada chamada
     * precisa de um `Response` novo: o corpo só pode ser lido uma vez.
     */
    async function loadAnswerWithCache() {
      const realFetch = globalThis.fetch;
      vi.resetModules();
      vi.stubEnv('VOYAGE_API_KEY', 'chave-de-teste');
      vi.stubEnv('EMBEDDING_ENDPOINT', 'https://embeddings.test/v1');
      vi.stubEnv('CACHE_ENABLED', 'true');
      vi.stubEnv('CACHE_SHADOW_MODE', 'false');
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          if (String(input instanceof Request ? input.url : input).includes('embeddings.test')) {
            return new Response(JSON.stringify({ data: [{ embedding: fakeVector(42) }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return realFetch(input, init);
        }),
      );
      const { answerWithCache } = await import('../src/index.js');
      return answerWithCache;
    }

    const runRag = () =>
      Promise.resolve({
        answerText: 'você se cadastra pelo portal, com CNPJ ativo',
        citations: [{ doc: 'manual.pdf', page: 2 }],
        sourceChunkIds: [],
        model: 'claude-sonnet',
      });

    beforeAll(async () => {
      await wipe();
      await setCorpusVersion(TENANT_A, 1);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it('primeira pergunta roda o pipeline e grava a resposta', async () => {
      const answerWithCache = await loadAnswerWithCache();
      const spy = vi.fn(runRag);

      const resposta = await answerWithCache({
        client: serviceClient(),
        tenantId: TENANT_A,
        query: PERGUNTA,
        runRag: spy,
      });

      expect(resposta.hitLevel).toBe('MISS');
      expect(spy).toHaveBeenCalledTimes(1);

      // A gravação é disparada sem await de propósito: o usuário já recebeu a resposta.
      await vi.waitFor(async () => expect(await countRows(TENANT_A)).toBe(1));
    });

    it('a mesma pergunta volta do L0, sem tocar no pipeline', async () => {
      const answerWithCache = await loadAnswerWithCache();
      const spy = vi.fn(runRag);

      const resposta = await answerWithCache({
        client: serviceClient(),
        tenantId: TENANT_A,
        query: PERGUNTA,
        runRag: spy,
      });

      expect(resposta.hitLevel).toBe('L0');
      expect(resposta.cached).toBe(true);
      expect(resposta.answerText).toBe('você se cadastra pelo portal, com CNPJ ativo');
      expect(spy).not.toHaveBeenCalled();
    });

    it('a pergunta reformulada volta do L1, na mesma partição', async () => {
      const answerWithCache = await loadAnswerWithCache();
      const spy = vi.fn(runRag);

      const resposta = await answerWithCache({
        client: serviceClient(),
        tenantId: TENANT_A,
        query: REFORMULADA,
        runRag: spy,
      });

      expect(resposta.hitLevel).toBe('L1');
      expect(resposta.cached).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    });

    it('cache_touch contabiliza os hits', async () => {
      await vi.waitFor(async () => {
        const { data } = await serviceClient()
          .from('rag_cache')
          .select('hit_count, last_hit_at')
          .eq('tenant_id', TENANT_A)
          .single();
        expect(data?.hit_count).toBe(2);
        expect(data?.last_hit_at).not.toBeNull();
      });
    });

    it('depois do bump de corpus, a mesma pergunta volta a pagar o pipeline', async () => {
      await bumpCorpusVersion(serviceClient(), TENANT_A);

      const answerWithCache = await loadAnswerWithCache();
      const spy = vi.fn(runRag);

      const resposta = await answerWithCache({
        client: serviceClient(),
        tenantId: TENANT_A,
        query: PERGUNTA,
        runRag: spy,
      });

      expect(resposta.hitLevel).toBe('MISS');
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('invalidação global por corpus_version', () => {
    beforeAll(async () => {
      await wipe();
      await setCorpusVersion(TENANT_A, 1);
      await seed({
        tenantId: TENANT_A,
        queryHash: 'hash-versao',
        partitionKey: 'part-1',
        corpusVersion: 1,
        answer: 'resposta da versão 1',
        seed: 4,
      });
    });

    it('bump de versão faz entrada antiga parar de dar match imediatamente', async () => {
      const client = clientForTenant(TENANT_A);

      const antes = await lookupExact({
        client,
        tenantId: TENANT_A,
        queryHash: 'hash-versao',
        corpusVersion: 1,
      });
      expect(antes?.answerText).toBe('resposta da versão 1');

      const nova = await bumpCorpusVersion(serviceClient(), TENANT_A);
      expect(nova).toBe(2);

      const depois = await lookupExact({
        client,
        tenantId: TENANT_A,
        queryHash: 'hash-versao',
        corpusVersion: nova,
      });
      expect(depois).toBeNull();
    });

    it('bump não deleta linha: purge físico é do cron', async () => {
      expect(await countRows(TENANT_A)).toBeGreaterThan(0);
    });

    it('getCorpusVersion enxerga a versão nova', async () => {
      expect(await getCorpusVersion(serviceClient(), TENANT_A)).toBe(2);
    });

    it('tenant sem linha em corpus_state começa na versão 1', async () => {
      expect(await getCorpusVersion(serviceClient(), TENANT_B)).toBe(1);
    });
  });

  describe('invalidação seletiva por source_chunk_ids', () => {
    beforeAll(async () => {
      await wipe();
      await setCorpusVersion(TENANT_A, 1);
      await seed({
        tenantId: TENANT_A,
        queryHash: 'hash-chunk-1',
        partitionKey: 'part-1',
        corpusVersion: 1,
        answer: 'cita o chunk 1',
        seed: 5,
        chunkIds: [CHUNK_1],
      });
      await seed({
        tenantId: TENANT_A,
        queryHash: 'hash-chunk-2',
        partitionKey: 'part-1',
        corpusVersion: 1,
        answer: 'cita o chunk 2',
        seed: 6,
        chunkIds: [CHUNK_2],
      });
    });

    it('remove só as entradas que citam os chunks alterados', async () => {
      await invalidateByChunks(serviceClient(), TENANT_A, [CHUNK_1]);

      expect(
        await lookupExact({
          client: serviceClient(),
          tenantId: TENANT_A,
          queryHash: 'hash-chunk-1',
          corpusVersion: 1,
        }),
      ).toBeNull();

      const sobrevivente = await lookupExact({
        client: serviceClient(),
        tenantId: TENANT_A,
        queryHash: 'hash-chunk-2',
        corpusVersion: 1,
      });
      expect(sobrevivente?.answerText).toBe('cita o chunk 2');
    });

    it('lista vazia de chunks é no-op', async () => {
      const antes = await countRows(TENANT_A);
      await invalidateByChunks(serviceClient(), TENANT_A, []);
      expect(await countRows(TENANT_A)).toBe(antes);
    });
  });

  describe('isolamento por tenant', () => {
    beforeAll(async () => {
      await wipe();
      await setCorpusVersion(TENANT_A, 1);
      await setCorpusVersion(TENANT_B, 1);
      // Mesmo query_hash, mesma partição, tenants diferentes: o pior caso possível.
      await seed({
        tenantId: TENANT_A,
        queryHash: 'hash-compartilhado',
        partitionKey: 'part-1',
        corpusVersion: 1,
        answer: 'segredo do tenant A',
        seed: 7,
      });
      await seed({
        tenantId: TENANT_B,
        queryHash: 'hash-compartilhado',
        partitionKey: 'part-1',
        corpusVersion: 1,
        answer: 'segredo do tenant B',
        seed: 7,
      });
    });

    it('lookup nunca atravessa tenant, mesmo com query_hash idêntico', async () => {
      const hitA = await lookupExact({
        client: clientForTenant(TENANT_A),
        tenantId: TENANT_A,
        queryHash: 'hash-compartilhado',
        corpusVersion: 1,
      });
      expect(hitA?.answerText).toBe('segredo do tenant A');

      const hitB = await lookupExact({
        client: clientForTenant(TENANT_B),
        tenantId: TENANT_B,
        queryHash: 'hash-compartilhado',
        corpusVersion: 1,
      });
      expect(hitB?.answerText).toBe('segredo do tenant B');
    });

    it('RLS bloqueia ler a linha do outro tenant mesmo pedindo explicitamente', async () => {
      const { data, error } = await clientForTenant(TENANT_A)
        .from('rag_cache')
        .select('answer_text')
        .eq('tenant_id', TENANT_B);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it('RLS bloqueia gravar linha em nome de outro tenant', async () => {
      const { error } = await clientForTenant(TENANT_A)
        .from('rag_cache')
        .insert(rowFor(TENANT_B, 'hash-invasor', 'injetado'));

      // 42501 é violação de RLS. Sem checar o código, qualquer erro de schema faria
      // este teste passar pelo motivo errado.
      expect(error?.code).toBe('42501');
    });

    it('e deixa passar a gravação legítima no próprio tenant', async () => {
      const { error } = await clientForTenant(TENANT_A)
        .from('rag_cache')
        .insert(rowFor(TENANT_A, 'hash-legitimo', 'gravado pelo dono'));

      expect(error).toBeNull();
    });

    it('bump em um tenant não afeta o cache de outro', async () => {
      await bumpCorpusVersion(serviceClient(), TENANT_A);

      expect(await getCorpusVersion(serviceClient(), TENANT_A)).toBe(2);
      expect(await getCorpusVersion(serviceClient(), TENANT_B)).toBe(1);

      const hitB = await lookupExact({
        client: clientForTenant(TENANT_B),
        tenantId: TENANT_B,
        queryHash: 'hash-compartilhado',
        corpusVersion: 1,
      });
      expect(hitB?.answerText).toBe('segredo do tenant B');
    });
  });
});
