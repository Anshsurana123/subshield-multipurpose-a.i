import 'server-only';

import { processChatMessage } from '@/lib/chat-commands';
import { sendChatMessage } from '@/lib/chat-senders';
import { deliverStoredPushNotification } from '@/lib/push-notifications';
import type { ChatChannel } from '@/lib/types';
import type { ClaimedWorkflowJob } from './repository';

function requiredString(payload: Record<string, unknown>, key: string, maxLength = 8_000): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value || value.length > maxLength) {
    throw new Error(`Invalid workflow payload field: ${key}`);
  }
  return value;
}

function channel(value: unknown): ChatChannel {
  if (value !== 'telegram' && value !== 'linq') throw new Error('Invalid workflow channel');
  return value;
}

async function processChannelMessage(payload: Record<string, unknown>): Promise<void> {
  const provider = channel(payload.provider);
  const eventId = requiredString(payload, 'eventId', 512);
  const userId = requiredString(payload, 'userId', 64);
  const chatId = requiredString(payload, 'chatId', 512);
  const text = requiredString(payload, 'text');
  const reply = await processChatMessage(text, {
    userId,
    channel: provider,
    chatId,
    eventId,
  });
  if (!(await sendChatMessage(provider, chatId, reply))) {
    throw new Error('Channel reply delivery failed');
  }
}

async function sendPushAlert(payload: Record<string, unknown>): Promise<void> {
  const notificationId = requiredString(payload, 'notificationId', 64);
  const userId = requiredString(payload, 'userId', 64);
  const title = requiredString(payload, 'title', 300);
  const body = requiredString(payload, 'body', 2_000);
  const pushComplete = await deliverStoredPushNotification({ notificationId, userId, title, body });
  if (!pushComplete) throw new Error('Push delivery failed');
}

async function sendTrackerChatAlert(payload: Record<string, unknown>): Promise<void> {
  const provider = channel(payload.channel);
  const chatId = requiredString(payload, 'chatId', 512);
  const title = requiredString(payload, 'title', 300);
  const body = requiredString(payload, 'body', 2_000);
  const message = `🎯 *${title}*\n\n${body}`;
  if (!(await sendChatMessage(provider, chatId, message))) {
    throw new Error('Tracker chat alert delivery failed');
  }
}

async function sendChannelLinkConfirmation(payload: Record<string, unknown>): Promise<void> {
  const provider = channel(payload.provider);
  const chatId = requiredString(payload, 'chatId', 512);
  const text = requiredString(payload, 'text', 500);
  if (!(await sendChatMessage(provider, chatId, text))) {
    throw new Error('Channel link confirmation delivery failed');
  }
}

export async function processWorkflowJob(job: ClaimedWorkflowJob): Promise<void> {
  if (job.jobType === 'process_channel_message') {
    await processChannelMessage(job.payload);
    return;
  }
  if (job.jobType === 'send_push_notification') {
    await sendPushAlert(job.payload);
    return;
  }
  if (job.jobType === 'send_channel_link_confirmation') {
    await sendChannelLinkConfirmation(job.payload);
    return;
  }
  await sendTrackerChatAlert(job.payload);
}
