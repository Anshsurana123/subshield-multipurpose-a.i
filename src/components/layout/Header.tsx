'use client';

import { ShieldCheck, Sparkles } from 'lucide-react';
import NotificationBell from '../shared/NotificationBell';
import { NotificationItem } from '@/lib/types';

interface HeaderProps {
  activePhase?: 'DISCOVER' | 'DECIDE' | 'ACT';
  notifications?: NotificationItem[];
  onScanClick?: () => void;
  onDismissNotification?: (id: string) => void;
}

export function Header({
  activePhase = 'DISCOVER',
  notifications = [],
  onScanClick,
  onDismissNotification = () => {},
}: HeaderProps) {
  const phases = ['DISCOVER', 'DECIDE', 'ACT'] as const;

  return (
    <header className="sticky top-0 z-40 border-b border-[#e2e6df] bg-white/95 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-[1440px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#176b4b] to-[#0d4a33] text-white shadow-lg shadow-[#176b4b]/20">
            <ShieldCheck size={19} strokeWidth={2.25} />
          </div>
          <div className="min-w-0">
            <h1 className="font-heading text-[17px] font-bold tracking-[-0.03em] text-[#17201c]">SubShield</h1>
            <p className="hidden text-[11px] text-[#68756d] sm:block">AI Subscription Agent</p>
          </div>
        </div>

        <nav aria-label="Workflow" className="hidden items-center gap-1 rounded-lg border border-[#e2e6df] bg-[#fafbf9] p-1 md:flex">
          {phases.map((phase, index) => {
            const isActive = activePhase === phase;
            return (
              <div key={phase} className="flex items-center">
                <span className={`rounded-md px-3 py-1.5 text-[11px] font-semibold tracking-[0.04em] ${
                  isActive ? 'bg-[#176b4b] text-white shadow-sm' : 'text-[#7a857e]'
                }`}>
                  <span className="mr-1.5 font-mono text-[10px]">0{index + 1}</span>{phase}
                </span>
                {index < phases.length - 1 && <span className="h-3 w-px bg-[#e2e6df]" />}
              </div>
            );
          })}
        </nav>

        <div className="flex items-center gap-3">
          <NotificationBell notifications={notifications} onDismiss={onDismissNotification} />

          <button
            onClick={onScanClick}
            className="inline-flex items-center gap-2 rounded-xl bg-[#176b4b] px-4 py-2 text-xs font-bold text-white shadow-sm transition-all hover:bg-[#10543a]"
          >
            <Sparkles size={13} fill="currentColor" />
            <span>Scan Inbox</span>
          </button>
        </div>
      </div>
    </header>
  );
}

export default Header;
