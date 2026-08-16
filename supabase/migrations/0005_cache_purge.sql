-- Eco · 0005_cache_purge
-- Fonte da verdade: docs/arquitetura.md §8
--
-- O bump de corpus_version invalida sem deletar: entrada antiga simplesmente para de dar
-- match. Zero lock, zero delete no caminho quente. Alguém precisa varrer depois, e é este
-- job. Sem ele a tabela cresce para sempre.

create or replace function cache_purge()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  removed bigint;
begin
  delete from rag_cache
  where expires_at < now() - interval '7 days'
     or corpus_version < (
          select s.corpus_version from corpus_state s where s.tenant_id = rag_cache.tenant_id
        ) - 2;

  get diagnostics removed = row_count;
  return removed;
end;
$$;

comment on function cache_purge() is
  'Purga entradas expiradas há mais de 7 dias e versões de corpus muito atrás da atual. '
  'security definer porque roda pelo cron, sem usuário, e precisa varrer todos os tenants. '
  'Não recebe parâmetro: não há superfície para injeção.';

-- Agendamento diário. pg_cron não existe em todo Postgres e, no Supabase gerenciado,
-- precisa ser habilitado antes. A migration não pode falhar por causa disso, então o
-- agendamento é condicional e a função fica disponível para chamada manual de qualquer jeito.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;

    -- Remove agendamento anterior para a migration continuar idempotente.
    perform cron.unschedule('eco-cache-purge')
    where exists (select 1 from cron.job where jobname = 'eco-cache-purge');

    perform cron.schedule('eco-cache-purge', '17 4 * * *', 'select cache_purge();');
  else
    raise notice 'pg_cron indisponível: cache_purge() criada, mas sem agendamento automático';
  end if;
exception
  when insufficient_privilege then
    raise notice 'sem privilégio para agendar pg_cron: chame cache_purge() por fora';
  when others then
    raise notice 'agendamento do purge não aplicado (%): chame cache_purge() por fora', sqlerrm;
end;
$$;
