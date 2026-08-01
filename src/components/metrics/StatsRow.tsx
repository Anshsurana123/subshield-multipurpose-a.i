"use client";

interface StatItem {
  label: string;
  value: string | number;
  color?: string;
}

export function StatsRow({ stats }: { stats: StatItem[] }) {
  return <div className="grid grid-cols-3 divide-x divide-[#e8ece7]">{stats.map((stat) => <div key={stat.label} className="px-2 first:pl-0 last:pr-0"><p className="text-[10px] text-[#7a857e]">{stat.label}</p><p className={`mt-1 text-sm font-semibold ${stat.color || 'text-[#26332c]'}`}>{stat.value}</p></div>)}</div>;
}

export default StatsRow;
