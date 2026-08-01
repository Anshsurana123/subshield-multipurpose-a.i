import React from 'react';

interface StatusDotProps {
  status: 'active' | 'pending' | 'expired' | 'failed' | 'COMPLETED' | 'ACTIVE';
  size?: 'sm' | 'md' | 'lg';
}

export function StatusDot({ status, size = 'md' }: StatusDotProps) {
  const sizeClasses = {
    sm: 'w-1.5 h-1.5',
    md: 'w-2.5 h-2.5',
    lg: 'w-3.5 h-3.5',
  };

  const normStatus = (status || 'active').toLowerCase();

  const colorClasses: Record<string, string> = {
    active: 'bg-[#10B981] shadow-[0_0_8px_rgba(16,185,129,0.8)]',
    completed: 'bg-[#10B981] shadow-[0_0_8px_rgba(16,185,129,0.8)]',
    pending: 'bg-[#F59E0B] shadow-[0_0_8px_rgba(245,158,11,0.8)]',
    expired: 'bg-[#EF4444] shadow-[0_0_8px_rgba(239,68,68,0.8)]',
    failed: 'bg-[#EF4444] shadow-[0_0_8px_rgba(239,68,68,0.8)]',
  };

  const bgClass = colorClasses[normStatus] || colorClasses.active;

  return (
    <div className="relative flex items-center justify-center shrink-0">
      <span
        className={`absolute rounded-full animate-ping opacity-75 ${sizeClasses[size]} ${bgClass}`}
      />
      <span
        className={`relative rounded-full ${sizeClasses[size]} ${bgClass}`}
      />
    </div>
  );
}

export default StatusDot;
