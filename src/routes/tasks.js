const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { upload, attachmentData } = require('../lib/upload');
const { logActivity } = require('../lib/activity');
const { hasProjectAccess, ensureProjectMember } = require('../lib/access');
const { notifyUser } = require('../lib/notify');
const { extractMentionedUserIds } = require('../lib/mentions');
const { syncProjectArchiveState } = require('../lib/projectArchive');

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
        progressUpdates: { include: { author: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' } },
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
    const allowedStatuses = ['TODO', 'IN_PROGRESS', 'DONE'];
    const normalizedStatus = allowedStatuses.includes(status) ? status : 'TODO';
    const checklists = Array.isArray(req.body.checklists)
      ? req.body.checklists.map(item => String(item || '').trim()).filter(Boolean).slice(0, 100)
      : [];
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
        status: normalizedStatus,
        priority: priority || 'NONE',
        checklists: checklists.length > 0 ? {
          create: checklists.map((content, position) => ({ content, position }))
        } : undefined
      },
      include: {
        assignee: true,
        checklists: { orderBy: { position: 'asc' } },
        labels: { include: { label: true } },
        children: { select: { id: true } }
      }
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
      try {
        await ensureProjectMember(task.assigneeId, projectId);
        if (task.assigneeId !== req.session.user.id) {
          await notifyUser(req.app.get('io'), task.assigneeId, `Kamu ditugaskan ke task "${task.title}"`, `/tasks/${task.id}`);
        }
      } catch (notifyError) {
        console.error('Task post-create notify failed:', notifyError.message);
      }
    }

    const projectArchiveState = await syncProjectArchiveState(prisma, projectId, req);

    res.json({ success: true, task, projectArchiveState });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal membuat tugas' });
  }
});

// Update task status (Kanban drag)
router.patch('/:id/status', async (req, res) => {
  try {
    const { status, position } = req.body;
    const allowedStatuses = ['TODO', 'IN_PROGRESS', 'DONE'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: 'Status task tidak valid' });
    }

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

    const projectArchiveState = await syncProjectArchiveState(prisma, task.projectId, req);

    res.json({ success: true, task, projectArchiveState });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal update tugas' });
  }
});

// Quick inline update: title only
router.patch('/:id/title', async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Judul task wajib diisi' });

    const existingTask = await canAccessTask(req.session.user, req.params.id);
    if (!existingTask) return res.status(403).json({ error: 'Akses ditolak' });

    const task = await prisma.task.update({
      where: { id: existingTask.id },
      data: { title }
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
    console.error(error);
    res.status(500).json({ error: 'Gagal memperbarui judul task' });
  }
});

// Quick inline update: description only
router.patch('/:id/description', async (req, res) => {
  try {
    const existingTask = await canAccessTask(req.session.user, req.params.id);
    if (!existingTask) return res.status(403).json({ error: 'Akses ditolak' });

    const description = String(req.body.description || '').trim() || null;
    const task = await prisma.task.update({
      where: { id: existingTask.id },
      data: { description }
    });

    await logActivity(prisma, req, {
      action: 'updated',
      entityType: 'task',
      entityId: task.id,
      projectId: task.projectId,
      taskId: task.id,
      metadata: { description: task.description }
    });

    res.json({ success: true, task });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal memperbarui deskripsi task' });
  }
});

