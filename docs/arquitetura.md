# arquitetura.md — Semantic Cache Layer para RAG

**Módulo:** `@donadao/semantic-cache`
**Owner:** Donadão Labs
**Status:** especificação pronta para execução
**Consumidor primário:** Editais monitor (Next.js 15 + Supabase/pgvector + LangChain + Claude Sonnet)
**Natureza:** módulo reutilizável — qualquer projeto Donadão com RAG pluga sem reescrever

> **Nota de adaptação (rev-0.1).** Este documento é reproduzido integralmente como fonte
> da verdade. Dois pontos foram adaptados na materialização em repositório e estão
> registrados no `CLAUDE.md`: (1) o módulo virou repositório standalone `eco-cache` /
> pacote `@donadao/eco`, então `packages/semantic-cache/src/` lê-se `src/`;
> (2) o gerenciador é **npm**, não pnpm. Nenhuma tabela, coluna, threshold ou regra
> foi alterada.

---

## 0. Instrução para o Claude Code (leia antes de codar)

1. Este documento é a fonte da verdade. Não invente tabela, coluna ou threshold fora do que está aqui.
2. O módulo é **um pacote isolado** em `packages/semantic-cache/`, não código espalhado no app. O app consome uma função: `answerWithCache()`.
3. Toda variável de ambiente vive num único objeto `CACHE_CONFIG` exportado de `packages/semantic-cache/src/config.ts`. Nada de `process.env` espalhado.
4. Rode as migrations na ordem numérica. Cada migration é idempotente (`if not exists`).
5. Antes de abrir PR: `pnpm typecheck && pnpm test` — os testes de falso positivo (§7) são bloqueantes, não opcionais.

---

## 1. O problema que este módulo resolve

Todo RAG em produção tem a mesma curva: 30–50% das perguntas são repetições ou quase-repetições. Cada uma delas paga o ciclo completo — embedding da query, busca vetorial no corpus, montagem de contexto de 6–10k tokens, chamada ao LLM, geração de 500–1000 tokens de saída. Custo total por pergunta: ~US$ 0,036. Latência: 3–6 s.

A resposta já existe. Ela foi gerada ontem, para uma pergunta escrita com outras palavras.

O Semantic Cache intercepta antes do pipeline caro: se a pergunta que chega é semanticamente equivalente a uma já respondida — e a base não mudou — serve a resposta armazenada.

**Ganho medido no desenho:**

| Métrica | Sem cache | Com cache (hit) |
|---|---|---|
| Custo por query | ~US$ 0,036 | ~US$ 0,000004 |
| Latência p50 | 3.400 ms | 90 ms |
| Latência p50 (hit exato, L0) | — | 12 ms |
| Chamadas ao Sonnet | 100% | 55–65% |

A 100k queries/mês com 40% de hit rate: **~US$ 1.440/mês de economia direta** e 40 mil interações que respondem instantaneamente. O ganho de percepção de produto é maior que o financeiro.

---

## 2. Decisão de arquitetura: cache em 3 níveis

Não existe "um cache". Existem três, em cascata, e cada nível só é consultado se o anterior falhar.

```
query do usuário
   │
   ├─ L0 · HASH EXATO ──────────────► hit → resposta (12 ms, custo zero)
   │   sha256(query normalizada + partition_key)
   │   lookup por índice B-tree. Sem rede. Sem embedding.
   │
   ├─ L1 · SEMÂNTICO ───────────────► hit → resposta (90 ms, custo ~US$ 0,000004)
   │   embedding da query (voyage-3-lite, 512d)
   │   busca HNSW em rag_cache DENTRO da mesma partition_key
   │   similaridade ≥ 0.94 E guard de entidades passa
   │
   └─ L2 · RAG COMPLETO ────────────► gera, responde, GRAVA em L0+L1
       retrieval no corpus → contexto → Claude Sonnet
```

**Por que L0 existe separado do L1:** metade dos "quase-repetidos" são repetidos literais — o usuário reformula pouco, ou é a mesma pessoa voltando. Resolver isso com uma chamada de embedding é pagar rede e dinheiro por algo que um índice B-tree faz de graça. L0 não é otimização prematura, é o caso mais frequente.

