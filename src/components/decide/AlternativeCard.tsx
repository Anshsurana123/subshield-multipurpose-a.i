"use client";

import { ArrowRight, Check } from "lucide-react";
import { Alternative } from "@/lib/types";

interface Props {
  alternative: Alternative;
  onSelect?: () => void;
}

export function AlternativeCard({ alternative, onSelect }: Props) {
  const savings = alternative.savings || 0;
  const parity = alternative.featureParityScore || 80;

  return (
    <article className="rounded-xl border border-[#e2e6df] bg-[#fafbf9] p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-[#26332c]">{alternative.name}</h4>
          <p className="mt-0.5 text-xs text-[#6b766f]">${alternative.price.toFixed(2)}/month · {parity}% feature match</p>
        </div>
        <span className="rounded-md bg-[#e8f2ec] px-2 py-1 text-[10px] font-semibold text-[#176b4b]">Save ${savings.toFixed(2)}</span>
      </div>
      {alternative.features?.length > 0 && <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5">
        {alternative.features.slice(0, 2).map((feature) => <span key={feature} className="inline-flex items-center gap-1 text-[11px] text-[#627068]"><Check size={12} className="text-[#176b4b]" />{feature}</span>)}
      </div>}
      <button onClick={onSelect} className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#176b4b] hover:text-[#0e5036]">Choose this alternative <ArrowRight size={13} /></button>
    </article>
  );
}

export default AlternativeCard;
