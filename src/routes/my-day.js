const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /my-day - My Day view
router.get('/', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);

    const [dueToday, inProgress, myDayTasks, suggestedTasks] = await Promise.all([
      // Tasks due today
      prisma.task.findMany({
        where: {
          assignees: { some: { id: userId } },
          dueDate: { gte: startOfDay, lt: endOfDay },
          status: { not: 'DONE' }
        },
        include: { project: { select: { name: true, id: true } }, labels: { include: { label: true } } },
        orderBy: { priority: 'asc' }
      }),
      // In progress tasks
      prisma.task.findMany({
        where: { assignees: { some: { id: userId } }, status: 'IN_PROGRESS' },
        include: { project: { select: { name: true, id: true } }, labels: { include: { label: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 10
      }),
      // Tasks marked for My Day
      prisma.task.findMany({
        where: { assignees: { some: { id: userId } }, myDay: true, status: { not: 'DONE' } },
        include: { project: { select: { name: true, id: true } }, labels: { include: { label: true } } },
        orderBy: { updatedAt: 'desc' }
      }),
      // Suggested: overdue or high priority not done
      prisma.task.findMany({
        where: {
          assignees: { some: { id: userId } },
          status: { not: 'DONE' },
          myDay: false,
          OR: [
            { dueDate: { lt: now } },
            { priority: { in: ['URGENT', 'HIGH'] } }
          ]
        },
        include: { project: { select: { name: true, id: true } }, labels: { include: { label: true } } },
        orderBy: [
          { priority: 'asc' },
          { dueDate: 'asc' }
        ],
        take: 10
      })
    ]);

    res.render('my-day', {
      title: 'My Day',
      dueToday,
      inProgress,
      myDayTasks,
      suggestedTasks
    });
  } catch (error) {
    console.error('My Day error:', error);
    req.flash('error', 'Gagal membuka My Day');
    res.redirect('/');
  }
});

// POST /my-day/toggle/:taskId - Toggle task in My Day
router.post('/toggle/:taskId', async (req, res) => {
  try {
    const task = await prisma.task.findUnique({
      where: { id: req.params.taskId },
      select: { id: true, assignees: { select: { id: true } }, myDay: true }
    });

    if (!task) return res.status(404).json({ error: 'Task tidak ditemukan' });
    if (!task.assignees.some(a => a.id === req.session.user.id)) return res.status(403).json({ error: 'Bukan task kamu' });

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: { myDay: !task.myDay }
    });

    res.json({ success: true, myDay: updated.myDay });
  } catch (error) {
    console.error('Toggle my day error:', error);
    res.status(500).json({ error: 'Gagal update' });
  }
});

module.exports = router;
