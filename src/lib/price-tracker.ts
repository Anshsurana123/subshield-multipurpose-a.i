import type { ChatChannel, TrackedProduct } from './types';
import { getSupabaseAdmin } from './supabase/server';
import { scrapeLivePrice } from './product-scraper';
import { formatPrice } from './chat-intent';
import { requirePublicHttpsUrl } from './security/url';

const PUBLIC_TRACKER_COLUMNS = [
  'id',
  'user_id',
  'product_url',
  'product_name',
  'current_price',
  'target_price',
  'currency',
  'status',
  'last_scanned_at',
  'created_at',
  'updated_at',
  'source_channel',
].join(',');

function mapRowToProduct(row: any, includePrivateSource = false): TrackedProduct {
  return {
    id: row.id,
    userId: row.user_id,
    productUrl: row.product_url,
    productName: row.product_name,
    currentPrice: Number(row.current_price),
    targetPrice: Number(row.target_price),
    currency: row.currency,
    status: row.status,
    lastScannedAt: row.last_scanned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceChannel: row.source_channel || undefined,
    sourceChatId: includePrivateSource ? row.source_chat_id || undefined : undefined,
    sourceEventId: includePrivateSource ? row.source_event_id || undefined : undefined,
    pravaSessionId: undefined,
  };
}

function requireUserId(userId: string | undefined): string {
  if (!userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error('An authenticated user ID is required');
  }
  return userId;
}

export class TrackerEnrollmentError extends Error {
  readonly status: number;

  constructor(readonly reason: string) {
    super(reason === 'rate_limited'
      ? 'Tracker enrollment rate limit exceeded'
      : 'Tracker enrollment quota exceeded');
    this.name = 'TrackerEnrollmentError';
    this.status = reason === 'rate_limited' ? 429 : 409;
  }
}

export async function addTrackedProduct(params: {
  userId: string;
  productUrl: string;
  productName?: string;
  targetPrice: number;
  currency?: string;
  channel?: ChatChannel | 'web';
  chatId?: string;
  eventId?: string;
  requestId?: string;
}): Promise<TrackedProduct> {
  const userId = requireUserId(params.userId);
  if (params.channel && params.eventId) {
    const { data: existing, error: existingError } = await getSupabaseAdmin()
      .from('tracked_products')
      .select(PUBLIC_TRACKER_COLUMNS)
      .eq('source_channel', params.channel)
      .eq('source_event_id', params.eventId)
      .eq('user_id', userId)
      .maybeSingle();
    if (existingError) throw new Error(`Tracked event lookup failed: ${existingError.code}`);
    if (existing) return mapRowToProduct(existing);
  }

  const safeUrl = await requirePublicHttpsUrl(params.productUrl);
  if (!Number.isFinite(params.targetPrice) || params.targetPrice <= 0) {
    throw new Error('targetPrice must be positive');
  }

  const id = params.requestId || crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('requestId must be a UUID');
  }
  const { data: reservationData, error: reservationError } = await getSupabaseAdmin()
    .rpc('reserve_tracker_enrollment', { p_user_id: userId, p_request_id: id });
  if (reservationError) throw new Error(`Tracker enrollment reservation failed: ${reservationError.code}`);
  const reservation = Array.isArray(reservationData) ? reservationData[0] : reservationData;
  if (!reservation?.accepted) {
    if (reservation?.reason === 'already_enrolled') {
      const { data: existing, error: existingError } = await getSupabaseAdmin()
        .from('tracked_products')
        .select(PUBLIC_TRACKER_COLUMNS)
        .eq('id', id)
        .eq('user_id', userId)
        .single();
      if (existingError || !existing) throw new Error('Tracker idempotency recovery failed');
      return mapRowToProduct(existing);
    }
    throw new TrackerEnrollmentError(String(reservation?.reason || 'quota_exceeded'));
  }

  const scraped = await scrapeLivePrice(safeUrl.toString());
  if (scraped.price === null) {
    throw new Error('A verified current price is required before tracking can start');
  }
  const productName = params.productName?.trim() || scraped.title?.slice(0, 120) || 'Tracked Product';
  const currentPrice = scraped.price;
  const scrapedCurrency = scraped.currency.toUpperCase();
  const currency = params.currency?.toUpperCase() || scrapedCurrency;
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be an ISO 4217 code');
  if (params.currency && /^[A-Z]{3}$/.test(scrapedCurrency) && scrapedCurrency !== currency) {
    throw new Error('The verified price currency does not match the requested currency');
  }

  const { data, error } = await getSupabaseAdmin()
    .from('tracked_products')
    .insert({
      id,
      user_id: userId,
      product_url: safeUrl.toString(),
      product_name: productName,
      current_price: currentPrice,
      target_price: params.targetPrice,
      currency,
      status: 'active',
      source_channel: params.channel || null,
      source_chat_id: params.chatId || null,
      source_event_id: params.eventId || null,
    })
    .select(PUBLIC_TRACKER_COLUMNS)
    .single();
  if (error?.code === '23505' && params.channel && params.eventId) {
    const { data: existing, error: existingError } = await getSupabaseAdmin()
      .from('tracked_products')
      .select(PUBLIC_TRACKER_COLUMNS)
      .eq('source_channel', params.channel)
      .eq('source_event_id', params.eventId)
      .eq('user_id', userId)
      .single();
    if (existingError || !existing) throw new Error(`Tracked event recovery failed: ${existingError?.code || 'no_row'}`);
    return mapRowToProduct(existing);
  }
  if (error || !data) throw new Error(`Tracked product insert failed: ${error?.code || 'no_row'}`);
  return mapRowToProduct(data);
}

