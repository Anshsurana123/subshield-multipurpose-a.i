import { NextResponse } from 'next/server';
import { pravaClient } from '@/lib/prava-client';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { sessionId, txnRefId, txnStatus, amountPaid, authorizationCode, responseCode } = body;

    if (!sessionId || !txnRefId || !txnStatus) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    if (txnStatus !== 'APPROVED' && txnStatus !== 'DECLINED') {
      return NextResponse.json(
        { error: 'txnStatus must be APPROVED or DECLINED' },
        { status: 400 }
      );
    }

    await pravaClient.reportTransactionStatus(sessionId, {
      txnRefId,
      txnStatus,
      amountPaid,
      authorizationCode,
      responseCode,
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Report status error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to report status' },
      { status: 500 }
    );
  }
}
