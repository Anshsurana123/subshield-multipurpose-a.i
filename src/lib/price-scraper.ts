import OpenAI from 'openai';
import { Browserbase } from '@browserbasehq/sdk';
import { Alternative } from './types';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

export async function scrapeLivePrices(vendor: string, currentPrice: number): Promise<Alternative[]> {
  console.log(`[PriceScraper] Finding live pricing alternatives for ${vendor} (current: $${currentPrice})...`);

  // Special Rule: Bundled ecosystems with unmatchable perks (e.g. Google One with AI credits, Antigravity access, Gemini Ultra, 2TB storage)
  const vendorLower = vendor.toLowerCase();
  if (vendorLower.includes('google one') || vendorLower.includes('apple one') || vendorLower.includes('antigravity')) {
    console.log(`[PriceScraper] Vendor '${vendor}' has unmatchable bundled ecosystem perks (AI credits, Antigravity, storage). Returning no alternatives.`);
    return [];
  }

  const apiKey = process.env.BROWSERBASE_API_KEY;
  let liveSearchContext = '';

  // Use Browserbase SDK search & fetch features if key is available
  if (apiKey) {
    try {
      const bb = new Browserbase({ apiKey });
      const query = `cheaper direct alternatives and pricing for ${vendor}`;
      console.log(`[PriceScraper] Executing Browserbase web search: "${query}"`);
      
      const searchData = await bb.search.web({ query, numResults: 3 });
      
      if (searchData?.results?.length > 0) {
        liveSearchContext = searchData.results
          .map((r: any) => `Title: ${r.title}\nURL: ${r.url}\nDescription: ${r.snippet || r.publishedDate || ''}`)
          .join('\n\n');
        console.log(`[PriceScraper] Retrieved ${searchData.results.length} live web search results from Browserbase.`);
      }
    } catch (err) {
      console.warn('[PriceScraper] Browserbase search fallback:', err);
    }
  }

  const prompt = `You are an autonomous software pricing research agent evaluating true feature parity.
Target Vendor: "${vendor}"
Current Price: $${currentPrice}/month

Live Web Context from Browserbase:
${liveSearchContext || 'No live web search context available.'}

STRICT RULE: Only suggest an alternative if it provides AT LEAST 80% feature parity. If the product includes unique bundled benefits (such as AI credits, developer tool access like Antigravity, or exclusive ecosystem features) that standalone competitors CANNOT match, output an EMPTY array for alternatives: { "alternatives": [] }.

Return JSON in this EXACT format:
{
  "alternatives": [
    {
      "name": "Competitor Name",
      "price": 9.99,
      "currency": "USD",
      "features": ["Feature 1", "Feature 2", "Feature 3"],
      "featureParityScore": 88,
      "url": "https://competitor.com/pricing",
      "savings": 6.00
    }
  ]
}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: prompt }],
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0]?.message?.content || '{}');
    const alts: Alternative[] = (result.alternatives || []).map((a: any) => ({
      name: a.name,
      price: Number(a.price),
      currency: a.currency || 'USD',
      features: a.features || [],
      featureParityScore: Number(a.featureParityScore) || 85,
      url: a.url || `https://google.com/search?q=${encodeURIComponent(a.name + ' pricing')}`,
      savings: Math.max(0, currentPrice - Number(a.price)),
      fetchedAt: new Date().toISOString(),
    }));

    return alts;
  } catch (err) {
    console.error('[PriceScraper] Failed to fetch prices via OpenAI:', err);
    return [];
  }
}
