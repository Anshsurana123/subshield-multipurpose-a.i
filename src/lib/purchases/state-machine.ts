import type { PurchaseState } from './types';

const CANCELLABLE: PurchaseState[] = ['canceled', 'expired'];

export const ALLOWED_PURCHASE_TRANSITIONS: Readonly<Record<PurchaseState, readonly PurchaseState[]>> = {
  draft: ['resolving', ...CANCELLABLE],
  resolving: ['awaiting_cart_review', 'failed', ...CANCELLABLE],
  awaiting_cart_review: ['cart_confirmed', ...CANCELLABLE],
  cart_confirmed: ['quoting', ...CANCELLABLE],
  quoting: ['awaiting_quote_confirmation', 'failed', ...CANCELLABLE],
  awaiting_quote_confirmation: ['quoted', ...CANCELLABLE],
  quoted: ['awaiting_payment_approval', ...CANCELLABLE],
  awaiting_payment_approval: ['credential_ready', 'failed', ...CANCELLABLE],
  credential_ready: ['executing', ...CANCELLABLE],
  executing: ['submitted', 'failed', 'unknown_reconciliation'],
  submitted: ['completed', 'declined', 'unknown_reconciliation'],
  unknown_reconciliation: ['completed', 'declined', 'failed'],
  completed: [],
  declined: [],
  failed: [],
  canceled: [],
  expired: [],
};

export class InvalidPurchaseTransitionError extends Error {
  constructor(readonly from: PurchaseState, readonly to: PurchaseState) {
    super(`Invalid purchase transition: ${from} -> ${to}`);
    this.name = 'InvalidPurchaseTransitionError';
  }
}

export function canTransitionPurchase(from: PurchaseState, to: PurchaseState): boolean {
  return ALLOWED_PURCHASE_TRANSITIONS[from].includes(to);
}

export function assertPurchaseTransition(from: PurchaseState, to: PurchaseState): void {
  if (!canTransitionPurchase(from, to)) {
    throw new InvalidPurchaseTransitionError(from, to);
  }
}

export function isTerminalPurchaseState(state: PurchaseState): boolean {
  return ALLOWED_PURCHASE_TRANSITIONS[state].length === 0;
}
