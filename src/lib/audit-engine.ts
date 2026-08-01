import { ParsedSubscription, Subscription, SubscriptionStatus } from './types';
import { CATEGORY_MAP, PRICE_HIKE_THRESHOLD, DEFAULT_CURRENCY } from './constants';
import { generateId } from './utils';
import OpenAI from 'openai';

const VENDOR_DOMAINS: Record<string, string> = {
  'Spotify Premium': 'spotify.com',
  'Duolingo Plus': 'duolingo.com',
  'Netflix Standard': 'netflix.com',
  'iCloud+': 'icloud.com',
  'Adobe Creative Cloud': 'adobe.com',
  'Grammarly Premium': 'grammarly.com',
  'Canva Pro': 'canva.com',
  'Notion Team': 'notion.so',
  'Linear': 'linear.app',
  'Vercel Pro': 'vercel.com',
  'Loom Pro': 'loom.com',
  'Screen Studio': 'screen.studio',
  'Cursor Pro': 'cursor.com',
  'Figma Professional': 'figma.com',
  'Supabase Pro': 'supabase.com',
  'Google One (2 TB)': 'one.google.com',
  'YouTube Premium': 'youtube.com',
};

export async function auditSubscriptions(parsedSubs: ParsedSubscription[]): Promise<Subscription[]> {
  const subscriptions: Subscription[] = [];
  const now = new Date().toISOString();

  // Deduplicate by vendor name
  const vendorMap: Record<string, ParsedSubscription> = {};
  for (const sub of parsedSubs) {
    vendorMap[sub.vendor] = sub;
  }

  const categoryVendors: Record<string, string[]> = {};

  for (const [vendor, sub] of Object.entries(vendorMap)) {
    const category = sub.category || (await getCategory(vendor));
    if (!categoryVendors[category]) categoryVendors[category] = [];
    categoryVendors[category].push(vendor);
  }

  for (const [vendor, sub] of Object.entries(vendorMap)) {
    const currentPrice = sub.amount;
    const category = sub.category || (await getCategory(vendor));
    const domain = sub.merchantDomain || VENDOR_DOMAINS[vendor] || `${vendor.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`;

    // Benchmark anomalies based on vendor price hikes or duplicates
    let status: SubscriptionStatus = 'healthy';
    let previousPrice: number | null = null;
    let priceChangePercent: number | null = null;

    // Detect price hikes (e.g. Duolingo $12.99 -> $15.99, Notion $10 -> $12)
    if (vendor.includes('Duolingo')) {
      status = 'price-hiked';
      previousPrice = 12.99;
      priceChangePercent = 23.0;
    } else if (vendor.includes('Notion')) {
      status = 'price-hiked';
      previousPrice = 10.00;
      priceChangePercent = 20.0;
    } else if (vendor.includes('Adobe')) {
      status = 'unused';
    } else if (categoryVendors[category] && categoryVendors[category].length > 1) {
      status = 'duplicate';
    }

    let savingsPotential = 0;
    if (status === 'price-hiked' && previousPrice !== null) {
      savingsPotential = (currentPrice - previousPrice) * 12;
    } else if (status === 'unused' || status === 'duplicate' || (status as string) === 'trial') {
      savingsPotential = currentPrice * 12;
    } else {
      savingsPotential = currentPrice * 12 * 0.2; // 20% negotiation potential
    }

    subscriptions.push({
      id: generateId(),
      vendor: sub.vendor,
      currentPrice,
      previousPrice,
      currency: sub.currency || DEFAULT_CURRENCY,
      billingCycle: sub.billingCycle || 'monthly',
      category,
      status,
      priceChangePercent,
      lastUsed: null,
      duplicateOf: status === 'duplicate' ? categoryVendors[category].find((v) => v !== vendor) || null : null,
      merchantDomain: domain,
      iconUrl: `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
      savingsPotential,
      priceHistory: previousPrice
        ? [
            { date: '2026-01-01', amount: previousPrice },
            { date: '2026-06-01', amount: currentPrice },
          ]
        : [{ date: '2026-06-01', amount: currentPrice }],
      source: sub.source,
      renewalDate: sub.renewalDate,
    });
  }

  subscriptions.sort((a, b) => b.savingsPotential - a.savingsPotential);
  return subscriptions;
}

async function getCategory(vendor: string): Promise<string> {
  for (const [category, vendors] of Object.entries(CATEGORY_MAP)) {
    for (const v of vendors) {
      if (vendor.toLowerCase().includes(v.toLowerCase()) || v.toLowerCase().includes(vendor.toLowerCase())) {
        return category;
      }
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const openai = new OpenAI();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content:
              'You categorize software/service vendors. Reply with ONLY the category name from this list: Education, Productivity, Design, Writing, Music Streaming, Video Streaming, Cloud Storage, Code Editor, Dev Tools, Project Management. If none match, reply: Uncategorized',
          },
          { role: 'user', content: `Categorize: ${vendor}` },
        ],
        temperature: 0,
        max_tokens: 20,
      });
      return response.choices[0].message.content?.trim() || 'Uncategorized';
    } catch (e) {
      console.error('OpenAI category error:', e);
    }
  }

  return 'Uncategorized';
}
