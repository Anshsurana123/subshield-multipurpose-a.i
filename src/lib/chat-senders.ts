import type { ChatChannel } from './types';

/**
 * Send a message to a Telegram chat using the bot token.
 */
export async function sendTelegramMessage(chatId: string | number, text: string): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.warn('[ChatSenders] TELEGRAM_BOT_TOKEN missing in environment variables.');
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
    });

    if (res.ok) return true;

    const errText = await res.text();
    console.warn(`[ChatSenders] Telegram sendMessage with Markdown failed (${res.status}): ${errText}. Retrying without parse_mode...`);

    res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: false,
      }),
    });

    if (!res.ok) {
      const fallbackErr = await res.text();
      console.error(`[ChatSenders] Telegram sendMessage plain text fallback failed (${res.status}): ${fallbackErr}`);
    }

    return res.ok;
  } catch (err) {
    console.error('[ChatSenders] Telegram sendMessage error:', err);
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
  fromNumber: string = '+12134155394'
): Promise<boolean> {
  const apiKey = process.env.LINQ_API_KEY;
  if (!apiKey) {
    console.warn('[ChatSenders] LINQ_API_KEY missing in environment variables.');
    return false;
  }

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
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error(`[ChatSenders] Linq POST /v3/chats failed (${res.status}): ${errText}`);
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
      }
    );
    if (res.ok) return true;

    const errText = await res.text();
    console.error(`[ChatSenders] Linq sendMessage failed (${res.status}): ${errText}. Attempting POST /v3/chats fallback...`);

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
    });
    return fallbackRes.ok;
  } catch (err) {
    console.error('[ChatSenders] Linq sendMessage error:', err);
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