---

## 3. O risco que mata cache semântico (e como matamos ele)

Esta seção é a mais importante do documento. Cache semântico mal feito não fica lento — ele **mente**.

Considere:

- `"editais de tecnologia abertos em São Paulo"`
- `"editais de tecnologia abertos no Rio Grande do Sul"`

Cosseno entre as duas: **~0.96**. Acima de qualquer threshold razoável. O embedding achata o nome do estado porque a estrutura semântica das frases é idêntica. Um cache ingênuo entrega editais de SP para quem perguntou do RS, com confiança total, e ninguém percebe até o cliente perder um prazo.

O mesmo vale para números (`acima de R$ 100 mil` vs `acima de R$ 500 mil`), datas, CNPJ, CNAE, nomes próprios.

### Solução em duas camadas

**A) Partition key determinística (pré-filtro rígido)**

Antes de qualquer embedding, um parser determinístico — regex + dicionário, **sem LLM** — extrai da query os campos que não podem ser interpolados:

- UF / município (dicionário de 27 UFs + variações)
- códigos CNAE (`\d{4}-?\d?/?\d{2}`)
- valores monetários e limiares numéricos
- intervalos de data e termos de recência (`hoje`, `esta semana`, `últimos 30 dias`)
- identificadores (CNPJ, número de edital, protocolo)

Esses campos, normalizados e ordenados, viram `partition_key = sha256(json canônico)`. **A busca vetorial só acontece dentro da mesma partition_key.** SP e RS caem em partições diferentes e nunca se encontram — não importa que o cosseno seja 0.99.

Custo do parser: microssegundos. Zero chamada externa. Se um dia precisar de extração mais rica, é um modelo Haiku *offline*, nunca no caminho quente.

**B) Entity guard (pós-filtro)**

Mesmo dentro da partição, antes de servir um hit L1, comparamos os tokens "duros" da query nova com os da query cacheada: números, siglas em caixa alta, entidades nomeadas. **Divergiu qualquer um → rejeita o hit** e cai para L2, independente da similaridade.

Custo de um falso positivo: resposta errada entregue com confiança.
Custo de um falso negativo: uma chamada de LLM.
A assimetria é brutal. O módulo é deliberadamente conservador.

### Recência: o que nunca entra no cache

Query classificada com marcador temporal (`hoje`, `agora`, `esta semana`, `último`, `mais recente`) recebe `ttl_seconds` curto ou `cacheable = false`. Regra em `src/policy.ts`, tabelada por classe de query — não espalhada em `if`s.

---

## 4. Schema

### Migration `0001_semantic_cache.sql`

```sql
create extension if not exists vector;
create extension if not exists pg_trgm;

create table if not exists rag_cache (
  id                uuid primary key default gen_random_uuid(),

  -- chaves de lookup
  tenant_id         uuid not null,
  partition_key     text not null,              -- sha256 dos filtros duros extraídos
  query_hash        text not null,              -- sha256(query normalizada + partition_key) → L0
  query_text        text not null,              -- query original, para auditoria
  query_normalized  text not null,
  query_embedding   vector(512) not null,       -- voyage-3-lite

  -- payload
  answer_text       text not null,
  answer_citations  jsonb not null default '[]'::jsonb,
  source_chunk_ids  uuid[] not null default '{}',
  model             text not null,
  entity_tokens     text[] not null default '{}', -- guard de §3B

  -- controle de validade
  corpus_version    bigint not null,
  expires_at        timestamptz not null,

  -- telemetria
  hit_count         int not null default 0,
  last_hit_at       timestamptz,
  created_at        timestamptz not null default now(),

  constraint rag_cache_uniq unique (tenant_id, query_hash)
);

-- L0: lookup exato
create index if not exists rag_cache_l0_idx
  on rag_cache (tenant_id, query_hash);

-- L1: busca vetorial, sempre pré-filtrada por tenant + partição
create index if not exists rag_cache_partition_idx
  on rag_cache (tenant_id, partition_key);

create index if not exists rag_cache_hnsw_idx
  on rag_cache using hnsw (query_embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create index if not exists rag_cache_expiry_idx
  on rag_cache (expires_at);

-- versão global do corpus por tenant
create table if not exists corpus_state (
  tenant_id       uuid primary key,
  corpus_version  bigint not null default 1,
  updated_at      timestamptz not null default now()
);
```

