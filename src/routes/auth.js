const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');

router.get('/register', (req, res) => {
  res.render('auth/register', { error: null });
});

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, companyName } = req.body;

    if (!name || !email || !password || !companyName) {
      return res.render('auth/register', { error: 'Semua field wajib diisi' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.render('auth/register', { error: 'Email sudah terdaftar' });
    }

    // User pertama yang daftar = Owner platform
    const userCount = await prisma.user.count();
    const platformRole = userCount === 0 ? 'owner' : 'user';

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email, password: hashedPassword, platformRole }
    });

    const slug = companyName.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now();
    const company = await prisma.company.create({
      data: { name: companyName, slug }
    });

    // Owner & non-owner sama-sama jadi admin di brand yang mereka buat
    await prisma.membership.create({
      data: { userId: user.id, companyId: company.id, role: 'admin' }
    });

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      platformRole: user.platformRole
    };

    req.flash('success', platformRole === 'owner'
      ? 'Selamat datang, Owner! Platform Cicle siap digunakan.'
      : 'Akun berhasil dibuat. Hubungi Owner untuk akses brand.'
    );
    res.redirect('/');
  } catch (error) {
    console.error(error);
    res.render('auth/register', { error: 'Terjadi kesalahan. Coba lagi.' });
  }
});

router.get('/login', (req, res) => {
  res.render('auth/login', { error: null });
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.render('auth/login', { error: 'Email atau password salah' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.render('auth/login', { error: 'Email atau password salah' });

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      platformRole: user.platformRole
    };

    res.redirect('/');
  } catch (error) {
    console.error(error);
    res.render('auth/login', { error: 'Terjadi kesalahan' });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/auth/login'));
});

module.exports = router;
