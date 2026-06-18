const express = require('express');
const router = express.Router();
const fs = require('fs/promises');
const path = require('path');
const prisma = require('../lib/prisma');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { uniqueSlug } = require('../lib/slug');
const { cleanupOrphanRecords, ensureDefaultWorkspace } = require('../lib/maintenance');
const { notifyUser } = require('../lib/notify');
const { upload } = require('../lib/upload');

router.use(requireAuth, requireOwner);

const BRAND_AVATAR_MAX_SIZE = 3 * 1024 * 1024;
const BRAND_AVATAR_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

async function removeLocalUpload(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const filename = path.basename(url);
  if (!filename || filename !== url.replace('/uploads/', '')) return;

  const filePath = path.join(__dirname, '..', 'public', 'uploads', filename);
  await fs.unlink(filePath).catch(() => {});
}

// Semua brand + partner per brand
router.get('/', async (req, res) => {
  try {
    await cleanupOrphanRecords();
    await ensureDefaultWorkspace(prisma, req.session.user);

    const workspaces = await prisma.workspace.findMany({
      include: {
        partners: { include: { user: true } },
        brands: {
          include: {
            partnerAccess: { include: { user: true } },
            memberships: true,
            projects: true
          },
          orderBy: { createdAt: 'desc' }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    const brands = workspaces.flatMap(workspace => workspace.brands.map(brand => ({ ...brand, workspace })));

    // Semua user yang bisa dijadikan partner
    const allUsers = await prisma.user.findMany({
      where: { platformRole: { in: ['partner', 'user'] } },
      orderBy: { name: 'asc' }
    });

    res.render('brands/index', { title: 'Kelola Brand', workspaces, brands, allUsers });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Gagal membuka daftar brand');
    res.redirect('/');
  }
});

// Buat brand baru
router.post('/create', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const workspaceId = String(req.body.workspaceId || '').trim();
    const description = String(req.body.description || '').trim();
    if (!name || !workspaceId) {
      req.flash('error', 'Nama brand dan workspace wajib diisi');
      return res.redirect('/brands');
    }
    await prisma.company.create({
      data: {
        name,
        slug: uniqueSlug(name),
        workspaceId,
        description: description || null,
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

router.post('/:id/update', async (req, res) => {
  try {
    const brandId = req.params.id;
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim();

    if (!name) {
      req.flash('error', 'Nama brand wajib diisi');
      return res.redirect('/brands');
    }

    const brand = await prisma.company.findUnique({ where: { id: brandId } });
    if (!brand) {
      req.flash('error', 'Brand tidak ditemukan');
      return res.redirect('/brands');
    }

    await prisma.company.update({
      where: { id: brandId },
      data: {
        name,
        description: description || null
      }
    });

    req.flash('success', `Brand "${name}" berhasil diperbarui`);
    res.redirect('/brands');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Gagal memperbarui brand');
    res.redirect('/brands');
  }
});

router.post('/:id/avatar', (req, res) => {
  upload.single('avatar')(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        req.flash('error', 'Gagal upload foto brand. Maksimal ukuran file 3 MB.');
        return res.redirect('/brands');
      }

      const file = req.file;
      if (!file) {
        req.flash('error', 'Pilih foto brand terlebih dulu');
        return res.redirect('/brands');
      }

      if (!BRAND_AVATAR_MIME_TYPES.has(file.mimetype)) {
        await removeLocalUpload(`/uploads/${file.filename}`);
        req.flash('error', 'File harus berupa gambar PNG, JPG, WebP, atau GIF');
        return res.redirect('/brands');
      }

      if (file.size > BRAND_AVATAR_MAX_SIZE) {
        await removeLocalUpload(`/uploads/${file.filename}`);
        req.flash('error', 'Ukuran foto brand maksimal 3 MB');
        return res.redirect('/brands');
      }

      const brand = await prisma.company.findUnique({
        where: { id: req.params.id },
        select: { avatar: true, name: true }
      });
      if (!brand) {
        await removeLocalUpload(`/uploads/${file.filename}`);
        req.flash('error', 'Brand tidak ditemukan');
        return res.redirect('/brands');
      }

      const avatar = `/uploads/${file.filename}`;
      await prisma.company.update({
        where: { id: req.params.id },
        data: { avatar }
      });

      if (brand.avatar && brand.avatar !== avatar) {
        await removeLocalUpload(brand.avatar);
      }

      req.flash('success', `Foto profil brand "${brand.name}" berhasil diperbarui`);
      res.redirect('/brands');
    } catch (err) {
      console.error(err);
      if (req.file) await removeLocalUpload(`/uploads/${req.file.filename}`);
      req.flash('error', 'Gagal memperbarui foto brand');
      res.redirect('/brands');
    }
  });
});

router.post('/:id/avatar/delete', async (req, res) => {
  try {
    const brand = await prisma.company.findUnique({
      where: { id: req.params.id },
      select: { avatar: true, name: true }
    });
    if (!brand) {
      req.flash('error', 'Brand tidak ditemukan');
      return res.redirect('/brands');
    }

    await prisma.company.update({
      where: { id: req.params.id },
      data: { avatar: null }
    });

    if (brand.avatar) await removeLocalUpload(brand.avatar);

    req.flash('success', `Foto profil brand "${brand.name}" dihapus`);
    res.redirect('/brands');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Gagal menghapus foto brand');
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

    await notifyUser(req.app.get('io'), targetUser.id, 'Kamu ditunjuk sebagai Partner untuk brand ini', '/');

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