export async function getTrackedProducts(userId: string): Promise<TrackedProduct[]> {
  const { data, error } = await getSupabaseAdmin()
    .from('tracked_products')
    .select(PUBLIC_TRACKER_COLUMNS)
    .eq('user_id', requireUserId(userId))
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Tracked product read failed: ${error.code}`);
  return (data || []).map((row) => mapRowToProduct(row, false));
}

async function scanTrackedProduct(item: TrackedProduct): Promise<{ targetReached: boolean }> {
  // Revalidate stored data on every scan. This protects upgraded databases and
  // any row that did not enter through the current API boundary.
  const safeUrl = await requirePublicHttpsUrl(item.productUrl);
  const scraped = await scrapeLivePrice(safeUrl.toString());
  if (scraped.price === null) throw new Error('Verified price unavailable');

  const currency = scraped.currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Merchant returned an invalid currency');
  const currencyChanged = currency !== item.currency;
  const now = new Date().toISOString();

  if (currencyChanged) {
    const { error } = await getSupabaseAdmin()
      .from('tracked_products')
      .update({
        product_name: scraped.title?.slice(0, 120) || item.productName,
        last_scanned_at: now,
        updated_at: now,
      })
      .eq('id', item.id)
      .eq('user_id', item.userId);
    if (error) throw new Error(`Tracked currency-mismatch update failed: ${error.code}`);
    return { targetReached: false };
  }

  if (scraped.price > item.targetPrice) {
    const { error } = await getSupabaseAdmin()
      .from('tracked_products')
      .update({
        current_price: scraped.price,
        currency,
        product_name: scraped.title?.slice(0, 120) || item.productName,
        last_scanned_at: now,
        updated_at: now,
      })
      .eq('id', item.id)
      .eq('user_id', item.userId);
    if (error) throw new Error(`Tracked product update failed: ${error.code}`);

    return { targetReached: false };
  }

  // Atomic target claim. Scanning never creates a payment session or executes
  // checkout; a separately confirmed quote workflow must do that later.
  const title = `Target reached: ${item.productName}`;
  const body = `Price is ${formatPrice(scraped.price, currency)}. Checkout has not started; review an exact merchant quote first.`;
  const { data, error } = await getSupabaseAdmin().rpc('claim_tracker_target', {
    p_product_id: item.id,
    p_user_id: item.userId,
    p_current_price: scraped.price,
    p_currency: currency,
    p_product_name: scraped.title?.slice(0, 120) || item.productName,
    p_title: title,
    p_body: body,
  });
  if (error) throw new Error(`Tracked target claim failed: ${error.code}`);
  const row = Array.isArray(data) ? data[0] : data;
  return { targetReached: Boolean(row?.claimed) };
}

export async function scanNextTrackedProduct(): Promise<{ scanned: boolean; targetReached: boolean }> {
  const { data, error } = await getSupabaseAdmin().rpc('claim_tracked_product_scan', {
    p_lease_seconds: 240,
  });
  if (error) throw new Error(`Tracker scan claim failed: ${error.code}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { scanned: false, targetReached: false };

  const item = mapRowToProduct(row, true);
  const leaseToken = typeof row.scan_lease_token === 'string' ? row.scan_lease_token : '';
  if (!leaseToken) throw new Error('Tracker scan claim did not return a lease token');
  let succeeded = false;
  try {
    const result = await scanTrackedProduct(item);
    succeeded = true;
    return { scanned: true, targetReached: result.targetReached };
  } finally {
    const { data: finished, error: finishError } = await getSupabaseAdmin().rpc('finish_tracked_product_scan', {
      p_product_id: item.id,
      p_lease_token: leaseToken,
      p_succeeded: succeeded,
    });
    if (finishError || finished !== true) {
      throw new Error(`Tracker scan completion failed: ${finishError?.code || 'lease_lost'}`);
    }
  }
}
