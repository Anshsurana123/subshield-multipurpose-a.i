import { NextResponse } from 'next/server';
import { AuthenticationError, RequestOriginError } from '@/lib/auth/server';
import { PurchasesDisabledError } from '@/lib/purchases/guard';

export function apiError(error: unknown, fallback: string): NextResponse {
  if (error instanceof AuthenticationError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof RequestOriginError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof PurchasesDisabledError) {
    return NextResponse.json({ error: 'Purchases are currently disabled' }, { status: 503 });
  }

  return NextResponse.json({ error: fallback }, { status: 500 });
}
