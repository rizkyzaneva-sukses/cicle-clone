const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Register - Create user + company
router.get('/register', (req, res) => {
  res.render('auth/register', { error: null });
});

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, companyName } = req.body;

    if (!name || !email || !password || !companyName) {
      return res.render('auth/register', { error: 'Semua field wajib diisi' });
    }

    // Check if user exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.render('auth/register', { error: 'Email sudah terdaftar' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword
      }
    });

    // Create company
    const slug = companyName.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now();
    const company = await prisma.company.create({
      data: {
        name: companyName,
        slug
      }
    });

    // Create membership as admin
    await prisma.membership.create({
      data: {
        userId: user.id,
        companyId: company.id,
        role: 'admin'
      }
    });

    // Auto login
    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email
    };

    req.flash('success', 'Selamat datang di Cicle! Perusahaan Anda berhasil dibuat.');
    res.redirect('/');
  } catch (error) {
    console.error(error);
    res.render('auth/register', { error: 'Terjadi kesalahan. Coba lagi.' });
  }
});

// Login
router.get('/login', (req, res) => {
  res.render('auth/login', { error: null });
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.render('auth/login', { error: 'Email atau password salah' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.render('auth/login', { error: 'Email atau password salah' });
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email
    };

    res.redirect('/');
  } catch (error) {
    console.error(error);
    res.render('auth/login', { error: 'Terjadi kesalahan' });
  }
});

// Logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/auth/login');
  });
});

module.exports = router;
