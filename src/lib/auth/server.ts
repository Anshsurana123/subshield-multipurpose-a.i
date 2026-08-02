import 'server-only';

import { timingSafeEqual } from 'crypto';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export interface AuthenticatedUser {
  id: string;
  email: string | null;
}

export class AuthenticationError extends Error {
  readonly status = 401;

  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class RequestOriginError extends Error {
  readonly status = 403;

  constructor(message = 'Cross-origin request rejected') {
    super(message);
    this.name = 'RequestOriginError';
  }
}

export async function requireUser(): Promise<AuthenticatedUser> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const subject = data?.claims?.sub;

  if (error || typeof subject !== 'string' || !subject) {
    throw new AuthenticationError();
  }

  const email = data.claims.email;
  return {
    id: subject,
    email: typeof email === 'string' ? email : null,
  };
}

function safeSecretEqual(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return (
    providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes)
  );
}

export function requireBearerSecret(
  request: Request,
  envName: 'INTERNAL_WORKER_SECRET' | 'CRON_SECRET'
): void {
  const expected = process.env[envName]?.trim();
  if (!expected) {
    throw new AuthenticationError(`${envName} is not configured`);
  }

  const authorization = request.headers.get('authorization') || '';
  const provided = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';

  if (!provided || !safeSecretEqual(provided, expected)) {
    throw new AuthenticationError('Invalid service authorization');
  }
}

export function secretHeaderMatches(provided: string | null, expected: string | undefined): boolean {
  const normalizedExpected = expected?.trim();
  return Boolean(
    provided &&
      normalizedExpected &&
      safeSecretEqual(provided, normalizedExpected)
  );
}

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (!origin) throw new RequestOriginError('Request origin is required');

  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    throw new RequestOriginError();
  }
  if (origin !== requestOrigin) throw new RequestOriginError();
}
