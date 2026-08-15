import { describe, expect, it } from 'vitest';
import { normalize, queryHashOf, sha256 } from '../src/normalize.js';
import { extractPartition, passesEntityGuard } from '../src/partition.js';
import { classify, classifyQuery } from '../src/policy.js';
import { extractUfs } from '../src/uf.js';

/**
 * Pré-processamento determinístico da query: normalização, política e partição.
 * Tudo aqui roda no caminho quente, sem rede e sem LLM.
 */

const key = (query: string) => extractPartition(normalize(query)).partitionKey;
const tokens = (query: string) => extractPartition(normalize(query)).entityTokens;

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

describe('extractUfs', () => {
  it('canoniza sigla e nome por extenso para o mesmo código', () => {
    expect(extractUfs('editais em sp').ufs).toEqual(['SP']);
    expect(extractUfs('editais em são paulo').ufs).toEqual(['SP']);
    expect(extractUfs('editais em sao paulo').ufs).toEqual(['SP']);
  });

  it('não confunde sigla ambígua com palavra: "se" não é Sergipe', () => {
    expect(extractUfs('se você tem interesse, como faço o cadastro').ufs).toEqual([]);
    expect(extractUfs('editais em se').ufs).toEqual(['SE']);
  });

  it('casa o nome mais longo primeiro: Mato Grosso do Sul não vira Mato Grosso', () => {
    expect(extractUfs('editais em mato grosso do sul').ufs).toEqual(['MS']);
    expect(extractUfs('editais em mato grosso').ufs).toEqual(['MT']);
  });

  it('coleta várias UFs em ordem estável', () => {
    expect(extractUfs('editais em sp e no rio grande do sul').ufs).toEqual(['RS', 'SP']);
  });
});

describe('extractPartition', () => {
  it('separa UF: São Paulo e Rio Grande do Sul em partições distintas', () => {
    expect(key('editais de TI em São Paulo')).not.toBe(key('editais de TI no Rio Grande do Sul'));
  });

  it('une sigla e nome por extenso na mesma partição', () => {
    expect(key('editais de TI em SP')).toBe(key('editais de TI em São Paulo'));
  });

  it('separa limiar monetário: R$ 100 mil e R$ 500 mil em partições distintas', () => {
    expect(key('editais acima de R$ 100 mil')).not.toBe(key('editais acima de R$ 500 mil'));
  });

  it('lê valor escrito de formas diferentes como o mesmo número', () => {
    expect(key('editais acima de R$ 100 mil')).toBe(key('editais acima de R$ 100.000'));
  });

  it('separa código CNAE', () => {
    expect(key('CNAE 6201-5/01')).not.toBe(key('CNAE 6202-3/00'));
  });

  it('separa identificador de edital', () => {
    expect(key('prazo do edital 042/2025')).not.toBe(key('prazo do edital 043/2025'));
  });

  it('separa recência de mês nomeado', () => {
    expect(key('editais abertos hoje')).not.toBe(key('editais abertos em janeiro'));
  });

  it('separa ano', () => {
    expect(key('editais de 2025')).not.toBe(key('editais de 2024'));
  });

  it('não confunde data completa com número de edital', () => {
    expect(key('editais publicados em 15/08/2026')).not.toBe(key('prazo do edital 08/2026'));
  });

  it('ignora ordem das palavras que não são campo duro', () => {
    expect(key('editais abertos em SP de TI')).toBe(key('editais de TI abertos em SP'));
  });

  it('query sem campo duro cai na partição vazia, e ela é estável', () => {
    expect(key('como faço pra me cadastrar')).toBe(key('qual o processo de cadastro'));
  });
});

describe('entity tokens', () => {
  it('guarda número residual que a partição não capturou', () => {
    expect(tokens('edital com 3 lotes')).toEqual(['3']);
    expect(tokens('qual o prazo do item 7')).toEqual(['7']);
  });

  it('não transforma sigla alfabética em token: CND e o nome por extenso devem casar', () => {
    expect(tokens('preciso da certidão CND')).toEqual([]);
    expect(tokens('preciso da certidão negativa de débitos')).toEqual([]);
  });
});

describe('passesEntityGuard', () => {
  it('rejeita hit quando um número diverge', () => {
    expect(passesEntityGuard(tokens('edital com 3 lotes'), tokens('edital com 5 lotes'))).toBe(
      false,
    );
  });

  it('rejeita hit quando a query nova tem um número a mais', () => {
    expect(passesEntityGuard(['7'], [])).toBe(false);
    expect(passesEntityGuard([], ['7'])).toBe(false);
  });

  it('aceita hit quando os tokens duros são idênticos', () => {
    expect(passesEntityGuard(['7'], ['7'])).toBe(true);
    expect(passesEntityGuard([], [])).toBe(true);
  });

  it('não depende da ordem dos tokens', () => {
    expect(passesEntityGuard(['3', '7'], ['7', '3'])).toBe(true);
  });
});
