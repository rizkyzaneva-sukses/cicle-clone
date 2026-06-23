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

async function getUserWorkspaceIds(userId) {
  const [memberships, partnerAccess, workspaceRoles, ownedWorkspaces] = await Promise.all([
    prisma.membership.findMany({
      where: { userId },
      include: { company: { select: { workspaceId: true } } }
    }),
    prisma.partnerAccess.findMany({
      where: { userId },
      include: { company: { select: { workspaceId: true } } }
    }),
    prisma.workspacePartner.findMany({
      where: { userId },
      select: { workspaceId: true }
    }),
    prisma.workspace.findMany({
      where: { ownerId: userId },
      select: { id: true }
    })
  ]);

  const workspaceIds = new Set();
  memberships.forEach(membership => {
    if (membership.company?.workspaceId) workspaceIds.add(membership.company.workspaceId);
  });
  partnerAccess.forEach(access => {
    if (access.company?.workspaceId) workspaceIds.add(access.company.workspaceId);
  });
  workspaceRoles.forEach(access => {
    if (access.workspaceId) workspaceIds.add(access.workspaceId);
  });
  ownedWorkspaces.forEach(workspace => {
    if (workspace.id) workspaceIds.add(workspace.id);
  });

  return [...workspaceIds];
}

async function getManageableHoldingWorkspaces(req) {
  const { id: userId, platformRole = 'user' } = req.session.user;

  if (platformRole === 'owner') {
    return prisma.workspace.findMany({
      include: {
        brands: {
          select: { id: true, name: true },
          orderBy: { createdAt: 'asc' }
        }
      },
      orderBy: { createdAt: 'asc' }
    });
  }

  if (platformRole !== 'partner') return [];

  return prisma.workspace.findMany({
    where: {
      OR: [
        { partners: { some: { userId } } },
        { brands: { some: { partnerAccess: { some: { userId } } } } }
      ]
    },
    include: {
      brands: {
        select: { id: true, name: true },
        orderBy: { createdAt: 'asc' }
      }
    },
    orderBy: { createdAt: 'asc' }
  });
}

async function canManageHoldingWorkspace(req, workspaceId) {
  const { id: userId, platformRole = 'user' } = req.session.user;

  if (platformRole === 'owner') return true;
  if (platformRole !== 'partner') return false;

  const [workspacePartner, brandPartner] = await Promise.all([
    prisma.workspacePartner.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } }
    }),
    prisma.partnerAccess.findFirst({
      where: { userId, company: { workspaceId } }
    })
  ]);

  return Boolean(workspacePartner || brandPartner);
}

async function deleteUserAccount(tx, userId) {
  await tx.task.updateMany({
    where: { assigneeId: userId },
    data: { assigneeId: null }
  });
  await tx.recurringTaskTemplate.updateMany({
    where: { assigneeId: userId },
    data: { assigneeId: null }
  });
  await tx.projectReportEntry.updateMany({
    where: { createdById: userId },
    data: { createdById: null }
  });
  await tx.announcement.updateMany({
    where: { createdById: userId },
    data: { createdById: null }
  });
  await tx.workspace.updateMany({
    where: { ownerId: userId },
    data: { ownerId: null }
  });
  await tx.activityLog.updateMany({
    where: { userId },
    data: { userId: null }
  });

  await tx.comment.deleteMany({ where: { userId } });
  await tx.chatMessage.deleteMany({ where: { userId } });
  await tx.membership.deleteMany({ where: { userId } });

  await tx.user.delete({ where: { id: userId } });
}

