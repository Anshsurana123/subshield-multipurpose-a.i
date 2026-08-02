'use client';

import Header from '@/components/layout/Header';
import PriceTrackerPanel from '@/components/act/PriceTrackerPanel';

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-mesh text-[#17201c]">
      <Header activePhase="ACT" />

      <main className="mx-auto w-full max-w-[1100px] space-y-6 px-4 py-7 sm:px-6 sm:py-10 lg:px-8">
        <section className="rounded-2xl border border-[#cde0d3] bg-[#f0f7f2] p-5">
          <p className="eyebrow">READ-ONLY SAFETY MODE</p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight">Price monitoring without automatic checkout</h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#526259]">
            PRAVA is rebuilding purchase execution around authenticated users, exact merchant quotes,
            explicit confirmation, and durable reconciliation. Reaching a target only records an alert;
            it does not create a payment session or place an order.
          </p>
        </section>

        <PriceTrackerPanel />
      </main>
    </div>
  );
}
