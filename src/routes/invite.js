const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const prisma = require('../lib/prisma');

// PENTING: /join harus SEBELUM /:token agar tidak tertangkap sebagai token

// Proses join (setelah login/register)
router.get('/join', async (req, res) => {
  try {
    if (!req.session.user) return res.redirect('/auth/login');

    const token = req.session.inviteToken;
    if (!token) return res.redirect('/');

    const brand = await prisma.company.findUnique({
      where: { inviteToken: token },
      include: { workspace: true }
    });

    if (!brand || !brand.workspace) {
      req.session.inviteToken = null;
      req.flash('error', 'Link invite tidak valid atau sudah kadaluarsa');
      return res.redirect('/');
    }

    const userId = req.session.user.id;

    // Cek apakah user sudah di workspace lain
    const existingMembership = await prisma.membership.findFirst({
      where: { userId },
      include: { company: { include: { workspace: true } } }
    });

    if (existingMembership && existingMembership.company?.workspaceId !== brand.workspaceId) {
      req.session.inviteToken = null;
      req.flash('error', `Kamu sudah terdaftar di workspace lain (${existingMembership.company?.workspace?.name || '?'}). 1 user hanya bisa bergabung di 1 workspace.`);
      return res.redirect('/');
    }

    // Cek apakah sudah member brand ini
    const alreadyMember = await prisma.membership.findFirst({
      where: { userId, companyId: brand.id }
    });

    if (alreadyMember) {
      req.session.inviteToken = null;
      req.flash('success', `Kamu sudah menjadi anggota ${brand.name}`);
      return res.redirect('/');
    }

    // Join brand
    await prisma.membership.create({
      data: { userId, companyId: brand.id, role: 'member' }
    });

    req.session.inviteToken = null;
    req.flash('success', `Selamat bergabung di brand ${brand.name}! 🎉`);
    res.redirect('/');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Gagal bergabung. Coba lagi.');
    res.redirect('/');
  }
});

// Landing invite link
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const brand = await prisma.company.findUnique({
      where: { inviteToken: token },
      include: { workspace: true }
    });

    if (!brand) {
      return res.render('invite/invalid', { title: 'Link Tidak Valid' });
    }

    // Simpan token di session
    req.session.inviteToken = token;

    // Kalau sudah login, langsung proses join
    if (req.session.user) {
      return res.redirect('/invite/join');
    }

    // Belum login, tampilkan landing page
    res.render('invite/landing', {
      title: `Bergabung ke ${brand.name}`,
      brand,
      workspace: brand.workspace
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Generate/regenerate token (owner only)
router.post('/brand/:brandId/generate-token', async (req, res) => {
  try {
    if (!req.session.user || req.session.user.platformRole !== 'owner') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { brandId } = req.params;
    const token = crypto.randomBytes(20).toString('hex');

    await prisma.company.update({
      where: { id: brandId },
      data: { inviteToken: token }
    });

    const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ success: true, link: `${baseUrl}/invite/${token}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
