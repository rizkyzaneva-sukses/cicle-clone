const prisma = require('./prisma');

// Brand-wide access: true for owner, partner with access, or any membership (admin/member)
async function hasCompanyAccess(user, companyId) {
  if (user.platformRole === 'owner') return true;

  if (user.platformRole === 'partner') {
    const access = await prisma.partnerAccess.findUnique({
      where: { userId_companyId: { userId: user.id, companyId } }
    });
    if (access) return true;

    const brand = await prisma.company.findUnique({
      where: { id: companyId },
      select: { workspaceId: true }
    });
    if (brand?.workspaceId) {
      const workspaceAccess = await prisma.workspacePartner.findUnique({
        where: { userId_workspaceId: { userId: user.id, workspaceId: brand.workspaceId } }
      });
      if (workspaceAccess) return true;
    }
  }

  const membership = await prisma.membership.findUnique({
    where: { userId_companyId: { userId: user.id, companyId } }
  });
  return Boolean(membership);
}

// True only for people who manage the whole brand (owner, partner with access, brand admin)
// Managers bypass per-project assignment and can see/manage every project in the brand.
async function isCompanyManager(user, companyId) {
  if (user.platformRole === 'owner') return true;

  if (user.platformRole === 'partner') {
    const access = await prisma.partnerAccess.findUnique({
      where: { userId_companyId: { userId: user.id, companyId } }
    });
    if (access) return true;

    const brand = await prisma.company.findUnique({
      where: { id: companyId },
      select: { workspaceId: true }
    });
    if (brand?.workspaceId) {
      const workspaceAccess = await prisma.workspacePartner.findUnique({
        where: { userId_workspaceId: { userId: user.id, workspaceId: brand.workspaceId } }
      });
      if (workspaceAccess) return true;
    }
  }

  const membership = await prisma.membership.findUnique({
    where: { userId_companyId: { userId: user.id, companyId } }
  });
  return membership?.role === 'admin';
}

// Project-level access: brand managers always have access; regular members need an explicit ProjectMember row.
async function hasProjectAccess(user, project) {
  if (await isCompanyManager(user, project.companyId)) return true;

  const member = await prisma.projectMember.findUnique({
    where: { userId_projectId: { userId: user.id, projectId: project.id } }
  });
  return Boolean(member);
}

// Grants project access to a user (idempotent). Used when someone is assigned a task or @mentioned.
async function ensureProjectMember(userId, projectId) {
  if (!userId) return;
  await prisma.projectMember.upsert({
    where: { userId_projectId: { userId, projectId } },
    update: {},
    create: { userId, projectId }
  });
}

module.exports = { hasCompanyAccess, isCompanyManager, hasProjectAccess, ensureProjectMember };
