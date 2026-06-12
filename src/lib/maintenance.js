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

module.exports = { cleanupOrphanRecords };
