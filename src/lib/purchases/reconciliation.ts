import type { PurchaseState } from './types';

export interface AmbiguousExecutionContext {
  submitted: boolean;
  timedOut?: boolean;
  browserDisconnected?: boolean;
  authoritativeDecline?: boolean;
  authoritativeApproval?: boolean;
}

export function outcomeStateForExecution(context: AmbiguousExecutionContext): PurchaseState {
  if (context.authoritativeApproval) return 'completed';
  if (context.authoritativeDecline) return 'declined';
  if (context.submitted && (context.timedOut || context.browserDisconnected)) {
    return 'unknown_reconciliation';
  }
  return context.submitted ? 'unknown_reconciliation' : 'failed';
}
