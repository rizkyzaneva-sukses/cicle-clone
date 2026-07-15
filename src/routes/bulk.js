const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { hasProjectAccess } = require('../lib/access');
const { logActivity } = require('../lib/activity');
const { notifyUser } = require('../lib/notify');

router.use(requireAuth);

// POST /bulk/status — bulk status change
router.post('/status', async (req, res) => {
  try {
    const { taskIds, status } = req.body;
    const allowedStatuses = ['TODO', 'IN_PROGRESS', 'DONE'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: 'Status tidak valid' });
    }
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ error: 'Pilih minimal 1 task' });
    }
    if (taskIds.length > 100) {
      return res.status(400).json({ error: 'Maksimal 100 task sekaligus' });
    }

    // Verify access for all tasks
    const tasks = await prisma.task.findMany({
      where: { id: { in: taskIds } },
      include: { project: { select: { id: true, companyId: true } } }
    });

    for (const task of tasks) {
      if (!await hasProjectAccess(req.session.user, task.project)) {
        return res.status(403).json({ error: `Akses ditolak untuk task "${task.title}"` });
      }
    }

    const result = await prisma.task.updateMany({
      where: { id: { in: taskIds } },
      data: { status }
    });

    // Log activity for each
    for (const task of tasks) {
      await logActivity(prisma, req, {
        action: 'bulk_status_changed',
        entityType: 'task',
        entityId: task.id,
        projectId: task.projectId,
        taskId: task.id,
        metadata: { status, bulk: true }
      });
    }

    res.json({ success: true, updated: result.count });
  } catch (error) {
    console.error('Bulk status error:', error);
    res.status(500).json({ error: 'Gagal update status' });
  }
});

// POST /bulk/assign — bulk assign
router.post('/assign', async (req, res) => {
  try {
    const { taskIds, assigneeIds } = req.body;
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ error: 'Pilih minimal 1 task' });
    }
    if (taskIds.length > 100) {
      return res.status(400).json({ error: 'Maksimal 100 task sekaligus' });
    }

    const tasks = await prisma.task.findMany({
      where: { id: { in: taskIds } },
      include: { project: { select: { id: true, companyId: true } } }
    });

    for (const task of tasks) {
      if (!await hasProjectAccess(req.session.user, task.project)) {
        return res.status(403).json({ error: `Akses ditolak untuk task "${task.title}"` });
      }
    }

    let primaryAssigneeId = null;
    let assigneesConnect = [];
    if (Array.isArray(assigneeIds) && assigneeIds.length > 0) {
      primaryAssigneeId = assigneeIds[0];
      assigneesConnect = assigneeIds.map(id => ({ id }));
    }

    await prisma.$transaction(taskIds.map(id => prisma.task.update({
      where: { id },
      data: {
        assigneeId: primaryAssigneeId,
        assignees: { set: assigneesConnect }
      }
    })));

    // Notify new assignees
    if (assigneesConnect.length > 0) {
      for (const task of tasks) {
        for (const a of assigneesConnect) {
          if (a.id !== req.session.user.id) {
            try {
              await notifyUser(req.app.get('io'), a.id,
                `Kamu ditugaskan ke task "${task.title}" (bulk assign)`,
                `/tasks/${task.id}`
              );
            } catch (_) {}
          }
        }
      }
    }

    res.json({ success: true, updated: taskIds.length });
  } catch (error) {
    console.error('Bulk assign error:', error);
    res.status(500).json({ error: 'Gagal assign task' });
  }
});

// POST /bulk/delete — bulk delete
router.post('/delete', async (req, res) => {
  try {
    const { taskIds } = req.body;
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ error: 'Pilih minimal 1 task' });
    }
    if (taskIds.length > 100) {
      return res.status(400).json({ error: 'Maksimal 100 task sekaligus' });
    }

    const tasks = await prisma.task.findMany({
      where: { id: { in: taskIds } },
      include: { project: { select: { id: true, companyId: true } } }
    });

    for (const task of tasks) {
      if (!await hasProjectAccess(req.session.user, task.project)) {
        return res.status(403).json({ error: `Akses ditolak untuk task "${task.title}"` });
      }
    }

    const result = await prisma.task.deleteMany({
      where: { id: { in: taskIds } }
    });

    res.json({ success: true, deleted: result.count });
  } catch (error) {
    console.error('Bulk delete error:', error);
    res.status(500).json({ error: 'Gagal hapus task' });
  }
});

// POST /bulk/priority — bulk priority change
router.post('/priority', async (req, res) => {
  try {
    const { taskIds, priority } = req.body;
    const allowed = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT'];
    if (!allowed.includes(priority)) {
      return res.status(400).json({ error: 'Priority tidak valid' });
    }
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ error: 'Pilih minimal 1 task' });
    }

    const tasks = await prisma.task.findMany({
      where: { id: { in: taskIds } },
      include: { project: { select: { id: true, companyId: true } } }
    });

    for (const task of tasks) {
      if (!await hasProjectAccess(req.session.user, task.project)) {
        return res.status(403).json({ error: `Akses ditolak` });
      }
    }

    const result = await prisma.task.updateMany({
      where: { id: { in: taskIds } },
      data: { priority }
    });

    res.json({ success: true, updated: result.count });
  } catch (error) {
    console.error('Bulk priority error:', error);
    res.status(500).json({ error: 'Gagal update priority' });
  }
});

module.exports = router;
