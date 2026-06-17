const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { upload, attachmentData } = require('../lib/upload');
const { logActivity } = require('../lib/activity');
const { hasProjectAccess, ensureProjectMember } = require('../lib/access');
const { notifyUser } = require('../lib/notify');
const { extractMentionedUserIds } = require('../lib/mentions');

router.use(requireAuth);

async function canAccessProject(user, projectId) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, companyId: true }
  });
  if (!project) return null;
  return await hasProjectAccess(user, project) ? project : null;
}

async function canAccessTask(user, taskId) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { project: { select: { id: true, companyId: true } } }
  });
  if (!task) return null;
  return await hasProjectAccess(user, task.project) ? task : null;
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
        parent: { select: { id: true, title: true, status: true } },
        children: { select: { id: true, title: true, status: true, priority: true, assignee: true }, orderBy: { createdAt: 'asc' } },
        checklists: { orderBy: { position: 'asc' }, include: { children: { orderBy: { position: 'asc' } } } },
        comments: { where: { parentId: null }, include: { user: true, files: true, replies: { include: { user: true, files: true }, orderBy: { createdAt: 'asc' } } }, orderBy: { createdAt: 'asc' } },
        labels: { include: { label: true } },
        attachments: { include: { uploadedBy: true }, orderBy: { createdAt: 'desc' } },
        activityLogs: { include: { user: true }, orderBy: { createdAt: 'desc' }, take: 30 }
      }
    });

    if (!task) return res.status(404).send('Task tidak ditemukan');
    if (!await hasProjectAccess(req.session.user, task.project)) {
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

    // Get other tasks in same project for parent selector (exclude self and descendants)
    const siblingTasks = await prisma.task.findMany({
      where: {
        projectId: task.projectId,
        id: { not: task.id },
        parentId: null // only top-level tasks as potential parents
      },
      select: { id: true, title: true, status: true },
      orderBy: { createdAt: 'desc' }
    });

    res.render('tasks/detail', {
      title: task.title,
      task,
      members: members.map(m => m.user),
      labels,
      siblingTasks,
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

    // Assigning grants project access; notify assignee
    if (task.assigneeId) {
      await ensureProjectMember(task.assigneeId, projectId);
      if (task.assigneeId !== req.session.user.id) {
        await notifyUser(req.app.get('io'), task.assigneeId, `Kamu ditugaskan ke task "${task.title}"`, `/tasks/${task.id}`);
      }
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

// Quick inline update: assignee only
router.patch('/:id/assignee', async (req, res) => {
  try {
    const { assigneeId } = req.body;
    const existingTask = await canAccessTask(req.session.user, req.params.id);
    if (!existingTask) return res.status(403).json({ error: 'Akses ditolak' });

    const normalizedId = (assigneeId === '' || assigneeId === null || assigneeId === 'null') ? null : assigneeId;
    if (normalizedId) {
      const valid = await isValidAssignee(normalizedId, existingTask.project.companyId);
      if (!valid) return res.status(400).json({ error: 'Assignee bukan anggota brand ini' });
    }

    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: { assigneeId: normalizedId },
      include: { assignee: true }
    });

    await logActivity(prisma, req, {
      action: normalizedId ? 'assigned' : 'unassigned',
      entityType: 'task',
      entityId: task.id,
      projectId: task.projectId,
      taskId: task.id,
      metadata: { assigneeId: normalizedId, assigneeName: task.assignee?.name || null }
    });

    if (normalizedId && normalizedId !== existingTask.assigneeId) {
      await ensureProjectMember(normalizedId, task.projectId);
      if (normalizedId !== req.session.user.id) {
        await notifyUser(req.app.get('io'), normalizedId, `Kamu ditugaskan ke task "${task.title}"`, `/tasks/${task.id}`);
      }
    }

    res.json({ success: true, task });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal update assignee' });
  }
});

// Quick inline update: due date only
router.patch('/:id/due-date', async (req, res) => {
  try {
    const { dueDate } = req.body;
    const existingTask = await canAccessTask(req.session.user, req.params.id);
    if (!existingTask) return res.status(403).json({ error: 'Akses ditolak' });

    let normalized = null;
    if (dueDate) {
      const d = new Date(dueDate);
      if (!isNaN(d.getTime())) normalized = d;
    }

    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: { dueDate: normalized }
    });

    await logActivity(prisma, req, {
      action: normalized ? 'set_due_date' : 'cleared_due_date',
      entityType: 'task',
      entityId: task.id,
      projectId: task.projectId,
      taskId: task.id,
      metadata: { dueDate: normalized ? normalized.toISOString() : null }
    });

    res.json({ success: true, task });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal update deadline' });
  }
});

