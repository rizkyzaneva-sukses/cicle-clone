const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

router.use(requireAuth);

// Get messages for project
router.get('/messages/:projectId', async (req, res) => {
  const messages = await prisma.chatMessage.findMany({
    where: { projectId: req.params.projectId },
    include: { user: true },
    orderBy: { createdAt: 'asc' },
    take: 100
  });
  res.json(messages);
});

// Post new message (fallback if socket fails)
router.post('/messages/:projectId', async (req, res) => {
  try {
    const { content } = req.body;
    const projectId = req.params.projectId;
    const userId = req.session.user.id;

    const message = await prisma.chatMessage.create({
      data: { content, projectId, userId },
      include: { user: true }
    });

    res.json({ success: true, message });
  } catch (error) {
    res.status(500).json({ error: 'Gagal kirim pesan' });
  }
});

module.exports = router;
