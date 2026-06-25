const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { enabled: pushEnabled, vapidPublicKey, sendPushToUser } = require('../lib/push');

router.use(requireAuth);

const validTypes = new Set(['PROJECT_TASK', 'DIRECT_CHAT', 'OTHER']);

// Browser push setup: public key + enable flag for the client to check before subscribing
router.get('/push/public-key', (req, res) => {
  res.json({ enabled: pushEnabled, publicKey: vapidPublicKey });
});

// Save a browser push subscription for this user
router.post('/push/subscribe', async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Subscription tidak valid' });
    }

    await prisma.pushSubscription.upsert({
      where: { endpoint },
      update: { userId: req.session.user.id, p256dh: keys.p256dh, auth: keys.auth },
      create: { userId: req.session.user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth }
    });

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal menyimpan subscription' });
  }
});

// Remove a browser push subscription (e.g. user disables notifications)
router.post('/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) {
      await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.session.user.id } });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Gagal menghapus subscription' });
  }
});

router.get('/push/status', async (req, res) => {
  const subscriptions = await prisma.pushSubscription.count({ where: { userId: req.session.user.id } });
  res.json({ enabled: pushEnabled, publicKey: vapidPublicKey, subscriptions });
});

router.post('/push/test', async (req, res) => {
  try {
    const result = await sendPushToUser(req.session.user.id, {
      title: 'Tes notifikasi Maulana Corp',
      body: 'Notifikasi desktop aktif dan siap dipakai.',
      url: '/'
    });

    if (!result.enabled) return res.status(400).json({ error: 'Notifikasi desktop belum diaktifkan oleh admin platform' });
    if (result.total === 0) return res.status(400).json({ error: 'Device ini belum tersubscribe ke notifikasi desktop' });
    if (result.sent === 0) return res.status(500).json({ error: 'Notif tes belum berhasil dikirim', result });

    res.json({ success: true, result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal mengirim notif tes' });
  }
});

router.get('/counts', async (req, res) => {
  const userId = req.session.user.id;
  const [unreadNotifications, unreadNotificationGroups, unreadDirectMessages] = await Promise.all([
    prisma.notification.count({ where: { userId, isRead: false } }),
    prisma.notification.groupBy({
      by: ['type'],
      where: { userId, isRead: false },
      _count: { _all: true }
    }),
    prisma.directMessage.count({ where: { receiverId: userId, readAt: null } })
  ]);

  const groups = { PROJECT_TASK: 0, DIRECT_CHAT: 0, OTHER: 0 };
  unreadNotificationGroups.forEach((group) => {
    groups[group.type] = group._count._all;
  });

  res.json({ unreadNotifications, unreadNotificationGroups: groups, unreadDirectMessages });
});

// Get recent notifications (JSON, for dropdown)
router.get('/', async (req, res) => {
  const { type } = req.query;
  const where = { userId: req.session.user.id };
  if (validTypes.has(type)) where.type = type;

  const notifications = await prisma.notification.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 15
  });
  res.json(notifications);
});

// Mark all as read
router.post('/read-all', async (req, res) => {
  await prisma.notification.updateMany({
    where: { userId: req.session.user.id, isRead: false },
    data: { isRead: true }
  });
  res.json({ success: true });
});

// Mark one as read
router.post('/:id/read', async (req, res) => {
  await prisma.notification.updateMany({
    where: { id: req.params.id, userId: req.session.user.id },
    data: { isRead: true }
  });
  res.json({ success: true });
});

module.exports = router;
