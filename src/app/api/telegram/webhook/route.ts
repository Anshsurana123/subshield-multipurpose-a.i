import { NextResponse } from 'next/server';
import { processTelegramMessage } from '@/lib/telegram-bot';
import { sendTelegramMessage } from '@/lib/chat-senders';
import { redactPII } from '@/lib/utils';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    console.log('[Telegram Webhook] Received update:', redactPII(JSON.stringify(body)));

    if (body.message) {
      const result = await processTelegramMessage(body.message);

      // Reply back to the chat via the shared Telegram sender
      const chatId = body.message.chat?.id;
      if (chatId) {
        const sent = await sendTelegramMessage(chatId, result.replyText);
        if (!sent) {
          console.warn('[Telegram Webhook] Reply not sent (check TELEGRAM_BOT_TOKEN and chat permissions).');
        }
      }

      return NextResponse.json({
        success: true,
        reply: result.replyText,
      });
    }

    return NextResponse.json({ success: true, message: 'No actionable message' });
  } catch (error: any) {
    console.error('[Telegram Webhook Error]:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Webhook error' },
      { status: 500 }
    );
  }
}
