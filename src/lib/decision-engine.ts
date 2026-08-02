import { createChatCompletion } from './ai-client';
import { Subscription, Alternative, Decision, ReplacementDifficulty, DecisionType } from './types';
import { getSupabaseAdmin } from './supabase/server';

export async function classifyReplacementDifficulty(
  vendor: string,
  category: string
): Promise<{ difficulty: ReplacementDifficulty; reason: string }> {
  const prompt = `You are an AI subscription analyst.
Vendor: "${vendor}"
Category: "${category}"

Classify replacement difficulty into EXACTLY one of:
- "easy": OTT/Streaming (Netflix, Hulu, Disney+), PDF readers, basic converters, cloud storage with simple export, simple utility apps. (Low lock-in, zero workflow disruption).
- "hard": Team productivity (Notion, Linear, Figma), code editors (Cursor), dev infrastructure, ecosystem bundles (Google One with AI credits, Antigravity access, 2TB storage), complex suite software (Adobe CC). (High data lock-in, team dependencies, complex setup).

Return JSON:
{
  "difficulty": "easy" | "hard",
  "reason": "Clear 1-sentence justification"
}`;

  try {
    const res = await createChatCompletion({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: prompt }],
      response_format: { type: 'json_object' },
    });

    const parsed = JSON.parse(res.choices[0]?.message?.content || '{}');
    return {
      difficulty: parsed.difficulty === 'easy' ? 'easy' : 'hard',
      reason: parsed.reason || 'Evaluated based on vendor category and data lock-in friction.',
    };
  } catch (err) {
    console.error('[DecisionEngine] Error classifying difficulty:', err);
    // Fallback heuristic rules
    const vendorLower = vendor.toLowerCase();
    const isEasy =
      vendorLower.includes('netflix') ||
      vendorLower.includes('hulu') ||
      vendorLower.includes('duolingo') ||
      vendorLower.includes('pdf') ||
      vendorLower.includes('spotify') ||
      vendorLower.includes('disney');

    return {
      difficulty: isEasy ? 'easy' : 'hard',
      reason: isEasy
        ? 'Commodity service with low switching friction.'
        : 'Integrated service with data and ecosystem dependencies.',
    };
  }
}

export async function processDecisionForSubscription(
  subscription: Subscription,
  alternatives: Alternative[]
): Promise<Decision> {
  // 1. Find cheapest alternative
  const cheaperAlt = alternatives
    .filter((a) => a.price < subscription.currentPrice)
    .sort((a, b) => a.price - b.price)[0];

  // 2. Classify difficulty
  const { difficulty, reason } = await classifyReplacementDifficulty(
    subscription.vendor,
    subscription.category
  );

  subscription.replacementDifficulty = difficulty;

  let decisionType: DecisionType = 'auto_switch';
  let decisionReason = '';

  if (!cheaperAlt) {
    decisionType = 'user_input';
    const isEcosystem = subscription.vendor.toLowerCase().includes('google one') || subscription.vendor.toLowerCase().includes('apple one');
    decisionReason = isEcosystem
      ? `No viable alternatives found for ${subscription.vendor}. This plan includes unique bundled ecosystem benefits (AI credits, Antigravity access, 2TB storage) that standalone storage tools cannot match.`
      : `No cheaper alternatives found for ${subscription.vendor}. Current rate ($${subscription.currentPrice}/mo) is market competitive.`;
  } else if (difficulty === 'easy') {
    // EASY replacement -> SUGGEST SWITCH WITH NO NEGOTIATION
    decisionType = 'auto_switch';
    decisionReason = `Easy replacement detected (${difficulty.toUpperCase()}). ${cheaperAlt.name} is available for $${cheaperAlt.price}/mo vs your $${subscription.currentPrice}/mo (Save $${(subscription.currentPrice - cheaperAlt.price).toFixed(2)}/mo). Direct switch recommended.`;
  } else {
    // HARD replacement -> NEGOTIATE FIRST till price is close to alternative
    decisionType = 'negotiate';
    decisionReason = `Hard replacement detected (${difficulty.toUpperCase()}). High switching friction. Attempting negotiation with ${subscription.vendor} to match ${cheaperAlt.name}'s price ($${cheaperAlt.price}/mo).`;
  }

  const decision: Decision = {
    id: crypto.randomUUID(),
    subscriptionId: subscription.id,
    type: decisionType,
    status: 'pending',
    alternative: cheaperAlt,
    reason: decisionReason,
    createdAt: new Date().toISOString(),
  };

  const { error } = await getSupabaseAdmin().from('decisions').insert({
    id: decision.id,
    subscription_id: subscription.id,
    type: decision.type,
    status: decision.status,
    reason: decision.reason,
  });
  if (error) throw new Error(`Decision persistence failed: ${error.code}`);

  return decision;
}