router.post('/:id/progress-updates', async (req, res) => {
  try {
    const task = await canAccessTask(req.session.user, req.params.id);
    if (!task) {
      if (req.headers.accept?.includes('json')) return res.status(403).json({ error: 'Akses ditolak' });
      req.flash('error', 'Akses ditolak');
      return res.redirect('/projects');
    }

    const content = String(req.body.content || '').trim();
    const allowedStatuses = ['ON_TRACK', 'BLOCKED', 'NEED_REVIEW'];
    const status = allowedStatuses.includes(req.body.status) ? req.body.status : null;

    if (!content) {
      if (req.headers.accept?.includes('json')) return res.status(400).json({ error: 'Progress update wajib diisi' });
      req.flash('error', 'Progress update wajib diisi');
      return res.redirect(`/tasks/${task.id}`);
    }

    const update = await prisma.taskProgressUpdate.create({
      data: {
        content,
        status,
        taskId: task.id,
        authorId: req.session.user.id
      },
      include: { author: { select: { id: true, name: true } } }
    });

    await logActivity(prisma, req, {
      action: 'progress_updated',
      entityType: 'task',
      entityId: task.id,
      projectId: task.projectId,
      taskId: task.id,
      metadata: { status, content }
    });

    if (req.headers.accept?.includes('json')) return res.json({ success: true, update });

    req.flash('success', 'Progress update berhasil ditambahkan');
    res.redirect(`/tasks/${task.id}`);
  } catch (error) {
    console.error(error);
    if (req.headers.accept?.includes('json')) return res.status(500).json({ error: 'Gagal menambah progress update' });
    req.flash('error', 'Gagal menambah progress update');
    res.redirect(`/tasks/${req.params.id}`);
  }
});

router.patch('/:id/progress-updates/:updateId', async (req, res) => {
  try {
    const task = await canAccessTask(req.session.user, req.params.id);
    if (!task) return res.status(403).json({ error: 'Akses ditolak' });

    const existing = await prisma.taskProgressUpdate.findUnique({
      where: { id: req.params.updateId }
    });
    if (!existing || existing.taskId !== task.id) return res.status(404).json({ error: 'Progress update tidak ditemukan' });
    if (existing.authorId !== req.session.user.id) return res.status(403).json({ error: 'Hanya pembuat progress yang bisa mengedit' });

    const content = String(req.body.content || '').trim();
    const allowedStatuses = ['ON_TRACK', 'BLOCKED', 'NEED_REVIEW'];
    const status = allowedStatuses.includes(req.body.status) ? req.body.status : null;
    if (!content) return res.status(400).json({ error: 'Progress update wajib diisi' });

    const update = await prisma.taskProgressUpdate.update({
      where: { id: existing.id },
      data: { content, status },
      include: { author: { select: { id: true, name: true } } }
    });

    await logActivity(prisma, req, {
      action: 'progress_updated',
      entityType: 'task',
      entityId: task.id,
      projectId: task.projectId,
      taskId: task.id,
      metadata: { status, content, edited: true }
    });

    res.json({ success: true, update });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal memperbarui progress update' });
  }
});

