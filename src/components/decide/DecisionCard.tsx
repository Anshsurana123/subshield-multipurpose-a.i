'use client';

import React from 'react';
import { Calculator, Sparkles } from 'lucide-react';
import { Decision, Subscription, Alternative } from '@/lib/types';

interface DecisionCardProps {
  decision: Decision;
  subscription: Subscription;
  alternative?: Alternative;
  onEstimateNegotiation: () => void;
}

export default function DecisionCard({
  decision,
  subscription,
  alternative,
  onEstimateNegotiation,
}: DecisionCardProps) {
  const isEasy = subscription.replacementDifficulty === 'easy';
  const projectedMonthlySavings = alternative
    ? Math.max(0, subscription.currentPrice - alternative.price)
    : 0;

  return (
    <div className="p-5 rounded-xl bg-white border border-[#e2e6df] shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-semibold ${
            isEasy ? 'bg-[#e8f2ec] text-[#176b4b] border border-[#cde0d3]' : 'bg-[#faf7ef] text-[#9b6300] border border-[#e4ded0]'
          }`}>
            <Sparkles className="w-3.5 h-3.5" />
            <span>AI REVIEW: {isEasy ? 'LOW SWITCHING FRICTION (COMPARE)' : 'HIGH FRICTION (ESTIMATE NEGOTIATION)'}</span>
          </span>
        </div>

        <span className="text-xs font-mono text-[#7a857e]">
          Source: {subscription.source.toUpperCase()}
        </span>
      </div>

      <p className="text-sm text-[#526259] leading-relaxed font-sans">
        {decision.reason}
      </p>

      {alternative && (
        <div className="p-4 rounded-lg bg-[#fafbf9] border border-[#e2e6df] flex items-center justify-between gap-4">
          <div>
            <div className="text-xs text-[#7a857e] font-mono">Estimated Alternative</div>
            <div className="text-base font-bold text-[#17201c] mt-0.5">{alternative.name}</div>
            <div className="text-xs text-[#176b4b] font-mono mt-1">
              ${alternative.price}/mo vs ${subscription.currentPrice}/mo (projected savings ${projectedMonthlySavings.toFixed(2)}/mo)
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isEasy ? (
              <span className="rounded-lg border border-[#cde0d3] bg-[#e8f2ec] px-3 py-2 text-xs font-semibold text-[#176b4b]">
                Estimate only
              </span>
            ) : (
              <button
                onClick={onEstimateNegotiation}
                className="px-4 py-2 rounded-lg bg-[#9b6300] hover:bg-[#7e5000] text-white font-bold text-xs flex items-center gap-1.5 shadow-sm transition-all"
              >
                <span>Estimate negotiated rate</span>
                <Calculator className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