async function buildHoldingWorkspaceView(workspaceId) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: {
      owner: true,
      partners: {
        include: { user: true },
        orderBy: { assignedAt: 'asc' }
      },
      brands: {
        select: { id: true, name: true, description: true, avatar: true },
        orderBy: { createdAt: 'asc' }
      }
    }
  });
  if (!workspace) return null;

  const [memberships, partnerAccess] = await Promise.all([
    prisma.membership.findMany({
      where: { company: { workspaceId } },
      include: {
        user: true,
        company: { select: { id: true, name: true } }
      },
      orderBy: { joinedAt: 'asc' }
    }),
    prisma.partnerAccess.findMany({
      where: { company: { workspaceId } },
      include: {
        user: true,
        company: { select: { id: true, name: true } }
      },
      orderBy: { assignedAt: 'asc' }
    })
  ]);

  const rows = new Map();
  const ensureRow = (user) => {
    if (!rows.has(user.id)) {
      rows.set(user.id, {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        platformRole: user.platformRole,
        telegramChatId: user.telegramChatId,
        workspaceRoles: new Set(),
        brandMemberships: new Map(),
        partnerBrands: new Map()
      });
    }
    return rows.get(user.id);
  };

  if (workspace.owner) {
    ensureRow(workspace.owner).workspaceRoles.add('OWNER');
  }

  workspace.partners.forEach(partner => {
    ensureRow(partner.user).workspaceRoles.add(partner.role);
  });

  memberships.forEach(membership => {
    const row = ensureRow(membership.user);
    row.brandMemberships.set(membership.companyId, {
      id: membership.company.id,
      name: membership.company.name,
      role: membership.role
    });
  });

  partnerAccess.forEach(access => {
    const row = ensureRow(access.user);
    row.partnerBrands.set(access.companyId, {
      id: access.company.id,
      name: access.company.name
    });
  });

  return {
    workspace,
    rows: [...rows.values()]
      .map(row => ({
        ...row,
        workspaceRoles: [...row.workspaceRoles],
        brandMemberships: [...row.brandMemberships.values()],
        partnerBrands: [...row.partnerBrands.values()]
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'id'))
  };
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

router.get('/holding', async (req, res) => {
  const userId = req.session.user.id;
  const platformRole = req.session.user.platformRole || 'user';

  if (!['owner', 'partner'].includes(platformRole)) {
    req.flash('error', 'Fitur ini khusus Owner / Partner');
    return res.redirect('/members');
  }

  const workspaces = await getManageableHoldingWorkspaces(req);

  const activeWorkspaceId = String(req.query.workspaceId || workspaces[0]?.id || '');
  const canOpenWorkspace = activeWorkspaceId
    ? workspaces.some(workspace => workspace.id === activeWorkspaceId)
    : false;
  if (activeWorkspaceId && !canOpenWorkspace) {
    req.flash('error', 'Kamu tidak punya akses ke holding tersebut');
    return res.redirect('/members/holding');
  }

  const holdingView = activeWorkspaceId ? await buildHoldingWorkspaceView(activeWorkspaceId) : null;

  const userScopeWhere = platformRole === 'owner'
    ? {}
    : {
        OR: [
          { memberships: { some: { company: { workspaceId: activeWorkspaceId } } } },
          { partnerAccess: { some: { company: { workspaceId: activeWorkspaceId } } } },
          { workspaceRoles: { some: { workspaceId: activeWorkspaceId } } },
          { ownedWorkspaces: { some: { id: activeWorkspaceId } } }
        ]
      };

  const allUsers = await prisma.user.findMany({
    where: userScopeWhere,
    include: {
      memberships: {
        include: {
          company: {
            select: {
              workspaceId: true,
              workspace: { select: { name: true } }
            }
          }
        }
      },
      partnerAccess: {
        include: {
          company: {
            select: {
              workspaceId: true,
              workspace: { select: { name: true } }
            }
          }
        }
      },
      workspaceRoles: {
        include: {
          workspace: { select: { id: true, name: true } }
        }
      },
      ownedWorkspaces: {
        select: { id: true, name: true }
      }
    },
    orderBy: { createdAt: 'asc' }
  });

  const allUserRows = allUsers.map(user => {
    const workspaceNames = new Set();
    user.memberships.forEach(membership => {
      if (membership.company?.workspace?.name) workspaceNames.add(membership.company.workspace.name);
    });
    user.partnerAccess.forEach(access => {
      if (access.company?.workspace?.name) workspaceNames.add(access.company.workspace.name);
    });
    user.workspaceRoles.forEach(access => {
      if (access.workspace?.name) workspaceNames.add(access.workspace.name);
    });
    user.ownedWorkspaces.forEach(workspace => {
      if (workspace.name) workspaceNames.add(workspace.name);
    });

    const workspaceIds = new Set();
    user.memberships.forEach(membership => {
      if (membership.company?.workspaceId) workspaceIds.add(membership.company.workspaceId);
    });
    user.partnerAccess.forEach(access => {
      if (access.company?.workspaceId) workspaceIds.add(access.company.workspaceId);
    });
    user.workspaceRoles.forEach(access => {
      if (access.workspace?.id) workspaceIds.add(access.workspace.id);
    });
    user.ownedWorkspaces.forEach(workspace => {
      if (workspace.id) workspaceIds.add(workspace.id);
    });

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      platformRole: user.platformRole,
      telegramChatId: user.telegramChatId,
      workspaceNames: [...workspaceNames],
      inActiveWorkspace: activeWorkspaceId ? workspaceIds.has(activeWorkspaceId) : false
    };
  });

  res.render('members-holding', {
    title: 'Anggota Holding',
    workspaces,
    workspace: holdingView?.workspace || null,
    holdingMembers: holdingView?.rows || [],
    allUsers: allUserRows,
    currentUserId: userId,
    currentPlatformRole: platformRole,
    canManageHoldingMemberships: platformRole === 'owner',
    canManageTelegram: ['owner', 'partner'].includes(platformRole)
  });
});

