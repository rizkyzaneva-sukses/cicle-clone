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

    const existing = await prisma.workspace.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        ownerId: req.session.user.id
      }
    });

    if (existing) {
      req.flash('error', 'Kamu sudah punya workspace dengan nama itu');
      return res.redirect('/');
    }

    const workspace = await prisma.workspace.create({
      data: {
        name,
        slug: uniqueSlug(name),
        ownerId: req.session.user.id
      }
    });

    await logActivity(prisma, req, {
      action: 'created',
      entityType: 'workspace',
      entityId: workspace.id,
      metadata: { name: workspace.name }
    });

    req.flash('success', `Workspace "${workspace.name}" berhasil dibuat`);
    res.redirect('/brands');
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal membuat workspace');
    res.redirect('/');
  }
});

router.post('/:id/partners', async (req, res) => {
  const { email, role } = req.body;
  const workspaceId = req.params.id;

  try {
    if (req.session.user.platformRole !== 'owner') {
      req.flash('error', 'Hanya Owner yang bisa mengatur CEO/COO workspace');
      return res.redirect('/brands');
    }

    const targetUser = await prisma.user.findUnique({ where: { email } });
    if (!targetUser) {
      req.flash('error', 'User dengan email tersebut belum terdaftar');
      return res.redirect('/brands');
    }

    const cleanRole = role === 'CEO' ? 'CEO' : 'COO';
    await prisma.workspacePartner.upsert({
      where: { userId_workspaceId: { userId: targetUser.id, workspaceId } },
      update: { role: cleanRole },
      create: { userId: targetUser.id, workspaceId, role: cleanRole }
    });

    if (targetUser.platformRole === 'user') {
      await prisma.user.update({
        where: { id: targetUser.id },
        data: { platformRole: 'partner' }
      });
    }

    req.flash('success', `${targetUser.name} berhasil dijadikan ${cleanRole} workspace`);
    res.redirect('/brands');
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal assign CEO/COO workspace');
    res.redirect('/brands');
  }
});

router.post('/:id/partners/:userId/remove', async (req, res) => {
  try {
    if (req.session.user.platformRole !== 'owner') {
      req.flash('error', 'Hanya Owner yang bisa mencabut CEO/COO workspace');
      return res.redirect('/brands');
    }

    await prisma.workspacePartner.delete({
      where: {
        userId_workspaceId: {
          userId: req.params.userId,
          workspaceId: req.params.id
        }
      }
    });

    req.flash('success', 'Akses CEO/COO workspace berhasil dicabut');
    res.redirect('/brands');
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal mencabut akses workspace');
    res.redirect('/brands');
  }
});

module.exports = router;
