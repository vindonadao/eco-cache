import { describe, expect, it } from 'vitest';
import { normalize } from '../src/normalize.js';
import { extractPartition, passesEntityGuard } from '../src/partition.js';

/**
 * SUÍTE BLOQUEANTE — docs/arquitetura.md §7.
 *
 * Cache semântico mal feito não fica lento, ele mente. Estes pares existem porque o
 * cosseno entre eles é alto o bastante para passar qualquer threshold razoável, e
 * mesmo assim a resposta de um NÃO serve para o outro.
 *
 * PR que quebra um destes não passa.
 *
 * O que é testável aqui é o que o módulo controla: partição e guard. A similaridade
 * em si é do modelo de embedding e do banco, e não entra em teste offline.
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

function analyze(query: string) {
  return extractPartition(normalize(query));
}

/** Reproduz a decisão do index.ts: partição igual E guard aprovado. */
function wouldServe(a: string, b: string): boolean {
  const left = analyze(a);
  const right = analyze(b);
  return (
    left.partitionKey === right.partitionKey &&
    passesEntityGuard(left.entityTokens, right.entityTokens)
  );
}

describe('falso positivo: pares que nunca podem se encontrar', () => {
  for (const [a, b, motivo] of MUST_NOT_MATCH) {
    it(`[${motivo}] "${a}" nunca serve para "${b}"`, () => {
      expect(wouldServe(a, b)).toBe(false);
    });
  }
});

describe('falso negativo: pares equivalentes que devem dar hit', () => {
  for (const [a, b] of MUST_MATCH) {
    it(`"${a}" serve para "${b}"`, () => {
      expect(wouldServe(a, b)).toBe(true);
    });
  }
});

describe('a partição é estável', () => {
  it('mesma query produz sempre a mesma chave', () => {
    expect(analyze('editais de TI em SP').partitionKey).toBe(
      analyze('editais de TI em SP').partitionKey,
    );
  });

  it('ordem das palavras livres não muda a partição', () => {
    expect(analyze('editais abertos em SP de TI').partitionKey).toBe(
      analyze('editais de TI abertos em SP').partitionKey,
    );
  });
});
