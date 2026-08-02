import { NextResponse } from 'next/server';
import { secretHeaderMatches } from '@/lib/auth/server';
import {
  claimAndEnqueueChannelEvent,
  resolveChannelIdentity,
} from '@/lib/channels/repository';
import { consumeChannelLinkCommand, extractChannelLinkCode } from '@/lib/channels/linking';
import { consumeRateLimit, PayloadTooLargeError, readLimitedBody } from '@/lib/http/request-safety';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: Request) {
  if (!secretHeaderMatches(
    request.headers.get('x-telegram-bot-api-secret-token'),
    process.env.TELEGRAM_WEBHOOK_SECRET
  )) {
    return NextResponse.json({ success: false, error: 'Invalid webhook secret' }, { status: 401 });
  }

  const source = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!consumeRateLimit(`telegram:${source}`, { limit: 60, windowMs: 60_000 })) {
    return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429 });
  }

  try {
    const rawBody = await readLimitedBody(request, MAX_BODY_BYTES);
    const body = JSON.parse(rawBody);
    const eventId = Number.isSafeInteger(body?.update_id) ? String(body.update_id) : '';
    const providerUserId = body?.message?.from?.id == null ? '' : String(body.message.from.id);
    const chatId = body?.message?.chat?.id == null ? '' : String(body.message.chat.id);
    const chatType = typeof body?.message?.chat?.type === 'string' ? body.message.chat.type : '';
    const text = typeof body?.message?.text === 'string' ? body.message.text : '';

    if (!eventId) {
      return NextResponse.json({ success: false, error: 'update_id is required' }, { status: 400 });
    }
    if (!providerUserId || !chatId || !text) {
      return NextResponse.json({ success: true, ignored: true });
    }
    if (chatType !== 'private') {
      return NextResponse.json({ success: true, ignored: true, reason: 'private_chat_required' });
    }

    const linkCode = extractChannelLinkCode(text);
    if (linkCode) {
      const link = await consumeChannelLinkCommand({
        provider: 'telegram',
        eventId,
        code: linkCode,
        providerUserId,
        chatId,
      });
      return NextResponse.json({ success: true, ...link });
    }

    const identity = await resolveChannelIdentity('telegram', providerUserId, chatId);
    if (!identity) return NextResponse.json({ success: true, linked: false });

    const result = await claimAndEnqueueChannelEvent({
      provider: 'telegram',
      eventId,
      userId: identity.userId,
      providerUserId,
      chatId,
      text,
    });
    if (!result.claimed) return NextResponse.json({ success: true, duplicate: true });
    return NextResponse.json({ success: true, queued: true });
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
    }
    console.error('[Telegram Webhook] processing failed');
    return NextResponse.json({ success: false, error: 'Webhook processing failed' }, { status: 500 });
  }
}
