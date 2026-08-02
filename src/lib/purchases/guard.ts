export const PURCHASES_DISABLED_CODE = 'PURCHASES_DISABLED' as const;

/**
 * Raised whenever code reaches a purchase mutation while the global kill
 * switch is not explicitly enabled. The check is deliberately fail-closed:
 * missing, empty, and unexpected values all disable purchases.
 */
export class PurchasesDisabledError extends Error {
  readonly code = PURCHASES_DISABLED_CODE;
  readonly operation: string;

  constructor(operation: string) {
    super(`Purchases are disabled; blocked operation: ${operation}`);
    this.name = 'PurchasesDisabledError';
    this.operation = operation;
  }
}

export function purchasesEnabled(): boolean {
  return process.env.PURCHASES_ENABLED === '1';
}

export function assertPurchasesEnabled(operation: string): void {
  if (!purchasesEnabled()) {
    throw new PurchasesDisabledError(operation);
  }
}

/**
 * A second, independent gate prevents the global switch from reviving legacy
 * merchant flows before provider contracts and workflow controls are ready.
 */
export function purchaseOrderingAvailable(): boolean {
  return purchasesEnabled() && process.env.MERCHANT_EXECUTION_ENABLED === '1';
}

export function assertMerchantExecutionEnabled(operation: string): void {
  assertPurchasesEnabled(operation);
  if (process.env.MERCHANT_EXECUTION_ENABLED !== '1') {
    throw new PurchasesDisabledError(`${operation}:merchant-execution-gate`);
  }
}
