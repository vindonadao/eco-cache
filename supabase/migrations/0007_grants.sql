-- Eco · 0007_grants
--
-- Privilégios explícitos para os roles do PostgREST.
--
-- Não está em nenhuma seção do arquitetura.md porque o documento presume que criar a
-- tabela basta. Não basta: versões recentes do Supabase deixaram de conceder acesso
-- automático a tabelas novas no schema public, e sem estes grants o módulo sobe com o
-- schema inteiro inacessível, respondendo "permission denied for table rag_cache".
--
-- Descoberto no CI, que roda o CLI mais novo que o da máquina de desenvolvimento. Depender
-- de privilégio implícito é depender da versão do servidor.
--
-- `anon` fica de fora de propósito, e é revogado por garantia: o tenant vem do JWT, então
-- requisição sem usuário não tem tenant e não tem o que fazer aqui. A RLS já barraria,
-- mas privilégio negado é uma camada antes dela.

-- Dados. A RLS de 0002 e 0006 continua sendo quem decide qual linha cada tenant enxerga.
grant select, insert, update, delete on rag_cache to authenticated, service_role;
grant select, insert, update, delete on corpus_state to authenticated, service_role;
grant select, insert on cache_events to authenticated, service_role;

-- `bigserial` cria uma sequence própria, e sem USAGE nela o insert falha mesmo com o
-- grant da tabela.
grant usage, select on sequence cache_events_id_seq to authenticated, service_role;

-- Leitura das métricas. A view é security_invoker, então a RLS da tabela vale aqui também.
grant select on cache_metrics_daily to authenticated, service_role;

revoke all on rag_cache from anon;
revoke all on corpus_state from anon;
revoke all on cache_events from anon;
revoke all on cache_metrics_daily from anon;
revoke all on sequence cache_events_id_seq from anon;

-- Em instalações mais antigas o default privilege do Supabase concede ALL a
-- `authenticated`, então os grants acima só somam e o excesso fica. `cache_events` é
-- append-only por desenho: reescrever telemetria é apagar a própria evidência.
revoke update, delete, truncate on cache_events from authenticated;

-- A view é derivada e agregada; escrever nela não faz sentido nem funcionaria.
revoke insert, update, delete, truncate on cache_metrics_daily from authenticated;
revoke insert, update, delete, truncate on cache_metrics_daily from service_role;

-- TRUNCATE contorna a RLS: apaga tudo sem passar por policy nenhuma.
revoke truncate on rag_cache from authenticated;
revoke truncate on corpus_state from authenticated;

-- Funções do caminho quente, chamadas com o JWT do usuário.
grant execute on function cache_lookup(uuid, text, text, vector, bigint, double precision)
  to authenticated, service_role;
grant execute on function cache_touch(uuid) to authenticated, service_role;

-- Purge é security definer e varre todos os tenants. Em Postgres, função nasce executável
-- por PUBLIC, então o revoke aqui não é decorativo.
revoke all on function cache_purge() from public;
revoke all on function cache_purge() from anon;
revoke all on function cache_purge() from authenticated;
grant execute on function cache_purge() to service_role;
