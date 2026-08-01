'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, UtensilsCrossed, ShoppingCart, Package, ExternalLink, Clock, Activity } from 'lucide-react';
import GlowCard from '../shared/GlowCard';
import type { LiveOrder } from '@/lib/order-console';

interface OrdersResponse {
  success: boolean;
  orders: LiveOrder[];
  counts: { food: number; zepto: number; product: number; total: number };
  fetchedAt: number;
}

const ENGINE_META: Record<LiveOrder['engine'], { label: string; icon: React.ReactNode; badge: string }> = {
  food: {
    label: 'Swiggy Food',
    icon: <UtensilsCrossed className="w-3.5 h-3.5" />,
    badge: 'bg-[#ffefe3] text-[#b45309] border-[#f5d7b8]',
  },
  zepto: {
    label: 'Zepto',
    icon: <ShoppingCart className="w-3.5 h-3.5" />,
    badge: 'bg-[#efe9ff] text-[#6d4bd6] border-[#ddd2f5]',
  },
  product: {
    label: 'Product (Prava)',
    icon: <Package className="w-3.5 h-3.5" />,
    badge: 'bg-[#e3f3ff] text-[#0b6bcb] border-[#c3e4fb]',
  },
};

const STATUS_LABEL: Record<string, string> = {
  awaiting_payment_method: 'Awaiting payment method',
  awaiting_registration_name: 'Needs name to register',
  awaiting_prava_approval: 'Awaiting Prava approval',
  placing: 'Placing order',
  approved_pending_execution: 'Approved — pending execution',
};

const STATUS_STYLE: Record<string, string> = {
  awaiting_payment_method: 'bg-[#faf7ef] text-[#9b6300] border-[#e4ded0]',
  awaiting_registration_name: 'bg-[#faf7ef] text-[#9b6300] border-[#e4ded0]',
  awaiting_prava_approval: 'bg-[#e8f2ec] text-[#176b4b] border-[#cde0d3]',
  placing: 'bg-[#e3f3ff] text-[#0b6bcb] border-[#c3e4fb]',
  approved_pending_execution: 'bg-[#f0f2ef] text-[#526259] border-[#e2e6df]',
};

