const prisma = require('./prisma');

// All users who manage a given brand: platform owners + admins of that brand + partners with access.
async function getCompanyManagerIds(companyId) {
  const [owners, admins, partnerAccess, company] = await Promise.all([
    prisma.user.findMany({ where: { platformRole: 'owner' }, select: { id: true } }),
    prisma.membership.findMany({ where: { companyId, role: 'admin' }, select: { userId: true } }),
    prisma.partnerAccess.findMany({ where: { companyId }, select: { userId: true } }),
    prisma.company.findUnique({ where: { id: companyId }, select: { workspaceId: true } })
  ]);

  const ids = new Set([
    ...owners.map(u => u.id),
    ...admins.map(m => m.userId),
    ...partnerAccess.map(p => p.userId)
  ]);

  if (company?.workspaceId) {
    const workspacePartners = await prisma.workspacePartner.findMany({
      where: { workspaceId: company.workspaceId },
      select: { userId: true }
    });
    workspacePartners.forEach(wp => ids.add(wp.userId));
  }

  return [...ids];
}

// Everyone who manages any brand on the platform (used for platform-wide broadcasts/reports).
async function getAllManagerIds() {
  const [owners, admins, partners] = await Promise.all([
    prisma.user.findMany({ where: { platformRole: 'owner' }, select: { id: true } }),
    prisma.membership.findMany({ where: { role: 'admin' }, select: { userId: true } }),
    prisma.user.findMany({ where: { platformRole: 'partner' }, select: { id: true } })
  ]);
  return [...new Set([...owners.map(u => u.id), ...admins.map(m => m.userId), ...partners.map(u => u.id)])];
}

module.exports = { getCompanyManagerIds, getAllManagerIds };
