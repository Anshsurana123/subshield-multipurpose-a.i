import { create } from 'zustand';
import {
  Subscription,
  Alternative,
  NegotiationEvent,
  Mandate,
  PravaSession,
  AuditPhase,
  DemoPhase,
  Decision,
  NotificationItem,
} from '@/lib/types';

export interface NegotiationResult {
  originalPrice: number;
  finalPrice: number;
  savings: number;
  vendor: string;
  subscriptionId: string;
}

interface SubShieldStore {
  // DISCOVER
  subscriptions: Subscription[];
  auditPhase: AuditPhase;
  isGoogleConnected: boolean;

  // DECIDE
  selectedSubscription: Subscription | null;
  alternatives: Alternative[];
  decisions: Decision[];
  notifications: NotificationItem[];
  negotiationEvents: NegotiationEvent[];
  isNegotiating: boolean;
  negotiationComplete: boolean;
  negotiationResult: NegotiationResult | null;

  // ACT
  mandates: Mandate[];
  activePravaSession: PravaSession | null;
  isCheckoutOpen: boolean;

  // Metrics
  totalSaved: number;
  blockedHikes: number;
  cancelledUnused: number;
  negotiatedDiscounts: number;

  // Demo
  demoPhase: DemoPhase;

  // Actions
  setSubscriptions: (subs: Subscription[]) => void;
  setAuditPhase: (phase: AuditPhase) => void;
  setIsGoogleConnected: (val: boolean) => void;
  selectSubscription: (sub: Subscription | null) => void;
  setAlternatives: (alts: Alternative[]) => void;
  setDecisions: (decisions: Decision[]) => void;
  addDecision: (decision: Decision) => void;
  setNotifications: (notifs: NotificationItem[]) => void;
  dismissNotification: (id: string) => void;
  addNegotiationEvent: (event: NegotiationEvent) => void;
  clearNegotiationEvents: () => void;
  setIsNegotiating: (val: boolean) => void;
  setNegotiationComplete: (val: boolean) => void;
  setNegotiationResult: (result: NegotiationResult | null) => void;
  addMandate: (mandate: Mandate) => void;
  updateMandate: (id: string, updates: Partial<Mandate>) => void;
  setActivePravaSession: (session: PravaSession | null) => void;
  setIsCheckoutOpen: (val: boolean) => void;
  addSavings: (amount: number) => void;
  incrementBlockedHikes: () => void;
  incrementCancelledUnused: () => void;
  incrementNegotiatedDiscounts: () => void;
  setDemoPhase: (phase: DemoPhase) => void;
  reset: () => void;
}

const initialState = {
  subscriptions: [],
  auditPhase: 'idle' as AuditPhase,
  isGoogleConnected: false,
  selectedSubscription: null,
  alternatives: [],
  decisions: [],
  notifications: [],
  negotiationEvents: [],
  isNegotiating: false,
  negotiationComplete: false,
  negotiationResult: null,
  mandates: [],
  activePravaSession: null,
  isCheckoutOpen: false,
  totalSaved: 0,
  blockedHikes: 0,
  cancelledUnused: 0,
  negotiatedDiscounts: 0,
  demoPhase: 'idle' as DemoPhase,
};

export const useSubShieldStore = create<SubShieldStore>((set) => ({
  ...initialState,

  setSubscriptions: (subs) => set({ subscriptions: subs }),
  setAuditPhase: (phase) => set({ auditPhase: phase }),
  setIsGoogleConnected: (val) => set({ isGoogleConnected: val }),
  selectSubscription: (sub) =>
    set({
      selectedSubscription: sub,
      alternatives: [],
      negotiationEvents: [],
      negotiationComplete: false,
      negotiationResult: null,
    }),
  setAlternatives: (alts) => set({ alternatives: alts }),
  setDecisions: (decisions) => set({ decisions }),
  addDecision: (decision) => set((state) => ({ decisions: [...state.decisions, decision] })),
  setNotifications: (notifs) => set({ notifications: notifs }),
  dismissNotification: (id) =>
    set((state) => ({ notifications: state.notifications.filter((n) => n.id !== id) })),
  addNegotiationEvent: (event) =>
    set((state) => ({ negotiationEvents: [...state.negotiationEvents, event] })),
  clearNegotiationEvents: () => set({ negotiationEvents: [] }),
  setIsNegotiating: (val) => set({ isNegotiating: val }),
  setNegotiationComplete: (val) => set({ negotiationComplete: val }),
  setNegotiationResult: (result) => set({ negotiationResult: result }),
  addMandate: (mandate) => set((state) => ({ mandates: [...state.mandates, mandate] })),
  updateMandate: (id, updates) =>
    set((state) => ({
      mandates: state.mandates.map((m) => (m.id === id ? { ...m, ...updates } : m)),
    })),
  setActivePravaSession: (session) => set({ activePravaSession: session }),
  setIsCheckoutOpen: (val) => set({ isCheckoutOpen: val }),
  addSavings: (amount) => set((state) => ({ totalSaved: state.totalSaved + amount })),
  incrementBlockedHikes: () => set((state) => ({ blockedHikes: state.blockedHikes + 1 })),
  incrementCancelledUnused: () => set((state) => ({ cancelledUnused: state.cancelledUnused + 1 })),
  incrementNegotiatedDiscounts: () => set((state) => ({ negotiatedDiscounts: state.negotiatedDiscounts + 1 })),
  setDemoPhase: (phase) => set({ demoPhase: phase }),
  reset: () => set(initialState),
}));
