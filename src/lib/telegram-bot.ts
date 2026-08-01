import { processChatMessage } from './chat-commands';
import { redactPII } from './utils';

export interface TelegramIncomingMessage {
  message_id: number;
  from?: {
    id: number;
    first_name?: string;
    username?: string;
  };
  chat: {
    id: number;
    type: string;
  };
  text?: string;
}

export async function processTelegramMessage(incoming: TelegramIncomingMessage): Promise<{ replyText: string }> {
  const text = incoming.text || '';
  console.log(`[TelegramBot] Processing incoming message from chat ${incoming.chat.id}: "${redactPII(text)}"`);

  const replyText = await processChatMessage(text, {
    userId: `tg_${incoming.chat.id}`,
    channel: 'telegram',
    chatId: String(incoming.chat.id),
  });

  return { replyText };
}
