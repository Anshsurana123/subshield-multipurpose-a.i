import type { ChatChannel } from './types';

/**
 * Send a message to a Telegram chat using the bot token.
 */
export async function sendTelegramMessage(chatId: string | number, text: string): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return false;

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[ChatSenders] Telegram sendMessage failed (${res.status}): ${errText}`);
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
export async function sendLinqMessage(chatId: string, text: string): Promise<boolean> {
  const apiKey = process.env.LINQ_API_KEY;
  if (!apiKey) return false;

  try {
    const res = await fetch(
      `https://api.linqapp.com/api/partner/v3/chats/${encodeURIComponent(chatId)}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          parts: [{ type: 'text', value: text }],
        }),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[ChatSenders] Linq sendMessage failed (${res.status}): ${errText}`);
    }
    return res.ok;
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
