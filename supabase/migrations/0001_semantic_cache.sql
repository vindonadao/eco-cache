-- Eco · 0001_semantic_cache
-- Fonte da verdade: docs/arquitetura.md §4
-- Idempotente. Rodar na ordem numérica.

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