router.post('/holding/:workspaceId/users/:userId/telegram', async (req, res) => {
  const workspaceId = req.params.workspaceId;
  const targetUserId = req.params.userId;
  const telegramChatId = String(req.body.telegramChatId || '').trim();

  try {
    if (!(await canManageHoldingWorkspace(req, workspaceId))) {
      req.flash('error', 'Kamu tidak punya akses ke holding tersebut');
      return res.redirect('/members/holding');
    }

    if (telegramChatId && !/^-?\d{5,30}$/.test(telegramChatId)) {
      req.flash('error', 'Telegram Chat ID harus berupa angka, contoh: 123456789');
      return res.redirect(`/members/holding?workspaceId=${workspaceId}`);
    }

    const target = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, name: true, platformRole: true }
    });
    if (!target) {
      req.flash('error', 'User tidak ditemukan');
      return res.redirect(`/members/holding?workspaceId=${workspaceId}`);
    }

    const targetWorkspaceIds = await getUserWorkspaceIds(target.id);
    if (!targetWorkspaceIds.includes(workspaceId)) {
      req.flash('error', `${target.name} bukan anggota holding ini`);
      return res.redirect(`/members/holding?workspaceId=${workspaceId}`);
    }

    if (req.session.user.platformRole === 'partner' && target.platformRole === 'owner') {
      req.flash('error', 'Partner tidak bisa mengubah Telegram Chat ID owner');
      return res.redirect(`/members/holding?workspaceId=${workspaceId}`);
    }

    await prisma.user.update({
      where: { id: target.id },
      data: { telegramChatId: telegramChatId || null }
    });

    req.flash(
      'success',
      telegramChatId
        ? `Telegram Chat ID ${target.name} berhasil disimpan`
        : `Telegram Chat ID ${target.name} berhasil dikosongkan`
    );
    res.redirect(`/members/holding?workspaceId=${workspaceId}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Gagal menyimpan Telegram Chat ID');
    res.redirect(`/members/holding?workspaceId=${workspaceId}`);
  }
});

router.post('/holding/:workspaceId/users/:userId/delete-account', async (req, res) => {
  const workspaceId = req.params.workspaceId;
  const targetUserId = req.params.userId;
  const currentUser = req.session.user;

  try {
    if (!(await canManageHoldingWorkspace(req, workspaceId))) {
      req.flash('error', 'Kamu tidak punya akses ke holding tersebut');
      return res.redirect('/members/holding');
    }

    if (targetUserId === currentUser.id) {
      req.flash('error', 'Tidak bisa menghapus akun sendiri');
      return res.redirect(`/members/holding?workspaceId=${workspaceId}`);
    }

    const target = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, name: true, email: true, platformRole: true }
    });
    if (!target) {
      req.flash('error', 'User tidak ditemukan');
      return res.redirect(`/members/holding?workspaceId=${workspaceId}`);
    }

    const targetWorkspaceIds = await getUserWorkspaceIds(target.id);
    if (!targetWorkspaceIds.includes(workspaceId)) {
      req.flash('error', `${target.name} bukan anggota holding ini`);
      return res.redirect(`/members/holding?workspaceId=${workspaceId}`);
    }

    if (currentUser.platformRole === 'partner' && target.platformRole !== 'user') {
      req.flash('error', 'Partner hanya bisa menghapus akun user biasa');
      return res.redirect(`/members/holding?workspaceId=${workspaceId}`);
    }

    await prisma.$transaction(async (tx) => {
      await deleteUserAccount(tx, target.id);
    });

    req.flash('success', `Akun ${target.name} (${target.email}) berhasil dihapus`);
    res.redirect(`/members/holding?workspaceId=${workspaceId}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Gagal menghapus akun user');
    res.redirect(`/members/holding?workspaceId=${workspaceId}`);
  }
});

