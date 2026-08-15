# CLAUDE.md — Eco (`eco-cache`)

Contexto canônico do projeto para o Claude Code. Leia antes de mexer.

## O que é

**Eco** — camada de cache semântico para RAG. Intercepta a pergunta antes do pipeline
caro: se ela é semanticamente equivalente a uma já respondida e o corpus não mudou,
serve a resposta armazenada. Se houver qualquer dúvida, não serve.

Produto da Donadão Labs · slug `eco-cache` · pacote `@donadao/eco` · repo público.

**Natureza: módulo reutilizável.** Não pertence a nenhum app. Qualquer projeto Donadão
com RAG pluga injetando o próprio `runRag`. O Eco não conhece LangChain, não conhece o
corpus, não conhece o prompt.

## Fonte da verdade

[`docs/arquitetura.md`](docs/arquitetura.md). **Não invente tabela, coluna ou threshold
fora do que está lá.** Toda decisão de schema, política e nível de cache vem daquele
documento. Se algo precisa mudar, muda lá primeiro.

## Stack

TypeScript (ESM, NodeNext) · Node 20+ · Supabase/Postgres com pgvector ·
voyage-3-lite (512d) para embedding · vitest · **npm** (não pnpm).

Zero dependência de runtime. `sha256` vem de `node:crypto`, a API de embedding é
chamada com `fetch` nativo, e `@supabase/supabase-js` é **peer dependency**: quem
consome já tem.

## Mapa do código

| Arquivo | Sprint | Papel | Estado |
|---|---|---|---|
| `src/config.ts` | 1 | `CACHE_CONFIG`, único ponto de env do módulo | pronto |
| `src/types.ts` | 1 | Tipos compartilhados | pronto |
| `src/normalize.ts` | 1 | NFKC, caixa, espaço, pontuação final + `sha256` | pronto |
| `src/policy.ts` | 1 | Classe de query → `{ cacheable, ttl, threshold }` | recência pronta |
| `src/metrics.ts` | 1 | Emissão de eventos, sink plugável | pronto |
| `src/lookup.ts` | 1 | RPC `cache_lookup`, `lookupExact` (L0), `touch`, versão do corpus | pronto |
| `src/store.ts` | 1 | Grava o resultado do L2 | pronto |
| `src/invalidate.ts` | 4 | Bump de `corpus_version` + purge seletivo | pronto |
| `src/uf.ts` | 2 | Dicionário das 27 UFs, canonização sigla ↔ nome | pronto |
| `src/partition.ts` | 2 | `extractPartition` + `passesEntityGuard` | pronto |
| `src/embed.ts` | 2 | voyage-3-lite, orçamento de 800 ms com retry dentro | pronto |
| `src/index.ts` | 1 | `answerWithCache()`, o contrato público | pronto |

`answerWithCache()` roda ponta a ponta desde a rev-0.2. Nunca foi exercitado contra
Postgres real: os testes usam client e `fetch` falsos. Aplicar as migrations num Supabase
de teste é o próximo passo antes de qualquer estreia.

## Testes

| Arquivo | Cobre |
|---|---|
| `tests/false-positive.test.ts` | **Bloqueante.** Os pares da §7, ativos |
| `tests/partition.test.ts` | Normalização, política, UF, partição, entity tokens, guard |
| `tests/embed.test.ts` | Retry, orçamento de 800 ms, dimensão, ausência de chave |
| `tests/answer-with-cache.test.ts` | Fluxo completo: hit, miss, degradação, guard, shadow, bypass |
| `tests/invalidation.test.ts` | `todo`: precisa de banco, é Sprint 4 |

`embed.test.ts` e `answer-with-cache.test.ts` não estão na lista da §6. Foram criados
porque as duas promessas mais fortes do documento (falha de embedding não derruba o
produto, e o guard tem a palavra final) não podem ficar sem teste.

## Migrations

`supabase/migrations/0001` a `0004`, na ordem, idempotentes. Transcrição literal de
`arquitetura.md` §4 e §5, exceto `0004_fn_cache_touch.sql`, cujo corpo o documento
descreve em prosa (incremento de `hit_count`/`last_hit_at`, retorno `void`).

## Decisões que valem registrar

**1. Repo standalone, não `packages/semantic-cache/`.** O documento presume um monorepo.
O módulo nasceu fora de qualquer app porque nenhum app da casa tem RAG em TypeScript
hoje (ver "Realidade dos consumidores"). Consumo por
`npm i github:vindonadao/eco-cache`, ou como workspace quando o app quiser fixar versão.

**2. npm, não pnpm.** O documento pede `pnpm typecheck && pnpm test`. O PregApp, o
consumidor mais próximo, usa npm workspaces. Padronizado em npm para não ter dois
gerenciadores na casa.

**3. `client` é o 4º campo de `answerWithCache`.** O documento define o input com três
campos e não diz como o módulo obtém conexão. Ele **tem** que receber o client da
request: a RLS resolve `tenant_id` por `auth.jwt() ->> 'tenant_id'`, então um singleton
dentro do pacote leria o tenant errado. Isso seria exatamente o vazamento cross-tenant
que a §4 chama de mais difícil de detectar em code review.

**4. `src/types.ts` é o único arquivo fora da lista da §6.** Existe para quebrar o ciclo
de import entre `index.ts` e os módulos que ele orquestra. Não carrega regra de negócio.

**5. `store()` não grava sem embedding.** `query_embedding` é `not null` no schema. Quando
`embed()` falha, o L2 responde e nada entra no cache. Gravar meia-entrada quebraria o L1
depois.

