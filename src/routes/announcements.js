const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { notifyUser } = require('../lib/notify');
const { upload } = require('../lib/upload');
const { sendTelegramMessage, sendTelegramPhoto } = require('../lib/telegram');

router.use(requireAuth);

const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');

function escapeTelegramHtml(value) {
  return String(value || '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
}

function buildPublicBaseUrl(req) {
  if (process.env.APP_URL) return String(process.env.APP_URL).replace(/\/+$/, '');

  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol;
  return `${protocol}://${req.get('host')}`;
}

async function sendAnnouncementTelegram(chatId, publicImageUrl, telegramContent) {
  if (!chatId) return { ok: false, reason: 'missing-chat-id' };

  if (publicImageUrl) {
    const photoResult = await sendTelegramPhoto(chatId, publicImageUrl, telegramContent.slice(0, 1024));
    if (photoResult?.ok) return photoResult;
  }

  const textWithImageFallback = publicImageUrl
    ? `${telegramContent}\n\n🖼️ ${escapeTelegramHtml(publicImageUrl)}`
    : telegramContent;

  return sendTelegramMessage(chatId, textWithImageFallback);
}

async function deleteAnnouncementImage(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith('/uploads/')) return;

  const filename = path.basename(imageUrl);
  const targetPath = path.join(uploadsDir, filename);
  if (!targetPath.startsWith(uploadsDir)) return;

  try {
    await fs.unlink(targetPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
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

    const users = await prisma.user.findMany({ select: { id: true, telegramChatId: true } });
    const io = req.app.get('io');
    const notifContent = `📢 Pengumuman: ${content}`;
    const telegramContent = `📢 <b>Pengumuman</b>\n\n${escapeTelegramHtml(content)}`;
    const appUrl = buildPublicBaseUrl(req);
    const publicImageUrl = imageUrl ? `${appUrl}${imageUrl}` : null;
    let appNotificationCount = 0;
    let telegramConnectedCount = 0;
    let telegramSuccessCount = 0;
    let telegramFailedCount = 0;

    for (const user of users) {
      try {
        await notifyUser(io, user.id, notifContent, '/announcements');
        appNotificationCount += 1;
      } catch (error) {
        console.error(`Announcement app notification failed for user ${user.id}:`, error.message);
      }

      if (user.telegramChatId) {
        telegramConnectedCount += 1;
        const telegramResult = await sendAnnouncementTelegram(user.telegramChatId, publicImageUrl, telegramContent);
        if (telegramResult?.ok) telegramSuccessCount += 1;
        else telegramFailedCount += 1;
      }
    }

    req.flash(
      'success',
      `Pengumuman tersimpan. Notif app: ${appNotificationCount} user. Telegram: ${telegramSuccessCount}/${telegramConnectedCount} terkirim.`
    );
    if (telegramFailedCount > 0) {
      req.flash('error', `Telegram gagal ke ${telegramFailedCount} user. Cek Chat ID / status bot untuk user terkait.`);
    }
    res.redirect('/announcements');
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal membuat pengumuman');
    res.redirect('/announcements');
  }
});

router.post('/:id/delete', async (req, res) => {
  try {
    if (req.session.user.platformRole !== 'owner') {
      req.flash('error', 'Hanya Owner yang bisa menghapus pengumuman');
      return res.redirect('/announcements');
    }

    const announcement = await prisma.announcement.findUnique({
      where: { id: req.params.id },
      select: { id: true, imageUrl: true }
    });

    if (!announcement) {
      req.flash('error', 'Pengumuman tidak ditemukan');
      return res.redirect('/announcements');
    }

    await prisma.announcement.delete({ where: { id: announcement.id } });
    await deleteAnnouncementImage(announcement.imageUrl);

    req.flash('success', 'Pengumuman berhasil dihapus');
    res.redirect('/announcements');
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal menghapus pengumuman');
    res.redirect('/announcements');
  }
});

module.exports = router;
