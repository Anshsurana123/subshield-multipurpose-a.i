export class PayloadTooLargeError extends Error {
  readonly status = 413;
}

export async function readLimitedBody(request: Request, maxBytes: number): Promise<string> {
  const declaredLength = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new PayloadTooLargeError('Payload too large');
  }

  const body = await request.text();
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    throw new PayloadTooLargeError('Payload too large');
  }
  return body;
}

interface RateBucket {
  count: number;
  resetsAt: number;
}

const buckets = new Map<string, RateBucket>();

/** Best-effort instance-local shield; durable event claims remain authoritative. */
export function consumeRateLimit(
  key: string,
  options: { limit: number; windowMs: number },
  now = Date.now()
): boolean {
  const current = buckets.get(key);
  if (!current || current.resetsAt <= now) {
    buckets.set(key, { count: 1, resetsAt: now + options.windowMs });
    return true;
  }
  if (current.count >= options.limit) return false;
  current.count += 1;
  return true;
}
