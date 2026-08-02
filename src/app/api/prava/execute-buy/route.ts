import { NextResponse } from 'next/server';
import { requireBearerSecret } from '@/lib/auth/server';
import { apiError } from '@/lib/http/errors';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    requireBearerSecret(request, 'INTERNAL_WORKER_SECRET');
    return NextResponse.json(
      { error: 'Inline purchase execution is disabled; use a claimed durable workflow job' },
      { status: 503 }
    );
  } catch (error) {
    return apiError(error, 'Unable to execute purchase');
  }
}

/** Prava browser redirects must never execute a merchant checkout. */
export async function GET() {
  return NextResponse.json(
    { error: 'Legacy purchase callback is no longer accepted' },
    { status: 410 }
  );
}
