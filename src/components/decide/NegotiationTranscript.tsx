"use client";

import { useEffect, useRef } from "react";
import { Bot, Circle } from "lucide-react";
import { NegotiationEvent } from "@/lib/types";
import TerminalLine from "@/components/shared/TerminalLine";
import GlowCard from "@/components/shared/GlowCard";

interface Props {
  events: NegotiationEvent[];
  isActive?: boolean;
}

export function NegotiationTranscript({ events, isActive = false }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [events]);

  return (
    <GlowCard className="flex h-full flex-col" animate={false}>
      <div className="flex items-center justify-between border-b border-[#e8ece7] px-5 py-3.5">
        <div className="flex items-center gap-2">
          <div className="grid size-7 place-items-center rounded-md bg-[#f0f2ef] text-[#4f6057]"><Bot size={14} /></div>
          <div>
            <h3 className="text-xs font-semibold text-[#26332c]">Negotiation activity</h3>
            <p className="text-[10px] text-[#7a857e]">A clear record of each step</p>
          </div>
        </div>
        <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold ${isActive ? 'text-[#176b4b]' : 'text-[#7a857e]'}`}>
          <Circle size={7} fill="currentColor" />{isActive ? 'In progress' : 'Ready'}
        </span>
      </div>
      <div ref={scrollRef} className="scrollbar-terminal flex-1 overflow-y-auto px-5 py-4">
        {events.length === 0 ? (
          <div className="flex h-full flex-col justify-center">
            <p className="text-sm font-medium text-[#47564e]">No negotiation in progress</p>
            <p className="mt-1 max-w-sm text-xs leading-5 text-[#7a857e]">Choose a subscription and start a negotiation when you are ready. The activity trail will appear here.</p>
          </div>
        ) : <div className="space-y-3">{events.map((event, index) => <TerminalLine key={`${event.timestamp}-${index}`} actor={event.actor} message={event.message} type={event.type} />)}</div>}
      </div>
    </GlowCard>
  );
}

export default NegotiationTranscript;
