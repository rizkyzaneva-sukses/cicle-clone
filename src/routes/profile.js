const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

router.get('/', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.session.user.id }
  });
  res.render('profile', { title: 'Profil Saya', user });
});

router.post('/update', async (req, res) => {
  try {
    const { name, email } = req.body;
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

    req.session.user = { id: updated.id, name: updated.name, email: updated.email };
    req.flash('success', 'Profil berhasil diperbarui');
    res.redirect('/profile');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Terjadi kesalahan');
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

module.exports = router;
