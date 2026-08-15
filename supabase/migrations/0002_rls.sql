-- Eco · 0002_rls
-- Fonte da verdade: docs/arquitetura.md §4
--
-- Regra não negociável: tenant_id faz parte da chave de lookup E da RLS.
-- Cache é o vetor de vazamento cross-tenant mais fácil de introduzir e mais
-- difícil de detectar em code review. A redundância aqui é intencional.

alter table rag_cache enable row level security;
alter table corpus_state enable row level security;

drop policy if exists rag_cache_tenant_isolation on rag_cache;
create policy rag_cache_tenant_isolation on rag_cache
  for all
  using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  with check (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

drop policy if exists corpus_state_tenant_isolation on corpus_state;
create policy corpus_state_tenant_isolation on corpus_state
  for all
  using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
