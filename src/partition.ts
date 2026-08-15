import type { PartitionResult } from './types.js';

/**
 * Extração determinística dos campos que NÃO podem ser interpolados por
 * similaridade — docs/arquitetura.md §3A. Regex + dicionário, sem LLM,
 * sem rede, no caminho quente.
 *
 * Campos que compõem a partição:
 *   - UF / município (dicionário de 27 UFs + variações)
 *   - códigos CNAE (\d{4}-?\d?/?\d{2})
 *   - valores monetários e limiares numéricos
 *   - intervalos de data e termos de recência
 *   - identificadores (CNPJ, número de edital, protocolo)
 *
 * Esses campos normalizados e ordenados viram partition_key = sha256(json canônico).
 * A busca vetorial só acontece dentro da mesma partition_key: SP e RS nunca se
 * encontram, não importa que o cosseno seja 0.99.
 *
 * @remarks NÃO IMPLEMENTADO — Sprint 2 (docs/arquitetura.md §10).
 *   A suíte bloqueante de falso positivo (§7) valida esta função.
 */
export function extractPartition(_normalized: string): PartitionResult {
  throw new Error('[eco] extractPartition: não implementado — Sprint 2 (arquitetura.md §3A)');
}

/**
 * Entity guard (pós-filtro) — docs/arquitetura.md §3B.
 * Compara os tokens duros da query nova com os da query cacheada.
 * Divergiu qualquer um, rejeita o hit e cai para L2, independente da similaridade.
 *
 * A assimetria é deliberada: falso positivo entrega resposta errada com confiança,
 * falso negativo custa uma chamada de LLM.
 *
 * @remarks NÃO IMPLEMENTADO — Sprint 2 (docs/arquitetura.md §10).
 */
export function passesEntityGuard(_queryTokens: string[], _cachedTokens: string[]): boolean {
  throw new Error('[eco] passesEntityGuard: não implementado — Sprint 2 (arquitetura.md §3B)');
}
