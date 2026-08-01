import { NextResponse } from 'next/server';
import { pravaClient } from '@/lib/prava-client';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { sessionId } = body;

    if (!sessionId) {
      return NextResponse.json(
        { error: 'sessionId is required' },
        { status: 400 }
      );
    }

    const result = await pravaClient.completeCheckout(sessionId);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Complete checkout error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to complete checkout' },
      { status: 500 }
    );
  }
}
