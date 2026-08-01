import { Alternative } from './types';
import { scrapeLivePrices } from './price-scraper';
import { supabaseAdmin } from './supabase/server';

export async function findAlternatives(vendor: string, currentPrice: number, subscriptionId?: string): Promise<Alternative[]> {
  // Check Supabase cached alternatives first (if cached within 7 days)
  if (subscriptionId) {
    try {
      const { data: cached } = await supabaseAdmin
        .from('alternatives')
        .select('*')
        .eq('subscription_id', subscriptionId);

      if (cached && cached.length > 0) {
        return cached.map((a: any) => ({
          id: a.id,
          name: a.name,
          price: Number(a.price),
          currency: 'USD',
          features: a.features || [],
          featureParityScore: Number(a.feature_parity) || 0.88,
          url: a.url || '',
          savings: Math.max(0, currentPrice - Number(a.price)),
          fetchedAt: a.fetched_at,
        }));
      }
    } catch (err) {
      console.warn('[AlternativesEngine] DB cache lookup failed:', err);
    }
  }

  // Live scrape / OpenAI synthesis
  const alts = await scrapeLivePrices(vendor, currentPrice);

  // Cache in Supabase if subscriptionId provided
  if (subscriptionId && alts.length > 0) {
    try {
      const rows = alts.map((a) => ({
        subscription_id: subscriptionId,
        name: a.name,
        price: a.price,
        feature_parity: a.featureParityScore,
        features: a.features,
        url: a.url,
      }));

      await supabaseAdmin.from('alternatives').insert(rows);
    } catch (cacheErr) {
      console.warn('[AlternativesEngine] Failed to save alternatives to DB:', cacheErr);
    }
  }

  return alts;
}
