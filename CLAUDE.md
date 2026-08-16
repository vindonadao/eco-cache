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
| `src/shadow.ts` | 3 | Compara o que teria servido com o que o pipeline respondeu | pronto |
| `src/events.ts` | 4 | Sink que persiste telemetria em `cache_events` | pronto |
| `src/index.ts` | 1 | `answerWithCache()`, o contrato público | pronto |

`answerWithCache()` roda ponta a ponta contra Postgres real desde a rev-0.3.

## Testes

| Arquivo | Cobre |
|---|---|
| `tests/false-positive.test.ts` | **Bloqueante.** Os pares da §7, ativos |
| `tests/partition.test.ts` | Normalização, política, UF, partição, entity tokens, guard |
| `tests/embed.test.ts` | Retry, orçamento de 800 ms, dimensão, ausência de chave |
| `tests/answer-with-cache.test.ts` | Fluxo com client falso: hit, miss, degradação, guard, shadow, bypass |
| `tests/invalidation.test.ts` | **Integração real.** RPC, RLS, ciclo completo, invalidação |
| `tests/support/db.ts` | JWT HS256 por `node:crypto`, clients por tenant, skip condicional |

`embed.test.ts` e `answer-with-cache.test.ts` não estão na lista da §6. Foram criados
porque as duas promessas mais fortes do documento (falha de embedding não derruba o
produto, e o guard tem a palavra final) não podem ficar sem teste.

## Rodando o banco local

```bash
supabase start     # aplica as 4 migrations automaticamente
npm test           # 78 testes, 20 deles contra Postgres
supabase stop
```

O `config.toml` usa portas na faixa **544xx** (API 54421, DB 54422, Studio 54423) porque
a faixa padrão 543xx já estava ocupada por outro projeto Supabase local nesta máquina.
`analytics` está desligado: o container de logs tenta montar o socket do colima e falha.

Sem Docker a suíte não quebra, ela pula: `databaseAvailable()` checa antes e o
`describe.skipIf` faz o resto. Sem banco são 58 testes, com banco 78.

## Migrations

`supabase/migrations/0001` a `0006`, na ordem, idempotentes.

`0001` a `0003` são transcrição literal de `arquitetura.md` §4 e §5. `0004` implementa o
que a §5 descreve em prosa. `0005` (purge da §8) e `0006` (telemetria da §9) traduzem
seções que o documento especifica sem dar o SQL completo.

O agendamento do purge é condicional: `pg_cron` não existe em todo Postgres e no Supabase
gerenciado precisa ser habilitado antes. A migration nunca falha por isso; sem cron, a
função `cache_purge()` fica disponível para chamada manual. No banco local o job é criado
como `eco-cache-purge`, `17 4 * * *`, verificado à mão (o schema `cron` não é exposto pelo
PostgREST, então não há teste automatizado disso).

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

**12. Shadow mode devolve `hitLevel: 'SHADOW'`, não `'MISS'`.** Antes da rev-0.4 o fluxo
em shadow caía no final e emitia `miss`, o que inflaria o miss rate e destruiria a
primeira métrica do dashboard da §9, justamente a que a semana de shadow existe para
medir. Em shadow o cache acertou e foi impedido de servir: conta como hit, com a
divergência registrada à parte.

**13. A comparação do shadow é determinística, sem LLM juiz.** O documento manda comparar
e não diz como. São dois sinais: Jaccard dos tokens da resposta e igualdade das citações.
Citação diferente conta como divergência mesmo com texto parecido, porque significa que a
resposta mudou de base. Um LLM juiz destruiria o propósito do cache, pelo mesmo motivo da
§11. `source_chunk_ids` não entra porque a RPC não os devolve.

**11. `para` e `pra` não são preposições de lugar para efeito de UF.** `fold('pará')`
produz `para`. Se `para` valesse como preposição, "para se cadastrar" viraria Sergipe e
"para me inscrever" viraria Pará. O preço é não detectar "editais para SE", que cai na
partição vazia. É falso negativo, o lado barato da assimetria, e construção verbal com
"para se / para me / para te" é muito mais frequente que essa forma de citar um estado.

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
- [x] Migrations aplicadas num Supabase de teste, `cache_lookup` respondendo
- [x] RLS exercitada com JWT real, incluindo a tentativa de gravar em nome de outro tenant
- [x] Ciclo completo verificado contra Postgres: MISS grava, L0 e L1 servem, bump invalida
- [x] Shadow mode capaz de medir divergência, não só de não servir
- [x] CI bloqueante rodando a suíte, incluindo a de falso positivo
- [x] Purge físico da §8 como migration, com agendamento condicional
- [x] Telemetria persistida e os quatro números da §9 numa view
- [ ] Estreia em shadow mode com métrica de divergência coletada
- [ ] Threshold calibrado com dado, não com o número do documento

**Decisão 16/08/2026: o Eco é portfólio técnico por ora**, sem consumidor em produção.
Os dois itens abertos acima dependem de uma estreia, e nenhum projeto da casa tem RAG em
TypeScript. O que dependia só de código está fechado.

## Limitações conhecidas

- **Município não é extraído.** A §3A diz "UF / município". As 27 UFs estão
  dicionarizadas; os 5.570 municípios não. Duas perguntas sobre cidades diferentes do
  mesmo estado caem na mesma partição e dependem só do embedding para se separar. Se
  algum consumidor for por cidade, isso vira falso positivo e precisa de solução antes.
- **Siglas ambíguas exigem preposição estrita.** "editais em SE" é detectado, "editais
  para SE" não. Ver decisão 11.
- **O threshold de 0,94 é o do documento, não medido.** Só sai do lugar depois da semana
  de shadow mode.
- **A API da Voyage nunca foi chamada de verdade.** `embed()` sempre rodou contra `fetch`
  falso. A forma da resposta veio da documentação, não de uma chamada observada.
- **Sem `pg_cron` configurado.** O purge físico da §8 está escrito no documento e não
  existe como job.

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
