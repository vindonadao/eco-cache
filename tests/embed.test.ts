import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Embedding — docs/arquitetura.md §6.
 *
 * A promessa que estes testes guardam: falha de embedding nunca derruba o produto,
 * e o retry não pode estourar o orçamento de 800 ms. Um cache que promete 90 ms não
 * pode gastar 1,6 s tentando duas vezes.
 *
 * `config.ts` lê env na carga do módulo, então cada caso reimporta com env própria.
 */

const DIMS = 512;

async function loadEmbed() {
  vi.resetModules();
  const module = await import('../src/embed.js');
  return module.embed;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function vectorPayload(length: number) {
  return { data: [{ embedding: Array.from({ length }, () => 0.1) }] };
}

beforeEach(() => {
  vi.stubEnv('VOYAGE_API_KEY', 'chave-de-teste');
  vi.stubEnv('EMBEDDING_ENDPOINT', 'https://embeddings.test/v1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('embed', () => {
  it('devolve o vetor quando a API responde', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(vectorPayload(DIMS))),
    );

    const embed = await loadEmbed();
    await expect(embed('editais de ti em sp')).resolves.toHaveLength(DIMS);
  });

  it('recusa vetor de dimensão errada em vez de deixar o Postgres reclamar depois', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(vectorPayload(1536))));

    const embed = await loadEmbed();
    await expect(embed('qualquer coisa')).rejects.toThrow(/512 dimensões, recebeu 1536/);
  });

  it('lança quando a resposta não traz vetor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [] })));

    const embed = await loadEmbed();
    await expect(embed('qualquer coisa')).rejects.toThrow(/sem vetor/);
  });

  it('não insiste em 4xx: chave errada não melhora com retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    const embed = await loadEmbed();
    await expect(embed('qualquer coisa')).rejects.toThrow(/respondeu 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tenta de novo em 5xx e aproveita a segunda resposta', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 503))
      .mockResolvedValueOnce(jsonResponse(vectorPayload(DIMS)));
    vi.stubGlobal('fetch', fetchMock);

    const embed = await loadEmbed();
    await expect(embed('qualquer coisa')).resolves.toHaveLength(DIMS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('tenta no máximo duas vezes, mesmo com a API sempre fora', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    const embed = await loadEmbed();
    await expect(embed('qualquer coisa')).rejects.toThrow(/respondeu 500/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('não tenta de novo se o orçamento de 800 ms já acabou', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      return jsonResponse({ error: 'boom' }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);

    const embed = await loadEmbed();
    await expect(embed('qualquer coisa')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falha cedo e claro quando não há chave configurada', async () => {
    vi.stubEnv('VOYAGE_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const embed = await loadEmbed();
    await expect(embed('qualquer coisa')).rejects.toThrow(/VOYAGE_API_KEY não configurada/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
