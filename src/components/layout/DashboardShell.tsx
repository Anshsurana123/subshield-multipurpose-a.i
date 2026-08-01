import { ReactNode } from "react";
import { Header } from "./Header";

interface DashboardShellProps {
  children: ReactNode;
  activePhase?: 'DISCOVER' | 'DECIDE' | 'ACT';
}

export function DashboardShell({ children, activePhase }: DashboardShellProps) {
  return (
    <div className="min-h-screen flex flex-col bg-mesh text-[#17201c]">
      <Header activePhase={activePhase} />
      <main className="flex-1 w-full max-w-7xl mx-auto p-4 sm:p-6">
        {children}
      </main>
    </div>
  );
}

export default DashboardShell;
