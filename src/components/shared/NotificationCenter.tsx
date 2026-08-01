'use client';

import React from 'react';
import { Bell, X, AlertTriangle } from 'lucide-react';
import { NotificationItem } from '@/lib/types';

interface NotificationCenterProps {
  notifications: NotificationItem[];
  onClose: () => void;
  onDismiss: (id: string) => void;
}

export default function NotificationCenter({ notifications, onClose, onDismiss }: NotificationCenterProps) {
  return (
    <div className="absolute right-0 top-12 w-80 md:w-96 rounded-2xl bg-white border border-[#e2e6df] shadow-[0_16px_40px_rgba(20,45,29,0.14)] p-4 z-50 space-y-3">
      <div className="flex items-center justify-between border-b border-[#e8ece7] pb-3">
        <div className="flex items-center gap-2">
          <Bell className="w-4 h-4 text-[#176b4b]" />
          <span className="text-sm font-bold text-[#17201c]">Push Notifications & Escalations</span>
        </div>
        <button onClick={onClose} className="text-[#7a857e] hover:text-[#17201c] p-1 rounded-lg">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
        {notifications.length === 0 ? (
          <div className="text-center py-6 text-xs text-[#7a857e] font-mono">
            No active escalations or notifications.
          </div>
        ) : (
          notifications.map((item) => (
            <div
              key={item.id}
              className="p-3 rounded-xl bg-[#fafbf9] border border-[#e2e6df] space-y-1.5 relative group"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-bold text-[#17201c]">
                  <AlertTriangle className="w-3.5 h-3.5 text-[#9b6300] shrink-0" />
                  <span>{item.title}</span>
                </div>
                <button
                  onClick={() => onDismiss(item.id)}
                  className="text-[#7a857e] hover:text-[#526259] text-xs p-1"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>

              <p className="text-xs text-[#526259] font-sans leading-relaxed">
                {item.body}
              </p>

              <div className="text-[10px] text-[#7a857e] font-mono pt-1">
                {new Date(item.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
