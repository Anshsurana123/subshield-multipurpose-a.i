import crypto from 'crypto';
import { supabaseAdmin } from './supabase/server';

/**
 * Generate a deterministic UUID for any chatId string (UUID, Telegram numeric ID, phone number).
 */
export function getDurableUuid(chatId: string): string {
  const trimmed = (chatId || '').trim();
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(trimmed)) return trimmed;

  const hash = crypto.createHash('md5').update(trimmed).digest('hex');
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16),
    '8' + hash.substring(17, 20),
    hash.substring(20, 32),
  ].join('-');
}

const PENDING_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Local memory cache
const memoryStore = new Map<string, { data: any; createdAt: number }>();

/**
 * Save a pending order persistently into Supabase.
 */
export async function saveDurablePendingOrder(
  chatId: string,
  orderType: 'food' | 'grocery' | 'product',
  orderData: any
): Promise<void> {
  if (!chatId) return;
  const uuidKey = getDurableUuid(chatId);
  const createdAt = orderData?.createdAt || Date.now();

  // 1. Memory cache
  memoryStore.set(`${orderType}:${chatId}`, { data: orderData, createdAt });

  // 2. Supabase persistent store
  try {
    const totalAmount =
      orderData?.totalAmount ||
      orderData?.totalPrice ||
      orderData?.estimatedPrice ||
      0;
    const productName = `Pending ${orderType.toUpperCase()} Order`;

    await supabaseAdmin.from('tracked_products').upsert({
      id: uuidKey,
      user_id: chatId,
      product_name: productName,
      product_url: JSON.stringify(orderData),
      current_price: typeof totalAmount === 'number' ? totalAmount : 0,
      target_price: typeof totalAmount === 'number' ? totalAmount : 0,
      status: `pending_${orderType}`,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[DurableStore] Error saving pending ${orderType} order:`, err);
  }
}

/**
 * Retrieve a pending order from memory or Supabase persistent store.
 */
export async function getDurablePendingOrder<T = any>(
  chatId: string,
  orderType: 'food' | 'grocery' | 'product'
): Promise<T | null> {
  if (!chatId) return null;
  const memKey = `${orderType}:${chatId}`;

  // 1. Check memory cache first
  const cached = memoryStore.get(memKey);
  if (cached) {
    if (Date.now() - cached.createdAt <= PENDING_TTL_MS) {
      return cached.data as T;
    }
    memoryStore.delete(memKey);
  }

  // 2. Fallback to Supabase persistent store
  try {
    const uuidKey = getDurableUuid(chatId);
    const { data, error } = await supabaseAdmin
      .from('tracked_products')
      .select('*')
      .eq('id', uuidKey)
      .single();

    if (!error && data && data.status === `pending_${orderType}` && data.product_url) {
      const parsed = JSON.parse(data.product_url);
      const createdAt = parsed.createdAt || new Date(data.updated_at).getTime();

      if (Date.now() - createdAt <= PENDING_TTL_MS) {
        // Re-populate memory cache
        memoryStore.set(memKey, { data: parsed, createdAt });
        return parsed as T;
      } else {
        // Expired — cleanup
        await deleteDurablePendingOrder(chatId, orderType);
      }
    }
  } catch (err) {
    console.error(`[DurableStore] Error fetching pending ${orderType} order:`, err);
  }

  return null;
}

/**
 * Delete a pending order when complete or cancelled.
 */
export async function deleteDurablePendingOrder(
  chatId: string,
  orderType: 'food' | 'grocery' | 'product'
): Promise<void> {
  if (!chatId) return;
  const memKey = `${orderType}:${chatId}`;
  memoryStore.delete(memKey);

  try {
    const uuidKey = getDurableUuid(chatId);
    await supabaseAdmin.from('tracked_products').delete().eq('id', uuidKey);
  } catch (err) {
    console.error(`[DurableStore] Error deleting pending ${orderType} order:`, err);
  }
}