function itemsLabel(order: LiveOrder): string {
  if (order.engine === 'product') {
    return `${order.productQuery}${order.vendorName ? ` — ${order.vendorName}` : ''}`;
  }
  return order.items.map((i) => `${i.quantity > 1 ? `${i.quantity}× ` : ''}${i.name}`).join(', ');
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m ${seconds % 60}s`;
}

function formatAmount(order: LiveOrder): string {
  if (order.engine === 'product') return `${order.currency} ${order.amount.toFixed(2)}`;
  return `₹${order.total.toLocaleString('en-IN')}`;
}

export default function OrderConsolePanel() {
  const [data, setData] = useState<OrdersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchOrders = useCallback(async (silent = false) => {
    try {
      const adminKey = process.env.NEXT_PUBLIC_ORDER_CONSOLE_KEY;
      const res = await fetch('/api/orders', {
        cache: 'no-store',
        headers: adminKey ? { 'x-admin-key': adminKey } : undefined,
      });
      if (res.status === 401) {
        setData(null);
        setError('Order console is locked — set NEXT_PUBLIC_ORDER_CONSOLE_KEY to match the server ORDER_CONSOLE_KEY.');
        return;
      }
      const json = await res.json();
      if (json.success) {
        setData(json);
        setError(null);
        setLastRefresh(new Date());
      } else {
        setError(json.error || 'Failed to load orders');
      }
    } catch (e: any) {
      if (!silent) setError(e?.message || 'Failed to load orders');
    }
  }, []);

  useEffect(() => {
    fetchOrders();
    timerRef.current = setInterval(() => fetchOrders(true), 8000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchOrders]);

  const total = data?.counts?.total ?? 0;
  const orders = data?.orders ?? [];

  return (
    <GlowCard className="p-6 md:p-8 rounded-2xl relative overflow-hidden space-y-6">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#e8f2ec] border border-[#cde0d3] text-[#176b4b] text-xs font-mono">
            <Activity className="w-3.5 h-3.5" />
            <span>LIVE ORDER CONSOLE</span>
          </div>
          <h2 className="text-xl font-bold text-[#17201c]">
            Orders Across Swiggy · Zepto · Shopify/Amazon
          </h2>
          <p className="text-xs text-[#68756d]">
            Pending orders parked in chat while they wait for a cash/upi/card answer or a Prava passkey approval. Auto-refreshes every 8s.
          </p>
        </div>

        <button
          onClick={() => fetchOrders()}
          className="px-4 py-2.5 rounded-xl bg-[#17201c] hover:bg-black text-white font-bold text-xs flex items-center gap-2 transition-all shrink-0 cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh Now</span>
        </button>
      </div>

      {/* Count strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(['food', 'zepto', 'product', 'total'] as const).map((key) => {
          const label = key === 'food' ? 'Swiggy Food' : key === 'zepto' ? 'Zepto' : key === 'product' ? 'Product' : 'Total';
          const count = key === 'total' ? total : (data?.counts?.[key] ?? 0);
          return (
            <div key={key} className="p-3 rounded-xl bg-[#fafbf9] border border-[#e2e6df]">
              <p className="text-[10px] font-mono font-bold text-[#68756d] uppercase tracking-wider">{label}</p>
              <p className="mt-1 text-2xl font-bold text-[#17201c] tabular-nums">{count}</p>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-[#fdf0f0] border border-[#f3c9c9] text-xs font-mono text-[#b3261e]">
          ⚠️ {error}
        </div>
      )}

      {orders.length === 0 ? (
        <div className="p-6 text-center rounded-xl bg-[#fafbf9] border border-[#e2e6df] text-xs text-[#68756d] font-mono">
          No pending orders right now. Send an order via Telegram/Linq — e.g. "order me paneer tikka", "order me amul milk",
          or "order me a gaming mouse within 2000 - 3000" — and it will appear here while awaiting payment.
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map((order) => {
            const meta = ENGINE_META[order.engine];
            const statusLabel = STATUS_LABEL[order.status] || order.status;
            const statusStyle = STATUS_STYLE[order.status] || STATUS_STYLE.awaiting_payment_method;
            const payLink = order.paymentLink;
            return (
              <div key={`${order.engine}-${order.chatId}-${order.createdAt}`} className="p-4 rounded-xl bg-white border border-[#e2e6df] shadow-sm space-y-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono font-bold border ${meta.badge}`}>
                      {meta.icon}
                      <span>{meta.label}</span>
                    </span>
                    <span className={`px-2.5 py-1 rounded-full text-[10px] font-mono font-bold border shrink-0 ${statusStyle}`}>
                      {statusLabel.toUpperCase()}
                    </span>
                  </div>
                  <span className="inline-flex items-center gap-1 text-[10px] font-mono text-[#68756d]">
                    <Clock className="w-3 h-3" />
                    {formatAge(order.ageSeconds)} ago
                  </span>
                </div>

                <div className="text-xs font-semibold text-[#17201c] break-words">
                  {itemsLabel(order)}
                </div>

                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-[11px] font-mono text-[#68756d] space-x-3">
                    <span>Chat: <strong className="text-[#17201c]">{order.chatId}</strong></span>
                    <span>Total: <strong className="text-[#176b4b]">{formatAmount(order)}</strong></span>
                    {order.engine !== 'product' && order.method && (
                      <span>Method: <strong className="text-[#17201c] uppercase">{order.method}</strong></span>
                    )}
                  </div>

                  {payLink ? (
                    <a
                      href={payLink}
                      target="_blank"
                      rel="noreferrer"
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-white text-[11px] font-bold transition-all shrink-0 ${
                        order.status === 'approved_pending_execution' ? 'bg-[#526259] hover:bg-[#3d4a43]' : 'bg-[#176b4b] hover:bg-[#10543a]'
                      }`}
                    >
                      <ExternalLink className="w-3 h-3" />
                      <span>{order.status === 'approved_pending_execution' ? 'View Payment' : 'Approve Payment'}</span>
                    </a>
                  ) : (
                    <span className="text-[10px] font-mono text-[#9ba5a0]">waiting on payment choice…</span>
                  )}
                </div>
              </div>
            );
          })}

          {lastRefresh && (
            <p className="text-right text-[10px] font-mono text-[#9ba5a0]">
              Last refresh {lastRefresh.toLocaleTimeString()}
            </p>
          )}
        </div>
      )}
    </GlowCard>
  );
}
