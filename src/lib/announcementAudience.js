const prisma = require('./prisma');

const AnnouncementScope = Object.freeze({
  APP: 'APP',
  HOLDING: 'HOLDING',
  BRAND: 'BRAND'
});

async function getAccessibleAnnouncementTargets(user) {
  if (!user?.id) return { workspaceIds: [], companyIds: [] };

  if (user.platformRole === 'owner') {
    const [workspaces, companies] = await Promise.all([
      prisma.workspace.findMany({ select: { id: true } }),
      prisma.company.findMany({ select: { id: true } })
    ]);

    return {
      workspaceIds: workspaces.map((workspace) => workspace.id),
      companyIds: companies.map((company) => company.id)
    };
  }

  const [memberships, partnerAccess, workspaceRoles] = await Promise.all([
    prisma.membership.findMany({
      where: { userId: user.id },
      select: {
        companyId: true,
        company: { select: { workspaceId: true } }
      }
    }),
    prisma.partnerAccess.findMany({
      where: { userId: user.id },
      select: {
        companyId: true,
        company: { select: { workspaceId: true } }
      }
    }),
    prisma.workspacePartner.findMany({
      where: { userId: user.id },
      select: { workspaceId: true }
    })
  ]);

  const workspaceIds = new Set();
  const companyIds = new Set();

  memberships.forEach((membership) => {
    companyIds.add(membership.companyId);
    if (membership.company?.workspaceId) workspaceIds.add(membership.company.workspaceId);
  });

  partnerAccess.forEach((access) => {
    companyIds.add(access.companyId);
    if (access.company?.workspaceId) workspaceIds.add(access.company.workspaceId);
  });

  workspaceRoles.forEach((role) => {
    workspaceIds.add(role.workspaceId);
  });

  if (workspaceIds.size > 0) {
    const workspaceBrands = await prisma.company.findMany({
      where: { workspaceId: { in: [...workspaceIds] } },
      select: { id: true }
    });
    workspaceBrands.forEach((brand) => companyIds.add(brand.id));
  }

  return {
    workspaceIds: [...workspaceIds],
    companyIds: [...companyIds]
  };
}

async function buildAnnouncementVisibilityWhere(user) {
  if (!user) return { scope: AnnouncementScope.APP };
  if (user.platformRole === 'owner') return {};

  const { workspaceIds, companyIds } = await getAccessibleAnnouncementTargets(user);
  const or = [{ scope: AnnouncementScope.APP }];

  if (workspaceIds.length > 0) {
    or.push({ scope: AnnouncementScope.HOLDING, workspaceId: { in: workspaceIds } });
  }

  if (companyIds.length > 0) {
    or.push({ scope: AnnouncementScope.BRAND, companyId: { in: companyIds } });
  }

  return { OR: or };
}

async function getLatestAnnouncementForUser(user) {
  const where = await buildAnnouncementVisibilityWhere(user);
  return prisma.announcement.findFirst({
    where,
    orderBy: { createdAt: 'desc' }
  });
}

function getAnnouncementScopeLabel(scope) {
  if (scope === AnnouncementScope.HOLDING) return 'Pengumuman Holding';
  if (scope === AnnouncementScope.BRAND) return 'Pengumuman Brand';
  return 'Pengumuman User Apps';
}

module.exports = {
  AnnouncementScope,
  getAccessibleAnnouncementTargets,
  buildAnnouncementVisibilityWhere,
  getLatestAnnouncementForUser,
  getAnnouncementScopeLabel
};
