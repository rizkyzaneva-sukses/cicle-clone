const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');
const { hasProjectAccess } = require('../lib/access');

router.use(requireAuth);

// Helper: pastikan user punya akses ke task pemilik checklist item
async function canAccessChecklistItem(user, checklistId) {
  const item = await prisma.checklistItem.findUnique({
    where: { id: checklistId },
    include: { task: { include: { project: true } } }
  });
  if (!item) return null;
  const allowed = await hasProjectAccess(user, item.task.project);
  return allowed ? item : null;
}

// Get all checklists for a task
router.get('/task/:taskId', async (req, res) => {
  try {
    const checklists = await prisma.checklistItem.findMany({
      where: { taskId: req.params.taskId, parentId: null },
      orderBy: { position: 'asc' },
      include: { children: { orderBy: { position: 'asc' } } }
    });
    res.json(checklists);
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengambil checklist' });
  }
});

// Add new checklist item
router.post('/task/:taskId', async (req, res) => {
  try {
    const { content, parentId } = req.body;
    const taskId = req.params.taskId;

    // Get max position (dalam parent yang sama)
    const maxPos = await prisma.checklistItem.aggregate({
      where: { taskId, parentId: parentId || null },
      _max: { position: true }
    });

    const newItem = await prisma.checklistItem.create({
      data: {
        content,
        taskId,
        parentId: parentId || null,
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

// Edit checklist item content
router.patch('/:id/content', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Content required' });
    const updated = await prisma.checklistItem.update({
      where: { id: req.params.id },
      data: { content: content.trim() }
    });
    const task = await prisma.task.findUnique({ where: { id: updated.taskId }, select: { projectId: true } });
    await logActivity(prisma, req, {
      action: 'updated_checklist',
      entityType: 'task',
      entityId: updated.taskId,
      projectId: task?.projectId,
      taskId: updated.taskId,
      metadata: { content: updated.content }
    });
    res.json({ success: true, item: updated });
  } catch (error) {
    res.status(500).json({ error: 'Gagal update konten checklist' });
  }
});

// Update checklist item fields: assignee / priority / dueDate
router.patch('/:id/fields', async (req, res) => {
  try {
    const item = await canAccessChecklistItem(req.session.user, req.params.id);
    if (!item) return res.status(403).json({ error: 'Akses ditolak' });

    const data = {};

    if (Object.prototype.hasOwnProperty.call(req.body, 'priority')) {
      const validPriorities = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT'];
      data.priority = validPriorities.includes(req.body.priority) ? req.body.priority : 'NONE';
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'dueDate')) {
      let normalized = null;
      if (req.body.dueDate) {
        const d = new Date(req.body.dueDate);
        if (!isNaN(d.getTime())) normalized = d;
      }
      data.dueDate = normalized;
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'assigneeId')) {
      const assigneeId = req.body.assigneeId || null;
      if (assigneeId) {
        // assignee harus anggota proyek atau minimal anggota brand
        const isProjectMember = await prisma.projectMember.findUnique({
          where: { userId_projectId: { userId: assigneeId, projectId: item.task.projectId } }
        });
        if (!isProjectMember) {
          const membership = await prisma.membership.findUnique({
            where: { userId_companyId: { userId: assigneeId, companyId: item.task.project.companyId } }
          });
          if (!membership) return res.status(400).json({ error: 'Assignee bukan anggota proyek/brand' });
        }
      }
      data.assigneeId = assigneeId;
    }

    const updated = await prisma.checklistItem.update({
      where: { id: req.params.id },
      data,
      include: { assignee: { select: { id: true, name: true } } }
    });

    await logActivity(prisma, req, {
      action: 'updated_checklist_fields',
      entityType: 'task',
      entityId: item.taskId,
      projectId: item.task.projectId,
      taskId: item.taskId,
      metadata: {
        content: item.content,
        assigneeId: updated.assigneeId,
        priority: updated.priority,
        dueDate: updated.dueDate ? updated.dueDate.toISOString() : null
      }
    });

    res.json({ success: true, item: updated });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal update checklist' });
  }
});

// Reorder checklist items
router.patch('/task/:taskId/reorder', async (req, res) => {
  try {
    const { items } = req.body; // expects [{ id: '...', position: Int }]
    if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'Invalid data' });
    
    await prisma.$transaction(
      items.map(item => 
        prisma.checklistItem.update({
          where: { id: item.id },
          data: { position: item.position }
        })
      )
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Gagal reorder checklist' });
  }
});

module.exports = router;
