import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/server';
import { apiError } from '@/lib/http/errors';
import { pravaClient } from '@/lib/prava-client';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser();
    const cards = await pravaClient.listCards(user.id);
    return NextResponse.json(cards, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return apiError(error, 'Unable to list cards');
  }
}
