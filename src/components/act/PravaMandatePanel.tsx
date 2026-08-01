"use client";

import { CreditCard, ShieldCheck } from "lucide-react";
import { Mandate } from "@/lib/types";
import MandateCard from "./MandateCard";
import GlowCard from "@/components/shared/GlowCard";

interface Props { mandates: Mandate[]; }

export function PravaMandatePanel({ mandates }: Props) {
  const activeMandates = mandates.filter((mandate) => mandate.status === 'active' || mandate.status === 'completed' || (mandate.status as string) === 'ACTIVE');
  const protectedSpend = activeMandates.reduce((sum, mandate) => sum + (mandate.amount || 0), 0);

  return <GlowCard className="h-full" animate={false}>
    <div className="flex items-start justify-between gap-4 border-b border-[#e8ece7] p-5 sm:p-6">
      <div className="flex gap-3"><div className="grid size-10 place-items-center rounded-xl bg-[#e8f2ec] text-[#176b4b]"><ShieldCheck size={19} /></div><div><p className="eyebrow">Act</p><h2 className="mt-1 font-heading text-lg font-bold tracking-[-0.03em] text-[#17201c]">Protected payments</h2><p className="mt-1 text-xs text-[#718077]">Merchant-specific mandates issued through Prava</p></div></div>
      <div className="rounded-lg border border-[#e2e6df] bg-[#fafbf9] px-3 py-2 text-right"><p className="text-[10px] text-[#7a857e]">Protected monthly</p><p className="mt-0.5 text-sm font-semibold text-[#26332c]">${protectedSpend.toFixed(2)}</p></div>
    </div>
    <div className="p-5 sm:p-6">
      {mandates.length === 0 ? <div className="flex min-h-[112px] items-center gap-4 rounded-xl border border-dashed border-[#d8dfd8] bg-[#fafbf9] p-5"><div className="grid size-10 shrink-0 place-items-center rounded-full border border-[#dfe6df] bg-white text-[#6f7c73]"><CreditCard size={18} /></div><div><p className="text-sm font-semibold text-[#48574f]">No protected payments yet</p><p className="mt-1 max-w-lg text-xs leading-5 text-[#77837b]">When you approve a negotiated rate, it will appear here with the merchant, spend limit, and expiration.</p></div></div> : <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{mandates.map((mandate) => <MandateCard key={mandate.id} mandate={mandate} />)}</div>}
    </div>
  </GlowCard>;
}

export default PravaMandatePanel;
