import { NextResponse } from 'next/server';
import { pravaClient } from '@/lib/prava-client';
import { CreateSessionRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body: CreateSessionRequest = await request.json();
    
    if (!body.userId || !body.vendorName || !body.amount) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    const session = await pravaClient.createMandateSession(body);
    return NextResponse.json(session);
  } catch (error: any) {
    console.error('Create session error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to create session' },
      { status: 500 }
    );
  }
}
