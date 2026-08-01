import { ArrowRight, BadgeCheck, Landmark, SearchCheck } from "lucide-react";

const steps = [
  { icon: SearchCheck, title: "Find waste", detail: "We flag unusual changes, unused software, and duplicate subscriptions." },
  { icon: ArrowRight, title: "Choose a response", detail: "Compare alternatives or let the negotiation workflow pursue a better rate." },
  { icon: BadgeCheck, title: "Protect the outcome", detail: "Approve a merchant-specific payment mandate only when you are ready." },
];

export default function WorkflowGuide() {
  return (
    <aside className="app-surface flex h-full flex-col rounded-2xl p-6 sm:p-7">
      <div className="grid size-10 place-items-center rounded-xl bg-[#f0f2ef] text-[#33443a]">
        <Landmark size={19} />
      </div>
      <p className="eyebrow mt-5">A calmer way to manage spend</p>
      <h2 className="mt-1 font-heading text-xl font-bold tracking-[-0.03em] text-[#17201c]">One decision at a time</h2>
      <ol className="mt-7 space-y-5">
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <li key={step.title} className="flex gap-3">
              <div className="relative grid size-8 shrink-0 place-items-center rounded-full border border-[#dbe3dc] bg-white text-[#176b4b]">
                <Icon size={14} />
                {index < steps.length - 1 && <span className="absolute top-8 h-5 w-px bg-[#dbe3dc]" />}
              </div>
              <div className="pt-0.5">
                <h3 className="text-sm font-semibold text-[#26332c]">{step.title}</h3>
                <p className="mt-1 text-xs leading-5 text-[#718077]">{step.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-auto rounded-lg border border-[#e3e9e2] bg-[#fafbf9] p-3 text-xs leading-5 text-[#637169]">You stay in control. Nothing is negotiated, cancelled, or paid without your approval.</p>
    </aside>
  );
}
