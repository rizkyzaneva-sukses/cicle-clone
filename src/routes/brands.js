const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { uniqueSlug } = require('../lib/slug');
const { cleanupOrphanRecords } = require('../lib/maintenance');

router.use(requireAuth, requireOwner);

// Semua brand + partner per brand
router.get('/', async (req, res) => {
  try {
    await cleanupOrphanRecords();

    const brands = await prisma.company.findMany({
      include: {
        partnerAccess: { include: { user: true } },
        memberships: true,
        projects: true
      },
      orderBy: { createdAt: 'desc' }
    });

    // Semua user yang bisa dijadikan partner
    const allUsers = await prisma.user.findMany({
      where: { platformRole: { in: ['partner', 'user'] } },
      orderBy: { name: 'asc' }
    });

    res.render('brands/index', { title: 'Kelola Brand', brands, allUsers });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Gagal membuka daftar brand');
    res.redirect('/');
  }
});

// Buat brand baru
router.post('/create', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      req.flash('error', 'Nama brand wajib diisi');
      return res.redirect('/brands');
    }
    await prisma.company.create({
      data: {
        name,
        slug: uniqueSlug(name),
        memberships: {
          create: {
            userId: req.session.user.id,
            role: 'admin'
          }
        }
      }
    });
    req.flash('success', `Brand "${name}" berhasil dibuat`);
    res.redirect('/brands');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Gagal membuat brand');
    res.redirect('/brands');
  }
});

// Hapus brand (owner only)
router.post('/:id/delete', async (req, res) => {
  try {
    const brand = await prisma.company.findUnique({ where: { id: req.params.id } });
    if (!brand) {
      req.flash('error', 'Brand tidak ditemukan');
      return res.redirect('/brands');
    }
    await prisma.company.delete({ where: { id: req.params.id } });
    req.flash('success', `Brand "${brand.name}" berhasil dihapus`);
    res.redirect('/brands');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Gagal menghapus brand. Pastikan tidak ada data terkait.');
    res.redirect('/brands');
  }
});

// Assign partner ke brand
router.post('/:id/assign-partner', async (req, res) => {
  const { email } = req.body;
  const companyId = req.params.id;

  try {
    const targetUser = await prisma.user.findUnique({ where: { email } });
    if (!targetUser) {
      req.flash('error', 'User dengan email tersebut belum terdaftar');
      return res.redirect('/brands');
    }

    // Upgrade platformRole ke partner jika masih user
    if (targetUser.platformRole === 'user') {
      await prisma.user.update({
        where: { id: targetUser.id },
        data: { platformRole: 'partner' }
      });
    }

    const existing = await prisma.partnerAccess.findUnique({
      where: { userId_companyId: { userId: targetUser.id, companyId } }
    });

    if (existing) {
      req.flash('error', `${targetUser.name} sudah jadi partner di brand ini`);
      return res.redirect('/brands');
    }

    await prisma.partnerAccess.create({
      data: { userId: targetUser.id, companyId }
    });

    // Notifikasi
    await prisma.notification.create({
      data: {
        userId: targetUser.id,
        content: `Kamu ditunjuk sebagai Partner untuk brand ini`,
        link: '/'
      }
    });
    const io = req.app.get('io');
    if (io) io.to(`user-${targetUser.id}`).emit('new-notification');

    req.flash('success', `${targetUser.name} berhasil ditambahkan sebagai Partner`);
    res.redirect('/brands');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Terjadi kesalahan');
    res.redirect('/brands');
  }
});

// Cabut akses partner dari brand
router.post('/:id/remove-partner/:userId', async (req, res) => {
  try {
    await prisma.partnerAccess.delete({
      where: {
        userId_companyId: { userId: req.params.userId, companyId: req.params.id }
      }
    });

    // Cek apakah partner masih punya brand lain — kalau tidak, downgrade ke user
    const remaining = await prisma.partnerAccess.count({
      where: { userId: req.params.userId }
    });
    if (remaining === 0) {
      await prisma.user.update({
        where: { id: req.params.userId },
        data: { platformRole: 'user' }
      });
    }

    req.flash('success', 'Akses partner berhasil dicabut');
    res.redirect('/brands');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Terjadi kesalahan');
    res.redirect('/brands');
  }
});

module.exports = router;
