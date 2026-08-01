'use client';

import Image from 'next/image';
import { ArrowUpRight } from 'lucide-react';
import { Subscription } from '@/lib/types';
import { AnomalyBadge } from './AnomalyBadge';
import SubscriptionSourceBadge from './SubscriptionSourceBadge';

interface SubscriptionCardProps {
  subscription: Subscription;
  onNegotiate?: () => void;
  onCancel?: () => void;
}

export function SubscriptionCard({ subscription, onNegotiate }: SubscriptionCardProps) {
  const isHiked = subscription.status === 'price-hiked';
  const vendorName = subscription.vendor || (subscription as any).vendorName || 'Subscription';
  const currentPrice = subscription.currentPrice ?? (subscription as any).price ?? 0;
  const previousPrice = subscription.previousPrice;
  const priceChangePercent = subscription.priceChangePercent ?? (subscription as any).priceChangePercentage;
  const period = subscription.billingCycle === 'annual' ? 'year' : 'month';

  return (
    <article className="group rounded-xl border border-[#e2e6df] bg-white p-4 transition-all hover:border-[#176b4b]/40 hover:shadow-lg hover:shadow-[#176b4b]/5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border border-[#e2e6df] bg-[#fafbf9]">
            {subscription.iconUrl ? (
              <Image src={subscription.iconUrl} alt="" width={40} height={40} className="size-full object-cover" unoptimized />
            ) : (
              <span className="text-sm font-bold text-[#68756d]">{vendorName.charAt(0)}</span>
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-[#17201c]">{vendorName}</h3>
              <SubscriptionSourceBadge source={subscription.source || 'gmail'} />
            </div>
            <p className="mt-0.5 truncate text-xs text-[#68756d]">{subscription.category}</p>
          </div>
        </div>
        <AnomalyBadge status={subscription.status} />
      </div>

      <div className="mt-5 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs text-[#68756d]">Current price</p>
          <p className="mt-1 text-xl font-semibold tracking-[-0.03em] text-[#17201c]">
            ${currentPrice.toFixed(2)}
            <span className="ml-1 text-xs font-normal text-[#68756d]">/ {period}</span>
          </p>
        </div>
        {isHiked && previousPrice && (
          <div className="text-right">
            <p className="text-xs text-[#68756d]">Was <span className="line-through">${previousPrice.toFixed(2)}</span></p>
            {priceChangePercent && <p className="mt-1 text-xs font-semibold text-[#9b6300]">+{Math.round(priceChangePercent)}% increase</p>}
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-[#e8ece7] pt-3">
        <span className="text-xs text-[#68756d]">
          Potential yearly value <strong className="font-semibold text-[#176b4b]">${subscription.savingsPotential.toFixed(0)}</strong>
        </span>
        <button onClick={onNegotiate} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold text-[#176b4b] hover:bg-[#e8f2ec] transition-colors">
          Review <ArrowUpRight size={14} />
        </button>
      </div>
    </article>
  );
}

export default SubscriptionCard;
