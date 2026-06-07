const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

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
