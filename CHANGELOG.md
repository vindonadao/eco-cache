# Changelog

Todas as mudanças relevantes do Eco. Versionamento por revisões (`rev-X.Y`).

## rev-0.1 — 15/08/2026

Abertura do projeto. Fundação a partir de `docs/arquitetura.md`.

### Adicionado

- `docs/arquitetura.md` como fonte da verdade do projeto, reproduzido na íntegra
- Migrations `0001` a `0004`: tabela `rag_cache`, `corpus_state`, índices B-tree e HNSW,
  RLS por tenant, RPC `cache_lookup` (L0 + L1) e `cache_touch`
- `src/config.ts` com `CACHE_CONFIG`, único ponto de leitura de env do módulo
- `src/normalize.ts`: normalização NFKC, `sha256` e composição do `query_hash`
- `src/policy.ts`: classificação por classe de query, com a regra de recência tabelada
- `src/lookup.ts`: chamada da RPC, `lookupExact` para o caminho L0-only, `touch` e
  leitura da versão do corpus
- `src/store.ts`: gravação do resultado do L2, sem bloquear a resposta ao usuário
- `src/invalidate.ts`: bump de `corpus_version` e purge seletivo por chunk
- `src/metrics.ts`: emissão de eventos com sink plugável
- `src/index.ts`: `answerWithCache()`, o contrato público, com o fluxo completo dos
  três níveis
- `tests/false-positive.test.ts` com os pares da §7 versionados
- `tests/partition.test.ts` com testes reais de normalização e política
- `tests/invalidation.test.ts` com os casos previstos
- Toolchain: TypeScript ESM, vitest, eslint, npm

### Pendente (Sprint 2)

- `src/partition.ts`: `extractPartition` e `passesEntityGuard` são stubs e lançam
- `src/embed.ts`: integração com voyage-3-lite é stub e lança
- Consequência: `answerWithCache()` ainda não roda ponta a ponta

### Decisões

- Repositório standalone em vez de `packages/semantic-cache/`, porque o módulo é
  reutilizável e nenhum app da casa tem RAG em TypeScript hoje
- npm em vez de pnpm, alinhado ao PregApp
- `client` como campo obrigatório de `answerWithCache`: a RLS resolve o tenant por JWT,
  então o cache precisa do client da request
- Zero dependência de runtime; `@supabase/supabase-js` como peer dependency

### Verificado no dia

- O PregApp, descrito na arquitetura como consumidor primário, não tem RAG: nenhuma
  migration com `vector` ou `embedding`, nenhum SDK de LLM
- O Fonte, único RAG em operação da casa, é Python e usa embeddings de 1536 dimensões,
  contra os 512 previstos aqui
