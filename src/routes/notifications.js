const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { enabled: pushEnabled, vapidPublicKey } = require('../lib/push');

router.use(requireAuth);

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

// Get recent notifications (JSON, for dropdown)
router.get('/', async (req, res) => {
  const notifications = await prisma.notification.findMany({
    where: { userId: req.session.user.id },
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
  await prisma.notification.update({
    where: { id: req.params.id },
    data: { isRead: true }
  });
  res.json({ success: true });
});

module.exports = router;