router.delete('/:id/progress-updates/:updateId', async (req, res) => {
  try {
    const task = await canAccessTask(req.session.user, req.params.id);
    if (!task) return res.status(403).json({ error: 'Akses ditolak' });

    const existing = await prisma.taskProgressUpdate.findUnique({
      where: { id: req.params.updateId }
    });
    if (!existing || existing.taskId !== task.id) return res.status(404).json({ error: 'Progress update tidak ditemukan' });
    if (existing.authorId !== req.session.user.id) return res.status(403).json({ error: 'Hanya pembuat progress yang bisa menghapus' });

    await prisma.taskProgressUpdate.delete({ where: { id: existing.id } });

    await logActivity(prisma, req, {
      action: 'progress_deleted',
      entityType: 'task',
      entityId: task.id,
      projectId: task.projectId,
      taskId: task.id,
      metadata: { content: existing.content, status: existing.status }
    });

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal menghapus progress update' });
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

// Update task from HTML forms on the task detail page.
router.post('/:id/update', async (req, res) => {
  try {
    const existingTask = await canAccessTask(req.session.user, req.params.id);
    if (!existingTask) {
      req.flash('error', 'Akses ditolak');
      return res.redirect('/projects');
    }

    const hasField = (name) => Object.prototype.hasOwnProperty.call(req.body, name);
    const data = {};

    if (hasField('title')) {
      const title = String(req.body.title || '').trim();
      if (!title) {
        req.flash('error', 'Judul task wajib diisi');
        return res.redirect(`/tasks/${existingTask.id}`);
      }
      data.title = title;
    }
    if (hasField('description')) data.description = String(req.body.description || '').trim() || null;

    if (hasField('status')) {
      const allowedStatuses = ['TODO', 'IN_PROGRESS', 'DONE'];
      if (!allowedStatuses.includes(req.body.status)) {
        req.flash('error', 'Status task tidak valid');
        return res.redirect(`/tasks/${existingTask.id}`);
      }
      data.status = req.body.status;
    }

    if (hasField('priority')) {
      const allowedPriorities = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT'];
      data.priority = allowedPriorities.includes(req.body.priority) ? req.body.priority : 'NONE';
    }

    if (hasField('dueDate')) {
      const dueDateRaw = String(req.body.dueDate || '').trim();
      const dueDate = dueDateRaw ? new Date(`${dueDateRaw}T00:00:00`) : null;
      if (dueDate && Number.isNaN(dueDate.getTime())) {
        req.flash('error', 'Deadline tidak valid');
        return res.redirect(`/tasks/${existingTask.id}`);
      }
      data.dueDate = dueDate;
    }

    if (hasField('assigneeId')) {
      const assigneeId = String(req.body.assigneeId || '').trim() || null;
      if (!await isValidAssignee(assigneeId, existingTask.project.companyId)) {
        req.flash('error', 'Assignee bukan anggota brand ini');
        return res.redirect(`/tasks/${existingTask.id}`);
      }
      data.assigneeId = assigneeId;

      if (assigneeId && assigneeId !== existingTask.assigneeId) {
        await ensureProjectMember(assigneeId, existingTask.projectId);
        if (assigneeId !== req.session.user.id) {
          await notifyUser(req.app.get('io'), assigneeId, `Kamu ditugaskan ke task "${data.title || existingTask.title}"`, `/tasks/${existingTask.id}`);
        }
      }
    }

    const task = await prisma.task.update({
      where: { id: existingTask.id },
      data
    });

    await logActivity(prisma, req, {
      action: 'updated',
      entityType: 'task',
      entityId: task.id,
      projectId: task.projectId,
      taskId: task.id,
      metadata: { title: task.title }
    });

    if (hasField('status')) {
      const projectArchiveState = await syncProjectArchiveState(prisma, task.projectId, req);
      if (projectArchiveState.status === 'archived') {
        req.flash('success', 'Task berhasil diperbarui. Semua task selesai, project otomatis masuk Arsip.');
        return res.redirect('/projects');
      }
      if (projectArchiveState.status === 'unarchived') {
        req.flash('success', 'Task berhasil diperbarui. Project otomatis dikembalikan ke daftar aktif.');
        return res.redirect(`/tasks/${task.id}`);
      }
    }

    req.flash('success', 'Task berhasil diperbarui');
    res.redirect(`/tasks/${task.id}`);
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal memperbarui task');
    res.redirect(`/tasks/${req.params.id}`);
  }
});

// Update task via JSON from the kanban editor.
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
    const projectArchiveState = await syncProjectArchiveState(prisma, task.projectId, req);
    res.json({ success: true, projectArchiveState });
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

    const q = (req.query.q || '').trim().toLowerCase();
    const mappedMembers = members.map(m => ({ id: m.user.id, name: m.user.name, email: m.user.email }));
    const filtered = q
      ? mappedMembers
          .filter(m => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
          .sort((a, b) => {
            const aStarts = a.name.toLowerCase().startsWith(q) || a.email.toLowerCase().startsWith(q);
            const bStarts = b.name.toLowerCase().startsWith(q) || b.email.toLowerCase().startsWith(q);
            return Number(bStarts) - Number(aStarts) || a.name.localeCompare(b.name);
          })
      : mappedMembers.sort((a, b) => a.name.localeCompare(b.name));

    res.json(filtered);
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

    const [sourceProjectArchiveState, targetProjectArchiveState] = await Promise.all([
      syncProjectArchiveState(prisma, existingTask.projectId, req),
      syncProjectArchiveState(prisma, targetProjectId, req)
    ]);

    res.json({ success: true, task, projectArchiveState: targetProjectArchiveState, sourceProjectArchiveState });
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
