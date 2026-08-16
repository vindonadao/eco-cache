/**
 * Tipos compartilhados do módulo.
 *
 * Único arquivo fora da lista de docs/arquitetura.md §6: existe para quebrar o
 * ciclo de import entre `index.ts` e os módulos que ele orquestra. Não carrega
 * regra de negócio — só o formato dos dados que as colunas de `rag_cache` já definem.
 */

/**
 * Nível que respondeu a query.
 *
 * `SHADOW` significa que o cache tinha resposta e não serviu, porque o shadow mode estava
 * ligado. O consumidor pagou o pipeline, então não é hit; mas também não é `MISS`, e
 * contar como miss estragaria a primeira métrica do dashboard da §9.
 */
export type HitLevel = 'L0' | 'L1' | 'MISS' | 'BYPASS' | 'SKIP' | 'SHADOW';

/**
 * Citação devolvida pelo pipeline de RAG. O shape é do consumidor: o Eco
 * apenas transporta e persiste em `rag_cache.answer_citations` (jsonb).
 */
export type Citation = Record<string, unknown>;

/** Resultado do pipeline caro (L2), injetado pelo consumidor via `runRag`. */
export interface RagResult {
  answerText: string;
  citations: Citation[];
  sourceChunkIds: string[];
  model: string;
}

/** Resposta entregue ao consumidor, vinda do cache ou do pipeline. */
export interface CachedAnswer {
  answerText: string;
  citations: Citation[];
  cached: boolean;
  hitLevel: HitLevel;
  similarity?: number;
}

/** Linha de cache retornada pela RPC `cache_lookup`. */
export interface CacheHit {
  hitLevel: Extract<HitLevel, 'L0' | 'L1'>;
  id: string;
  answerText: string;
  citations: Citation[];
  entityTokens: string[];
  similarity: number;
}

/** Decisão de cacheabilidade por classe de query — docs/arquitetura.md §3. */
export interface CachePolicy {
  cacheable: boolean;
  ttlSeconds: number;
  threshold: number;
  reason: string;
}

/** Campos duros extraídos da query antes de qualquer embedding. */
export interface PartitionResult {
  partitionKey: string;
  entityTokens: string[];
}

/** Evento de telemetria — docs/arquitetura.md §9. */
export type CacheEvent =
  | { type: 'hit_l0' }
  | { type: 'hit_l1'; similarity: number }
  | { type: 'miss' }
  | { type: 'guard_reject'; similarity: number }
  | { type: 'embed_fail'; error: string }
  | {
      type: 'shadow_mismatch';
      similarity: number;
      hitLevel: Extract<HitLevel, 'L0' | 'L1'>;
      textSimilarity: number;
      citationsMatch: boolean;
    };
