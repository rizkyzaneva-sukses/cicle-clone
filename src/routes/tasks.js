const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// Task detail page
router.get('/:id', async (req, res) => {
  try {
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: {
        project: { include: { company: true } },
        assignee: true,
        checklists: { orderBy: { position: 'asc' } },
        comments: { include: { user: true }, orderBy: { createdAt: 'asc' } }
      }
    });

    if (!task) return res.status(404).send('Task tidak ditemukan');

    const members = await prisma.membership.findMany({
      where: { companyId: task.project.companyId },
      include: { user: true }
    });

    res.render('tasks/detail', {
      title: task.title,
      task,
      members: members.map(m => m.user),
      currentUserId: req.session.user.id
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Terjadi kesalahan');
  }
});

// Create task
router.post('/create', async (req, res) => {
  try {
    const { title, description, projectId, assigneeId, dueDate, status, priority } = req.body;

    const task = await prisma.task.create({
      data: {
        title,
        description: description || null,
        projectId,
        assigneeId: assigneeId || null,
        dueDate: dueDate ? new Date(dueDate) : null,
        status: status || 'TODO',
        priority: priority || 'NONE'
      },
      include: { assignee: true }
    });

    // Notify assignee
    if (task.assigneeId && task.assigneeId !== req.session.user.id) {
      await prisma.notification.create({
        data: {
          userId: task.assigneeId,
          content: `Kamu ditugaskan ke task "${task.title}"`,
          link: `/tasks/${task.id}`
        }
      });
      const io = req.app.get('io');
      if (io) io.to(`user-${task.assigneeId}`).emit('new-notification');
    }

    res.json({ success: true, task });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal membuat tugas' });
  }
});

// Update task status (Kanban drag)
router.patch('/:id/status', async (req, res) => {
  try {
    const { status, position } = req.body;

    const task = await prisma.task.update({
      where: { id: req.params.id },
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

// Update task — form submit from detail page
router.post('/:id/update', async (req, res) => {
  try {
    const { title, description, assigneeId, dueDate, priority, status } = req.body;
    const oldTask = await prisma.task.findUnique({ where: { id: req.params.id } });

    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: {
        title,
        description: description || null,
        assigneeId: assigneeId || null,
        dueDate: dueDate ? new Date(dueDate) : null,
        priority: priority || 'NONE',
        status: status || oldTask.status
      }
    });

    // Notify new assignee
    if (assigneeId && assigneeId !== oldTask.assigneeId && assigneeId !== req.session.user.id) {
      await prisma.notification.create({
        data: {
          userId: assigneeId,
          content: `Kamu ditugaskan ke task "${task.title}"`,
          link: `/tasks/${task.id}`
        }
      });
      const io = req.app.get('io');
      if (io) io.to(`user-${assigneeId}`).emit('new-notification');
    }

    res.redirect(`/tasks/${req.params.id}`);
  } catch (error) {
    console.error(error);
    res.redirect(`/tasks/${req.params.id}`);
  }
});

// Update task — JSON (from kanban edit)
router.put('/:id', async (req, res) => {
  try {
    const { title, description, assigneeId, dueDate, priority } = req.body;

    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: {
        title,
        description,
        assigneeId: assigneeId || null,
        dueDate: dueDate ? new Date(dueDate) : null,
        priority: priority || undefined
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

// Add comment
router.post('/:id/comments', async (req, res) => {
  try {
    const { content } = req.body;
    const userId = req.session.user.id;

    const comment = await prisma.comment.create({
      data: { content, taskId: req.params.id, userId },
      include: { user: true }
    });

    res.json({ success: true, comment });
  } catch (error) {
    res.status(500).json({ error: 'Gagal tambah komentar' });
  }
});

// Delete comment
router.delete('/:id/comments/:commentId', async (req, res) => {
  try {
    const comment = await prisma.comment.findUnique({ where: { id: req.params.commentId } });
    if (!comment) return res.status(404).json({ error: 'Komentar tidak ditemukan' });
    if (comment.userId !== req.session.user.id) {
      return res.status(403).json({ error: 'Bukan komentar kamu' });
    }
    await prisma.comment.delete({ where: { id: req.params.commentId } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Gagal hapus komentar' });
  }
});

module.exports = router;
