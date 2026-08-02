import { NextResponse } from 'next/server';
import { requireBearerSecret } from '@/lib/auth/server';
import { apiError } from '@/lib/http/errors';
import { scanNextTrackedProduct } from '@/lib/price-tracker';

export const dynamic = 'force-dynamic';
export const maxDuration = 240;

export async function GET(request: Request) {
  try {
    requireBearerSecret(request, 'CRON_SECRET');
    const deadline = Date.now() + 210_000;
    let scanned = 0;
    let targetReached = 0;
    let failed = 0;

    while (scanned + failed < 4 && Date.now() < deadline) {
      try {
        const result = await scanNextTrackedProduct();
        if (!result.scanned) break;
        scanned += 1;
        if (result.targetReached) targetReached += 1;
      } catch {
        failed += 1;
      }
    }

    return NextResponse.json({ scanned, targetReached, failed });
  } catch (error) {
    return apiError(error, 'Unable to scan tracked product');
  }
}
