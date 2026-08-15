import { CACHE_CONFIG } from './config.js';
import type { CachePolicy } from './types.js';

/**
 * Classe de query → política de cache. Tabelada, não espalhada em `if`s
 * (docs/arquitetura.md §3, "Recência: o que nunca entra no cache").
 */
type QueryClass = 'volatile' | 'default';

/**
 * Marcadores temporais. Query com qualquer um deles tem resposta que envelhece
 * sozinha: o corpus não mudou, mas "hoje" mudou. TTL curto, não o default.
 */
// Lookaround por \p{L} em vez de \b: `\b` usa definição ASCII de word char, então
// `\búltimo\b` nunca casa (ú e o acento final caem fora de \w). Com acento é rotina em PT.
const RECENCY_MARKERS =
  /(?<!\p{L})(hoje|agora|esta semana|nesta semana|último|últimos|última|últimas|mais recente|mais recentes|recentes|ontem|amanhã)(?!\p{L})/u;

const POLICY_TABLE: Record<QueryClass, Omit<CachePolicy, 'reason'>> = {
  volatile: {
    cacheable: true,
    ttlSeconds: CACHE_CONFIG.volatileTtlSeconds,
    threshold: CACHE_CONFIG.defaultThreshold,
  },
  default: {
    cacheable: true,
    ttlSeconds: CACHE_CONFIG.defaultTtlSeconds,
    threshold: CACHE_CONFIG.defaultThreshold,
  },
};

export function classifyQuery(normalized: string): QueryClass {
  return RECENCY_MARKERS.test(normalized) ? 'volatile' : 'default';
}

export function classify(normalized: string): CachePolicy {
  const queryClass = classifyQuery(normalized);
  return {
    ...POLICY_TABLE[queryClass],
    reason: queryClass,
  };
}

/**
 * PENDENTE (Sprint 1) — docs/arquitetura.md §11: resposta personalizada nunca
 * entra no cache. A detecção depende do prompt do consumidor, não da query, então
 * a decisão de onde esse sinal entra no contrato ainda está aberta. Ver CLAUDE.md.
 */
