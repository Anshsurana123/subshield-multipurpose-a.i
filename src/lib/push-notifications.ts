import webpush from 'web-push';
import { getSupabaseAdmin } from './supabase/server';

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@subshield.app';

if (vapidPublicKey && vapidPrivateKey) {
  try {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  } catch {
    // Delivery remains unavailable; the durable dashboard notification stays.
  }
}

/** Deliver a notification already persisted by an outbox transaction. */
export async function deliverStoredPushNotification(input: {
  notificationId: string;
  userId: string;
  title: string;
  body: string;
}): Promise<boolean> {
  const admin = getSupabaseAdmin();
  const { data: notification, error: notificationError } = await admin
    .from('notifications')
    .select('id, user_id, delivery_status, delivery_attempt_count')
    .eq('id', input.notificationId)
    .eq('user_id', input.userId)
    .maybeSingle();
  if (notificationError) throw new Error(`Notification read failed: ${notificationError.code}`);
  if (!notification) throw new Error('Notification not found');
  if (notification.delivery_status === 'delivered' || notification.delivery_status === 'unavailable') return true;

  const { data: user, error: userError } = await admin
    .from('users')
    .select('push_subscription')
    .eq('id', input.userId)
    .maybeSingle();
  if (userError) throw new Error(`Push subscription read failed: ${userError.code}`);

  if (!user?.push_subscription || !vapidPublicKey || !vapidPrivateKey) {
    const { error } = await admin
      .from('notifications')
      .update({
        delivery_status: 'unavailable',
        delivery_attempt_count: Number(notification.delivery_attempt_count) + 1,
        last_delivery_error_code: 'PUSH_NOT_CONFIGURED',
      })
      .eq('id', input.notificationId)
      .eq('user_id', input.userId);
    if (error) throw new Error(`Notification status update failed: ${error.code}`);
    return true;
  }

  try {
    await webpush.sendNotification(user.push_subscription, JSON.stringify({
      title: input.title,
      body: input.body,
      icon: '/favicon.ico',
      data: { notificationId: input.notificationId },
    }));
    const { error } = await admin
      .from('notifications')
      .update({
        delivery_status: 'delivered',
        delivery_attempt_count: Number(notification.delivery_attempt_count) + 1,
        last_delivery_error_code: null,
      })
      .eq('id', input.notificationId)
      .eq('user_id', input.userId);
    if (error) throw new Error(`Notification status update failed: ${error.code}`);
    return true;
  } catch {
    const { error } = await admin
      .from('notifications')
      .update({
        delivery_status: 'failed',
        delivery_attempt_count: Number(notification.delivery_attempt_count) + 1,
        last_delivery_error_code: 'PUSH_DELIVERY_FAILED',
      })
      .eq('id', input.notificationId)
      .eq('user_id', input.userId);
    if (error) throw new Error(`Notification failure update failed: ${error.code}`);
    return false;
  }
}
