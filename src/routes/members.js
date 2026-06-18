const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { notifyUser } = require('../lib/notify');

router.use(requireAuth);

// Ambil company yang relevan untuk user ini
async function getUserCompany(userId, platformRole) {
  if (platformRole === 'owner') {
    // Owner bisa lihat semua — default ke yang pertama, atau dari query
    return prisma.membership.findFirst({
      where: { userId },
      include: { company: true }
    });
  }
  if (platformRole === 'partner') {
    const pa = await prisma.partnerAccess.findFirst({
      where: { userId },
      include: { company: true }
    });
    return pa ? { company: pa.company, role: 'partner' } : null;
  }
  return prisma.membership.findFirst({
    where: { userId },
    include: { company: true }
  });
}

async function canManageCompany(req, companyId) {
  const { id: userId, platformRole = 'user' } = req.session.user;

  if (platformRole === 'owner') return true;

  if (platformRole === 'partner') {
    const directPartner = await prisma.partnerAccess.findUnique({
      where: { userId_companyId: { userId, companyId } }
    });
    if (directPartner) return true;

    const workspacePartner = await prisma.workspacePartner.findFirst({
      where: { userId, workspace: { brands: { some: { id: companyId } } } }
    });
    if (workspacePartner) return true;
  }

  const adminMembership = await prisma.membership.findFirst({
    where: { userId, companyId, role: 'admin' }
  });
  return !!adminMembership;
}

async function getResettableTarget(req, targetUserId, companyId) {
  const { id: currentUserId, platformRole = 'user' } = req.session.user;
  if (!companyId || targetUserId === currentUserId) return null;

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, name: true, email: true, platformRole: true }
  });
  if (!target) return null;

  if (platformRole === 'owner') return target;
  if (target.platformRole === 'owner' || target.platformRole === 'partner') return null;

  const canManage = await canManageCompany(req, companyId);
  if (!canManage) return null;

  const targetMembership = await prisma.membership.findUnique({
    where: { userId_companyId: { userId: targetUserId, companyId } }
  });
  return targetMembership ? target : null;
}

router.get('/', async (req, res) => {
  const userId = req.session.user.id;
  const platformRole = req.session.user.platformRole || 'user';

  // Ambil companyId dari query (owner bisa switch brand)
  const companyId = req.query.companyId;

  let company, userRole;

  if (platformRole === 'owner') {
    const c = companyId
      ? await prisma.company.findUnique({ where: { id: companyId } })
      : (await prisma.company.findFirst({ orderBy: { createdAt: 'asc' } }));
    company = c;
    userRole = 'owner';
  } else if (platformRole === 'partner') {
    const workspaceAccess = await prisma.workspacePartner.findFirst({
      where: {
        userId,
        ...(companyId ? { workspace: { brands: { some: { id: companyId } } } } : {})
      },
      include: {
        workspace: {
          include: { brands: true }
        }
      }
    });
    if (workspaceAccess) {
      company = companyId
        ? workspaceAccess.workspace.brands.find(brand => brand.id === companyId)
        : workspaceAccess.workspace.brands[0];
      userRole = workspaceAccess.role.toLowerCase();
    } else {
      const pa = await prisma.partnerAccess.findFirst({
      where: { userId, ...(companyId ? { companyId } : {}) },
      include: { company: true }
      });
      company = pa?.company;
      userRole = 'partner';
    }
  } else {
    const m = await prisma.membership.findFirst({
      where: { userId, ...(companyId ? { companyId } : {}) },
      include: { company: true }
    });
    company = m?.company;
    userRole = m?.role || 'member';
  }

  if (!company) return res.redirect('/');

  const members = await prisma.membership.findMany({
    where: { companyId: company.id },
    include: { user: true },
    orderBy: { joinedAt: 'asc' }
  });

  // Partner yang punya akses ke brand ini
  const partners = await prisma.partnerAccess.findMany({
    where: { companyId: company.id },
    include: { user: true }
  });

  const canManage = ['owner', 'partner', 'admin', 'ceo', 'coo'].includes(userRole);

  res.render('members', {
    title: 'Anggota Tim',
    company,
    members,
    partners,
    userRole,
    canManage,
    currentUserId: userId
  });
});

