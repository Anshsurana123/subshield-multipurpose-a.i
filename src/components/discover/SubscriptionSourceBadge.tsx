import React from 'react';
import { Mail, Globe } from 'lucide-react';
import { SubscriptionSource } from '@/lib/types';

interface SubscriptionSourceBadgeProps {
  source: SubscriptionSource;
}

export default function SubscriptionSourceBadge({ source }: SubscriptionSourceBadgeProps) {
  if (source === 'gmail') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#fdf4f3] border border-[#efd3d0] text-[#a53630] text-[10px] font-mono">
        <Mail className="w-3 h-3" />
        <span>Gmail</span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#eef3fd] border border-[#c8d7f0] text-[#3b5daf] text-[10px] font-mono">
      <Globe className="w-3 h-3" />
      <span>Google Subs</span>
    </span>
  );
}
