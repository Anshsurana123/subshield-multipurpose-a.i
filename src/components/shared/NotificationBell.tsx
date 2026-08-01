'use client';

import React, { useState } from 'react';
import { Bell } from 'lucide-react';
import NotificationCenter from './NotificationCenter';
import { NotificationItem } from '@/lib/types';

interface NotificationBellProps {
  notifications: NotificationItem[];
  onDismiss: (id: string) => void;
}

export default function NotificationBell({ notifications, onDismiss }: NotificationBellProps) {
  const [isOpen, setIsOpen] = useState(false);
  const unreadCount = notifications.filter((n) => !n.readAt).length;

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2.5 rounded-xl bg-[#fafbf9] hover:bg-[#f0f2ef] border border-[#e2e6df] text-[#526259] transition-all flex items-center justify-center"
      >
        <Bell className="w-4 h-4 text-[#176b4b]" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 px-1.5 py-0.5 rounded-full bg-[#176b4b] text-white text-[10px] font-bold font-mono animate-pulse">
            {unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <NotificationCenter
          notifications={notifications}
          onClose={() => setIsOpen(false)}
          onDismiss={onDismiss}
        />
      )}
    </div>
  );
}
