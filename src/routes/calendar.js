const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

async function getCalendarTaskWhere(user) {
  if (user.platformRole === 'owner') return { dueDate: { not: null } };

  const [memberships, partnerAccess, workspaceAccess] = await Promise.all([
    prisma.membership.findMany({ where: { userId: user.id }, select: { companyId: true, role: true } }),
    prisma.partnerAccess.findMany({ where: { userId: user.id }, select: { companyId: true } }),
    prisma.workspacePartner.findMany({
      where: { userId: user.id },
      include: { workspace: { select: { brands: { select: { id: true } } } } }
    })
  ]);

  const managedCompanyIds = [
    ...memberships.filter(m => m.role === 'admin').map(m => m.companyId),
    ...partnerAccess.map(p => p.companyId),
    ...workspaceAccess.flatMap(a => a.workspace.brands.map(b => b.id))
  ];

  if (managedCompanyIds.length > 0) {
    return { dueDate: { not: null }, project: { companyId: { in: [...new Set(managedCompanyIds)] } } };
  }

  const projectMemberships = await prisma.projectMember.findMany({ where: { userId: user.id }, select: { projectId: true } });
  const projectIds = projectMemberships.map(pm => pm.projectId);

  return {
    dueDate: { not: null },
    OR: [{ assignees: { some: { id: user.id } } }, { projectId: { in: projectIds } }]
  };
}

router.get('/', async (req, res) => {
  try {
    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth(); // 0-indexed

    if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
      const [y, m] = req.query.month.split('-').map(Number);
      year = y;
      month = m - 1;
    }

    const rangeStart = new Date(year, month, 1);
    const rangeEnd = new Date(year, month + 1, 1);

    const where = await getCalendarTaskWhere(req.session.user);
    const tasks = await prisma.task.findMany({
      where: { ...where, dueDate: { gte: rangeStart, lt: rangeEnd } },
      include: { project: { select: { name: true } }, assignees: { select: { name: true } } },
      orderBy: { dueDate: 'asc' }
    });

    const tasksByDay = {};
    tasks.forEach(t => {
      const day = new Date(t.dueDate).getDate();
      (tasksByDay[day] ||= []).push(t);
    });

    const firstDayOfWeek = rangeStart.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonth = new Date(year, month - 1, 1);
    const nextMonth = new Date(year, month + 1, 1);

    res.render('calendar', {
      title: 'Kalender',
      year,
      month,
      daysInMonth,
      firstDayOfWeek,
      tasksByDay,
      monthLabel: rangeStart.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }),
      prevMonthKey: `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`,
      nextMonthKey: `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`,
      todayDate: (now.getFullYear() === year && now.getMonth() === month) ? now.getDate() : null
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Gagal membuka kalender');
  }
});

module.exports = router;
