# Changelog

Todas as mudanças relevantes do Eco. Versionamento por revisões (`rev-X.Y`).

## rev-0.4 — 16/08/2026

Fecha tudo que dependia só de código. O que resta precisa de uma estreia real.

### Corrigido

- **Shadow mode contava acerto como `miss`.** O fluxo caía no final e emitia `miss`,
  inflando exatamente a primeira métrica do dashboard da §9, que é a razão de a semana de
  shadow existir. Agora o hit é contabilizado como hit e a resposta volta com
  `hitLevel: 'SHADOW'`
- **Shadow mode não comparava nada.** O evento `shadow_mismatch` estava declarado no tipo
  e nunca era emitido, então uma semana inteira de shadow produziria zero informação e o
  threshold acabaria calibrado no olho
- Em shadow, o módulo não regrava a entrada que acabou de servir como hit

### Adicionado

- `src/shadow.ts`: comparação determinística entre o que o cache teria servido e o que o
  pipeline respondeu, por Jaccard de tokens e igualdade de citações. Sem LLM juiz, pelo
  mesmo motivo da §11. Citação diferente conta como divergência mesmo com texto parecido
- `CACHE_SHADOW_MISMATCH_FLOOR` (default 0.9). Não é threshold de cache: nada é servido ou
  recusado por causa dele, e o evento carrega o número medido para reanálise com outro corte
- **CI no GitHub Actions**, que a §7 promete desde sempre. Dois jobs: o portão bloqueante
  (lint, typecheck, build, testes) sem depender de Docker, e a integração com Supabase.
  O job de integração falha se detectar teste pulado, senão passaria sem testar nada
- `0005_cache_purge.sql`: função `cache_purge()` e agendamento diário condicional em
  `pg_cron`. A migration nunca falha por ausência da extensão; sem cron, a função fica
  disponível para chamada manual
- `0006_cache_events.sql`: tabela append-only com RLS por tenant e a view
  `cache_metrics_daily` com os quatro números da §9, em `security_invoker`
- `src/events.ts`: sink opcional que persiste a telemetria. Quem preferir Helicone ou
  LangSmith continua registrando o próprio destino

### Verificado

- `cache_purge()` remove expirada de 8 dias e versão de corpus muito atrás, e preserva a
  expirada ontem e a viva. É idempotente
- Job `eco-cache-purge` agendado (`17 4 * * *`), conferido à mão no banco. Sem teste
  automatizado: o schema `cron` não é exposto pelo PostgREST, e criar função só para
  espiá-lo seria superfície nova em produção por causa de teste
- A view calcula hit rate e guard reject rate corretamente, e a RLS de `cache_events` isola
- 86 testes com banco, 58 sem

### Decisão

- **O Eco é portfólio técnico por ora**, sem consumidor em produção. Os dois itens abertos
  do DoD dependem de uma estreia, e nenhum projeto da casa tem RAG em TypeScript hoje

## rev-0.3 — 16/08/2026

O schema deixou de ser texto. Primeira execução contra Postgres real.

### Corrigido

- **`fold('pará')` produz `'para'`**, a preposição mais comum do português, e o extrator
  de UF tratava toda pergunta com "para" como pergunta sobre o estado do Pará. "Como faço
  para me cadastrar" ia para uma partição do PA e nunca casava com sua própria
  reformulação. `para` e `pra` saíram da lista de preposições de lugar e `para` entrou na
  lista de termos que exigem preposição antes. Só apareceu no ciclo completo contra banco;
  nenhum teste unitário pegaria isso, porque o par da §7 usa "SP" e "São Paulo"

### Adicionado

- `tests/support/db.ts`: JWT HS256 assinado com `node:crypto`, clients por tenant e por
  serviço, vetor determinístico e detecção de banco disponível
- `tests/invalidation.test.ts` reescrito como integração real, 20 casos: RPC nos dois
  níveis, expiração, isolamento de partição, invalidação global e seletiva, RLS de leitura
  e de escrita, e o ciclo completo (MISS grava, L0 serve, L1 serve, `cache_touch` conta,
  bump invalida)
- Regressão do "para" travada em `tests/partition.test.ts`
- Stack Supabase local: `supabase/config.toml` com portas 544xx

### Verificado contra Postgres

- As quatro migrations aplicam limpas e são idempotentes
- `cache_lookup` responde L0 por hash e L1 por vizinhança, e não atravessa partição
- RLS devolve 42501 na tentativa de gravar em nome de outro tenant, e deixa passar a
  gravação legítima. Sem checar o código do erro, o teste passaria por motivo errado
- Dois tenants com o mesmo `query_hash` na mesma partição não se enxergam
- 78 testes com banco, 58 sem. Sem Docker a suíte pula em vez de falhar

### Notas de ambiente

- Portas realocadas para a faixa 544xx: a 54322 estava ocupada por outro Supabase local
- `analytics` desligado no `config.toml`: o container de logs tenta montar o socket do
  colima e derruba o start

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
