import { NextResponse } from 'next/server';
import { consumeRateLimit } from '@/lib/http/request-safety';
import { consumePravaCallbackState } from '@/lib/purchases/callback';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const source = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!consumeRateLimit(`prava-callback:${source}`, { limit: 30, windowMs: 60_000 })) {
    return NextResponse.redirect(new URL('/dashboard?paymentReturn=rate_limited', url.origin));
  }

  try {
    const consumed = await consumePravaCallbackState(url.searchParams.get('state') || '');
    return NextResponse.redirect(new URL(
      consumed ? '/dashboard?paymentReturn=received' : '/dashboard?paymentReturn=invalid',
      url.origin
    ));
  } catch {
    return NextResponse.redirect(new URL('/dashboard?paymentReturn=unavailable', url.origin));
  }
}
