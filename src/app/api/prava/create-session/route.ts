import { NextResponse } from 'next/server';
import { requireSameOrigin, requireUser } from '@/lib/auth/server';
import { apiError } from '@/lib/http/errors';
import { assertPurchasesEnabled } from '@/lib/purchases/guard';
import { getPurchaseRepository } from '@/lib/purchases/repository';
import { PayloadTooLargeError, readLimitedBody } from '@/lib/http/request-safety';

export const dynamic = 'force-dynamic';

/**
 * Session creation remains closed until the durable quote-to-session workflow
 * claims an authenticated purchase order. Client-supplied identity, merchant,
 * and amount fields are intentionally no longer accepted here.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    assertPurchasesEnabled('api:request-prava-session');
    const body = JSON.parse(await readLimitedBody(request, 16 * 1024));
    if (
      typeof body?.purchaseOrderId !== 'string' ||
      !Number.isInteger(body?.expectedVersion) ||
      body.expectedVersion < 0
    ) {
      return NextResponse.json({ error: 'purchaseOrderId and expectedVersion are required' }, { status: 400 });
    }

    const result = await getPurchaseRepository().requestPravaSession({
      purchaseOrderId: body.purchaseOrderId,
      userId: user.id,
      expectedVersion: body.expectedVersion,
    });
    if (!result.accepted) {
      return NextResponse.json({ accepted: false, orderVersion: result.orderVersion }, { status: 409 });
    }
    return NextResponse.json({ accepted: true, orderVersion: result.orderVersion }, { status: 202 });
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    return apiError(error, 'Unable to create payment session');
  }
}
