const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /workload - Workload balancing dashboard
router.get('/', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { platformRole } = req.session.user;

    // Get accessible brands
    let brands;
    if (platformRole === 'owner') {
      brands = await prisma.company.findMany({ orderBy: { name: 'asc' } });
    } else {
      const memberships = await prisma.membership.findMany({ where: { userId }, include: { company: true } });
      brands = memberships.map(m => m.company);
    }

    const selectedBrand = req.query.brand || (brands[0]?.id || '');
    if (!selectedBrand) {
      return res.render('workload', { title: 'Workload', brands, selectedBrand, members: [], projects: [] });
    }

    // Get all members of the brand
    const memberships = await prisma.membership.findMany({
      where: { companyId: selectedBrand },
      include: { user: { select: { id: true, name: true, email: true, avatar: true } } }
    });

    const members = [];
    const now = new Date();

    for (const membership of memberships) {
      const user = membership.user;

      const [activeTasks, overdueTasks, totalTasks, doneTasks] = await Promise.all([
        prisma.task.count({
          where: { assignees: { some: { id: user.id } }, status: { in: ['TODO', 'IN_PROGRESS'] }, project: { companyId: selectedBrand } }
        }),
        prisma.task.count({
          where: { assignees: { some: { id: user.id } }, status: { not: 'DONE' }, dueDate: { lt: now }, project: { companyId: selectedBrand } }
        }),
        prisma.task.count({
          where: { assignees: { some: { id: user.id } }, project: { companyId: selectedBrand } }
        }),
        prisma.task.count({
          where: { assignees: { some: { id: user.id } }, status: 'DONE', project: { companyId: selectedBrand } }
        })
      ]);

      const recentTasks = await prisma.task.findMany({
        where: { assignees: { some: { id: user.id } }, status: { in: ['TODO', 'IN_PROGRESS'] }, project: { companyId: selectedBrand } },
        select: { id: true, title: true, status: true, priority: true, dueDate: true, project: { select: { name: true } } },
        orderBy: { dueDate: 'asc' },
        take: 10
      });

      members.push({
        ...user,
        role: membership.role,
        activeTasks,
        overdueTasks,
        totalTasks,
        doneTasks,
        completionRate: totalTasks > 0 ? Math.round(doneTasks / totalTasks * 100) : 0,
        recentTasks,
        isOverloaded: activeTasks > 10,
        capacity: Math.max(0, 10 - activeTasks)
      });
    }

    // Sort by active tasks descending (most overloaded first)
    members.sort((a, b) => b.activeTasks - a.activeTasks);

    // Get projects for reassignment dropdown
    const projects = await prisma.project.findMany({
      where: { companyId: selectedBrand, archivedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' }
    });

    res.render('workload', {
      title: 'Workload Balancing',
      brands,
      selectedBrand,
      members,
      projects
    });
  } catch (error) {
    console.error('Workload error:', error);
    req.flash('error', 'Gagal membuka halaman workload');
    res.redirect('/');
  }
});

// GET /workload/api/:brandId - JSON API for workload data
router.get('/api/:brandId', async (req, res) => {
  try {
    const memberships = await prisma.membership.findMany({
      where: { companyId: req.params.brandId },
      include: { user: { select: { id: true, name: true } } }
    });

    const result = [];
    for (const m of memberships) {
      const activeTasks = await prisma.task.count({
        where: { assignees: { some: { id: m.user.id } }, status: { in: ['TODO', 'IN_PROGRESS'] }, project: { companyId: req.params.brandId } }
      });
      result.push({ ...m.user, activeTasks, capacity: Math.max(0, 10 - activeTasks) });
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengambil data workload' });
  }
});

module.exports = router;
