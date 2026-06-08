const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');

router.use(requireAuth);

// Get all checklists for a task
router.get('/task/:taskId', async (req, res) => {
  try {
    const checklists = await prisma.checklistItem.findMany({
      where: { taskId: req.params.taskId },
      orderBy: { position: 'asc' }
    });
    res.json(checklists);
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengambil checklist' });
  }
});

// Add new checklist item
router.post('/task/:taskId', async (req, res) => {
  try {
    const { content } = req.body;
    const taskId = req.params.taskId;

    // Get max position
    const maxPos = await prisma.checklistItem.aggregate({
      where: { taskId },
      _max: { position: true }
    });

    const newItem = await prisma.checklistItem.create({
      data: {
        content,
        taskId,
        position: (maxPos._max.position || 0) + 1
      }
    });

    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
    await logActivity(prisma, req, {
      action: 'added_checklist',
      entityType: 'task',
      entityId: taskId,
      projectId: task?.projectId,
      taskId,
      metadata: { content }
    });

    res.json({ success: true, item: newItem });
  } catch (error) {
    res.status(500).json({ error: 'Gagal menambah checklist' });
  }
});

// Toggle checklist done
router.patch('/:id/toggle', async (req, res) => {
  try {
    const item = await prisma.checklistItem.findUnique({
      where: { id: req.params.id }
    });

    if (!item) return res.status(404).json({ error: 'Item tidak ditemukan' });

    const updated = await prisma.checklistItem.update({
      where: { id: req.params.id },
      data: { isDone: !item.isDone }
    });

    const task = await prisma.task.findUnique({ where: { id: item.taskId }, select: { projectId: true } });
    await logActivity(prisma, req, {
      action: updated.isDone ? 'completed_checklist' : 'reopened_checklist',
      entityType: 'task',
      entityId: item.taskId,
      projectId: task?.projectId,
      taskId: item.taskId,
      metadata: { content: item.content }
    });

    res.json({ success: true, item: updated });
  } catch (error) {
    res.status(500).json({ error: 'Gagal update checklist' });
  }
});

// Delete checklist item
router.delete('/:id', async (req, res) => {
  try {
    const item = await prisma.checklistItem.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Item tidak ditemukan' });
    await prisma.checklistItem.delete({
      where: { id: req.params.id }
    });
    const task = await prisma.task.findUnique({ where: { id: item.taskId }, select: { projectId: true } });
    await logActivity(prisma, req, {
      action: 'deleted_checklist',
      entityType: 'task',
      entityId: item.taskId,
      projectId: task?.projectId,
      taskId: item.taskId,
      metadata: { content: item.content }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Gagal hapus checklist' });
  }
});

module.exports = router;
