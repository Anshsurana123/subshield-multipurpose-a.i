const DECIMAL_MONEY = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

export function parseDecimalToMinor(value: string, exponent = 2): bigint {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new RangeError('Currency exponent must be an integer between 0 and 6');
  }

  const match = DECIMAL_MONEY.exec(value.trim());
  if (!match) throw new Error('Amount must be a non-negative decimal string');

  const fraction = match[2] || '';
  if (fraction.length > exponent) {
    throw new Error(`Amount has more than ${exponent} decimal places`);
  }

  const scale = 10n ** BigInt(exponent);
  return BigInt(match[1]) * scale + BigInt((fraction + '0'.repeat(exponent)).slice(0, exponent) || '0');
}

export function formatMinorAmount(value: bigint, exponent = 2): string {
  if (value < 0n) throw new Error('Amount cannot be negative');
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new RangeError('Currency exponent must be an integer between 0 and 6');
  }
  if (exponent === 0) return value.toString();

  const scale = 10n ** BigInt(exponent);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(exponent, '0');
  return `${whole}.${fraction}`;
}

export function assertExactAmount(expectedMinor: bigint, actualMinor: bigint): void {
  if (expectedMinor !== actualMinor) {
    throw new Error('Merchant total does not match the authorized total');
  }
}
