import { describe, it } from 'vitest';

/**
 * SUÍTE BLOQUEANTE — docs/arquitetura.md §7.
 *
 * Cache semântico mal feito não fica lento, ele mente. Estes pares existem
 * porque o cosseno entre eles é alto o bastante para passar qualquer threshold
 * razoável, e mesmo assim a resposta de um NÃO serve para o outro.
 *
 * PR que quebra um destes não passa.
 *
 * Status rev-0.1: os casos estão versionados como `todo` porque `extractPartition`
 * e `passesEntityGuard` são do Sprint 2. Ao implementá-los, troque `it.todo` por
 * `it` — os dados já estão aqui, não reescreva a tabela.
 */

/** Pares que DEVEM cair em partições distintas ou ser rejeitados pelo guard. */
export const MUST_NOT_MATCH: ReadonlyArray<[string, string, string]> = [
  ['editais de TI em São Paulo', 'editais de TI no Rio Grande do Sul', 'UF'],
  ['editais acima de R$ 100 mil', 'editais acima de R$ 500 mil', 'limiar numérico'],
  ['CNAE 6201-5/01', 'CNAE 6202-3/00', 'código'],
  ['editais abertos hoje', 'editais abertos em janeiro', 'recência'],
  ['prazo do edital 042/2025', 'prazo do edital 043/2025', 'identificador'],
];

/** Pares que DEVEM dar hit. Cache que nunca acerta não é conservador, é inútil. */
export const MUST_MATCH: ReadonlyArray<[string, string]> = [
  ['quais editais de TI estão abertos em SP?', 'tem edital de tecnologia aberto em São Paulo?'],
  ['como faço pra me cadastrar?', 'qual o processo de cadastro?'],
];

describe('falso positivo: pares que nunca podem se encontrar', () => {
  for (const [a, b, motivo] of MUST_NOT_MATCH) {
    it.todo(`[${motivo}] "${a}" nunca serve para "${b}"`);
  }
});

describe('falso negativo: pares equivalentes que devem dar hit', () => {
  for (const [a, b] of MUST_MATCH) {
    it.todo(`"${a}" serve para "${b}"`);
  }
});
