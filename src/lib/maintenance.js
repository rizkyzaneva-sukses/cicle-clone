const prisma = require('./prisma');

async function ensureBrandProfileFields(client = prisma) {
  await client.$executeRawUnsafe(`
    ALTER TABLE "Company"
    ADD COLUMN IF NOT EXISTS "description" TEXT,
    ADD COLUMN IF NOT EXISTS "avatar" TEXT
  `);
}

async function ensureProjectReportTables(client = prisma) {
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ProjectReportConfig" (
      "id" TEXT PRIMARY KEY,
      "projectId" TEXT NOT NULL UNIQUE,
      "columns" JSONB NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ProjectReportConfig_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);

  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ProjectReportEntry" (
      "id" TEXT PRIMARY KEY,
      "projectId" TEXT NOT NULL,
      "reportDate" TIMESTAMP(3) NOT NULL,
      "companyId" TEXT,
      "values" JSONB NOT NULL,
      "note" TEXT,
      "createdById" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ProjectReportEntry_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "ProjectReportEntry_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE,
      CONSTRAINT "ProjectReportEntry_createdById_fkey"
        FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
    )
  `);

  await client.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "ProjectReportEntry_projectId_reportDate_idx"
    ON "ProjectReportEntry" ("projectId", "reportDate")
  `);

  await client.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "ProjectReportEntry_companyId_idx"
    ON "ProjectReportEntry" ("companyId")
  `);
}

async function ensureProjectChatReadTable(client = prisma) {
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ProjectChatRead" (
      "id" TEXT PRIMARY KEY,
      "projectId" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ProjectChatRead_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "ProjectChatRead_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);

  await client.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "ProjectChatRead_projectId_userId_key"
    ON "ProjectChatRead" ("projectId", "userId")
  `);

  await client.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "ProjectChatRead_projectId_idx"
    ON "ProjectChatRead" ("projectId")
  `);

  await client.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "ProjectChatRead_userId_idx"
    ON "ProjectChatRead" ("userId")
  `);
}

async function ensureTaskProgressUpdateTable(client = prisma) {
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "TaskProgressUpdate" (
      "id" TEXT PRIMARY KEY,
      "content" TEXT NOT NULL,
      "status" TEXT,
      "taskId" TEXT NOT NULL,
      "authorId" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "TaskProgressUpdate_taskId_fkey"
        FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "TaskProgressUpdate_authorId_fkey"
        FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);

  await client.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "TaskProgressUpdate_taskId_createdAt_idx"
    ON "TaskProgressUpdate" ("taskId", "createdAt")
  `);

  await client.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "TaskProgressUpdate_authorId_idx"
    ON "TaskProgressUpdate" ("authorId")
  `);
}

async function ensureAnnouncementImageFields(client = prisma) {
  await client.$executeRawUnsafe(`
    ALTER TABLE "Announcement"
    ADD COLUMN IF NOT EXISTS "imageUrl" TEXT,
    ADD COLUMN IF NOT EXISTS "imageName" TEXT
  `);
}

async function ensureAnnouncementScopeFields(client = prisma) {
  await client.$executeRawUnsafe(`
    ALTER TABLE "Announcement"
    ADD COLUMN IF NOT EXISTS "scope" TEXT DEFAULT 'APP',
    ADD COLUMN IF NOT EXISTS "workspaceId" TEXT,
    ADD COLUMN IF NOT EXISTS "companyId" TEXT
  `);

  await client.$executeRawUnsafe(`
    UPDATE "Announcement"
    SET "scope" = 'APP'
    WHERE "scope" IS NULL OR TRIM("scope") = ''
  `);

  await client.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Announcement_scope_idx"
    ON "Announcement" ("scope")
  `);

  await client.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Announcement_workspaceId_idx"
    ON "Announcement" ("workspaceId")
  `);

  await client.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Announcement_companyId_idx"
    ON "Announcement" ("companyId")
  `);
}

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

async function applyAccountHotfixes(client = prisma) {
  await client.user.updateMany({
    where: { email: 'zanevadwib@gmail.com' },
    data: { telegramChatId: '8397401762' }
  });
}

// Ensure onboardingCompleted column exists + mark existing users as completed
async function ensureOnboardingField(client = prisma) {
  await client.$executeRawUnsafe(`
    ALTER TABLE "User"
    ADD COLUMN IF NOT EXISTS "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false
  `);
  // Existing users sudah lama pake app → skip onboarding
  await client.$executeRawUnsafe(`
    UPDATE "User" SET "onboardingCompleted" = true
    WHERE "onboardingCompleted" = false
    AND "createdAt" < NOW() - INTERVAL '1 day'
  `);
}

module.exports = { ensureBrandProfileFields, ensureProjectReportTables, ensureProjectChatReadTable, ensureTaskProgressUpdateTable, ensureAnnouncementImageFields, ensureAnnouncementScopeFields, cleanupOrphanRecords, ensureDefaultWorkspace, backfillProjectMembers, applyAccountHotfixes, ensureOnboardingField };
