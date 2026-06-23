const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { botUsername, getDeepLink, enabled: telegramEnabled } = require('../lib/telegram');

// Upload avatar
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'public', 'uploads')),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `avatar-${req.session.user.id}-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('File harus gambar'));
  }
});

// GET /onboarding — halaman onboarding
router.get('/', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.session.user.id },
    select: { id: true, name: true, email: true, avatar: true, telegramChatId: true, onboardingCompleted: true }
  });

  // Kalau sudah completed, redirect ke dashboard
  if (user.onboardingCompleted) {
    return res.redirect('/');
  }

  const deepLink = telegramEnabled ? getDeepLink(user.id) : null;

  res.render('onboarding', {
    user,
    telegramEnabled,
    botUsername,
    deepLink,
    telegramConnected: Boolean(user.telegramChatId),
    error: null,
    success: null
  });
});

// POST /onboarding/profile — update nama + avatar
router.post('/profile', requireAuth, upload.single('avatar'), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) {
      return res.redirect('/onboarding?error=Nama wajib diisi');
    }

    const updateData = { name };
    if (req.file) {
      updateData.avatar = `/uploads/${req.file.filename}`;
    }

    await prisma.user.update({ where: { id: req.session.user.id }, data: updateData });

    // Update session
    req.session.user.name = name;
    if (req.file) req.session.user.avatar = updateData.avatar;

    res.redirect('/onboarding?success=Profil berhasil diperbarui');
  } catch (err) {
    console.error(err);
    res.redirect('/onboarding?error=Gagal update profil');
  }
});

// POST /onboarding/telegram — save chat ID manual (fallback)
router.post('/telegram', requireAuth, async (req, res) => {
  try {
    const chatId = String(req.body.chatId || '').trim();
    if (!chatId || !/^\d{5,30}$/.test(chatId)) {
      return res.redirect('/onboarding?error=Chat ID tidak valid (5-30 digit angka)');
    }

    await prisma.user.update({
      where: { id: req.session.user.id },
      data: { telegramChatId: chatId }
    });

    res.redirect('/onboarding?success=Telegram berhasil terhubung!');
  } catch (err) {
    console.error(err);
    res.redirect('/onboarding?error=Gagal menyimpan Telegram');
  }
});

// GET /onboarding/telegram-status — AJAX polling: cek apakah Telegram sudah connected
router.get('/telegram-status', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.session.user.id },
      select: { telegramChatId: true }
    });
    res.json({ connected: Boolean(user.telegramChatId), chatId: user.telegramChatId || null });
  } catch (err) {
    res.json({ connected: false, chatId: null });
  }
});

// POST /onboarding/complete — tandai onboarding selesai
router.post('/complete', requireAuth, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.session.user.id },
      data: { onboardingCompleted: true }
    });
    req.flash('success', 'Selamat datang! Setup akunmu sudah selesai 🎉');
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.redirect('/onboarding?error=Gagal menyelesaikan setup');
  }
});

module.exports = router;
