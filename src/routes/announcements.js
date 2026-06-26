const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { notifyUser } = require('../lib/notify');
const { upload } = require('../lib/upload');
const { sendTelegramMessage, sendTelegramPhoto } = require('../lib/telegram');

router.use(requireAuth);

function escapeTelegramHtml(value) {
  return String(value || '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
}

router.get('/', async (req, res) => {
  const announcements = await prisma.announcement.findMany({
    include: { createdBy: true },
    orderBy: { createdAt: 'desc' },
    take: 50
  });
  res.render('announcements', { title: 'Pengumuman', announcements });
});

router.post('/', upload.single('image'), async (req, res) => {
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

    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
    const imageName = req.file?.originalname || null;

    await prisma.announcement.create({
      data: { content, imageUrl, imageName, createdById: req.session.user.id }
    });

    const users = await prisma.user.findMany({
      where: { id: { not: req.session.user.id } },
      select: { id: true, telegramChatId: true }
    });
    const io = req.app.get('io');
    const notifContent = `📢 Pengumuman: ${content}`;
    const telegramContent = `📢 <b>Pengumuman</b>\n\n${escapeTelegramHtml(content)}`;
    const appUrl = process.env.APP_URL ? String(process.env.APP_URL).replace(/\/+$/, '') : '';
    const publicImageUrl = imageUrl && appUrl ? `${appUrl}${imageUrl}` : null;

    for (const user of users) {
      await notifyUser(io, user.id, notifContent, '/announcements');
      if (user.telegramChatId) {
        if (publicImageUrl) await sendTelegramPhoto(user.telegramChatId, publicImageUrl, telegramContent.slice(0, 1024));
        else await sendTelegramMessage(user.telegramChatId, telegramContent);
      }
    }

    req.flash('success', imageUrl ? 'Pengumuman + image terkirim ke semua user' : 'Pengumuman terkirim ke semua user');
    res.redirect('/announcements');
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal membuat pengumuman');
    res.redirect('/announcements');
  }
});

module.exports = router;
