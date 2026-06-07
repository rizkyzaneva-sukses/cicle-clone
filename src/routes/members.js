const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// List all members of user's company
router.get('/', async (req, res) => {
  const userId = req.session.user.id;

  const userMembership = await prisma.membership.findFirst({
    where: { userId },
    include: {
      company: {
        include: {
          memberships: {
            include: { user: true },
            orderBy: { joinedAt: 'asc' }
          }
        }
      }
    }
  });

  if (!userMembership) return res.redirect('/');

  res.render('members', {
    title: 'Anggota Tim',
    company: userMembership.company,
    members: userMembership.company.memberships,
    isAdmin: userMembership.role === 'admin',
    currentUserId: userId
  });
});

// Invite member by email
router.post('/invite', async (req, res) => {
  const { email } = req.body;
  const userId = req.session.user.id;

  try {
    const adminMembership = await prisma.membership.findFirst({
      where: { userId, role: 'admin' }
    });

    if (!adminMembership) {
      req.flash('error', 'Hanya admin yang bisa mengundang anggota');
      return res.redirect('/members');
    }

    const targetUser = await prisma.user.findUnique({ where: { email } });
    if (!targetUser) {
      req.flash('error', 'User dengan email tersebut belum terdaftar. Minta mereka daftar dulu.');
      return res.redirect('/members');
    }

    const existing = await prisma.membership.findUnique({
      where: { userId_companyId: { userId: targetUser.id, companyId: adminMembership.companyId } }
    });

    if (existing) {
      req.flash('error', `${targetUser.name} sudah menjadi anggota workspace ini`);
      return res.redirect('/members');
    }

    await prisma.membership.create({
      data: { userId: targetUser.id, companyId: adminMembership.companyId, role: 'member' }
    });

    req.flash('success', `${targetUser.name} berhasil ditambahkan sebagai anggota`);
    res.redirect('/members');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Terjadi kesalahan, coba lagi');
    res.redirect('/members');
  }
});

// Change member role
router.post('/:membershipId/role', async (req, res) => {
  const { membershipId } = req.params;
  const { role } = req.body;
  const userId = req.session.user.id;

  try {
    const adminMembership = await prisma.membership.findFirst({
      where: { userId, role: 'admin' }
    });

    if (!adminMembership) {
      req.flash('error', 'Hanya admin yang bisa mengubah role');
      return res.redirect('/members');
    }

    const target = await prisma.membership.findUnique({ where: { id: membershipId } });
    if (target?.userId === userId) {
      req.flash('error', 'Tidak bisa mengubah role sendiri');
      return res.redirect('/members');
    }

    await prisma.membership.update({
      where: { id: membershipId },
      data: { role: role === 'admin' ? 'admin' : 'member' }
    });

    req.flash('success', 'Role berhasil diubah');
    res.redirect('/members');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Terjadi kesalahan');
    res.redirect('/members');
  }
});

// Remove member
router.post('/:membershipId/remove', async (req, res) => {
  const { membershipId } = req.params;
  const userId = req.session.user.id;

  try {
    const adminMembership = await prisma.membership.findFirst({
      where: { userId, role: 'admin' }
    });

    if (!adminMembership) {
      req.flash('error', 'Hanya admin yang bisa menghapus anggota');
      return res.redirect('/members');
    }

    const target = await prisma.membership.findUnique({ where: { id: membershipId } });
    if (!target) return res.redirect('/members');

    if (target.userId === userId) {
      req.flash('error', 'Tidak bisa menghapus diri sendiri dari workspace');
      return res.redirect('/members');
    }

    await prisma.membership.delete({ where: { id: membershipId } });
    req.flash('success', 'Anggota berhasil dihapus dari workspace');
    res.redirect('/members');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Terjadi kesalahan');
    res.redirect('/members');
  }
});

module.exports = router;
