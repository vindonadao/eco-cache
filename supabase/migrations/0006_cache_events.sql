-- Eco · 0006_cache_events
-- Fonte da verdade: docs/arquitetura.md §9
--
-- Append-only. A §9 dá duas opções, tabela própria ou Helicone/LangSmith; esta é a
-- primeira, e o sink do módulo continua plugável para quem preferir a segunda.

create table if not exists cache_events (
  id          bigserial primary key,
  tenant_id   uuid not null,
  event_type  text not null,
  hit_level   text,
  similarity  double precision,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),

  constraint cache_events_type_check check (
    event_type in ('hit_l0', 'hit_l1', 'miss', 'guard_reject', 'embed_fail', 'shadow_mismatch')
  )
);

create index if not exists cache_events_tenant_time_idx
  on cache_events (tenant_id, created_at desc);

create index if not exists cache_events_type_idx
  on cache_events (tenant_id, event_type, created_at desc);

alter table cache_events enable row level security;

drop policy if exists cache_events_tenant_isolation on cache_events;
create policy cache_events_tenant_isolation on cache_events
  for all
  using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  with check (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

/**
 * Os quatro números da §9, por tenant e por dia. Custo evitado fica de fora de propósito:
 * depende do preço do modelo de cada consumidor, que o módulo não conhece. Multiplique
 * `hits` pelo seu custo médio de chamada.
 */
create or replace view cache_metrics_daily as
select
  tenant_id,
  date_trunc('day', created_at) as dia,
  count(*) filter (where event_type = 'hit_l0')          as hit_l0,
  count(*) filter (where event_type = 'hit_l1')          as hit_l1,
  count(*) filter (where event_type = 'miss')            as miss,
  count(*) filter (where event_type = 'guard_reject')    as guard_reject,
  count(*) filter (where event_type = 'embed_fail')      as embed_fail,
  count(*) filter (where event_type = 'shadow_mismatch') as shadow_mismatch,
  count(*) filter (where event_type in ('hit_l0', 'hit_l1')) as hits,
  round(
    count(*) filter (where event_type in ('hit_l0', 'hit_l1'))::numeric
      / nullif(count(*) filter (where event_type in ('hit_l0', 'hit_l1', 'miss')), 0),
    4
  ) as hit_rate,
  -- Acima de 5% quer dizer threshold frouxo ou partição mal desenhada (§9).
  round(
    count(*) filter (where event_type = 'guard_reject')::numeric
      / nullif(count(*) filter (where event_type in ('hit_l0', 'hit_l1', 'guard_reject')), 0),
    4
  ) as guard_reject_rate,
  -- Só faz sentido durante a semana de shadow: é o número que libera servir o cache.
  round(
    count(*) filter (where event_type = 'shadow_mismatch')::numeric
      / nullif(count(*) filter (where event_type in ('hit_l0', 'hit_l1')), 0),
    4
  ) as shadow_mismatch_rate
from cache_events
group by tenant_id, date_trunc('day', created_at);

-- A view roda com os privilégios de quem consulta, então a RLS de cache_events continua
-- valendo. Sem isto, um tenant leria a métrica de outro.
alter view cache_metrics_daily set (security_invoker = on);

-- Uma view sobre tabela com RLS ainda assim não deve ficar aberta ao anônimo.
revoke all on cache_metrics_daily from anon;
