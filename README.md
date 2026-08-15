# Eco

Camada de cache semântico para RAG. Responde o que já foi respondido, sem misturar o que
não pode ser misturado.

[![status](https://img.shields.io/badge/status-rev--0.2-blue)](CHANGELOG.md)
[![licença](https://img.shields.io/badge/licença-MIT-green)](LICENSE)

## O problema

Todo RAG em produção tem a mesma curva: 30 a 50% das perguntas são repetições ou
quase-repetições. Cada uma paga o ciclo completo. Embedding da query, busca vetorial no
corpus, contexto de 6 a 10 mil tokens, chamada ao LLM, geração da resposta. Perto de
US$ 0,036 e de 3 a 6 segundos, por pergunta cuja resposta já foi escrita ontem.

| Métrica | Sem cache | Com hit |
|---|---|---|
| Custo por query | ~US$ 0,036 | ~US$ 0,000004 |
| Latência p50 | 3.400 ms | 90 ms |
| Latência p50 (hit exato) | | 12 ms |

## O problema do problema

Cache semântico mal feito não fica lento. Ele mente.

```
"editais de tecnologia abertos em São Paulo"
"editais de tecnologia abertos no Rio Grande do Sul"
```

Cosseno entre as duas: por volta de 0,96. Acima de qualquer threshold razoável. O
embedding achata o nome do estado porque a estrutura da frase é idêntica. Um cache
ingênuo entrega São Paulo para quem perguntou do Rio Grande do Sul, com confiança total,
e ninguém percebe até alguém perder um prazo.

O Eco existe por causa dessa linha, não por causa da economia.

**Partition key determinística.** Antes de qualquer embedding, um parser sem LLM extrai
o que não pode ser interpolado: UF, código CNAE, limiar monetário, intervalo de data,
identificador. Isso vira a chave da partição, e a busca vetorial só acontece dentro da
mesma partição. São Paulo e Rio Grande do Sul nunca se encontram, mesmo com cosseno 0,99.

**Entity guard.** Dentro da partição, antes de servir, os tokens duros da pergunta nova
são comparados com os da pergunta cacheada. Divergiu um número, uma sigla, uma entidade,
o hit é rejeitado e a pergunta segue para o pipeline completo.

A assimetria manda no desenho. Um falso negativo custa uma chamada de LLM. Um falso
positivo custa uma resposta errada entregue com confiança.

## Três níveis

```
query
  ├─ L0 · hash exato ....... 12 ms, custo zero, sem rede
  ├─ L1 · semântico ........ 90 ms, dentro da partição, similaridade ≥ 0,94 + guard
  └─ L2 · RAG completo ..... gera, responde e grava em L0+L1
```

L0 existe separado porque metade dos quase-repetidos é repetição literal. Pagar uma
chamada de embedding para resolver o que um índice B-tree resolve de graça não é
otimização, é desperdício.

## Uso

```ts
import { answerWithCache } from '@donadao/eco';

const resposta = await answerWithCache({
  client,              // SupabaseClient da request, com o JWT do usuário
  tenantId,
  query: pergunta,
  runRag: () => meuPipelineDeRag(pergunta),   // o caro, injetado
});

resposta.answerText;
resposta.cached;       // true quando veio do cache
resposta.hitLevel;     // 'L0' | 'L1' | 'MISS' | 'BYPASS' | 'SKIP'
```

O Eco não conhece o seu pipeline. Não importa se é LangChain, LlamaIndex ou chamada
direta ao modelo: ele recebe `runRag` e decide se precisa executá-lo.

O `client` é o da request, com o JWT do usuário, e não um singleton. A RLS resolve o
tenant por `auth.jwt()`, então um client compartilhado leria o tenant errado.

## Instalação

```bash
npm i github:vindonadao/eco-cache
```

Aplique as migrations do pacote no seu Postgres, na ordem:

```
supabase/migrations/0001_semantic_cache.sql
supabase/migrations/0002_rls.sql
supabase/migrations/0003_fn_cache_lookup.sql
supabase/migrations/0004_fn_cache_touch.sql
```

Requer a extensão `vector`. Variáveis em [`.env.example`](.env.example).

## Antes de servir em produção

Ligue em shadow mode. `CACHE_SHADOW_MODE=true` faz o cache consultar, registrar o que
teria servido e **não servir**: o RAG roda e as duas respostas são comparadas. Só depois
de ver a divergência real o threshold vai para produção.

Calibrar threshold no olho é como se descobre, três meses depois, que 4% das respostas
estavam erradas.

## Estado

**rev-0.2.** O módulo roda ponta a ponta: partição determinística, entity guard,
embedding com orçamento de 800 ms, os três níveis de cache, invalidação por versão de
corpus. A suíte de falso positivo está ativa e verde, com os pares da tabela obrigatória.
São 55 testes.

O que falta antes de produção: aplicar as migrations num Postgres de verdade (nenhum
teste tocou banco, o client é falso) e rodar a semana de shadow mode para calibrar o
threshold. Extração de município não existe, só de UF, então perguntas sobre cidades
diferentes do mesmo estado ainda dependem só do embedding para se separar.

O plano completo está em [`docs/arquitetura.md`](docs/arquitetura.md), que é a fonte da
verdade do projeto. O contexto de trabalho está em [`CLAUDE.md`](CLAUDE.md).

## Zero dependência de runtime

`sha256` do `node:crypto`, HTTP com `fetch` nativo. `@supabase/supabase-js` é peer
dependency: quem consome já tem. Nada de Redis, e a razão está na §11 da arquitetura.

---

Built by Donadão Labs.
