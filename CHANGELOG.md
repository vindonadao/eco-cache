# Changelog

Todas as mudanças relevantes do Eco. Versionamento por revisões (`rev-X.Y`).

## rev-0.2 — 15/08/2026

Sprint 2. O módulo passa a rodar ponta a ponta.

### Adicionado

- `src/uf.ts`: dicionário das 27 UFs com canonização sigla ↔ nome por extenso, casamento
  do alias mais longo primeiro e desambiguação das siglas que também são palavra comum
- `src/partition.ts`: `extractPartition` extrai CNPJ, data, valor monetário, CNAE,
  identificador, recência, mês, ano e UF em ordem, cada extrator consumindo o trecho que
  casou; `passesEntityGuard` compara os tokens duros residuais
- `src/embed.ts`: voyage-3-lite por `fetch`, orçamento total de 800 ms com retry dentro
  do deadline, retry só em 429, 5xx, timeout e erro de rede, e validação da dimensão do
  vetor antes de devolver
- `EMBEDDING_ENDPOINT` no `config.ts`, para teste e para proxy interno
- `tests/embed.test.ts` e `tests/answer-with-cache.test.ts`
- Suíte de falso positivo ativada: os pares da §7 saíram de `todo` e são teste real

### Verificado

- Os cinco pares que não podem se encontrar caem em partições distintas pelo campo duro
  correto, não por acidente: UF, valor, CNAE, recência e identificador
- Os dois pares que devem casar compartilham partição: "SP" e "São Paulo" canonizam para
  a mesma chave, e query sem campo duro cai na partição vazia estável
- "se você tem interesse" não vira Sergipe; "Mato Grosso do Sul" não colide com "Mato Grosso"
- Falha de embedding degrada para L0 e o produto continua respondendo
- 55 testes passando, 7 `todo` (invalidação, que precisa de banco)

### Decisões

- Entity token é só o que contém dígito. A §3B pede sigla em caixa alta, mas a §7 exige
  que "TI" case com "tecnologia". A tabela bloqueante vence, e a partição já cobre o resto
- Siglas de UF ambíguas exigem preposição de lugar antes
- Os 800 ms do `embed` são orçamento total, não por tentativa

### Limitação registrada

- Município não é extraído, só UF. Perguntas sobre cidades diferentes do mesmo estado
  caem na mesma partição

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
