"use client";

import { useEffect, useState } from "react";
import { Clock3, ShieldCheck } from "lucide-react";
import { Mandate } from "@/lib/types";

export function MandateCard({ mandate }: { mandate: Mandate }) {
  const [timeLeft, setTimeLeft] = useState('');
  useEffect(() => {
    const updateTimer = () => {
      const diff = new Date(mandate.expiresAt).getTime() - Date.now();
      if (!mandate.expiresAt || diff <= 0) return setTimeLeft(diff <= 0 ? 'Expired' : '—');
      setTimeLeft(`${Math.floor(diff / 60000)}m ${Math.floor((diff % 60000) / 1000)}s`);
    };
    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [mandate.expiresAt]);

  const active = mandate.status === 'active' || mandate.status === 'completed' || (mandate.status as string) === 'ACTIVE';
  const outcome = mandate.checkoutOutcome;
  return <article className="rounded-xl border border-[#dce5dd] bg-[#fafbf9] p-4">
    <div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-[#26332c]">{mandate.vendor}</h3><p className="mt-1 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#176b4b]"><span className="size-1.5 rounded-full bg-[#176b4b]" />{active ? 'Active' : mandate.status}</p></div><div className="text-right"><p className="text-lg font-semibold tracking-[-0.03em] text-[#17201c]">${(mandate.amount || 0).toFixed(2)}</p><p className="text-[10px] text-[#7a857e]">monthly limit</p></div></div>
    <div className="mt-4 flex items-center justify-between border-t border-[#e8ece7] pt-3 text-xs"><span className="inline-flex items-center gap-1.5 text-[#69776e]"><Clock3 size={13} />Expires in {timeLeft}</span>{outcome && <span className="font-mono text-[#5e6b63]">•••• {outcome.tokenLast4}</span>}</div>
    {active && <button className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#a53630] hover:text-[#852c27]"><ShieldCheck size={13} />Revoke payment</button>}
  </article>;
}

export default MandateCard;