**Nota sobre o índice HNSW:** com filtro por `partition_key`, o Postgres pode escolher o índice B-tree e descartar o HNSW quando a partição é pequena — e está certo em fazer isso. Não force com hints. Em partições grandes (>10k entradas) o HNSW entra. Ajuste `set local hnsw.ef_search = 40;` dentro da função de lookup.

### Migration `0002_rls.sql`

```sql
alter table rag_cache enable row level security;
alter table corpus_state enable row level security;

create policy rag_cache_tenant_isolation on rag_cache
  for all
  using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  with check (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

create policy corpus_state_tenant_isolation on corpus_state
  for all
  using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
```

**Regra não negociável:** `tenant_id` faz parte da chave de lookup *e* da RLS. Cache é o vetor de vazamento cross-tenant mais fácil de introduzir e mais difícil de detectar em code review. Redundância aqui é intencional.

Corpus público (editais federais, por exemplo) usa um `tenant_id` sentinela `00000000-0000-0000-0000-000000000000` com policy de leitura aberta. Consulta em corpus público lê das duas partições; consulta em corpus privado, só da própria.

---

## 5. RPC de lookup (uma ida ao banco, não três)

`0003_fn_cache_lookup.sql`:

```sql
create or replace function cache_lookup(
  p_tenant_id      uuid,
  p_query_hash     text,
  p_partition_key  text,
  p_embedding      vector(512),
  p_corpus_version bigint,
  p_threshold      float default 0.94
)
returns table (
  hit_level     text,
  id            uuid,
  answer_text   text,
  answer_citations jsonb,
  entity_tokens text[],
  similarity    float
)
language plpgsql
security invoker
as $$
begin
  set local hnsw.ef_search = 40;

  -- L0
  return query
  select 'L0'::text, c.id, c.answer_text, c.answer_citations, c.entity_tokens, 1.0::float
  from rag_cache c
  where c.tenant_id = p_tenant_id
    and c.query_hash = p_query_hash
    and c.corpus_version = p_corpus_version
    and c.expires_at > now()
  limit 1;

  if found then return; end if;

  -- L1
  return query
  select 'L1'::text, c.id, c.answer_text, c.answer_citations, c.entity_tokens,
         1 - (c.query_embedding <=> p_embedding) as similarity
  from rag_cache c
  where c.tenant_id = p_tenant_id
    and c.partition_key = p_partition_key
    and c.corpus_version = p_corpus_version
    and c.expires_at > now()
    and 1 - (c.query_embedding <=> p_embedding) >= p_threshold
  order by c.query_embedding <=> p_embedding
  limit 1;
end;
$$;
```

`0004_fn_cache_touch.sql` — incremento de `hit_count`/`last_hit_at` em chamada separada, `void`, disparada sem `await`. Nunca segure a resposta do usuário para escrever telemetria.

---

## 6. Módulo TypeScript

```
packages/semantic-cache/
├── src/
│   ├── config.ts          # CACHE_CONFIG — único ponto de env
│   ├── normalize.ts       # NFKC, lowercase, colapso de espaço, strip de pontuação final
│   ├── partition.ts       # extração determinística → partition_key + entity_tokens
│   ├── policy.ts          # classe de query → { cacheable, ttl, threshold }
│   ├── embed.ts           # voyage-3-lite, com retry e timeout de 800 ms
│   ├── lookup.ts          # chama a RPC, aplica entity guard
│   ├── store.ts           # grava resultado do L2
│   ├── invalidate.ts      # bump de corpus_version + purge seletivo
│   ├── metrics.ts         # emissão de eventos
│   └── index.ts           # answerWithCache()
└── tests/
    ├── false-positive.test.ts   # BLOQUEANTE
    ├── partition.test.ts
    └── invalidation.test.ts
```

### `config.ts`

