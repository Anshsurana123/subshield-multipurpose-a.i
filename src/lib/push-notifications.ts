import webpush from 'web-push';
import { supabaseAdmin } from './supabase/server';
import { NotificationItem, NotificationType } from './types';

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@subshield.app';

if (vapidPublicKey && vapidPrivateKey) {
  try {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  } catch (err) {
    console.warn('[PushNotifications] VAPID initialization notice:', err);
  }
}

export async function sendPushNotification(
  userId: string,
  title: string,
  body: string,
  type: NotificationType,
  decisionId?: string
): Promise<NotificationItem | null> {
  console.log(`[PushNotifications] Preparing push notification for user ${userId}: "${title}"`);

  const notification: NotificationItem = {
    id: `notif_${Math.random().toString(36).substring(2, 9)}`,
    userId,
    decisionId,
    title,
    body,
    type,
    sentAt: new Date().toISOString(),
  };

  // 1. Fetch user's push subscription from Supabase
  try {
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('push_subscription')
      .eq('id', userId)
      .single();

    if (user && user.push_subscription && vapidPublicKey && vapidPrivateKey) {
      await webpush.sendNotification(
        user.push_subscription,
        JSON.stringify({
          title,
          body,
          icon: '/favicon.ico',
          data: { decisionId, type },
        })
      );
      console.log('[PushNotifications] Web push delivered successfully!');
    }
  } catch (err) {
    console.warn('[PushNotifications] Push delivery notice (mock/fallback mode):', err);
  }

  // 2. Log notification in Supabase database
  try {
    await supabaseAdmin.from('notifications').insert({
      id: notification.id,
      user_id: userId,
      decision_id: decisionId || null,
      title,
      body,
      type,
      sent_at: notification.sentAt,
    });
  } catch (dbErr) {
    console.warn('[PushNotifications] Could not save notification to DB:', dbErr);
  }

  return notification;
}
