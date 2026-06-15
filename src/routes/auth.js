const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { uniqueSlug } = require('../lib/slug');
const { isConfiguredOwner } = require('../lib/owners');

router.get('/register', async (req, res) => {
  const userCount = await prisma.user.count();
  // Simpan invite token dari query ke session
  if (req.query.next && req.query.next === '/invite/join' && req.query.token) {
    req.session.inviteToken = req.query.token;
  }
  res.render('auth/register', { error: null, isFirstUser: userCount === 0, next: req.query.next || '/' });
});

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, companyName } = req.body;

    // User pertama yang daftar = Owner platform
    const userCount = await prisma.user.count();
    const isFirstUser = userCount === 0;

    if (!name || !email || !password || (isFirstUser && !companyName)) {
      return res.render('auth/register', { error: 'Semua field wajib diisi', isFirstUser });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.render('auth/register', { error: 'Email sudah terdaftar', isFirstUser });
    }

    const platformRole = isFirstUser || isConfiguredOwner(email) ? 'owner' : 'user';

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email, password: hashedPassword, platformRole }
    });

    if (isFirstUser) {
      await prisma.workspace.create({
        data: {
          name: companyName,
          slug: uniqueSlug(companyName),
          ownerId: user.id
        }
      });
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      platformRole: user.platformRole
    };

    req.flash('success', platformRole === 'owner'
      ? 'Selamat datang, Owner! Maulana Corp Project Management siap digunakan.'
      : 'Akun berhasil dibuat. Bergabung ke brand via link invite...'
    );
    const nextUrl = req.body.next || '/';
    res.redirect(nextUrl === '/invite/join' ? '/invite/join' : '/');
  } catch (error) {
    console.error(error);
    const userCount = await prisma.user.count().catch(() => 1);
    res.render('auth/register', { error: 'Terjadi kesalahan. Coba lagi.', isFirstUser: userCount === 0, next: '/' });
  }
});

router.get('/login', (req, res) => {
  res.render('auth/login', { error: null, next: req.query.next || '/' });
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.render('auth/login', { error: 'Email atau password salah' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.render('auth/login', { error: 'Email atau password salah' });

    if (isConfiguredOwner(user.email) && user.platformRole !== 'owner') {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { platformRole: 'owner' }
      });
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      platformRole: user.platformRole
    };

    const nextUrl = req.query.next || req.body.next || '/';
    res.redirect(nextUrl === '/invite/join' ? '/invite/join' : '/');
  } catch (error) {
    console.error(error);
    res.render('auth/login', { error: 'Terjadi kesalahan' });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/auth/login'));
});

module.exports = router;
