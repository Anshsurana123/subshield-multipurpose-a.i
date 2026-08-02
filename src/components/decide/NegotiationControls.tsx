"use client";

import { ArrowRight, Calculator, Check, Sparkles } from "lucide-react";
import { Alternative, Subscription } from "@/lib/types";
import GlowCard from "@/components/shared/GlowCard";

interface Props {
  subscription: Subscription | null;
  alternatives: Alternative[];
  isNegotiating: boolean;
  negotiationComplete: boolean;
  finalPrice: number | null;
  onEstimateNegotiation: () => void;
}

export function NegotiationControls({ subscription, alternatives, isNegotiating, negotiationComplete, finalPrice, onEstimateNegotiation }: Props) {
  if (!subscription) {
    return <GlowCard className="flex h-full min-h-[260px] items-center p-6" animate={false}>
      <div>
        <p className="eyebrow">Decide</p>
        <h3 className="mt-2 font-heading text-xl font-bold tracking-[-0.03em] text-[#17201c]">Select a subscription to continue</h3>
        <p className="mt-2 max-w-sm text-sm leading-6 text-[#68756d]">We will show the current rate, possible alternatives, and the options you can take—without making any changes on your behalf.</p>
      </div>
    </GlowCard>;
  }

  const currentPrice = subscription.currentPrice ?? (subscription as any).price ?? 0;
  const vendorName = subscription.vendor || (subscription as any).vendorName || 'Subscription';
  const monthlySaving = finalPrice !== null ? Math.max(0, currentPrice - finalPrice) : 0;

  return (
    <GlowCard className="h-full p-5 sm:p-6" animate={false}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Decide</p>
          <h3 className="mt-1 font-heading text-xl font-bold tracking-[-0.03em] text-[#17201c]">{vendorName}</h3>
          <p className="mt-1 text-sm text-[#68756d]">Current rate <span className="font-semibold text-[#26332c]">${currentPrice.toFixed(2)}/month</span></p>
        </div>
        <span className="rounded-md border border-[#e2e6df] bg-[#fafbf9] px-2 py-1 text-[10px] font-semibold capitalize text-[#607067]">{subscription.status.replace('-', ' ')}</span>
      </div>

      {!isNegotiating && !negotiationComplete && <div className="mt-6 rounded-xl border border-[#dce7de] bg-[#f4f8f4] p-4">
        <div className="flex gap-3">
          <Sparkles size={17} className="mt-0.5 shrink-0 text-[#176b4b]" />
          <div>
            <h4 className="text-sm font-semibold text-[#26332c]">Estimate a better rate</h4>
            <p className="mt-1 text-xs leading-5 text-[#68756d]">Generate a planning estimate using the alternatives below. This does not contact the merchant or change your subscription.</p>
          </div>
        </div>
        <button onClick={onEstimateNegotiation} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#176b4b] px-4 py-2.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#10543a]">Generate rate estimate <ArrowRight size={14} /></button>
      </div>}

      {isNegotiating && <div className="mt-6 rounded-xl border border-[#dce7de] bg-[#f4f8f4] p-5">
        <div className="flex items-center gap-3"><span className="size-2 animate-pulse rounded-full bg-[#176b4b]" /><div><p className="text-sm font-semibold text-[#26332c]">Building rate estimate</p><p className="mt-1 text-xs text-[#6b766f]">Follow the planning record above. No subscription or payment action is being taken.</p></div></div>
      </div>}

      {negotiationComplete && finalPrice !== null && <div className="mt-6 rounded-xl border border-[#cde0d3] bg-[#f0f7f2] p-5">
        <div className="flex gap-3"><Calculator className="shrink-0 text-[#176b4b]" size={20} /><div><p className="text-sm font-semibold text-[#1b3a2a]">Estimated negotiated rate</p><p className="mt-1 text-xs leading-5 text-[#476051]">${finalPrice.toFixed(2)}/month, with projected savings of ${monthlySaving.toFixed(2)} each month (${(monthlySaving * 12).toFixed(2)} yearly).</p><p className="mt-2 text-[11px] leading-4 text-[#68756d]">Estimate only. No offer was accepted, no merchant order was created, and no payment was initiated.</p></div></div>
      </div>}

      {alternatives.length > 0 && <div className="mt-6 border-t border-[#e8ece7] pt-5"><div className="mb-3"><p className="text-sm font-semibold text-[#26332c]">Alternative estimates</p><p className="mt-0.5 text-xs text-[#748078]">Read-only comparisons. Prices and feature matches should be verified with each provider.</p></div><div className="space-y-2">{alternatives.map((alternative, index) => {
        const projectedSaving = Math.max(0, currentPrice - alternative.price);
        return <article key={`${alternative.name}-${index}`} className="rounded-xl border border-[#e2e6df] bg-[#fafbf9] p-3.5">
          <div className="flex items-start justify-between gap-3"><div><h4 className="text-sm font-semibold text-[#26332c]">{alternative.name}</h4><p className="mt-0.5 text-xs text-[#6b766f]">${alternative.price.toFixed(2)}/month · {alternative.featureParityScore || 80}% estimated feature match</p></div><span className="rounded-md bg-[#e8f2ec] px-2 py-1 text-[10px] font-semibold text-[#176b4b]">Projected save ${projectedSaving.toFixed(2)}</span></div>
          {alternative.features?.length > 0 && <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5">{alternative.features.slice(0, 2).map((feature) => <span key={feature} className="inline-flex items-center gap-1 text-[11px] text-[#627068]"><Check size={12} className="text-[#176b4b]" />{feature}</span>)}</div>}
        </article>;
      })}</div></div>}
    </GlowCard>
  );
}

export default NegotiationControls;
