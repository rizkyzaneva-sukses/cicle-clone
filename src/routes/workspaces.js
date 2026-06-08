const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { uniqueSlug } = require('../lib/slug');
const { logActivity } = require('../lib/activity');

router.use(requireAuth);

router.post('/create', async (req, res) => {
  try {
    if (req.session.user.platformRole !== 'owner') {
      req.flash('error', 'Hanya Owner yang bisa membuat workspace baru');
      return res.redirect('/');
    }

    const name = (req.body.name || '').trim();
    if (!name) {
      req.flash('error', 'Nama workspace wajib diisi');
      return res.redirect('/');
    }

    const existing = await prisma.company.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        memberships: { some: { userId: req.session.user.id } }
      }
    });

    if (existing) {
      req.flash('error', 'Kamu sudah punya workspace dengan nama itu');
      return res.redirect('/');
    }

    const company = await prisma.company.create({
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

    await logActivity(prisma, req, {
      action: 'created',
      entityType: 'workspace',
      entityId: company.id,
      metadata: { name: company.name }
    });

    req.flash('success', `Workspace "${company.name}" berhasil dibuat`);
    res.redirect(`/projects?companyId=${company.id}`);
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal membuat workspace');
    res.redirect('/');
  }
});

module.exports = router;
