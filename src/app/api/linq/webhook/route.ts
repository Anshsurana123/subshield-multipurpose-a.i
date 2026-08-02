import { NextResponse } from 'next/server';
import { processChatMessage } from '@/lib/chat-commands';
import { sendLinqMessage } from '@/lib/chat-senders';
import { verifyLinqWebhookSignature } from '@/lib/linq-client';
import { redactPII } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Linq webhook — receives `message.received` events from the Linq Partner API.
 *
 * Setup:
 *  1. Add LINQ_API_KEY + LINQ_WEBHOOK_SECRET to .env.local
 *  2. Register this URL as the webhook target:
 *     npx tsx scratch/register-linq-webhook.mjs https://<app>/api/linq/webhook
 *  3. Message the bot via iMessage/RCS/SMS — the product link + price is
 *     processed by the same shared chat logic as Telegram.
 */
export async function POST(request: Request) {
  try {
    const rawBody = await request.text();

    // Security: verify the HMAC-SHA256 signature if a secret is configured.
    if (!verifyLinqWebhookSignature(rawBody, request.headers)) {
      return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 401 });
    }

    const body = JSON.parse(rawBody);
    console.log('[Linq Webhook] Received event:', redactPII(JSON.stringify(body)).slice(0, 1000));

    // Defensive payload parsing — Linq v3 sends structured messages with a `parts`
    // array (e.g. [{ type: "text", value: "..." }]), or flat `text`/`content`.
    const message = body?.message ?? body?.data?.message ?? body?.data ?? body;

    let text = '';
    const rawParts = message?.parts || body?.data?.parts || body?.parts;
    if (Array.isArray(rawParts) && rawParts.length > 0) {
      text = rawParts.map((p: any) => p?.value || p?.text || '').filter(Boolean).join(' ');
    }
    if (!text) {
      text = String(
        message?.text ??
        message?.content ??
        body?.data?.text ??
        body?.text ??
        ''
      );
    }

    const chatId: string | undefined =
      message?.chat?.id ||
      message?.chatId ||
      message?.chat_id ||
      body?.data?.chat_id ||
      body?.data?.chatId ||
      body?.chat_id ||
      body?.chatId ||
      body?.chat?.id;

    const eventType = body?.event || body?.type || body?.event_type;

    if (!chatId) {
      console.warn('[Linq Webhook] No chat ID in payload:', redactPII(JSON.stringify(body)).slice(0, 500));
      return NextResponse.json({ success: false, error: 'No chat id' }, { status: 400 });
    }

    // Ignore outbound messages (e.g. sent by the bot itself) to prevent reply loops
    const direction = message?.direction || body?.data?.direction || body?.direction;
    if (direction === 'outbound') {
      return NextResponse.json({ success: true, message: 'Ignored outbound message' });
    }

    // Only handle incoming text messages; ignore delivery receipts, typing indicators etc.
    if (!text || (eventType && !String(eventType).includes('message.received') && !String(eventType).includes('message.created'))) {
      return NextResponse.json({ success: true, message: 'Ignored non-message event' });
    }

    const replyText = await processChatMessage(text, {
      userId: `linq_${chatId}`,
      channel: 'linq',
      chatId,
    });

    await sendLinqMessage(chatId, replyText);

    return NextResponse.json({ success: true, reply: replyText });
  } catch (error: any) {
    console.error('[Linq Webhook Error]:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Webhook error' },
      { status: 500 }
    );
  }
}
