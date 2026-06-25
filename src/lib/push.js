const webpush = require('web-push');
const prisma = require('./prisma');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const enabled = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (enabled) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@maulanacorp.local',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

async function sendPushToUser(userId, payload) {
  const result = { enabled, total: 0, sent: 0, removed: 0, failed: 0 };
  if (!enabled) return result;

  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  result.total = subscriptions.length;

  await Promise.all(subscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
      result.sent += 1;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        result.removed += 1;
      } else {
        result.failed += 1;
        console.error('Push send failed:', err.message);
      }
    }
  }));

  return result;
}

module.exports = { sendPushToUser, enabled, vapidPublicKey: VAPID_PUBLIC_KEY || null };
