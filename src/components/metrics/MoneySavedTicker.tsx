"use client";

import { useEffect, useState } from "react";
import { TrendingDown } from "lucide-react";
import GlowCard from "@/components/shared/GlowCard";
import StatsRow from "./StatsRow";

function AnimatedCounter({ value }: { value: number }) {
  const [displayValue, setDisplayValue] = useState(0);
  useEffect(() => {
    let frame = 0;
    const initialValue = displayValue;
    const startedAt = performance.now();
    const update = (now: number) => {
      const progress = Math.min((now - startedAt) / 650, 1);
      setDisplayValue(initialValue + (value - initialValue) * (1 - Math.pow(1 - progress, 3)));
      if (progress < 1) frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <>{displayValue.toFixed(2)}</>;
}

export function MoneySavedTicker({ totalSaved, blockedHikes, cancelledUnused, negotiatedDiscounts }: { totalSaved: number; blockedHikes: number; cancelledUnused: number; negotiatedDiscounts: number }) {
  const stats = [
    { label: "Price rises stopped", value: blockedHikes, color: "text-[#9b6300]" },
    { label: "Subscriptions removed", value: cancelledUnused, color: "text-[#a53630]" },
    { label: "Rates improved", value: negotiatedDiscounts, color: "text-[#176b4b]" },
  ];
  return <GlowCard className="flex h-full flex-col p-5 sm:p-6" animate={false}>
    <div className="flex items-center gap-2 text-[#176b4b]"><TrendingDown size={17} /><p className="eyebrow !text-[#176b4b]">Recovered value</p></div>
    <div className="flex flex-1 items-center py-5"><p className="font-heading text-4xl font-bold tracking-[-0.05em] text-[#17201c]"><span className="text-[#176b4b]">$</span><AnimatedCounter value={totalSaved} /><span className="ml-1 text-sm font-medium tracking-normal text-[#7a857e]">/ year</span></p></div>
    <div className="border-t border-[#e8ece7] pt-4"><StatsRow stats={stats} /></div>
  </GlowCard>;
}

export default MoneySavedTicker;
