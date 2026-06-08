const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { upload, attachmentData } = require('../lib/upload');
const { logActivity } = require('../lib/activity');

router.use(requireAuth);

async function hasCompanyAccess(user, companyId) {
  if (user.platformRole === 'owner') return true;

  if (user.platformRole === 'partner') {
    const access = await prisma.partnerAccess.findUnique({
      where: { userId_companyId: { userId: user.id, companyId } }
    });
    if (access) return true;
  }

  const membership = await prisma.membership.findUnique({
    where: { userId_companyId: { userId: user.id, companyId } }
  });
  return Boolean(membership);
}

async function canAccessProject(user, projectId) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, companyId: true }
  });
  if (!project) return null;
  return await hasCompanyAccess(user, project.companyId) ? project : null;
}

async function canAccessTask(user, taskId) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { project: { select: { id: true, companyId: true } } }
  });
  if (!task) return null;
  return await hasCompanyAccess(user, task.project.companyId) ? task : null;
}

async function isValidAssignee(userId, companyId) {
  if (!userId) return true;
  const membership = await prisma.membership.findUnique({
    where: { userId_companyId: { userId, companyId } }
  });
  return Boolean(membership);
}

// Task detail page
router.get('/:id', async (req, res) => {
  try {
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: {
        project: { include: { company: true } },
        assignee: true,
        checklists: { orderBy: { position: 'asc' } },
        comments: { include: { user: true }, orderBy: { createdAt: 'asc' } },
        labels: { include: { label: true } },
        attachments: { include: { uploadedBy: true }, orderBy: { createdAt: 'desc' } },
        activityLogs: { include: { user: true }, orderBy: { createdAt: 'desc' }, take: 30 }
      }
    });

    if (!task) return res.status(404).send('Task tidak ditemukan');
    if (!await hasCompanyAccess(req.session.user, task.project.companyId)) {
      return res.status(403).send('Akses ditolak');
    }

    const members = await prisma.membership.findMany({
      where: { companyId: task.project.companyId },
      include: { user: true }
    });

    const labels = await prisma.label.findMany({
      where: {
        OR: [
          { companyId: task.project.companyId },
          { companyId: null }
        ]
      },
      orderBy: { name: 'asc' }
    });

    res.render('tasks/detail', {
      title: task.title,
      task,
      members: members.map(m => m.user),
      labels,
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
    const project = await canAccessProject(req.session.user, projectId);
    if (!project) return res.status(403).json({ error: 'Akses ditolak' });
    if (!await isValidAssignee(assigneeId, project.companyId)) {
      return res.status(400).json({ error: 'Assignee bukan anggota brand ini' });
    }

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

    await logActivity(prisma, req, {
      action: 'created',
      entityType: 'task',
      entityId: task.id,
      projectId,
      taskId: task.id,
      metadata: { title: task.title }
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
    const existingTask = await canAccessTask(req.session.user, req.params.id);
    if (!existingTask) return res.status(403).json({ error: 'Akses ditolak' });

    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: {
        status,
        position: position !== undefined ? parseInt(position) : undefined
      },
      include: { assignee: true }
    });

    await logActivity(prisma, req, {
      action: 'status_changed',
      entityType: 'task',
      entityId: task.id,
      projectId: task.projectId,
      taskId: task.id,
      metadata: { status }
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
    const oldTask = await canAccessTask(req.session.user, req.params.id);
    if (!oldTask) return res.status(403).send('Akses ditolak');
    if (!await isValidAssignee(assigneeId, oldTask.project.companyId)) {
      req.flash('error', 'Assignee bukan anggota brand ini');
      return res.redirect(`/tasks/${req.params.id}`);
    }

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

    await logActivity(prisma, req, {
      action: 'updated',
      entityType: 'task',
      entityId: task.id,
      projectId: oldTask.projectId,
      taskId: task.id,
      metadata: { title: task.title, status: task.status }
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
    const existingTask = await canAccessTask(req.session.user, req.params.id);
    if (!existingTask) return res.status(403).json({ error: 'Akses ditolak' });
    if (!await isValidAssignee(assigneeId, existingTask.project.companyId)) {
      return res.status(400).json({ error: 'Assignee bukan anggota brand ini' });
    }

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

    await logActivity(prisma, req, {
      action: 'updated',
      entityType: 'task',
      entityId: task.id,
      projectId: task.projectId,
      taskId: task.id,
      metadata: { title: task.title }
    });

    res.json({ success: true, task });
  } catch (error) {
    res.status(500).json({ error: 'Gagal update' });
  }
});

// Delete task
router.delete('/:id', async (req, res) => {
  try {
    const task = await canAccessTask(req.session.user, req.params.id);
    if (!task) return res.status(403).json({ error: 'Akses ditolak' });
    await prisma.task.delete({ where: { id: req.params.id } });
    if (task) {
      await logActivity(prisma, req, {
        action: 'deleted',
        entityType: 'task',
        entityId: task.id,
        projectId: task.projectId,
        metadata: { title: task.title }
      });
    }
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
    const accessibleTask = await canAccessTask(req.session.user, req.params.id);
    if (!accessibleTask) return res.status(403).json({ error: 'Akses ditolak' });

    const comment = await prisma.comment.create({
      data: { content, taskId: req.params.id, userId },
      include: { user: true }
    });

    await logActivity(prisma, req, {
      action: 'commented',
      entityType: 'task',
      entityId: req.params.id,
      projectId: accessibleTask.projectId,
      taskId: req.params.id,
      metadata: { content }
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

router.post('/:id/attachments', upload.array('files', 8), async (req, res) => {
  try {
    const task = await canAccessTask(req.session.user, req.params.id);
    if (!task) return res.status(403).json({ error: 'Akses ditolak' });

    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'Pilih file dulu' });

    await prisma.attachment.createMany({
      data: files.map(file => attachmentData(file, req.session.user.id, {
        taskId: task.id,
        projectId: task.projectId
      }))
    });

    await logActivity(prisma, req, {
      action: 'uploaded_attachment',
      entityType: 'task',
      entityId: task.id,
      projectId: task.projectId,
      taskId: task.id,
      metadata: { files: files.map(file => file.originalname) }
    });

    res.redirect(`/tasks/${task.id}`);
  } catch (error) {
    console.error(error);
    res.redirect(`/tasks/${req.params.id}`);
  }
});

router.post('/:id/labels', async (req, res) => {
  try {
    const { name, color, labelId } = req.body;
    const task = await canAccessTask(req.session.user, req.params.id);
    if (!task) return res.status(403).json({ error: 'Akses ditolak' });

    let label = null;
    if (labelId) {
      label = await prisma.label.findUnique({ where: { id: labelId } });
      if (label && label.companyId && label.companyId !== task.project.companyId) {
        return res.status(403).send('Akses label ditolak');
      }
    } else if (name) {
      const labelName = name.trim();
      if (!labelName) return res.redirect(`/tasks/${task.id}`);
      label = await prisma.label.upsert({
        where: { name_companyId: { name: labelName, companyId: task.project.companyId } },
        update: { color: color || '#3B82F6' },
        create: {
          name: labelName,
          color: color || '#3B82F6',
          companyId: task.project.companyId
        }
      });
    }

    if (!label) return res.redirect(`/tasks/${task.id}`);

    await prisma.taskLabel.upsert({
      where: { taskId_labelId: { taskId: task.id, labelId: label.id } },
      update: {},
      create: { taskId: task.id, labelId: label.id }
    });

    await logActivity(prisma, req, {
      action: 'added_label',
      entityType: 'task',
      entityId: task.id,
      projectId: task.projectId,
      taskId: task.id,
      metadata: { label: label.name }
    });

    res.redirect(`/tasks/${task.id}`);
  } catch (error) {
    console.error(error);
    res.redirect(`/tasks/${req.params.id}`);
  }
});

router.post('/:id/labels/:labelId/remove', async (req, res) => {
  try {
    const accessTask = await canAccessTask(req.session.user, req.params.id);
    if (!accessTask) return res.status(403).send('Akses ditolak');

    const taskLabel = await prisma.taskLabel.findUnique({
      where: { taskId_labelId: { taskId: req.params.id, labelId: req.params.labelId } },
      include: { task: true, label: true }
    });

    if (taskLabel) {
      await prisma.taskLabel.delete({
        where: { taskId_labelId: { taskId: req.params.id, labelId: req.params.labelId } }
      });
      await logActivity(prisma, req, {
        action: 'removed_label',
        entityType: 'task',
        entityId: taskLabel.taskId,
        projectId: taskLabel.task.projectId,
        taskId: taskLabel.taskId,
        metadata: { label: taskLabel.label.name }
      });
    }

    res.redirect(`/tasks/${req.params.id}`);
  } catch (error) {
    console.error(error);
    res.redirect(`/tasks/${req.params.id}`);
  }
});

module.exports = router;
