const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// Dashboard Kinerja
router.get('/', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { platformRole } = req.session.user;

    // Get accessible brands
    let brands;
    if (platformRole === 'owner') {
      brands = await prisma.company.findMany({ orderBy: { name: 'asc' } });
    } else if (platformRole === 'partner') {
      const access = await prisma.partnerAccess.findMany({
        where: { userId },
        include: { company: true }
      });
      brands = access.map(a => a.company);
    } else {
      const memberships = await prisma.membership.findMany({
        where: { userId },
        include: { company: true }
      });
      brands = memberships.map(m => m.company);
    }

    const brandIds = brands.map(b => b.id);

    // Overall stats
    const [total, done, active, overdue] = await Promise.all([
      prisma.task.count({ where: { project: { companyId: { in: brandIds } } } }),
      prisma.task.count({ where: { project: { companyId: { in: brandIds } }, status: 'DONE' } }),
      prisma.task.count({ where: { project: { companyId: { in: brandIds } }, status: { in: ['TODO', 'IN_PROGRESS'] } } }),
      prisma.task.count({ where: { project: { companyId: { in: brandIds } }, status: { in: ['TODO', 'IN_PROGRESS'] }, dueDate: { lt: new Date() } } })
    ]);

    // Per member stats
    const members = await prisma.membership.findMany({
      where: { companyId: { in: brandIds } },
      include: { user: true, company: true }
    });

    const memberStats = [];
    for (const membership of members) {
      const userTasks = await prisma.task.findMany({
        where: {
          assigneeId: membership.userId,
          project: { companyId: membership.companyId }
        },
        select: { id: true, status: true, dueDate: true }
      });

      const totalTasks = userTasks.length;
      const doneTasks = userTasks.filter(t => t.status === 'DONE').length;
      const activeTasks = userTasks.filter(t => t.status !== 'DONE').length;
      const overdueTasks = userTasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date() && t.status !== 'DONE').length;
      const completionRate = totalTasks > 0 ? Math.round(doneTasks / totalTasks * 100) : 0;

      memberStats.push({
        id: membership.user.id,
        name: membership.user.name,
        email: membership.user.email,
        brandId: membership.companyId,
        brandName: membership.company.name,
        totalTasks,
        doneTasks,
        activeTasks,
        overdueTasks,
        completionRate
      });
    }

    // Sort by completion rate desc
    memberStats.sort((a, b) => b.completionRate - a.completionRate);

    res.render('performance', {
      title: 'Dashboard Kinerja',
      brands,
      stats: { total, done, active, overdue },
      members: memberStats
    });
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal membuka dashboard kinerja');
    res.redirect('/');
  }
});

module.exports = router;
