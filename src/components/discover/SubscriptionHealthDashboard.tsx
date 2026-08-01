"use client";

import { useState } from "react";
import { Subscription } from "@/lib/types";
import { SubscriptionCard } from "./SubscriptionCard";

interface DashboardProps {
  subscriptions: Subscription[];
  onNegotiate: (id: string) => void;
  selectedId?: string | null;
}

const tabs = ['All', 'Price Hiked', 'Unused', 'Duplicate', 'Trial'] as const;

export function SubscriptionHealthDashboard({ subscriptions, onNegotiate, selectedId }: DashboardProps) {
  const [filter, setFilter] = useState<(typeof tabs)[number]>('All');
  const filteredSubs = subscriptions.filter((sub) =>
    filter === 'All' ||
    (filter === 'Price Hiked' && sub.status === 'price-hiked') ||
    (filter === 'Unused' && sub.status === 'unused') ||
    (filter === 'Duplicate' && sub.status === 'duplicate') ||
    (filter === 'Trial' && sub.status === 'trial')
  );

  const getCount = (tab: (typeof tabs)[number]) => tab === 'All' ? subscriptions.length : subscriptions.filter((sub) => {
    const expected = tab.toLowerCase().replace(' ', '-') as Subscription['status'];
    return sub.status === expected;
  }).length;

  return (
    <section className="app-surface h-full rounded-2xl p-5 sm:p-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <p className="eyebrow">Discover</p>
          <h3 className="mt-1 font-heading text-xl font-bold tracking-[-0.03em] text-[#17201c]">Subscription health</h3>
          <p className="mt-1 text-sm text-[#68756d]">{subscriptions.length} recurring charges reviewed</p>
        </div>
        <div className="rounded-lg border border-[#e2e6df] bg-[#fafbf9] px-3 py-2 text-xs text-[#647169]">Select a card to review your options</div>
      </div>

      <div className="mt-6 flex gap-2 overflow-x-auto pb-1">
        {tabs.map((tab) => {
          const isActive = filter === tab;
          return <button key={tab} onClick={() => setFilter(tab)} className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${isActive ? 'bg-[#173d2d] text-white' : 'border border-[#e2e6df] bg-white text-[#647169] hover:bg-[#f6f8f5]'}`}>
            {tab} <span className={`ml-1 ${isActive ? 'text-white/70' : 'text-[#8a958d]'}`}>{getCount(tab)}</span>
          </button>;
        })}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
        {filteredSubs.map((sub) => <div key={sub.id} className={selectedId === sub.id ? 'rounded-xl ring-2 ring-[#176b4b] ring-offset-2 ring-offset-white' : ''}>
          <SubscriptionCard subscription={sub} onNegotiate={() => onNegotiate(sub.id)} />
        </div>)}
        {filteredSubs.length === 0 && <p className="col-span-full py-12 text-center text-sm text-[#748078]">No subscriptions match this filter.</p>}
      </div>
    </section>
  );
}

export default SubscriptionHealthDashboard;
