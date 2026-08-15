import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RagResult } from '../src/types.js';

/**
 * Fluxo de `answerWithCache()` — docs/arquitetura.md §6.
 *
 * As três decisões que o documento manda explicitar, verificadas aqui:
 * falha de embedding degrada em vez de quebrar, gravação não bloqueia a resposta,
 * e `runRag` é injetado (o módulo não conhece o pipeline).
 */

const DIMS = 512;
const TENANT = '11111111-1111-1111-1111-111111111111';

interface FakeCalls {
  rpc: string[];
  upserts: number;
}

interface CacheRow {
  hit_level: 'L0' | 'L1';
  id: string;
  answer_text: string;
  answer_citations: unknown[];
  entity_tokens: string[];
  similarity: number;
}

function fakeClient(options: { lookupRows?: CacheRow[]; exactRow?: CacheRow | null } = {}) {
  const calls: FakeCalls = { rpc: [], upserts: 0 };

  const selectChain = {
    select: () => selectChain,
    eq: () => selectChain,
    gt: () => selectChain,
    limit: () => selectChain,
    maybeSingle: async () => ({ data: currentSelect, error: null }),
  };

  let currentSelect: unknown = null;

  const client = {
    rpc: async (fn: string) => {
      calls.rpc.push(fn);
      if (fn === 'cache_lookup') return { data: options.lookupRows ?? [], error: null };
      return { data: null, error: null };
    },
    from: (table: string) => {
      currentSelect =
        table === 'corpus_state'
          ? { corpus_version: 7 }
          : (options.exactRow ?? null);
      return {
        ...selectChain,
        upsert: async () => {
          calls.upserts += 1;
          return { error: null };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

const ragResult: RagResult = {
  answerText: 'resposta gerada pelo pipeline',
  citations: [{ doc: 'edital.pdf', page: 3 }],
  sourceChunkIds: [],
  model: 'claude-sonnet',
};

function cachedRow(overrides: Partial<CacheRow> = {}): CacheRow {
  return {
    hit_level: 'L1',
    id: '22222222-2222-2222-2222-222222222222',
    answer_text: 'resposta que já estava no cache',
    answer_citations: [],
    entity_tokens: [],
    similarity: 0.97,
    ...overrides,
  };
}

async function loadModule() {
  vi.resetModules();
  return import('../src/index.js');
}

function stubEmbeddingOk() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, () => 0.1) }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

beforeEach(() => {
  vi.stubEnv('VOYAGE_API_KEY', 'chave-de-teste');
  vi.stubEnv('EMBEDDING_ENDPOINT', 'https://embeddings.test/v1');
  vi.stubEnv('CACHE_ENABLED', 'true');
  vi.stubEnv('CACHE_SHADOW_MODE', 'false');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('answerWithCache', () => {
  it('serve o cache e não roda o pipeline caro quando há hit', async () => {
    stubEmbeddingOk();
    const { client } = fakeClient({ lookupRows: [cachedRow()] });
    const runRag = vi.fn().mockResolvedValue(ragResult);

    const { answerWithCache } = await loadModule();
    const resposta = await answerWithCache({ client, tenantId: TENANT, query: 'como me cadastro?', runRag });

    expect(resposta.cached).toBe(true);
    expect(resposta.hitLevel).toBe('L1');
    expect(resposta.answerText).toBe('resposta que já estava no cache');
    expect(runRag).not.toHaveBeenCalled();
  });

  it('roda o pipeline e responde MISS quando o cache está vazio', async () => {
    stubEmbeddingOk();
    const { client } = fakeClient({ lookupRows: [] });
    const runRag = vi.fn().mockResolvedValue(ragResult);

    const { answerWithCache } = await loadModule();
    const resposta = await answerWithCache({ client, tenantId: TENANT, query: 'como me cadastro?', runRag });

    expect(resposta.cached).toBe(false);
    expect(resposta.hitLevel).toBe('MISS');
    expect(resposta.answerText).toBe(ragResult.answerText);
    expect(runRag).toHaveBeenCalledTimes(1);
  });

  it('falha de embedding degrada para L0 em vez de derrubar o produto', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('rede fora')));
    const { client, calls } = fakeClient({ exactRow: null });
    const runRag = vi.fn().mockResolvedValue(ragResult);

    const { answerWithCache } = await loadModule();
    const resposta = await answerWithCache({ client, tenantId: TENANT, query: 'como me cadastro?', runRag });

    expect(resposta.answerText).toBe(ragResult.answerText);
    expect(runRag).toHaveBeenCalledTimes(1);
    expect(calls.rpc).not.toContain('cache_lookup');
  });

  it('sem embedding não grava no cache: a coluna do vetor é not null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('rede fora')));
    const { client, calls } = fakeClient({ exactRow: null });

    const { answerWithCache } = await loadModule();
    await answerWithCache({
      client,
      tenantId: TENANT,
      query: 'como me cadastro?',
      runRag: async () => ragResult,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.upserts).toBe(0);
  });

  it('guard rejeita o hit quando um número diverge, mesmo com similaridade alta', async () => {
    stubEmbeddingOk();
    const { client } = fakeClient({
      lookupRows: [cachedRow({ entity_tokens: ['5'], similarity: 0.99 })],
    });
    const runRag = vi.fn().mockResolvedValue(ragResult);

    const { answerWithCache } = await loadModule();
    const resposta = await answerWithCache({
      client,
      tenantId: TENANT,
      query: 'edital com 3 lotes',
      runRag,
    });

    expect(resposta.cached).toBe(false);
    expect(resposta.answerText).toBe(ragResult.answerText);
    expect(runRag).toHaveBeenCalledTimes(1);
  });

  it('shadow mode consulta, registra e não serve', async () => {
    vi.stubEnv('CACHE_SHADOW_MODE', 'true');
    stubEmbeddingOk();
    const { client } = fakeClient({ lookupRows: [cachedRow()] });
    const runRag = vi.fn().mockResolvedValue(ragResult);

    const { answerWithCache } = await loadModule();
    const resposta = await answerWithCache({ client, tenantId: TENANT, query: 'como me cadastro?', runRag });

    expect(resposta.cached).toBe(false);
    expect(resposta.answerText).toBe(ragResult.answerText);
    expect(runRag).toHaveBeenCalledTimes(1);
  });

  it('cache desligado passa direto, sem tocar no banco', async () => {
    vi.stubEnv('CACHE_ENABLED', 'false');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { client, calls } = fakeClient();

    const { answerWithCache } = await loadModule();
    const resposta = await answerWithCache({
      client,
      tenantId: TENANT,
      query: 'como me cadastro?',
      runRag: async () => ragResult,
    });

    expect(resposta.hitLevel).toBe('BYPASS');
    expect(calls.rpc).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
