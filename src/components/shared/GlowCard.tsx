"use client";

import { motion } from "framer-motion";
import { ReactNode } from "react";

interface GlowCardProps {
  children: ReactNode;
  glowColor?: string;
  className?: string;
  animate?: boolean;
}

export function GlowCard({ children, className = "", animate = false }: GlowCardProps) {
  return (
    <motion.div
      whileHover={animate ? { y: -2 } : undefined}
      transition={{ duration: 0.18 }}
      className={`app-surface relative overflow-hidden rounded-2xl ${className}`}
    >
      {children}
    </motion.div>
  );
}

export default GlowCard;
