import type { SupabaseClient } from '@supabase/supabase-js';
import { metrics } from './metrics.js';
import type { CacheEvent } from './types.js';

/**
 * Sink que persiste a telemetria em `cache_events` — docs/arquitetura.md §9.
 *
 * Opcional: o módulo funciona sem nenhum sink, e quem preferir Helicone ou LangSmith
 * registra o seu com `metrics.setSink`. Este existe para quem quer os quatro números do
 * dashboard sem montar infra nova, consultando a view `cache_metrics_daily`.
 *
 * Nunca bloqueia e nunca lança: telemetria que derruba resposta é pior que telemetria
 * ausente.
 */
export function supabaseEventSink(client: SupabaseClient, tenantId: string) {
  return (event: CacheEvent): void => {
    void client
      .from('cache_events')
      .insert(toRow(event, tenantId))
      .then(({ error }) => {
        if (error) console.warn(`[eco] telemetria não gravada: ${error.message}`);
      });
  };
}

/** Registra o sink no módulo. Atalho para o caso comum. */
export function useSupabaseEvents(client: SupabaseClient, tenantId: string): void {
  metrics.setSink(supabaseEventSink(client, tenantId));
}

function toRow(event: CacheEvent, tenantId: string) {
  const base = { tenant_id: tenantId, event_type: event.type };

  switch (event.type) {
    case 'hit_l0':
      return { ...base, hit_level: 'L0', similarity: 1 };
    case 'hit_l1':
      return { ...base, hit_level: 'L1', similarity: event.similarity };
    case 'guard_reject':
      return { ...base, similarity: event.similarity };
    case 'embed_fail':
      return { ...base, detail: { error: event.error } };
    case 'shadow_mismatch':
      return {
        ...base,
        hit_level: event.hitLevel,
        similarity: event.similarity,
        detail: {
          text_similarity: event.textSimilarity,
          citations_match: event.citationsMatch,
        },
      };
    case 'miss':
      return base;
  }
}
