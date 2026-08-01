import { NextResponse } from 'next/server';
import { pravaClient } from '@/lib/prava-client';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');

    if (!sessionId) {
      return NextResponse.json(
        { error: 'sessionId is required' },
        { status: 400 }
      );
    }

    const result = await pravaClient.pollPaymentResult(sessionId);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Payment result error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to poll payment result' },
      { status: 500 }
    );
  }
}
