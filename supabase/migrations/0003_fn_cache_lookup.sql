-- Eco · 0003_fn_cache_lookup
-- Fonte da verdade: docs/arquitetura.md §5
-- Uma ida ao banco, não três. L0 primeiro; L1 só se L0 falhar.

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
