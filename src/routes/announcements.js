const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { notifyUser } = require('../lib/notify');
const { sendTelegramMessage } = require('../lib/telegram');

router.use(requireAuth);

router.get('/', async (req, res) => {
  const announcements = await prisma.announcement.findMany({
    include: { createdBy: true },
    orderBy: { createdAt: 'desc' },
    take: 50
  });
  res.render('announcements', { title: 'Pengumuman', announcements });
});

router.post('/', async (req, res) => {
  try {
    if (req.session.user.platformRole !== 'owner') {
      req.flash('error', 'Hanya Owner yang bisa membuat pengumuman');
      return res.redirect('/announcements');
    }
    const content = (req.body.content || '').trim();
    if (!content) {
      req.flash('error', 'Isi pengumuman wajib diisi');
      return res.redirect('/announcements');
    }

    await prisma.announcement.create({
      data: { content, createdById: req.session.user.id }
    });

    const users = await prisma.user.findMany({
      where: { id: { not: req.session.user.id } },
      select: { id: true, telegramChatId: true }
    });
    const io = req.app.get('io');
    const notifContent = `📢 Pengumuman: ${content}`;
    for (const user of users) {
      await notifyUser(io, user.id, notifContent, '/announcements');
      if (user.telegramChatId) await sendTelegramMessage(user.telegramChatId, notifContent);
    }

    req.flash('success', 'Pengumuman terkirim ke semua user');
    res.redirect('/announcements');
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal membuat pengumuman');
    res.redirect('/announcements');
  }
});

module.exports = router;