**6. Marcadores de recência usam lookaround `\p{L}`, não `\b`.** `\b` é ASCII: `\búltimo\b`
nunca casaria. Em português isso é rotina, não exceção.

**7. Entity token é só o que tem dígito.** A §3B fala em "números, siglas em caixa alta,
entidades nomeadas", mas a §7 exige que *"editais de TI em SP"* dê hit com *"edital de
tecnologia em São Paulo"*. Se sigla alfabética virasse token duro, esse par nunca casaria,
porque "TI" não tem par em "tecnologia". As duas regras do documento se contradizem, e a
tabela bloqueante vence. Estado, código e valor já são capturados pela partição, que é a
rede de verdade; o guard cuida do número que escapou dela. Além disso `extractPartition`
recebe a query já normalizada, ou seja, minúscula: "caixa alta" nem chega até ele.

**8. Siglas de UF ambíguas exigem preposição de lugar.** `se`, `to`, `ma`, `pa`, `go`,
`ac`, `al` e `am` são palavras correntes em português. Sem isso, *"se você tem
interesse"* viraria Sergipe e mandaria a query para uma partição errada.

**9. Ordem dos extratores é semântica, não estética.** CNPJ antes de data, data antes de
identificador, valor antes de CNAE. Cada extrator consome o trecho que casou. Trocar a
ordem faz `15/08/2026` virar edital e `R$ 1.000.000` virar código CNAE.

**10. Os 800 ms do `embed` são orçamento total, não por tentativa.** O documento pede
"retry e timeout de 800 ms". Duas tentativas de 800 ms dariam 1,6 s num caminho que
promete 90 ms, então o retry só acontece se sobrar tempo no deadline.

## Realidade dos consumidores (verificado em 15/08/2026)

- **PregApp (o "Editais monitor" do documento) não tem RAG.** Migrations `0001` a `0006`,
  nenhuma linha de `vector` ou `embedding`; sem LangChain, sem SDK de LLM. O documento o
  descreve como "Next.js 15 + Supabase/pgvector + LangChain + Claude Sonnet", o que
  descreve um estado futuro, não o repo de hoje. **O Eco não tem o que cachear lá ainda.**
- **O único RAG em operação da casa é o [Fonte](https://github.com/vindonadao/fonte-rag),
  e ele é Python** (FastAPI + LangChain + pgvector, `text-embedding-3-small`, 1536d).
  Para o Fonte consumir o Eco: ou expõe o cache por HTTP, ou existe um port Python. As
  dimensões também não batem com os 512d do voyage-3-lite.
- **miramac** contém apenas uma pasta `supabase` vazia.

## Regras do projeto

- **`.env` nunca commitado.** Só `.env.example`.
- **A suíte de falso positivo é bloqueante.** `tests/false-positive.test.ts` guarda os
  pares da §7 como `it.todo` até o Sprint 2. Ao implementar `extractPartition`, troque
  `it.todo` por `it`. **Não reescreva a tabela de pares.**
- **Shadow mode antes de servir.** Nenhuma estreia serve resposta de cache na primeira
  semana. `CACHE_SHADOW_MODE=true`, mede divergência, só então calibra o threshold.
- **Falso negativo é barato, falso positivo não.** Na dúvida entre servir e não servir,
  não sirva. O custo de errar é uma resposta errada entregue com confiança.
- **Nada de LLM no caminho quente.** Nem para extrair partição, nem para julgar hit.

## Definition of Done (rev-1.0)

- [x] `extractPartition` separa UF, CNAE, limiar monetário, recência e identificador
- [x] `passesEntityGuard` rejeita divergência numérica
- [x] `embed` com orçamento de 800 ms e degradação para L0 quando falha
- [x] Todos os pares da §7 rodando como teste real, verdes
- [x] `npm run lint && npm run typecheck && npm test` limpos
- [ ] Migrations aplicadas num Supabase de teste, `cache_lookup` respondendo
- [ ] Estreia em shadow mode com métrica de divergência coletada

## Limitações conhecidas

- **Município não é extraído.** A §3A diz "UF / município". As 27 UFs estão
  dicionarizadas; os 5.570 municípios não. Duas perguntas sobre cidades diferentes do
  mesmo estado caem na mesma partição e dependem só do embedding para se separar. Se
  algum consumidor for por cidade, isso vira falso positivo e precisa de solução antes.
- **Nenhum teste tocou Postgres.** Client e `fetch` são falsos. As migrations, a RPC e a
  RLS estão escritas mas não executadas.
- **O threshold de 0,94 é o do documento, não medido.** Só sai do lugar depois da semana
  de shadow mode.

## Forks abertos (arquitetura.md §12)

1. **Modelo de embedding.** Default `voyage-3-lite` (512d). O Fonte usa
   `text-embedding-3-small` (1536d). Uma pipeline só exige escolher um, e a escolha muda
   `vector(512)` no schema.
2. **Corpus público.** O tenant sentinela `00000000-...-0000` compartilha resposta gerada
   entre contas. Falta confirmar que nenhum contrato impede isso.
3. **Onde estreia.** O desenho foi calibrado para o PregApp, que ainda não tem RAG.
4. **Resposta personalizada** (§11: `cacheable = false`, sem exceção). O sinal vem do
   prompt do consumidor, não da query, então onde ele entra no contrato está em aberto.
   Ver nota no fim de `src/policy.ts`.
