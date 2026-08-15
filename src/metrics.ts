import type { CacheEvent } from './types.js';

type Sink = (event: CacheEvent) => void;

let sink: Sink = () => {
  /* silencioso por padrão: o consumidor pluga o destino */
};

/**
 * Telemetria do módulo — docs/arquitetura.md §9.
 * O Eco não escolhe destino (tabela `cache_events`, Helicone, LangSmith).
 * O consumidor registra o sink; sem sink, emissão é no-op.
 */
export const metrics = {
  setSink(next: Sink): void {
    sink = next;
  },
  emit(event: CacheEvent): void {
    try {
      sink(event);
    } catch {
      /* telemetria nunca derruba o caminho quente */
    }
  },
};