// Invite member (admin/partner/owner)
router.post('/invite', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { companyId } = req.body;
  const { id: userId, platformRole = 'user' } = req.session.user;

  try {
    // Cek hak akses
    const hasAccess = platformRole === 'owner' ||
      (platformRole === 'partner' && (await prisma.partnerAccess.findUnique({
        where: { userId_companyId: { userId, companyId } }
      }) || await prisma.workspacePartner.findFirst({
        where: { userId, workspace: { brands: { some: { id: companyId } } } }
      }))) ||
      await prisma.membership.findFirst({ where: { userId, companyId, role: 'admin' } });

    if (!hasAccess) {
      req.flash('error', 'Kamu tidak punya akses untuk mengundang anggota');
      return res.redirect(`/members?companyId=${companyId}`);
    }

    const target = await prisma.user.findUnique({ where: { email } });
    if (!target) {
      req.flash('error', 'User belum terdaftar. Minta mereka daftar dulu.');
      return res.redirect(`/members?companyId=${companyId}`);
    }

    const existing = await prisma.membership.findUnique({
      where: { userId_companyId: { userId: target.id, companyId } }
    });
    if (existing) {
      req.flash('error', `${target.name} sudah jadi anggota brand ini`);
      return res.redirect(`/members?companyId=${companyId}`);
    }

    await prisma.membership.create({
      data: { userId: target.id, companyId, role: 'member' }
    });

    req.flash('success', `${target.name} berhasil ditambahkan sebagai Member`);
    res.redirect(`/members?companyId=${companyId}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Terjadi kesalahan');
    res.redirect('/members');
  }
});

// Cabut akses partner dari brand (owner only)
router.post('/partners/:userId/remove', async (req, res) => {
  const { userId } = req.params;
  const { companyId } = req.body;
  const platformRole = req.session.user.platformRole || 'user';

  try {
    if (platformRole !== 'owner') {
      req.flash('error', 'Hanya Owner yang bisa mencabut akses Partner');
      return res.redirect(`/members?companyId=${companyId}`);
    }

    const access = await prisma.partnerAccess.findUnique({
      where: { userId_companyId: { userId, companyId } },
      include: { user: true, company: true }
    });

    if (!access) {
      req.flash('error', 'Partner tidak ditemukan di brand ini');
      return res.redirect(`/members?companyId=${companyId}`);
    }

    await prisma.partnerAccess.delete({
      where: { userId_companyId: { userId, companyId } }
    });

    const remaining = await prisma.partnerAccess.count({ where: { userId } });
    if (remaining === 0) {
      await prisma.user.update({
        where: { id: userId },
        data: { platformRole: 'user' }
      });
    }

    await notifyUser(req.app.get('io'), userId, `Akses Partner kamu untuk brand "${access.company.name}" sudah dicabut`, '/');

    req.flash('success', `${access.user.name} sudah tidak menjadi Partner di brand ini`);
    res.redirect(`/members?companyId=${companyId}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Gagal mencabut akses Partner');
    res.redirect(`/members?companyId=${companyId}`);
  }
});

