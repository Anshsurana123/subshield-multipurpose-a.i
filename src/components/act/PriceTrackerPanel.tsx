'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, ExternalLink, Plus, ShoppingBag, ShieldCheck } from 'lucide-react';
import GlowCard from '../shared/GlowCard';
import type { TrackedProduct } from '@/lib/types';

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export default function PriceTrackerPanel() {
  const [products, setProducts] = useState<TrackedProduct[]>([]);
  const [productUrl, setProductUrl] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [isAdding, setIsAdding] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const fetchProducts = useCallback(async () => {
    try {
      const response = await fetch('/api/tracker', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load tracked products');
      setProducts(Array.isArray(data.products) ? data.products : []);
    } catch (error) {
      setStatusMsg(error instanceof Error ? error.message : 'Unable to load tracked products');
    }
  }, []);

  useEffect(() => {
    void fetchProducts();
  }, [fetchProducts]);

  const handleAddProduct = async (event: FormEvent) => {
    event.preventDefault();
    if (!productUrl || !targetPrice) return;

    setIsAdding(true);
    setStatusMsg(null);
    try {
      const response = await fetch('/api/tracker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productUrl, targetPrice: Number(targetPrice), currency }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to add tracked product');
      setProductUrl('');
      setTargetPrice('');
      setStatusMsg('Item added. A target hit will create an alert only.');
      await fetchProducts();
    } catch (error) {
      setStatusMsg(error instanceof Error ? error.message : 'Unable to add tracked product');
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <GlowCard className="space-y-6 rounded-2xl p-6 md:p-8">
      <div className="space-y-2">
        <div className="inline-flex items-center gap-2 rounded-full border border-[#cde0d3] bg-[#e8f2ec] px-3 py-1 text-xs font-mono text-[#176b4b]">
          <ShieldCheck className="size-3.5" />
          <span>AUTHENTICATED PRICE TRACKER</span>
        </div>
        <h2 className="text-xl font-bold">Track a public product page</h2>
        <p className="max-w-2xl text-xs leading-relaxed text-[#68756d]">
          Tracking is isolated to your account. PRAVA will not create a payment session or submit a
          merchant order from a scraped catalog price.
        </p>
      </div>

      <form onSubmit={handleAddProduct} className="flex flex-col gap-3 sm:flex-row">
        <input
          type="url"
          required
          placeholder="https://merchant.example/product"
          value={productUrl}
          onChange={(event) => setProductUrl(event.target.value)}
          className="flex-1 rounded-xl border border-[#e2e6df] bg-[#fafbf9] px-4 py-2.5 text-xs focus:border-[#176b4b] focus:outline-none"
        />
        <input
          type="number"
          min="0.01"
          step="0.01"
          required
          placeholder="Target"
          value={targetPrice}
          onChange={(event) => setTargetPrice(event.target.value)}
          className="w-full rounded-xl border border-[#e2e6df] bg-[#fafbf9] px-4 py-2.5 text-xs focus:border-[#176b4b] focus:outline-none sm:w-32"
        />
        <input
          aria-label="Currency"
          pattern="[A-Za-z]{3}"
          maxLength={3}
          required
          value={currency}
          onChange={(event) => setCurrency(event.target.value.toUpperCase())}
          className="w-full rounded-xl border border-[#e2e6df] bg-[#fafbf9] px-4 py-2.5 text-xs uppercase focus:border-[#176b4b] focus:outline-none sm:w-24"
        />
        <button
          type="submit"
          disabled={isAdding}
          className="flex shrink-0 items-center justify-center gap-1.5 rounded-xl bg-[#17201c] px-5 py-2.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          <Plus className="size-4" />
          <span>{isAdding ? 'Adding…' : 'Track price'}</span>
        </button>
      </form>

      {statusMsg && (
        <div className="flex items-center gap-2 rounded-xl border border-[#cde0d3] bg-[#e8f2ec] p-3 text-xs text-[#176b4b]">
          <CheckCircle2 className="size-4 shrink-0" />
          <span>{statusMsg}</span>
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-[#68756d]">
          Tracked items ({products.length})
        </h3>
        {products.length === 0 ? (
          <div className="rounded-xl border border-[#e2e6df] bg-[#fafbf9] p-6 text-center text-xs text-[#68756d]">
            No products are being tracked.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {products.map((product) => (
              <div key={product.id} className="flex items-start justify-between gap-3 rounded-xl border border-[#e2e6df] bg-white p-4 shadow-sm">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <ShoppingBag className="size-4 shrink-0 text-[#176b4b]" />
                    <h4 className="truncate text-xs font-bold">{product.productName}</h4>
                  </div>
                  <a href={product.productUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 truncate text-[11px] text-[#68756d] hover:text-[#176b4b]">
                    <ExternalLink className="size-3 shrink-0" />
                    <span className="truncate">{product.productUrl}</span>
                  </a>
                  <div className="pt-1 text-xs font-mono">
                    Target: <strong>{formatMoney(product.targetPrice, product.currency)}</strong>
                    {' · '}Current: {formatMoney(product.currentPrice, product.currency)}
                  </div>
                </div>
                <span className="shrink-0 rounded-full border border-[#e2e6df] bg-[#f0f2ef] px-2.5 py-1 text-[10px] font-mono font-bold text-[#526259]">
                  {product.status === 'target_reached' ? 'REVIEW REQUIRED' : product.status.replaceAll('_', ' ').toUpperCase()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </GlowCard>
  );
}
