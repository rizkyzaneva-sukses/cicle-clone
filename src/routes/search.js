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

  const [memberships, partnerAccess] = await Promise.all([
    prisma.membership.findMany({ where: { userId: user.id }, select: { companyId: true } }),
    prisma.partnerAccess.findMany({ where: { userId: user.id }, select: { companyId: true } })
  ]);

  return [...new Set([
    ...memberships.map(m => m.companyId),
    ...partnerAccess.map(p => p.companyId)
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
            project: { companyId: { in: companyIds } },
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