// Ubah role member
router.post('/:membershipId/role', async (req, res) => {
  const { membershipId } = req.params;
  const { role, companyId } = req.body;
  const { id: userId, platformRole } = req.session.user;

  try {
    const target = await prisma.membership.findUnique({ where: { id: membershipId } });
    if (!target) return res.redirect(`/members?companyId=${companyId}`);
    if (target.userId === userId) {
      req.flash('error', 'Tidak bisa mengubah role sendiri');
      return res.redirect(`/members?companyId=${companyId}`);
    }

    const canChange = platformRole === 'owner' ||
      (platformRole === 'partner' && (await prisma.partnerAccess.findUnique({
        where: { userId_companyId: { userId, companyId: target.companyId } }
      }) || await prisma.workspacePartner.findFirst({
        where: { userId, workspace: { brands: { some: { id: target.companyId } } } }
      }))) ||
      await prisma.membership.findFirst({ where: { userId, companyId: target.companyId, role: 'admin' } });

    if (!canChange) {
      req.flash('error', 'Akses ditolak');
      return res.redirect(`/members?companyId=${companyId}`);
    }

    await prisma.membership.update({
      where: { id: membershipId },
      data: { role: role === 'admin' ? 'admin' : 'member' }
    });

    req.flash('success', 'Role berhasil diubah');
    res.redirect(`/members?companyId=${companyId}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Terjadi kesalahan');
    res.redirect('/members');
  }
});

// Hapus member
router.post('/:membershipId/remove', async (req, res) => {
  const { membershipId } = req.params;
  const { companyId } = req.body;
  const { id: userId, platformRole } = req.session.user;

  try {
    const target = await prisma.membership.findUnique({ where: { id: membershipId } });
    if (!target) return res.redirect(`/members?companyId=${companyId}`);
    if (target.userId === userId) {
      req.flash('error', 'Tidak bisa menghapus diri sendiri');
      return res.redirect(`/members?companyId=${companyId}`);
    }

    const canRemove = platformRole === 'owner' ||
      (platformRole === 'partner' && (await prisma.partnerAccess.findUnique({
        where: { userId_companyId: { userId, companyId: target.companyId } }
      }) || await prisma.workspacePartner.findFirst({
        where: { userId, workspace: { brands: { some: { id: target.companyId } } } }
      }))) ||
      await prisma.membership.findFirst({ where: { userId, companyId: target.companyId, role: 'admin' } });

    if (!canRemove) {
      req.flash('error', 'Akses ditolak');
      return res.redirect(`/members?companyId=${companyId}`);
    }

    await prisma.membership.delete({ where: { id: membershipId } });
    req.flash('success', 'Anggota berhasil dihapus');
    res.redirect(`/members?companyId=${companyId}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Terjadi kesalahan');
    res.redirect('/members');
  }
});

// Reset password anggota oleh pengelola brand/workspace
router.post('/users/:userId/reset-password', async (req, res) => {
  const { userId: targetUserId } = req.params;
  const companyId = String(req.body.companyId || '');
  const newPassword = String(req.body.newPassword || '');
  const confirmPassword = String(req.body.confirmPassword || '');

  try {
    if (newPassword !== confirmPassword) {
      req.flash('error', 'Konfirmasi password tidak cocok');
      return res.redirect(companyId ? `/members?companyId=${companyId}` : '/members');
    }

    if (newPassword.length < 6) {
      req.flash('error', 'Password baru minimal 6 karakter');
      return res.redirect(companyId ? `/members?companyId=${companyId}` : '/members');
    }

    const target = await getResettableTarget(req, targetUserId, companyId);
    if (!target) {
      req.flash('error', 'Kamu tidak punya akses untuk reset password user ini');
      return res.redirect(companyId ? `/members?companyId=${companyId}` : '/members');
    }

    await prisma.user.update({
      where: { id: targetUserId },
      data: { password: await bcrypt.hash(newPassword, 10) }
    });

    await notifyUser(req.app.get('io'), targetUserId, 'Password akun kamu sudah direset oleh pengelola tim', '/profile').catch(() => {});

    req.flash('success', `Password ${target.name} berhasil direset. Berikan password baru langsung ke user terkait.`);
    res.redirect(`/members?companyId=${companyId}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Gagal reset password');
    res.redirect(companyId ? `/members?companyId=${companyId}` : '/members');
  }
});

module.exports = router;
