import crypto from 'crypto';

export function formatCurrency(amount: number, currency: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(amount);
}

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1).getTime();
  const d2 = new Date(date2).getTime();
  return Math.abs(Math.round((d2 - d1) / (1000 * 60 * 60 * 24)));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncateTokenForDisplay(token: string): string {
  if (!token || token.length <= 4) return '****';
  return '****' + token.slice(-4);
}

/**
 * PCI-safe logging: never emit raw user-supplied text — a user could paste a
 * card number into chat. Masks 13+ digit sequences (PANs, spaced/dashed PANs)
 * with a placeholder. Conservative on purpose: over-masking is fine.
 */
export function redactPII(input: unknown): string {
  return String(input ?? '').replace(/\b\d[\d -]{11,}\d\b/g, '[REDACTED-NUMBER]');
}
