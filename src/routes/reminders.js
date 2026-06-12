const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

async function getTaskWhere(user) {
  if (user.platformRole === 'owner') {
    return { status: { not: 'DONE' }, dueDate: { not: null } };
  }

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
    ...workspaceAccess.flatMap(access => access.workspace.brands.map(brand => brand.id))
  ];

  if (managedCompanyIds.length > 0) {
    return {
      status: { not: 'DONE' },
      dueDate: { not: null },
      project: { companyId: { in: [...new Set(managedCompanyIds)] } }
    };
  }

  return {
    status: { not: 'DONE' },
    dueDate: { not: null },
    assigneeId: user.id
  };
}

router.get('/', async (req, res) => {
  try {
    const where = await getTaskWhere(req.session.user);
    const tasks = await prisma.task.findMany({
      where,
      include: { project: { include: { company: true } }, assignee: true },
      orderBy: { dueDate: 'asc' },
      take: 100
    });

    res.render('reminders', { title: 'Reminder', tasks, now: new Date() });
  } catch (error) {
    console.error(error);
    res.status(500).send('Gagal membuka reminder');
  }
});

router.post('/scan', async (req, res) => {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(23, 59, 59, 999);

    const tasks = await prisma.task.findMany({
      where: {
        status: { not: 'DONE' },
        dueDate: { lte: tomorrow },
        assigneeId: { not: null }
      },
      include: { assignee: true }
    });

    let created = 0;
    for (const task of tasks) {
      const link = `/tasks/${task.id}`;
      const isOverdue = task.dueDate < new Date();
      const content = isOverdue
        ? `Task "${task.title}" sudah lewat deadline`
        : `Task "${task.title}" mendekati deadline`;

      const existing = await prisma.notification.findFirst({
        where: {
          userId: task.assigneeId,
          link,
          content,
          isRead: false
        }
      });

      if (!existing) {
        await prisma.notification.create({
          data: { userId: task.assigneeId, content, link }
        });
        created++;
      }
    }

    req.flash('success', `${created} reminder baru dibuat`);
    res.redirect('/reminders');
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal membuat reminder');
    res.redirect('/reminders');
  }
});

module.exports = router;