router.post('/holding/:workspaceId/add-user', async (req, res) => {
  const workspaceId = req.params.workspaceId;
  const email = String(req.body.email || '').trim().toLowerCase();
  const selectedBrandIds = Array.isArray(req.body.brandIds)
    ? req.body.brandIds
    : req.body.brandIds ? [req.body.brandIds] : [];

  try {
    if (req.session.user.platformRole !== 'owner') {
      req.flash('error', 'Fitur ini khusus Owner');
      return res.redirect(`/members/holding?workspaceId=${workspaceId}`);
    }

    if (!email) {
      req.flash('error', 'Email user app wajib diisi');
      return res.redirect(`/members/holding?workspaceId=${workspaceId}`);
    }

    if (selectedBrandIds.length === 0) {
      req.flash('error', 'Pilih minimal satu brand');
      return res.redirect(`/members/holding?workspaceId=${workspaceId}`);
    }

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { brands: { select: { id: true, name: true } } }
    });
    if (!workspace) {
      req.flash('error', 'Workspace tidak ditemukan');
      return res.redirect('/members/holding');
    }

    const validBrandIds = new Set(workspace.brands.map(brand => brand.id));
    const brandIds = selectedBrandIds.filter(id => validBrandIds.has(id));
    if (brandIds.length === 0) {
      req.flash('error', 'Brand tujuan tidak valid');
      return res.redirect(`/members/holding?workspaceId=${workspaceId}`);
    }

    const target = await prisma.user.findUnique({ where: { email } });
    if (!target) {
      req.flash('error', 'User app dengan email tersebut belum terdaftar');
      return res.redirect(`/members/holding?workspaceId=${workspaceId}`);
    }

    const workspaceIds = await getUserWorkspaceIds(target.id);
    if (workspaceIds.some(id => id !== workspaceId)) {
      req.flash('error', `${target.name} sudah terhubung ke workspace lain`);
      return res.redirect(`/members/holding?workspaceId=${workspaceId}`);
    }

    await prisma.membership.createMany({
      data: brandIds.map(companyId => ({
        userId: target.id,
        companyId,
        role: 'member'
      })),
      skipDuplicates: true
    });

    req.flash('success', `${target.name} berhasil dimasukkan ke holding dan di-assign ke brand terpilih`);
    res.redirect(`/members/holding?workspaceId=${workspaceId}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Gagal menambahkan user ke holding');
    res.redirect(`/members/holding?workspaceId=${workspaceId}`);
  }
});

router.post('/holding/:workspaceId/users/:userId/brands', async (req, res) => {
  const workspaceId = req.params.workspaceId;
  const targetUserId = req.params.userId;
  const selectedBrandIds = Array.isArray(req.body.brandIds)
    ? req.body.brandIds
    : req.body.brandIds ? [req.body.brandIds] : [];

  try {
    if (req.session.user.platformRole !== 'owner') {
      req.flash('error', 'Fitur ini khusus Owner');
      return res.redirect(`/members/holding?workspaceId=${workspaceId}`);
    }

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { brands: { select: { id: true } } }
    });
    if (!workspace) {
      req.flash('error', 'Workspace tidak ditemukan');
      return res.redirect('/members/holding');
    }

    const target = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) {
      req.flash('error', 'User tidak ditemukan');
      return res.redirect(`/members/holding?workspaceId=${workspaceId}`);
    }

    const workspaceIds = await getUserWorkspaceIds(target.id);
    if (workspaceIds.some(id => id !== workspaceId)) {
      req.flash('error', `${target.name} sudah terhubung ke workspace lain`);
      return res.redirect(`/members/holding?workspaceId=${workspaceId}`);
    }

    const workspaceBrandIds = workspace.brands.map(brand => brand.id);
    const validBrandIds = new Set(workspaceBrandIds);
    const brandIds = selectedBrandIds.filter(id => validBrandIds.has(id));

    await prisma.$transaction(async (tx) => {
      await tx.membership.deleteMany({
        where: {
          userId: targetUserId,
          companyId: {
            in: workspaceBrandIds.filter(id => !brandIds.includes(id))
          }
        }
      });

      if (brandIds.length > 0) {
        await tx.membership.createMany({
          data: brandIds.map(companyId => ({
            userId: targetUserId,
            companyId,
            role: 'member'
          })),
          skipDuplicates: true
        });
      }
    });

    req.flash('success', `Brand untuk ${target.name} berhasil diperbarui`);
    res.redirect(`/members/holding?workspaceId=${workspaceId}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Gagal memperbarui assign brand user');
    res.redirect(`/members/holding?workspaceId=${workspaceId}`);
  }
});

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
