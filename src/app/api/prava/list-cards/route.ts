import { NextResponse } from 'next/server';
import { pravaClient } from '@/lib/prava-client';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const customerId = searchParams.get('customerId');

    if (!customerId) {
      return NextResponse.json(
        { error: 'customerId is required' },
        { status: 400 }
      );
    }

    const cards = await pravaClient.listCards(customerId);
    return NextResponse.json(cards);
  } catch (error: any) {
    console.error('List cards error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to list cards' },
      { status: 500 }
    );
  }
}
