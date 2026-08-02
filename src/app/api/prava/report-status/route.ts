import { NextResponse } from 'next/server';
import { requireBearerSecret } from '@/lib/auth/server';
import { apiError } from '@/lib/http/errors';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    requireBearerSecret(request, 'INTERNAL_WORKER_SECRET');
    return NextResponse.json(
      { error: 'Direct status reporting is disabled; reports must be claimed from transaction_reports' },
      { status: 503 }
    );
  } catch (error) {
    return apiError(error, 'Unable to report transaction status');
  }
}
