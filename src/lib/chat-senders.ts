import type { ChatChannel } from './types';

const CHAT_SEND_TIMEOUT_MS = 15_000;

/**
 * Send a message to a Telegram chat using the bot token.
 */
export async function sendTelegramMessage(chatId: string | number, text: string): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return false;
  }

  try {
    let res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      }),
      signal: AbortSignal.timeout(CHAT_SEND_TIMEOUT_MS),
    });

    if (res.ok) return true;

    await res.body?.cancel();

    res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: false,
      }),
      signal: AbortSignal.timeout(CHAT_SEND_TIMEOUT_MS),
    });

    if (!res.ok) {
      await res.body?.cancel();
    }

    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Send a message to a Linq chat via the Linq Partner API v3.
 * Docs: POST /v3/chats/{chatId}/messages with parts array.
 */
export async function sendLinqMessage(
  chatId: string,
  text: string,
  fromNumber: string = process.env.LINQ_FROM_NUMBER || ''
): Promise<boolean> {
  const apiKey = process.env.LINQ_API_KEY;
  if (!apiKey || !fromNumber) return false;

  try {
    const trimmedId = (chatId || '').trim();
    const isPhoneNumber = /^\+?\d{10,15}$/.test(trimmedId);

    // Endpoint A: Direct phone number routing via POST /v3/chats
    if (isPhoneNumber) {
      const res = await fetch('https://api.linqapp.com/api/partner/v3/chats', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from: fromNumber,
          to: [trimmedId],
          message: {
            parts: [{ type: 'text', value: text }],
          },
        }),
        signal: AbortSignal.timeout(CHAT_SEND_TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel();
      }
      return res.ok;
    }

    // Endpoint B: Existing chat ID routing via POST /v3/chats/{chatId}/messages
    const res = await fetch(
      `https://api.linqapp.com/api/partner/v3/chats/${encodeURIComponent(trimmedId)}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          message: {
            parts: [{ type: 'text', value: text }],
          },
        }),
        signal: AbortSignal.timeout(CHAT_SEND_TIMEOUT_MS),
      }
    );
    if (res.ok) return true;

    await res.body?.cancel();

    // Fallback attempt via POST /v3/chats
    const fallbackRes = await fetch('https://api.linqapp.com/api/partner/v3/chats', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: fromNumber,
        to: [trimmedId],
        message: {
          parts: [{ type: 'text', value: text }],
        },
      }),
      signal: AbortSignal.timeout(CHAT_SEND_TIMEOUT_MS),
    });
    if (!fallbackRes.ok) await fallbackRes.body?.cancel();
    return fallbackRes.ok;
  } catch {
    return false;
  }
}

/**
 * Dispatch a reply to whichever chat the product was enrolled from.
 */
export async function sendChatMessage(
  channel: ChatChannel | 'web' | null | undefined,
  chatId: string | null | undefined,
  text: string
): Promise<boolean> {
  if (!channel || !chatId) return false;
  if (channel === 'telegram') return sendTelegramMessage(chatId, text);
  if (channel === 'linq') return sendLinqMessage(chatId, text);
  return false;
}