// Quick inline update: priority only
router.patch('/:id/priority', async (req, res) => {
  try {
    const { priority } = req.body;
    const validPriorities = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT'];
    const normalized = (validPriorities.includes(priority) ? priority : 'NONE');

    const existingTask = await canAccessTask(req.session.user, req.params.id);
    if (!existingTask) return res.status(403).json({ error: 'Akses ditolak' });

    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: { priority: normalized }
    });

    await logActivity(prisma, req, {
      action: 'priority_changed',
      entityType: 'task',
      entityId: task.id,
      projectId: task.projectId,
      taskId: task.id,
      metadata: { priority: normalized }
    });

    res.json({ success: true, task });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal update prioritas' });
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
    if (assigneeId && assigneeId !== existingTask.assigneeId) {
      await ensureProjectMember(assigneeId, existingTask.projectId);
      if (assigneeId !== req.session.user.id) {
        await notifyUser(req.app.get('io'), assigneeId, `Kamu ditugaskan ke task "${title || existingTask.title}"`, `/tasks/${existingTask.id}`);
      }
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
router.post('/:id/comments', upload.array('files', 5), async (req, res) => {
  try {
    const { content, parentId } = req.body;
    const userId = req.session.user.id;
    const accessibleTask = await canAccessTask(req.session.user, req.params.id);
    if (!accessibleTask) return res.status(403).json({ error: 'Akses ditolak' });
    if (!content && (!req.files || req.files.length === 0)) return res.status(400).json({ error: 'Komentar wajib diisi' });

    const comment = await prisma.comment.create({
      data: {
        content: content || '',
        taskId: req.params.id,
        userId,
        parentId: parentId || null
      },
      include: { user: true }
    });

    // Save attached files
    if (req.files && req.files.length > 0) {
      await prisma.commentFile.createMany({
        data: req.files.map(file => ({
          filename: file.filename || file.originalname,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          url: `/uploads/${file.filename || file.originalname}`,
          commentId: comment.id,
          uploadedById: userId
        }))
      });
    }

    const fullComment = await prisma.comment.findUnique({
      where: { id: comment.id },
      include: { user: true, files: true }
    });

    await logActivity(prisma, req, {
      action: 'commented',
      entityType: 'task',
      entityId: req.params.id,
      projectId: accessibleTask.projectId,
      taskId: req.params.id,
      metadata: { content, parentId, hasFiles: !!(req.files && req.files.length) }
    });

    // @mention notifications
    const companyMembers = await prisma.membership.findMany({
      where: { companyId: accessibleTask.project.companyId },
      include: { user: { select: { id: true, name: true } } }
    });
    const mentionedIds = extractMentionedUserIds(content, companyMembers.map(m => m.user))
      .filter(id => id !== userId);
    const io = req.app.get('io');
    for (const mentionedId of mentionedIds) {
      await ensureProjectMember(mentionedId, accessibleTask.projectId);
      await notifyUser(io, mentionedId, `${fullComment.user.name} menyebut kamu di komentar task "${accessibleTask.title}"`, `/tasks/${req.params.id}`);
    }

    res.json({ success: true, comment: fullComment });
  } catch (error) {
    console.error(error);
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

// Set parent task
router.post('/:id/set-parent', async (req, res) => {
  try {
    const { parentId } = req.body;
    const task = await canAccessTask(req.session.user, req.params.id);
    if (!task) return res.status(403).json({ error: 'Akses ditolak' });

    // Validate parent exists and is in same project
    if (parentId) {
      const parentTask = await prisma.task.findUnique({ where: { id: parentId } });
      if (!parentTask) return res.status(404).json({ error: 'Parent task tidak ditemukan' });
      if (parentTask.projectId !== task.projectId) {
        return res.status(400).json({ error: 'Parent task harus dari proyek yang sama' });
      }
      // Prevent circular reference
      if (parentId === req.params.id) {
        return res.status(400).json({ error: 'Task tidak bisa menjadi parent diri sendiri' });
      }
      // Check if the proposed parent is already a child of this task
      const existingChildren = await prisma.task.findMany({ where: { parentId: req.params.id } });
      if (existingChildren.some(c => c.id === parentId)) {
        return res.status(400).json({ error: 'Tidak bisa membuat circular reference' });
      }
    }

    const updated = await prisma.task.update({
      where: { id: req.params.id },
      data: { parentId: parentId || null }
    });

    await logActivity(prisma, req, {
      action: parentId ? 'set_parent' : 'removed_parent',
      entityType: 'task',
      entityId: task.id,
      projectId: task.projectId,
      taskId: task.id,
      metadata: { parentId: parentId || null }
    });

    res.json({ success: true, task: updated });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal update parent task' });
  }
});

// Remove parent task
router.post('/:id/remove-parent', async (req, res) => {
  try {
    const task = await canAccessTask(req.session.user, req.params.id);
    if (!task) return res.status(403).json({ error: 'Akses ditolak' });

    await prisma.task.update({
      where: { id: req.params.id },
      data: { parentId: null }
    });

    await logActivity(prisma, req, {
      action: 'removed_parent',
      entityType: 'task',
      entityId: task.id,
      projectId: task.projectId,
      taskId: task.id,
      metadata: {}
    });

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal menghapus parent task' });
  }
});

module.exports = router;

// Get members for @mention autocomplete
router.get('/:id/members', async (req, res) => {
  try {
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      select: { project: { select: { companyId: true } } }
    });
    if (!task) return res.json([]);

    const members = await prisma.membership.findMany({
      where: { companyId: task.project.companyId },
      include: { user: { select: { id: true, name: true, email: true } } }
    });

    const q = (req.query.q || '').toLowerCase();
    const filtered = q
      ? members.filter(m => m.user.name.toLowerCase().includes(q) || m.user.email.toLowerCase().includes(q))
      : members;

    res.json(filtered.map(m => ({ id: m.user.id, name: m.user.name, email: m.user.email })));
  } catch (error) {
    res.status(500).json([]);
  }
});

// Move task to a different project
router.patch('/:id/project', async (req, res) => {
  try {
    const { projectId: targetProjectId } = req.body;
    if (!targetProjectId) return res.status(400).json({ error: 'Target project wajib diisi' });

    const existingTask = await canAccessTask(req.session.user, req.params.id);
    if (!existingTask) return res.status(403).json({ error: 'Akses ditolak' });

    // Check access to target project
    const targetProject = await prisma.project.findUnique({ where: { id: targetProjectId }, select: { id: true, companyId: true } });
    if (!targetProject || !await hasProjectAccess(req.session.user, targetProject)) {
      return res.status(403).json({ error: 'Akses ke proyek target ditolak' });
    }

    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: { projectId: targetProjectId }
    });

    await logActivity(prisma, req, {
      action: 'moved',
      entityType: 'task',
      entityId: task.id,
      projectId: targetProjectId,
      taskId: task.id,
      metadata: { fromProjectId: existingTask.projectId, toProjectId: targetProjectId }
    });

    res.json({ success: true, task });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal memindahkan task' });
  }
});

// Toggle reaction on comment (Cheers)
router.post('/:id/comments/:commentId/reactions', async (req, res) => {
  try {
    const { emoji } = req.body;
    const userId = req.session.user.id;
    const comment = await prisma.comment.findUnique({ where: { id: req.params.commentId } });
    if (!comment) return res.status(404).json({ error: 'Komentar tidak ditemukan' });

    const reactions = comment.reactions || {};
    const users = reactions[emoji] || [];
    const idx = users.indexOf(userId);

    if (idx > -1) {
      users.splice(idx, 1);
      if (users.length === 0) delete reactions[emoji];
      else reactions[emoji] = users;
    } else {
      reactions[emoji] = [...users, userId];
    }

    await prisma.comment.update({
      where: { id: req.params.commentId },
      data: { reactions }
    });

    res.json({ success: true, reactions: Object.entries(reactions) });
  } catch (error) {
    res.status(500).json({ error: 'Gagal update reaction' });
  }
});
