import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/server';
import { apiError } from '@/lib/http/errors';
import { pravaClient } from '@/lib/prava-client';
import { userOwnsPravaSession } from '@/lib/purchases/access';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const sessionId = new URL(request.url).searchParams.get('sessionId');
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }
    if (!(await userOwnsPravaSession(user.id, sessionId))) {
      return NextResponse.json({ error: 'Payment session not found' }, { status: 404 });
    }

    const result = await pravaClient.pollPaymentResult(sessionId);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return apiError(error, 'Unable to read payment result');
  }
}
