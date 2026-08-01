"use client";

import { ArrowRight, BadgeCheck, Sparkles } from "lucide-react";
import { Alternative, NegotiationEvent, Subscription } from "@/lib/types";
import AlternativeCard from "./AlternativeCard";
import GlowCard from "@/components/shared/GlowCard";

interface Props {
  subscription: Subscription | null;
  alternatives: Alternative[];
  negotiationEvents: NegotiationEvent[];
  isNegotiating: boolean;
  negotiationComplete: boolean;
  finalPrice: number | null;
  onStartNegotiation: () => void;
  onAcceptOffer: () => void;
  onDeclineAndSwitch: (alt: Alternative) => void;
}

export function NegotiationControls({ subscription, alternatives, isNegotiating, negotiationComplete, finalPrice, onStartNegotiation, onAcceptOffer, onDeclineAndSwitch }: Props) {
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
  const monthlySaving = finalPrice ? currentPrice - finalPrice : 0;

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
            <h4 className="text-sm font-semibold text-[#26332c]">Ask for a better rate</h4>
            <p className="mt-1 text-xs leading-5 text-[#68756d]">We will use the alternatives below as leverage and keep a transparent record of the conversation.</p>
          </div>
        </div>
        <button onClick={onStartNegotiation} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#176b4b] px-4 py-2.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#10543a]">Start negotiation <ArrowRight size={14} /></button>
      </div>}

      {isNegotiating && <div className="mt-6 rounded-xl border border-[#dce7de] bg-[#f4f8f4] p-5">
        <div className="flex items-center gap-3"><span className="size-2 animate-pulse rounded-full bg-[#176b4b]" /><div><p className="text-sm font-semibold text-[#26332c]">Negotiation in progress</p><p className="mt-1 text-xs text-[#6b766f]">Follow the activity record above. This usually takes a moment.</p></div></div>
      </div>}

      {negotiationComplete && finalPrice && <div className="mt-6 rounded-xl border border-[#cde0d3] bg-[#f0f7f2] p-5">
        <div className="flex gap-3"><BadgeCheck className="shrink-0 text-[#176b4b]" size={20} /><div><p className="text-sm font-semibold text-[#1b3a2a]">New rate secured</p><p className="mt-1 text-xs leading-5 text-[#476051]">${finalPrice.toFixed(2)}/month, saving ${monthlySaving.toFixed(2)} each month (${(monthlySaving * 12).toFixed(2)} yearly).</p></div></div>
        <button onClick={onAcceptOffer} className="mt-4 w-full rounded-lg bg-[#176b4b] px-4 py-2.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#10543a]">Approve protected payment</button>
        {alternatives.length > 0 && <button onClick={() => onDeclineAndSwitch(alternatives[0])} className="mt-2 w-full rounded-lg px-4 py-2 text-xs font-semibold text-[#4e5f55] transition-colors hover:bg-[#f3f5f1]">Choose {alternatives[0].name} instead</button>}
      </div>}

      {!negotiationComplete && alternatives.length > 0 && <div className="mt-6 border-t border-[#e8ece7] pt-5"><div className="mb-3"><p className="text-sm font-semibold text-[#26332c]">Alternatives worth considering</p><p className="mt-0.5 text-xs text-[#748078]">Comparable services discovered for this subscription.</p></div><div className="space-y-2">{alternatives.map((alternative, index) => <AlternativeCard key={`${alternative.name}-${index}`} alternative={alternative} onSelect={() => onDeclineAndSwitch(alternative)} />)}</div></div>}
    </GlowCard>
  );
}

export default NegotiationControls;
