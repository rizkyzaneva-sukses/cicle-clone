const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');

router.use(requireAuth);

// Focus Timer page
router.get('/', async (req, res) => {
  try {
    const userId = req.session.user.id;

    // Get user's active tasks (not DONE) from projects they have access to
    const memberships = await prisma.membership.findMany({
      where: { userId },
      select: { companyId: true }
    });

    const companyIds = memberships.map(m => m.companyId);

    const tasks = await prisma.task.findMany({
      where: {
        assigneeId: userId,
        status: { not: 'DONE' },
        project: { companyId: { in: companyIds } }
      },
      include: { project: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }
    });

    // Get today's focus sessions count and total time
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todaySessions = await prisma.activityLog.findMany({
      where: {
        userId,
        action: 'focus_session',
        createdAt: { gte: todayStart }
      }
    });

    const totalFocusMinutes = todaySessions.reduce((acc, log) => {
      return acc + (log.metadata?.minutes || 0);
    }, 0);

    res.render('focus', {
      title: 'Focus Timer',
      tasks,
      todaySessions: todaySessions.length,
      totalFocusMinutes
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Terjadi kesalahan');
  }
});

// Log a focus session
router.post('/log', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { taskId, minutes, type } = req.body;
    const parsedMinutes = parseInt(minutes, 10);

    await logActivity(prisma, req, {
      action: 'focus_session',
      entityType: 'task',
      entityId: taskId || '',
      taskId: taskId || null,
      metadata: { minutes: Number.isFinite(parsedMinutes) && parsedMinutes > 0 ? parsedMinutes : 30, type: type || 'work' }
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal log sesi' });
  }
});

module.exports = router;
