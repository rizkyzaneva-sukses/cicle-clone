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

    // Get today's focus sessions
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

    // Weekly stats
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());

    const weekSessions = await prisma.activityLog.findMany({
      where: {
        userId,
        action: 'focus_session',
        createdAt: { gte: weekStart }
      }
    });

    const weeklyStats = {
      totalSessions: weekSessions.length,
      totalMinutes: weekSessions.reduce((acc, log) => acc + (log.metadata?.minutes || 0), 0),
      byDay: {}
    };

    // Group by day for weekly chart
    for (let i = 0; i < 7; i++) {
      const day = new Date(weekStart);
      day.setDate(day.getDate() + i);
      const dayKey = day.toISOString().split('T')[0];
      const dayLabel = day.toLocaleDateString('id-ID', { weekday: 'short' });
      const daySessions = weekSessions.filter(s => {
        const sDate = new Date(s.createdAt);
        return sDate.toISOString().split('T')[0] === dayKey;
      });
      weeklyStats.byDay[dayLabel] = {
        sessions: daySessions.length,
        minutes: daySessions.reduce((acc, log) => acc + (log.metadata?.minutes || 0), 0)
      };
    }

    res.render('focus', {
      title: 'Focus Timer',
      tasks,
      todaySessions: todaySessions.length,
      totalFocusMinutes,
      weeklyStats
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

// Get focus stats API
router.get('/stats', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());

    const [todaySessions, weekSessions] = await Promise.all([
      prisma.activityLog.findMany({
        where: { userId, action: 'focus_session', createdAt: { gte: todayStart } }
      }),
      prisma.activityLog.findMany({
        where: { userId, action: 'focus_session', createdAt: { gte: weekStart } }
      })
    ]);

    res.json({
      today: {
        sessions: todaySessions.length,
        minutes: todaySessions.reduce((acc, log) => acc + (log.metadata?.minutes || 0), 0)
      },
      week: {
        sessions: weekSessions.length,
        minutes: weekSessions.reduce((acc, log) => acc + (log.metadata?.minutes || 0), 0)
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil statistik' });
  }
});

module.exports = router;
