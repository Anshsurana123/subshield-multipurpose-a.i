"use client";

import { CheckCircle2, ShieldCheck } from "lucide-react";
import { motion } from "framer-motion";
import { CheckoutOutcome } from "@/lib/types";

export default function CheckoutResultBanner({ outcome }: { outcome: CheckoutOutcome }) {
  const amount = outcome.amountPaid ? `$${parseFloat(outcome.amountPaid).toFixed(2)}` : '$0.00';
  const isReported = outcome.reportedToVisa && outcome.status === 'completed';
  return <motion.div initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} className="fixed left-1/2 top-5 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2">
    <div className="flex items-start gap-3 rounded-xl border border-[#cde0d3] bg-white p-4 shadow-[0_16px_40px_rgba(20,45,29,0.16)]">
      <div className="grid size-9 shrink-0 place-items-center rounded-full bg-[#e8f2ec] text-[#176b4b]"><ShieldCheck size={18} /></div>
      <div className="min-w-0 flex-1"><div className="flex items-center gap-1.5"><h3 className="text-sm font-semibold text-[#1b3a2a]">{isReported ? 'Payment completed' : 'Passkey verification complete'}</h3><CheckCircle2 size={15} className="text-[#176b4b]" /></div><p className="mt-1 text-xs leading-5 text-[#66746b]">{isReported ? `${outcome.merchantName} is limited to ${amount}/month.` : `Credentials for ${outcome.merchantName} are ready for the merchant checkout. Token ending ${outcome.tokenLast4}.`}</p></div>
    </div>
  </motion.div>;
}
