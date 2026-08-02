"use client";

import { Calculator, Eye, TrendingDown } from "lucide-react";
import { Alternative, Subscription } from "@/lib/types";
import GlowCard from "@/components/shared/GlowCard";

interface Props {
  subscription: Subscription | null;
  negotiatedPrice: number | null;
  alternatives: Alternative[];
}

export function SavingsProjectionPanel({ subscription, negotiatedPrice, alternatives }: Props) {
  const currentPrice = subscription?.currentPrice ?? null;
  const lowestAlternative = alternatives.reduce<Alternative | null>(
    (lowest, alternative) => (!lowest || alternative.price < lowest.price ? alternative : lowest),
    null
  );

  const negotiatedMonthlySavings =
    currentPrice !== null && negotiatedPrice !== null
      ? Math.max(0, currentPrice - negotiatedPrice)
      : null;
  const alternativeMonthlySavings =
    currentPrice !== null && lowestAlternative
      ? Math.max(0, currentPrice - lowestAlternative.price)
      : null;
  const bestAnnualProjection = Math.max(
    negotiatedMonthlySavings ?? 0,
    alternativeMonthlySavings ?? 0
  ) * 12;

  return (
    <GlowCard className="h-full" animate={false}>
      <div className="flex items-start justify-between gap-4 border-b border-[#e8ece7] p-5 sm:p-6">
        <div className="flex gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-[#e8f2ec] text-[#176b4b]">
            <Calculator size={19} />
          </div>
          <div>
            <p className="eyebrow">Estimate</p>
            <h2 className="mt-1 font-heading text-lg font-bold tracking-[-0.03em] text-[#17201c]">Savings scenarios</h2>
            <p className="mt-1 text-xs text-[#718077]">Read-only comparisons for planning</p>
          </div>
        </div>
        <div className="rounded-lg border border-[#e2e6df] bg-[#fafbf9] px-3 py-2 text-right">
          <p className="text-[10px] text-[#7a857e]">Best projected yearly savings</p>
          <p className="mt-0.5 text-sm font-semibold text-[#26332c]">${bestAnnualProjection.toFixed(2)}</p>
        </div>
      </div>

      <div className="p-5 sm:p-6">
        {!subscription ? (
          <div className="flex min-h-[112px] items-center gap-4 rounded-xl border border-dashed border-[#d8dfd8] bg-[#fafbf9] p-5">
            <div className="grid size-10 shrink-0 place-items-center rounded-full border border-[#dfe6df] bg-white text-[#6f7c73]">
              <Eye size={18} />
            </div>
            <div>
              <p className="text-sm font-semibold text-[#48574f]">Select a subscription to compare scenarios</p>
              <p className="mt-1 max-w-lg text-xs leading-5 text-[#77837b]">No subscription, merchant account, or payment method will be changed from this dashboard.</p>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <ProjectionCard label="Current listed rate" value={currentPrice} detail={`${subscription.vendor} · reference only`} />
              <ProjectionCard
                label="Negotiated-rate estimate"
                value={negotiatedPrice}
                detail={negotiatedMonthlySavings === null ? 'Generate an estimate to compare' : `Projected save $${negotiatedMonthlySavings.toFixed(2)}/month`}
              />
              <ProjectionCard
                label="Lowest alternative estimate"
                value={lowestAlternative?.price ?? null}
                detail={lowestAlternative && alternativeMonthlySavings !== null ? `${lowestAlternative.name} · projected save $${alternativeMonthlySavings.toFixed(2)}/month` : 'No alternative estimate available'}
              />
            </div>
            <p className="mt-4 flex items-start gap-2 rounded-lg border border-[#e5e8e2] bg-[#fafbf9] px-3 py-2.5 text-[11px] leading-5 text-[#68756d]">
              <TrendingDown size={14} className="mt-0.5 shrink-0 text-[#176b4b]" />
              Estimates are informational and may exclude taxes, fees, plan differences, or future price changes. No offer was accepted and no payment or merchant order was created.
            </p>
          </>
        )}
      </div>
    </GlowCard>
  );
}

function ProjectionCard({ label, value, detail }: { label: string; value: number | null; detail: string }) {
  return (
    <article className="rounded-xl border border-[#e2e6df] bg-[#fafbf9] p-4">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-[#7a857e]">{label}</p>
      <p className="mt-2 text-xl font-semibold tracking-[-0.03em] text-[#17201c]">{value === null ? '—' : `$${value.toFixed(2)}/mo`}</p>
      <p className="mt-1 text-xs leading-5 text-[#68756d]">{detail}</p>
    </article>
  );
}

export default SavingsProjectionPanel;
