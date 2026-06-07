const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(requireAuth);

// Create task
router.post('/create', async (req, res) => {
  try {
    const { title, description, projectId, assigneeId, dueDate, status } = req.body;

    const task = await prisma.task.create({
      data: {
        title,
        description: description || null,
        projectId,
        assigneeId: assigneeId || null,
        dueDate: dueDate ? new Date(dueDate) : null,
        status: status || 'TODO'
      },
      include: { assignee: true }
    });

    // Emit to socket if needed (handled in frontend or here)
    res.json({ success: true, task });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal membuat tugas' });
  }
});

// Update task status (for Kanban drag)
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, position } = req.body;

    const task = await prisma.task.update({
      where: { id },
      data: { 
        status,
        position: position !== undefined ? parseInt(position) : undefined 
      },
      include: { assignee: true }
    });

    res.json({ success: true, task });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal update tugas' });
  }
});

// Update task (general)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, assigneeId, dueDate } = req.body;

    const task = await prisma.task.update({
      where: { id },
      data: {
        title,
        description,
        assigneeId: assigneeId || null,
        dueDate: dueDate ? new Date(dueDate) : null
      },
      include: { assignee: true }
    });

    res.json({ success: true, task });
  } catch (error) {
    res.status(500).json({ error: 'Gagal update' });
  }
});

// Delete task
router.delete('/:id', async (req, res) => {
  try {
    await prisma.task.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Gagal hapus' });
  }
});

// Add comment to task
router.post('/:id/comments', async (req, res) => {
  try {
    const { id: taskId } = req.params;
    const { content } = req.body;
    const userId = req.session.user.id;

    const comment = await prisma.comment.create({
      data: {
        content,
        taskId,
        userId
      },
      include: { user: true }
    });

    res.json({ success: true, comment });
  } catch (error) {
    res.status(500).json({ error: 'Gagal tambah komentar' });
  }
});

module.exports = router;
