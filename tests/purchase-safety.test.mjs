import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPurchaseTransition,
  canTransitionPurchase,
  isTerminalPurchaseState,
} from '../src/lib/purchases/state-machine.ts';
import {
  assertExactAmount,
  formatMinorAmount,
  parseDecimalToMinor,
} from '../src/lib/purchases/money.ts';
import { outcomeStateForExecution } from '../src/lib/purchases/reconciliation.ts';
import {
  assertMerchantExecutionEnabled,
  assertPurchasesEnabled,
  purchaseOrderingAvailable,
  PurchasesDisabledError,
} from '../src/lib/purchases/guard.ts';
import { safeRelativeRedirect } from '../src/lib/auth/redirect.ts';

test('purchase state machine permits the reviewed happy path and rejects skips', () => {
  const path = [
    'draft',
    'resolving',
    'awaiting_cart_review',
    'cart_confirmed',
    'quoting',
    'awaiting_quote_confirmation',
    'quoted',
    'awaiting_payment_approval',
    'credential_ready',
    'executing',
    'submitted',
    'completed',
  ];
  for (let index = 0; index < path.length - 1; index += 1) {
    assert.equal(canTransitionPurchase(path[index], path[index + 1]), true);
    assert.doesNotThrow(() => assertPurchaseTransition(path[index], path[index + 1]));
  }

  assert.equal(canTransitionPurchase('draft', 'executing'), false);
  assert.throws(() => assertPurchaseTransition('quoted', 'completed'));
  for (const terminal of ['completed', 'declined', 'failed', 'canceled', 'expired']) {
    assert.equal(isTerminalPurchaseState(terminal), true);
  }
});

test('money conversion stays exact and rejects rounding or mismatches', () => {
  assert.equal(parseDecimalToMinor('123.40'), 12_340n);
  assert.equal(parseDecimalToMinor('123', 0), 123n);
  assert.equal(formatMinorAmount(12_340n), '123.40');
  assert.throws(() => parseDecimalToMinor('1.001', 2));
  assert.throws(() => parseDecimalToMinor('-1.00'));
  assert.throws(() => assertExactAmount(100n, 99n));
});

test('ambiguous post-submit outcomes enter reconciliation instead of retrying', () => {
  assert.equal(outcomeStateForExecution({ submitted: true, timedOut: true }), 'unknown_reconciliation');
  assert.equal(outcomeStateForExecution({ submitted: true, browserDisconnected: true }), 'unknown_reconciliation');
  assert.equal(outcomeStateForExecution({ submitted: false, timedOut: true }), 'failed');
  assert.equal(outcomeStateForExecution({ submitted: true, authoritativeDecline: true }), 'declined');
  assert.equal(outcomeStateForExecution({ submitted: true, authoritativeApproval: true }), 'completed');
});

test('both independent purchase gates fail closed', () => {
  const previousPurchases = process.env.PURCHASES_ENABLED;
  const previousMerchant = process.env.MERCHANT_EXECUTION_ENABLED;
  try {
    delete process.env.PURCHASES_ENABLED;
    delete process.env.MERCHANT_EXECUTION_ENABLED;
    assert.throws(() => assertPurchasesEnabled('test'), PurchasesDisabledError);

    process.env.PURCHASES_ENABLED = '1';
    assert.doesNotThrow(() => assertPurchasesEnabled('test'));
    assert.equal(purchaseOrderingAvailable(), false);
    assert.throws(() => assertMerchantExecutionEnabled('test'), PurchasesDisabledError);

    process.env.MERCHANT_EXECUTION_ENABLED = '1';
    assert.equal(purchaseOrderingAvailable(), true);
    assert.doesNotThrow(() => assertMerchantExecutionEnabled('test'));
  } finally {
    if (previousPurchases === undefined) delete process.env.PURCHASES_ENABLED;
    else process.env.PURCHASES_ENABLED = previousPurchases;
    if (previousMerchant === undefined) delete process.env.MERCHANT_EXECUTION_ENABLED;
    else process.env.MERCHANT_EXECUTION_ENABLED = previousMerchant;
  }
});

test('redirects remain same-origin and reject slash/backslash confusion', () => {
  assert.equal(safeRelativeRedirect('/dashboard?tab=alerts'), '/dashboard?tab=alerts');
  assert.equal(safeRelativeRedirect('https://evil.example'), '/dashboard');
  assert.equal(safeRelativeRedirect('//evil.example'), '/dashboard');
  assert.equal(safeRelativeRedirect('/\\evil.example'), '/dashboard');
  assert.equal(safeRelativeRedirect('/dashboard\nnext'), '/dashboard');
});
