import { NextResponse } from 'next/server';
import { addTrackedProduct, getTrackedProducts, scanAndBuyTrackedProducts } from '@/lib/price-tracker';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId') || 'demo-user-id';
    const products = await getTrackedProducts(userId);
    return NextResponse.json({ success: true, products });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Trigger price scan & auto buy if action === 'scan'
    if (body.action === 'scan') {
      const result = await scanAndBuyTrackedProducts(body.userId || 'demo-user-id');
      return NextResponse.json({ success: true, ...result });
    }

    if (!body.productUrl || !body.targetPrice) {
      return NextResponse.json(
        { success: false, error: 'productUrl and targetPrice are required' },
        { status: 400 }
      );
    }

    const product = await addTrackedProduct({
      userId: body.userId || 'demo-user-id',
      productUrl: body.productUrl,
      productName: body.productName,
      targetPrice: Number(body.targetPrice),
    });

    return NextResponse.json({ success: true, product });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
