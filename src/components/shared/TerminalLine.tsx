"use client";

import { motion } from "framer-motion";

interface TerminalLineProps {
  actor: 'AGENT' | 'VENDOR' | 'SYSTEM';
  message: string;
  type?: string;
  animate?: boolean;
}

const actorStyles = {
  AGENT: 'bg-[#e8f2ec] text-[#176b4b]',
  VENDOR: 'bg-[#fff6e7] text-[#8a5a00]',
  SYSTEM: 'bg-[#eef1ee] text-[#56635c]',
};

export function TerminalLine({ actor, message, type, animate = true }: TerminalLineProps) {
  return (
    <motion.div initial={animate ? { opacity: 0, y: 4 } : undefined} animate={{ opacity: 1, y: 0 }} className="flex items-start gap-2.5 text-xs leading-5">
      <span className={`mt-0.5 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold ${actorStyles[actor]}`}>{actor}</span>
      <div className="min-w-0 text-[#4f5f56]">
        {type && <span className="mr-1.5 text-[10px] capitalize text-[#879188]">{type}</span>}
        {message}
      </div>
    </motion.div>
  );
}

export default TerminalLine;
