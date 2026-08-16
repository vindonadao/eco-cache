import { createHmac } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Suporte para os testes que precisam de Postgres de verdade.
 *
 * Nada aqui é mock: as migrations rodam num Supabase local e a RLS é exercitada com JWT
 * assinado, do mesmo jeito que em produção. Sem banco disponível, a suíte pula em vez de
 * falhar, para não travar quem clonou o repo sem Docker.
 */

/**
 * Defaults do `supabase start`. São credenciais locais publicadas na documentação do
 * Supabase, iguais em qualquer máquina, e servem só para o stack de desenvolvimento.
 * Não é segredo vazado: é o que faz a suíte rodar sem configuração depois de um clone.
 *
 * A porta 54421 (em vez da 54321 padrão) evita colisão com outro projeto Supabase local.
 */
const SUPABASE_URL = process.env.TEST_SUPABASE_URL ?? 'http://127.0.0.1:54421';
const SERVICE_KEY =
  process.env.TEST_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const JWT_SECRET =
  process.env.TEST_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long';

export const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Assina um JWT HS256 com `node:crypto`. Zero dependência, como o resto do módulo. */
export function signJwt(claims: Record<string, unknown>, secret: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);

  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    aud: 'authenticated',
    role: 'authenticated',
    iat: now,
    exp: now + 3600,
    ...claims,
  });
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');

  return `${header}.${payload}.${signature}`;
}

/** Client autenticado como um tenant específico. É ele que a RLS enxerga. */
export function clientForTenant(tenantId: string): SupabaseClient {
  const token = signJwt({ sub: tenantId, tenant_id: tenantId }, JWT_SECRET);
  return createClient(SUPABASE_URL, token, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}`, apikey: token } },
  });
}

/** Client de serviço, para preparar e limpar cenário passando por cima da RLS. */
export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Vetor determinístico de 512 dimensões, para não depender da API de embedding. */
export function fakeVector(seed: number, dims = 512): number[] {
  return Array.from({ length: dims }, (_, i) => Math.sin(seed * (i + 1)) / 10);
}

/** O banco de teste está de pé e com as migrations aplicadas? */
export async function databaseAvailable(): Promise<boolean> {
  if (!SERVICE_KEY || !JWT_SECRET) return false;
  try {
    const { error } = await serviceClient().from('rag_cache').select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}
