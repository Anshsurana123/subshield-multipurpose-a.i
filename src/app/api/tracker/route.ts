import { NextResponse } from 'next/server';
import { requireSameOrigin, requireUser } from '@/lib/auth/server';
import { apiError } from '@/lib/http/errors';
import { addTrackedProduct, getTrackedProducts, TrackerEnrollmentError } from '@/lib/price-tracker';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser();
    const products = await getTrackedProducts(user.id);
    return NextResponse.json({ success: true, products });
  } catch (error) {
    return apiError(error, 'Unable to read tracked products');
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const body = await request.json();

    if (body?.action === 'scan') {
      return NextResponse.json(
        { success: false, error: 'Inline scans are disabled; authenticated cron workflows perform scans' },
        { status: 503 }
      );
    }
    if (typeof body?.productUrl !== 'string' || !Number.isFinite(Number(body?.targetPrice)) || Number(body.targetPrice) <= 0) {
      return NextResponse.json(
        { success: false, error: 'A valid productUrl and positive targetPrice are required' },
        { status: 400 }
      );
    }

    const product = await addTrackedProduct({
      userId: user.id,
      productUrl: body.productUrl,
      productName: typeof body.productName === 'string' ? body.productName : undefined,
      targetPrice: Number(body.targetPrice),
      currency: typeof body.currency === 'string' ? body.currency : undefined,
      channel: 'web',
      requestId: request.headers.get('idempotency-key') || undefined,
    });
    return NextResponse.json({ success: true, product }, { status: 201 });
  } catch (error) {
    if (error instanceof TrackerEnrollmentError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    return apiError(error, 'Unable to update tracked products');
  }
}
