import { describe, expect, it } from 'vitest';
import { normalize, queryHashOf, sha256 } from '../src/normalize.js';
import { classify, classifyQuery } from '../src/policy.js';

/**
 * Pré-processamento determinístico da query: normalização, política e partição.
 * Tudo aqui roda no caminho quente, sem rede e sem LLM.
 */

describe('normalize', () => {
  it('colapsa espaço, caixa e pontuação final no mesmo hash', () => {
    expect(normalize('  Quais Editais estão   Abertos?  ')).toBe('quais editais estão abertos');
  });

  it('mantém acento: São Paulo e Sao Paulo não são a mesma coisa para o parser', () => {
    expect(normalize('São Paulo')).toBe('são paulo');
  });

  it('não come pontuação interna', () => {
    expect(normalize('CNAE 6201-5/01.')).toBe('cnae 6201-5/01');
  });

  it('é idempotente', () => {
    const once = normalize('Editais abertos HOJE!');
    expect(normalize(once)).toBe(once);
  });
});

describe('queryHashOf', () => {
  it('mesma query em partições diferentes gera hashes diferentes', () => {
    const q = normalize('editais de TI abertos');
    expect(queryHashOf(q, sha256('{"uf":"SP"}'))).not.toBe(queryHashOf(q, sha256('{"uf":"RS"}')));
  });

  it('é determinístico', () => {
    expect(queryHashOf('abc', 'p')).toBe(queryHashOf('abc', 'p'));
  });
});

describe('policy', () => {
  it('marca query com recência como volátil', () => {
    expect(classifyQuery(normalize('editais abertos hoje'))).toBe('volatile');
    expect(classifyQuery(normalize('qual o edital mais recente'))).toBe('volatile');
  });

  it('pega marcador acentuado, que \\b não pegaria', () => {
    expect(classifyQuery(normalize('qual foi o último edital publicado'))).toBe('volatile');
  });

  it('não marca query atemporal como volátil', () => {
    expect(classifyQuery(normalize('como faço para me cadastrar'))).toBe('default');
    expect(classifyQuery(normalize('quais documentos preciso enviar'))).toBe('default');
  });

  it('volátil recebe TTL curto, não o default de 7 dias', () => {
    const volatil = classify(normalize('editais abertos hoje'));
    const padrao = classify(normalize('como faço para me cadastrar'));
    expect(volatil.ttlSeconds).toBeLessThan(padrao.ttlSeconds);
  });
});

describe('extractPartition', () => {
  it.todo('separa UF: São Paulo e Rio Grande do Sul em partições distintas');
  it.todo('separa limiar monetário: R$ 100 mil e R$ 500 mil em partições distintas');
  it.todo('separa código CNAE');
  it.todo('separa identificador de edital');
  it.todo('ignora ordem das palavras que não são campo duro');
});

describe('passesEntityGuard', () => {
  it.todo('rejeita hit quando um número diverge');
  it.todo('rejeita hit quando uma sigla em caixa alta diverge');
  it.todo('aceita hit quando os tokens duros são idênticos');
});
