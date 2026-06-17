const prisma = require('./prisma');

async function cleanupOrphanRecords(client = prisma) {
  await client.$executeRaw`
    DELETE FROM "PartnerAccess" pa
    WHERE NOT EXISTS (
      SELECT 1 FROM "User" u WHERE u.id = pa."userId"
    )
    OR NOT EXISTS (
      SELECT 1 FROM "Company" c WHERE c.id = pa."companyId"
    )
  `;

  await client.$executeRaw`
    UPDATE "Task" t
    SET "assigneeId" = NULL
    WHERE t."assigneeId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "User" u WHERE u.id = t."assigneeId"
    )
  `;
}

async function ensureDefaultWorkspace(client = prisma, ownerUser = null) {
  const workspaceCount = await client.workspace.count();
  if (workspaceCount > 0) {
    const fallbackWorkspace = await client.workspace.findFirst({ orderBy: { createdAt: 'asc' } });
    await client.company.updateMany({
      where: { workspaceId: null },
      data: { workspaceId: fallbackWorkspace.id }
    });
    return fallbackWorkspace;
  }

  const owner = ownerUser || await client.user.findFirst({
    where: { platformRole: 'owner' },
    orderBy: { createdAt: 'asc' }
  });

  const workspace = await client.workspace.create({
    data: {
      name: 'Maulana Corp',
      slug: 'maulana-corp',
      ownerId: owner?.id || null
    }
  });

  await client.company.updateMany({
    where: { workspaceId: null },
    data: { workspaceId: workspace.id }
  });

  return workspace;
}

// One-time backfill: when per-project access was introduced, every existing brand
// member already had visibility into all of that brand's projects. Grandfather that in
// so nobody loses access to a project they could already see; only NEW projects/members
// require explicit assignment going forward.
async function backfillProjectMembers(client = prisma) {
  const existingCount = await client.projectMember.count();
  if (existingCount > 0) return;

  const memberships = await client.membership.findMany({
    include: { company: { include: { projects: { select: { id: true } } } } }
  });

  const rows = [];
  for (const membership of memberships) {
    for (const project of membership.company.projects) {
      rows.push({ userId: membership.userId, projectId: project.id });
    }
  }

  if (rows.length > 0) {
    await client.projectMember.createMany({ data: rows, skipDuplicates: true });
  }
}

module.exports = { cleanupOrphanRecords, ensureDefaultWorkspace, backfillProjectMembers };
