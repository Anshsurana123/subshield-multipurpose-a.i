import { NextResponse } from 'next/server';
import {
  claimAndEnqueueChannelEvent,
  resolveChannelIdentity,
} from '@/lib/channels/repository';
import { consumeChannelLinkCommand, extractChannelLinkCode } from '@/lib/channels/linking';
import { consumeRateLimit, PayloadTooLargeError, readLimitedBody } from '@/lib/http/request-safety';
import { verifyLinqWebhookSignature } from '@/lib/linq-client';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const MAX_BODY_BYTES = 256 * 1024;

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

export async function POST(request: Request) {
  const source = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!consumeRateLimit(`linq:${source}`, { limit: 60, windowMs: 60_000 })) {
    return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429 });
  }

  try {
    const rawBody = await readLimitedBody(request, MAX_BODY_BYTES);
    if (!verifyLinqWebhookSignature(rawBody, request.headers)) {
      return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 401 });
    }

    const eventId = request.headers.get('webhook-id') || '';
    if (!eventId) {
      return NextResponse.json({ success: false, error: 'webhook-id is required' }, { status: 400 });
    }

    const body = JSON.parse(rawBody);
    const message = body?.message ?? body?.data?.message ?? body?.data ?? body;
    const eventType = firstString(body?.event, body?.type, body?.event_type);
    if (eventType && !eventType.includes('message.received') && !eventType.includes('message.created')) {
      return NextResponse.json({ success: true, ignored: true });
    }
    if (firstString(message?.direction, body?.data?.direction, body?.direction) === 'outbound') {
      return NextResponse.json({ success: true, ignored: true });
    }

    const parts = message?.parts ?? body?.data?.parts ?? body?.parts;
    const text = Array.isArray(parts)
      ? parts.map((part) => firstString(part?.value, part?.text)).filter(Boolean).join(' ')
      : firstString(message?.text, message?.content, body?.data?.text, body?.text);
    const chatId = firstString(
      message?.chat?.id,
      message?.chatId,
      message?.chat_id,
      body?.data?.chat_id,
      body?.data?.chatId,
      body?.chat_id,
      body?.chatId,
      body?.chat?.id
    );
    const providerUserId = firstString(
      message?.sender?.id,
      message?.sender?.phone_number,
      message?.from?.id,
      message?.from?.phone_number,
      message?.from_phone_number,
      message?.sender_phone_number,
      body?.data?.sender_id,
      body?.sender_id
    );
    const participantList = message?.chat?.participants ?? body?.data?.chat?.participants ?? body?.chat?.participants;
    const isGroupChat = message?.chat?.is_group === true ||
      body?.data?.chat?.is_group === true ||
      body?.chat?.is_group === true ||
      (Array.isArray(participantList) && participantList.length > 2);

    if (!chatId || !providerUserId || !text) {
      return NextResponse.json({ success: true, ignored: true });
    }
    if (isGroupChat) {
      return NextResponse.json({ success: true, ignored: true, reason: 'private_chat_required' });
    }

    const linkCode = extractChannelLinkCode(text);
    if (linkCode) {
      const link = await consumeChannelLinkCommand({
        provider: 'linq',
        eventId,
        code: linkCode,
        providerUserId,
        chatId,
      });
      return NextResponse.json({ success: true, ...link });
    }

    const identity = await resolveChannelIdentity('linq', providerUserId, chatId);
    if (!identity) return NextResponse.json({ success: true, linked: false });

    const result = await claimAndEnqueueChannelEvent({
      provider: 'linq',
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
    console.error('[Linq Webhook] processing failed');
    return NextResponse.json({ success: false, error: 'Webhook processing failed' }, { status: 500 });
  }
}