```ts
export const CACHE_CONFIG = {
  enabled:            process.env.CACHE_ENABLED !== 'false',
  embeddingModel:     'voyage-3-lite',
  embeddingDims:      512,
  embeddingTimeoutMs: 800,
  defaultThreshold:   0.94,
  defaultTtlSeconds:  60 * 60 * 24 * 7,
  volatileTtlSeconds: 60 * 15,
  shadowMode:         process.env.CACHE_SHADOW_MODE === 'true',
  publicTenantId:     '00000000-0000-0000-0000-000000000000',
} as const;
```

### `index.ts` — contrato público

```ts
export async function answerWithCache(input: {
  tenantId: string;
  query: string;
  runRag: () => Promise<RagResult>;   // o pipeline caro, injetado
}): Promise<CachedAnswer> {
  const { tenantId, query, runRag } = input;

  if (!CACHE_CONFIG.enabled) return toCached(await runRag(), 'BYPASS');

  const normalized = normalize(query);
  const { partitionKey, entityTokens } = extractPartition(normalized);
  const policy = classify(normalized);

  if (!policy.cacheable) return toCached(await runRag(), 'SKIP');

  const corpusVersion = await getCorpusVersion(tenantId);
  const queryHash = sha256(`${normalized}::${partitionKey}`);

  // L0 sem embedding: tenta primeiro com vetor nulo evitado pela ordem da RPC
  let embedding: number[] | null = null;
  try {
    embedding = await embed(normalized);        // timeout curto
  } catch {
    embedding = null;                            // degrada para L0-only, nunca quebra
  }

  const hit = embedding
    ? await lookup({ tenantId, queryHash, partitionKey, embedding, corpusVersion, threshold: policy.threshold })
    : await lookupExact({ tenantId, queryHash, corpusVersion });

  if (hit && passesEntityGuard(entityTokens, hit.entityTokens)) {
    void touch(hit.id);
    metrics.emit({ level: hit.hitLevel, similarity: hit.similarity });

    if (CACHE_CONFIG.shadowMode) {
      void compareInBackground(hit, runRag);     // valida sem servir
    } else {
      return { ...hit, cached: true };
    }
  }

  const fresh = await runRag();
  void store({ tenantId, query, normalized, queryHash, partitionKey,
               entityTokens, embedding, corpusVersion, ttl: policy.ttl, result: fresh });
  return toCached(fresh, 'MISS');
}
```

**Três decisões embutidas aí que valem explicitar:**

- **Falha de embedding não derruba o produto.** Timeout de 800 ms → degrada para L0 → no pior caso, roda o RAG completo. O cache é sempre opcional no caminho crítico.
- **A gravação não bloqueia.** `void store(...)`. O usuário já recebeu a resposta.
- **`runRag` é injetado.** O módulo não conhece LangChain, não conhece o corpus, não conhece o prompt. Isso é o que o torna reutilizável entre Editais monitor, miramaC e o que vier.

---

## 7. Testes bloqueantes de falso positivo

`tests/false-positive.test.ts` — pares que **devem** cair em partições distintas ou ser rejeitados pelo guard:

| Query A | Query B | Motivo |
|---|---|---|
| editais de TI em São Paulo | editais de TI no Rio Grande do Sul | UF |
| editais acima de R$ 100 mil | editais acima de R$ 500 mil | limiar numérico |
| CNAE 6201-5/01 | CNAE 6202-3/00 | código |
| editais abertos hoje | editais abertos em janeiro | recência |
| prazo do edital 042/2025 | prazo do edital 043/2025 | identificador |

E pares que **devem** dar hit:

| Query A | Query B |
|---|---|
| quais editais de TI estão abertos em SP? | tem edital de tecnologia aberto em São Paulo? |
| como faço pra me cadastrar? | qual o processo de cadastro? |

Estes testes rodam no CI. PR que quebra um deles não passa.

---

## 8. Invalidação

**Global (padrão).** Reindexação do corpus → `corpus_version += 1` no `corpus_state`. Todas as entradas com versão antiga param de dar match instantaneamente. Zero delete, zero lock. Purge físico depois, por cron.

