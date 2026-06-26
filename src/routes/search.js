const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

async function getCompanyIds(user) {
  if (user.platformRole === 'owner') {
    const companies = await prisma.company.findMany({ select: { id: true } });
    return companies.map(company => company.id);
  }

  const [memberships, partnerAccess, workspaceAccess] = await Promise.all([
    prisma.membership.findMany({ where: { userId: user.id }, select: { companyId: true } }),
    prisma.partnerAccess.findMany({ where: { userId: user.id }, select: { companyId: true } }),
    prisma.workspacePartner.findMany({
      where: { userId: user.id },
      include: { workspace: { select: { brands: { select: { id: true } } } } }
    })
  ]);

  return [...new Set([
    ...memberships.map(m => m.companyId),
    ...partnerAccess.map(p => p.companyId),
    ...workspaceAccess.flatMap(access => access.workspace.brands.map(brand => brand.id))
  ])];
}

router.get('/', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const companyIds = await getCompanyIds(req.session.user);

    let projects = [];
    let tasks = [];
    let users = [];

    if (q) {
      [projects, tasks, users] = await Promise.all([
        prisma.project.findMany({
          where: {
            companyId: { in: companyIds },
            archivedAt: null,
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } }
            ]
          },
          include: { company: true },
          take: 10
        }),
        prisma.task.findMany({
          where: {
            project: { companyId: { in: companyIds }, archivedAt: null },
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } }
            ]
          },
          include: { project: { include: { company: true } }, assignee: true },
          take: 20
        }),
        prisma.user.findMany({
          where: {
            AND: [
              {
                OR: [
                  { name: { contains: q, mode: 'insensitive' } },
                  { email: { contains: q, mode: 'insensitive' } }
                ]
              },
              {
                OR: [
                  { memberships: { some: { companyId: { in: companyIds } } } },
                  { partnerAccess: { some: { companyId: { in: companyIds } } } },
                  { platformRole: 'owner' }
                ]
              }
            ]
          },
          take: 10
        })
      ]);
    }

    res.render('search', { title: 'Search', q, projects, tasks, users });
  } catch (error) {
    console.error(error);
    res.status(500).send('Gagal mencari');
  }
});

module.exports = router;
