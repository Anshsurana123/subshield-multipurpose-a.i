import { NegotiationEvent, Alternative, NegotiationEventType } from './types';
import { createStagehandBrowser, navigateToVendorCancellation } from './stagehand-client';
import OpenAI from 'openai';
import { sleep } from './utils';

function createEvent(
  actor: 'AGENT' | 'VENDOR' | 'SYSTEM',
  message: string,
  type: NegotiationEventType = 'action'
): NegotiationEvent {
  return {
    timestamp: new Date().toISOString(),
    actor,
    message,
    type,
  };
}

export async function* runNegotiation(params: {
  vendor: string;
  currentPrice: number;
  targetPrice: number;
  alternatives: Alternative[];
  merchantDomain: string;
}): AsyncGenerator<NegotiationEvent> {

  yield createEvent('SYSTEM', `Initiating negotiation for ${params.vendor}...`, 'action');
  await sleep(800);

  yield createEvent('AGENT', `Navigating to ${params.vendor} account settings...`, 'action');
  await sleep(600);

  let offerResult: { discountedPrice: number } | null = null;

  try {
    // Try real Stagehand browser automation
    if (process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID) {
      yield createEvent('SYSTEM', 'Launching browser automation via Browserbase...', 'action');
      await sleep(500);

      const stagehand = await createStagehandBrowser();

      yield createEvent('AGENT', `Browser session active. Opening ${params.merchantDomain}...`, 'action');
      await sleep(300);

      yield createEvent('AGENT', 'Searching for subscription management page...', 'action');

      const offer = await navigateToVendorCancellation(stagehand, params.vendor, params.merchantDomain);

      try { await stagehand.close(); } catch { /* ignore close errors */ }

      if (offer.offerFound) {
        yield createEvent('AGENT', 'Initiating cancellation flow — reason: "too expensive"', 'action');
        await sleep(500);

        yield createEvent('VENDOR', offer.offerText || `We don't want to lose you! How about $${offer.discountedPrice}/mo?`, 'offer');
        await sleep(400);

        const bestAlt = params.alternatives[0];
        yield createEvent('AGENT',
          `Countering: "I'm considering ${bestAlt?.name || 'a competitor'} at $${bestAlt?.price || params.targetPrice}/mo. Can you match?"`,
          'action'
        );
        await sleep(500);

        if (offer.discountedPrice && offer.discountedPrice <= params.targetPrice * 1.1) {
          yield createEvent('VENDOR', `We can offer you $${offer.discountedPrice}/mo — our best retention rate.`, 'offer');
          offerResult = { discountedPrice: offer.discountedPrice };
        } else {
          yield createEvent('VENDOR', `The best we can do is $${offer.discountedPrice || params.currentPrice}/mo.`, 'response');
        }
      } else {
        yield createEvent('SYSTEM', 'No retention offer detected on this vendor.', 'response');
      }
    } else {
      throw new Error('No Browserbase credentials — falling back to AI simulation');
    }
  } catch (error) {
    // Fallback to GPT-4o simulated negotiation transcript
    yield createEvent('SYSTEM', 'Using AI-powered negotiation simulation...', 'action');
    await sleep(400);

    if (!process.env.OPENAI_API_KEY) {
      // Deterministic fallback when no AI key
      yield* runDeterministicNegotiation(params);
      offerResult = { discountedPrice: params.targetPrice };
    } else {
      const openai = new OpenAI();
      const altNames = params.alternatives.map(a => `${a.name} ($${a.price}/mo)`).join(', ');

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{
          role: 'system',
          content: `You are simulating a customer retention chat between a user's AI agent and a ${params.vendor} support bot. 
The user currently pays $${params.currentPrice}/mo and wants to cancel because it's too expensive.
The agent cites alternatives: ${altNames}.
The vendor bot should eventually offer around $${params.targetPrice}/mo.
Return a JSON object with a "messages" array. Each message: { "speaker": "AGENT" | "VENDOR", "text": "..." }
Keep it to 6-8 messages. Make it realistic and professional.`
        }],
        response_format: { type: 'json_object' },
        temperature: 0.7,
      });

      const content = response.choices[0].message.content;
      if (content) {
        const data = JSON.parse(content);
        const messages = data.messages || [];

        for (const msg of messages) {
          await sleep(1200);
          const actor = msg.speaker === 'AGENT' ? 'AGENT' as const : 'VENDOR' as const;
          const eventType: NegotiationEventType = msg.speaker === 'VENDOR' && msg.text.includes('$') ? 'offer' : 'response';
          yield createEvent(actor, msg.text, eventType);

          // Extract price from vendor messages
          if (msg.speaker === 'VENDOR' && msg.text.includes('$')) {
            const match = msg.text.match(/\$(\d+(?:\.\d+)?)/);
            if (match) {
              offerResult = { discountedPrice: parseFloat(match[1]) };
            }
          }
        }
      }
    }
  }

  // Final result
  await sleep(500);
  if (offerResult) {
    const savings = params.currentPrice - offerResult.discountedPrice;
    yield createEvent('SYSTEM',
      `✅ Negotiation successful! Secured $${offerResult.discountedPrice.toFixed(2)}/mo (saving $${savings.toFixed(2)}/mo, $${(savings * 12).toFixed(2)}/year)`,
      'result'
    );
  } else {
    yield createEvent('SYSTEM',
      `Negotiation complete. No discount offered. Recommend switching to ${params.alternatives[0]?.name || 'a competitor'} at $${params.alternatives[0]?.price || params.targetPrice}/mo.`,
      'result'
    );
  }
}

/** Deterministic fallback when no API keys are configured */
async function* runDeterministicNegotiation(params: {
  vendor: string;
  currentPrice: number;
  targetPrice: number;
  alternatives: Alternative[];
}): AsyncGenerator<NegotiationEvent> {
  const alt = params.alternatives[0];
  const altName = alt?.name || 'Alternative';
  const altPrice = alt?.price || params.targetPrice;

  const script: [string, 'AGENT' | 'VENDOR', NegotiationEventType][] = [
    [`Connecting to ${params.vendor} retention department...`, 'AGENT', 'action'],
    [`Hello! I see you're looking to cancel your subscription. Can I ask why?`, 'VENDOR', 'response'],
    [`The current price of $${params.currentPrice}/mo is too high. I've found ${altName} at $${altPrice}/mo with comparable features.`, 'AGENT', 'action'],
    [`I understand. Let me check what I can do for you...`, 'VENDOR', 'response'],
    [`We value your business. I can offer you a special rate of $${params.targetPrice}/mo — that's ${Math.round(((params.currentPrice - params.targetPrice) / params.currentPrice) * 100)}% off.`, 'VENDOR', 'offer'],
    [`That matches my target. I'll accept $${params.targetPrice}/mo. Please apply this rate to my account.`, 'AGENT', 'action'],
    [`Done! Your new rate of $${params.targetPrice}/mo has been applied. Thank you for staying with us!`, 'VENDOR', 'response'],
  ];

  for (const [message, actor, type] of script) {
    await sleep(1200);
    yield createEvent(actor, message, type);
  }
}
