-- Eco · 0004_fn_cache_touch
-- Fonte da verdade: docs/arquitetura.md §5
--
-- Telemetria de hit em chamada separada, retorno void, disparada sem await.
-- Nunca segure a resposta do usuário para escrever telemetria.

create or replace function cache_touch(p_id uuid)
returns void
language sql
security invoker
as $$
  update rag_cache
     set hit_count   = hit_count + 1,
         last_hit_at = now()
   where id = p_id;
$$;