**Seletiva (opcional, fase 2).** Quando só alguns documentos mudam, invalida por `source_chunk_ids && $1`:

```sql
delete from rag_cache
where tenant_id = $1 and source_chunk_ids && $2::uuid[];
```

**Cron (`pg_cron`, diário):**
```sql
delete from rag_cache
where expires_at < now() - interval '7 days'
   or corpus_version < (select corpus_version from corpus_state s where s.tenant_id = rag_cache.tenant_id) - 2;
```

Comece com global. Invalidação seletiva só se a reindexação for incremental e frequente o bastante para o hit rate despencar — meça antes de construir.

---

## 9. Observabilidade

Tabela `cache_events` (append-only) ou envio direto pro Helicone/LangSmith. Eventos: `hit_l0`, `hit_l1`, `miss`, `guard_reject`, `embed_fail`, `shadow_mismatch`.

Dashboard mínimo — quatro números, nada além disso:

1. **Hit rate por nível** (L0 / L1 / miss). Alvo em regime: 35–50% combinado.
2. **Custo evitado** = hits × custo médio da chamada L2.
3. **Latência p50/p95 por nível.**
4. **Guard reject rate.** Se subir muito acima de 5%, o threshold está frouxo ou a partição está mal desenhada.

**Shadow mode obrigatório na primeira semana.** `CACHE_SHADOW_MODE=true`: o cache consulta, registra o que teria servido, mas **não serve** — roda o RAG e compara. Só depois de ver a taxa de divergência real é que o threshold vai pra produção. Calibrar threshold no olho é como se descobre, três meses depois, que 4% das respostas estavam erradas.

---

## 10. Plano de execução

**Sprint 1 — fundação (≈14 h)**
Migrations 0001–0004. Módulo com L0 apenas (hash exato, sem embedding). Métricas básicas. Já entrega valor: hit rate de repetição literal costuma ser 15–20%.

**Sprint 2 — semântico + guards (≈20 h)**
`partition.ts`, `embed.ts`, L1 completo, entity guard, suíte de falso positivo. Deploy em shadow mode.

**Sprint 3 — calibração e corte (≈8 h)**
Análise de uma semana de shadow. Threshold definitivo por classe de query. Ativação progressiva: 10% → 50% → 100% do tráfego.

**Sprint 4 — invalidação e limpeza (≈8 h)**
Bump de versão no pipeline de reindex, `pg_cron`, dashboard.

**Total: ~50 h.** Payback com o volume projetado do Editais monitor: menos de dois meses de operação.

---

## 11. O que este módulo NÃO faz (e por quê)

- **Não usa Redis.** O Postgres do Supabase já tem pgvector, já tem os dados, já tem RLS. Adicionar Redis significa segundo datastore, segunda política de consistência, segundo ponto de falha e um vazamento cross-tenant a mais para auditar. Se um dia o `cache_lookup` virar gargalo mensurável — e ele não vai antes de dezenas de milhares de queries por minuto — a discussão se reabre com dado na mão.
- **Não cacheia resposta personalizada.** Se o prompt inclui dados da conta do usuário, `cacheable = false`. Sem exceção.
- **Não usa LLM para decidir hit.** Chamar um modelo para julgar se duas perguntas são equivalentes destrói o único motivo de o cache existir.
- **Não cacheia streaming parcial.** Grava só resposta completa. Hit serve o texto inteiro de uma vez — o que, aliás, é uma UX melhor que o streaming.

---

## 12. Forks que dependem de você, Vinicius

1. **Modelo de embedding.** O default é `voyage-3-lite` (512d, US$ 0,02/1M). Se o Editais monitor já indexa o corpus com outro modelo, alinhe os dois para manter uma pipeline só — me diga qual e eu ajusto as dimensões no schema.
2. **Escopo do corpus público.** Editais federais são iguais para todos os clientes — cache compartilhado no tenant sentinela multiplica o hit rate. Confirma que não há regra contratual que impeça compartilhar resposta gerada entre contas.
3. **Onde estreia.** O desenho está calibrado para o Editais monitor. Se preferir estrear num projeto de menor risco antes, o módulo é agnóstico — só troca o `runRag` injetado.
