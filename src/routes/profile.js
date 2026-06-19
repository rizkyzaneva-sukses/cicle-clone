const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const fs = require('fs/promises');
const path = require('path');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { botUsername, getDeepLink } = require('../lib/telegram');
const { upload } = require('../lib/upload');

router.use(requireAuth);

const AVATAR_MAX_SIZE = 3 * 1024 * 1024;
const AVATAR_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function sessionUserFrom(user, currentSession = {}) {
  return {
    ...currentSession,
    id: user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar,
    platformRole: user.platformRole
  };
}

async function removeLocalUpload(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const filename = path.basename(url);
  if (!filename || filename !== url.replace('/uploads/', '')) return;

  const filePath = path.join(__dirname, '..', 'public', 'uploads', filename);
  await fs.unlink(filePath).catch(() => {});
}

router.get('/', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.session.user.id }
  });
  res.render('profile', { 
    title: 'Profil Saya', 
    user, 
    telegramBotUsername: botUsername,
    telegramDeepLink: getDeepLink(user.id)
  });
});

router.post('/update', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const userId = req.session.user.id;

    if (!name || !email) {
      req.flash('error', 'Nama dan email wajib diisi');
      return res.redirect('/profile');
    }

    const existing = await prisma.user.findFirst({
      where: { email, NOT: { id: userId } }
    });
    if (existing) {
      req.flash('error', 'Email sudah digunakan akun lain');
      return res.redirect('/profile');
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { name, email }
    });

    req.session.user = sessionUserFrom(updated, req.session.user);
    req.flash('success', 'Profil berhasil diperbarui');
    res.redirect('/profile');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Terjadi kesalahan');
    res.redirect('/profile');
  }
});

router.post('/avatar', (req, res) => {
  upload.single('avatar')(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        req.flash('error', 'Gagal upload foto. Maksimal ukuran file 3 MB.');
        return res.redirect('/profile');
      }

      const file = req.file;
      if (!file) {
        req.flash('error', 'Pilih foto profil terlebih dulu');
        return res.redirect('/profile');
      }

      if (!AVATAR_MIME_TYPES.has(file.mimetype)) {
        await removeLocalUpload(`/uploads/${file.filename}`);
        req.flash('error', 'File harus berupa gambar PNG, JPG, WebP, atau GIF');
        return res.redirect('/profile');
      }

      if (file.size > AVATAR_MAX_SIZE) {
        await removeLocalUpload(`/uploads/${file.filename}`);
        req.flash('error', 'Ukuran foto profil maksimal 3 MB');
        return res.redirect('/profile');
      }

      const currentUser = await prisma.user.findUnique({
        where: { id: req.session.user.id },
        select: { avatar: true }
      });
      const avatar = `/uploads/${file.filename}`;

      const updated = await prisma.user.update({
        where: { id: req.session.user.id },
        data: { avatar }
      });

      if (currentUser?.avatar && currentUser.avatar !== avatar) {
        await removeLocalUpload(currentUser.avatar);
      }

      req.session.user = sessionUserFrom(updated, req.session.user);
      req.flash('success', 'Foto profil berhasil diperbarui');
      res.redirect('/profile');
    } catch (err) {
      console.error(err);
      if (req.file) await removeLocalUpload(`/uploads/${req.file.filename}`);
      req.flash('error', 'Gagal memperbarui foto profil');
      res.redirect('/profile');
    }
  });
});

router.post('/avatar/delete', async (req, res) => {
  try {
    const currentUser = await prisma.user.findUnique({
      where: { id: req.session.user.id },
      select: { avatar: true }
    });

    const updated = await prisma.user.update({
      where: { id: req.session.user.id },
      data: { avatar: null }
    });

    if (currentUser?.avatar) await removeLocalUpload(currentUser.avatar);

    req.session.user = sessionUserFrom(updated, req.session.user);
    req.flash('success', 'Foto profil dihapus');
    res.redirect('/profile');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Gagal menghapus foto profil');
    res.redirect('/profile');
  }
});

router.post('/password', async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const userId = req.session.user.id;

    if (newPassword !== confirmPassword) {
      req.flash('error', 'Konfirmasi password tidak cocok');
      return res.redirect('/profile');
    }

    if (newPassword.length < 6) {
      req.flash('error', 'Password baru minimal 6 karakter');
      return res.redirect('/profile');
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) {
      req.flash('error', 'Password lama tidak benar');
      return res.redirect('/profile');
    }

    await prisma.user.update({
      where: { id: userId },
      data: { password: await bcrypt.hash(newPassword, 10) }
    });

    req.flash('success', 'Password berhasil diubah');
    res.redirect('/profile');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Terjadi kesalahan');
    res.redirect('/profile');
  }
});

router.post('/telegram', async (req, res) => {
  try {
    const telegramChatId = (req.body.telegramChatId || '').trim();
    await prisma.user.update({
      where: { id: req.session.user.id },
      data: { telegramChatId: telegramChatId || null }
    });
    req.flash('success', telegramChatId ? 'Telegram Chat ID disimpan' : 'Telegram Chat ID dihapus');
    res.redirect('/profile');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Gagal menyimpan Telegram Chat ID');
    res.redirect('/profile');
  }
});

module.exports = router;
