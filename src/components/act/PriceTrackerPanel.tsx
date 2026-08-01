'use client';

import React, { useState, useEffect } from 'react';
import { ShoppingBag, Plus, RefreshCw, Sparkles, CheckCircle2, ExternalLink, Zap } from 'lucide-react';
import GlowCard from '../shared/GlowCard';
import { TrackedProduct } from '@/lib/types';

export default function PriceTrackerPanel() {
  const [products, setProducts] = useState<TrackedProduct[]>([]);
  const [productUrl, setProductUrl] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const fetchProducts = async () => {
    try {
      const res = await fetch('/api/tracker?userId=demo-user-id');
      const data = await res.json();
      if (data.success && data.products) {
        setProducts(data.products);
      }
    } catch (err) {
      console.error('Failed to fetch tracked products:', err);
    }
  };

  useEffect(() => {
    fetchProducts();
  }, []);

  const handleAddProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!productUrl || !targetPrice) return;

    setIsAdding(true);
    setStatusMsg(null);
    try {
      const res = await fetch('/api/tracker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'demo-user-id',
          productUrl,
          targetPrice: parseFloat(targetPrice),
        }),
      });
      const data = await res.json();
      if (data.success) {
        setProductUrl('');
        setTargetPrice('');
        setStatusMsg('✅ Item added to Price Tracker! Active monitoring via Steel.');
        fetchProducts();
      }
    } catch (err) {
      console.error('Failed to add product:', err);
    } finally {
      setIsAdding(false);
    }
  };

  const handleRunPriceScan = async () => {
    setIsScanning(true);
    setStatusMsg(null);
    try {
      const res = await fetch('/api/tracker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'scan', userId: 'demo-user-id' }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.purchased > 0) {
          setStatusMsg(`🎉 Target price hit! Automatically executed ${data.purchased} Prava Instant Buy Order(s).`);
        } else {
          setStatusMsg('Checked tracked products via Steel browser. Prices are being monitored.');
        }
        fetchProducts();
      }
    } catch (err) {
      console.error('Scan error:', err);
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <GlowCard className="p-6 md:p-8 rounded-2xl relative overflow-hidden space-y-6">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#e8f2ec] border border-[#cde0d3] text-[#176b4b] text-xs font-mono">
            <Zap className="w-3.5 h-3.5" />
            <span>PRAVA INSTANT-BUY PRICE TRACKER</span>
          </div>
          <h2 className="text-xl font-bold text-[#17201c]">
            Track Product Prices & Auto-Buy via Telegram / Web
          </h2>
          <p className="text-xs text-[#68756d]">
            Paste product links below (or send via Telegram/Linq). When target price is reached, SubShield issues a single-use Prava Virtual Card and executes the purchase automatically.
          </p>
        </div>

        <button
          onClick={handleRunPriceScan}
          disabled={isScanning}
          className="px-4 py-2.5 rounded-xl bg-[#176b4b] hover:bg-[#10543a] text-white font-bold text-xs flex items-center gap-2 transition-all shrink-0 cursor-pointer disabled:opacity-50"
        >
          {isScanning ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>Checking Live Prices...</span>
            </>
          ) : (
            <>
              <Sparkles className="w-3.5 h-3.5" />
              <span>Scan Prices Now</span>
            </>
          )}
        </button>
      </div>

      <form onSubmit={handleAddProduct} className="flex flex-col sm:flex-row gap-3">
        <input
          type="url"
          required
          placeholder="Paste product URL (Amazon, BestBuy, software license...)"
          value={productUrl}
          onChange={(e) => setProductUrl(e.target.value)}
          className="flex-1 px-4 py-2.5 rounded-xl border border-[#e2e6df] bg-[#fafbf9] text-xs text-[#17201c] focus:outline-none focus:border-[#176b4b]"
        />
        <input
          type="number"
          step="0.01"
          required
          placeholder="Target Price ($)"
          value={targetPrice}
          onChange={(e) => setTargetPrice(e.target.value)}
          className="w-full sm:w-36 px-4 py-2.5 rounded-xl border border-[#e2e6df] bg-[#fafbf9] text-xs text-[#17201c] focus:outline-none focus:border-[#176b4b]"
        />
        <button
          type="submit"
          disabled={isAdding}
          className="px-5 py-2.5 rounded-xl bg-[#17201c] hover:bg-black text-white font-semibold text-xs flex items-center justify-center gap-1.5 shrink-0 cursor-pointer disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
          <span>Track & Auto-Buy</span>
        </button>
      </form>

      {statusMsg && (
        <div className="p-3 rounded-xl bg-[#e8f2ec] border border-[#cde0d3] text-xs font-mono text-[#176b4b] flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{statusMsg}</span>
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-xs font-mono font-bold text-[#68756d] uppercase tracking-wider">
          Tracked Items ({products.length})
        </h3>

        {products.length === 0 ? (
          <div className="p-6 text-center rounded-xl bg-[#fafbf9] border border-[#e2e6df] text-xs text-[#68756d] font-mono">
            No products currently tracked. Paste a product link above or send via Telegram to activate automated Prava purchase orders!
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {products.map((p) => (
              <div key={p.id} className="p-4 rounded-xl bg-white border border-[#e2e6df] shadow-sm flex items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <ShoppingBag className="w-4 h-4 text-[#176b4b] shrink-0" />
                    <h4 className="text-xs font-bold text-[#17201c] truncate">{p.productName}</h4>
                  </div>
                  <a href={p.productUrl} target="_blank" rel="noreferrer" className="text-[11px] text-[#68756d] hover:text-[#176b4b] flex items-center gap-1 truncate font-mono">
                    <ExternalLink className="w-3 h-3 shrink-0" />
                    <span className="truncate">{p.productUrl}</span>
                  </a>
                  <div className="text-xs font-mono pt-1">
                    Target: <strong className="text-[#176b4b]">${p.targetPrice.toFixed(2)}</strong> | Current: ${p.currentPrice.toFixed(2)}
                  </div>
                </div>

                <span className={`px-2.5 py-1 rounded-full text-[10px] font-mono font-bold shrink-0 ${
                  p.status === 'purchased' ? 'bg-[#e8f2ec] text-[#176b4b] border border-[#cde0d3]' :
                  p.status === 'target_reached' ? 'bg-[#faf7ef] text-[#9b6300] border border-[#e4ded0]' :
                  'bg-[#f0f2ef] text-[#526259] border border-[#e2e6df]'
                }`}>
                  {p.status.toUpperCase()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </GlowCard>
  );
}
