const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { hasCompanyAccess, hasProjectAccess } = require('../lib/access');
const { logActivity } = require('../lib/activity');

router.use(requireAuth);

function normalizeChecklistItems(checklists) {
  if (!Array.isArray(checklists)) return [];
  return checklists
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 100);
}

function taskChecklistToTemplateItems(checklists) {
  const rows = [];
  for (const item of checklists || []) {
    rows.push(item.content);
    for (const child of item.children || []) {
      rows.push(`- ${child.content}`);
    }
  }
  return normalizeChecklistItems(rows);
}

// Get templates for a brand
router.get('/brand/:companyId', async (req, res) => {
  try {
    if (!await hasCompanyAccess(req.session.user, req.params.companyId)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }

    const templates = await prisma.taskTemplate.findMany({
      where: { companyId: req.params.companyId },
      include: { checklists: { orderBy: { position: 'asc' } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json(templates);
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengambil template' });
  }
});

// Create template
router.post('/', async (req, res) => {
  try {
    const { name, description, priority, companyId, checklists } = req.body;
    if (!name || !companyId) return res.status(400).json({ error: 'Nama dan brand wajib diisi' });
    if (!await hasCompanyAccess(req.session.user, companyId)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }

    const checklistItems = normalizeChecklistItems(checklists);

    const template = await prisma.taskTemplate.create({
      data: {
        name: String(name).trim(),
        description: String(description || '').trim() || null,
        priority: priority || 'NONE',
        companyId,
        checklists: checklistItems.length > 0 ? {
          create: checklistItems.map((c, i) => ({ content: c, position: i }))
        } : undefined
      },
      include: { checklists: { orderBy: { position: 'asc' } } }
    });

    res.json({ success: true, template });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal membuat template' });
  }
});

// Save an existing task as a reusable template
router.post('/from-task/:taskId', async (req, res) => {
  try {
    const task = await prisma.task.findUnique({
      where: { id: req.params.taskId },
      include: {
        project: { select: { id: true, companyId: true } },
        checklists: {
          where: { parentId: null },
          orderBy: { position: 'asc' },
          include: { children: { orderBy: { position: 'asc' } } }
        }
      }
    });

    if (!task) return res.status(404).json({ error: 'Task tidak ditemukan' });
    if (!await hasProjectAccess(req.session.user, task.project)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }

    const name = String(req.body.name || task.title || '').trim();
    if (!name) return res.status(400).json({ error: 'Nama template wajib diisi' });

    const checklistItems = taskChecklistToTemplateItems(task.checklists);
    const template = await prisma.taskTemplate.create({
      data: {
        name,
        description: task.description || null,
        priority: task.priority || 'NONE',
        companyId: task.project.companyId,
        checklists: checklistItems.length > 0 ? {
          create: checklistItems.map((content, position) => ({ content, position }))
        } : undefined
      },
      include: { checklists: { orderBy: { position: 'asc' } } }
    });

    await logActivity(prisma, req, {
      action: 'created_template',
      entityType: 'task',
      entityId: task.id,
      projectId: task.projectId,
      taskId: task.id,
      metadata: { templateId: template.id, templateName: template.name }
    });

    res.json({ success: true, template });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal menyimpan template dari task' });
  }
});

// Delete template
router.delete('/:id', async (req, res) => {
  try {
    const template = await prisma.taskTemplate.findUnique({
      where: { id: req.params.id },
      select: { companyId: true }
    });
    if (!template) return res.status(404).json({ error: 'Template tidak ditemukan' });
    if (!await hasCompanyAccess(req.session.user, template.companyId)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }

    await prisma.taskTemplate.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Gagal hapus template' });
  }
});

// Create task from template
router.post('/:id/create-task', async (req, res) => {
  try {
    const { projectId } = req.body;
    if (!projectId) return res.status(400).json({ error: 'Project wajib diisi' });

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, companyId: true }
    });
    if (!project || !await hasProjectAccess(req.session.user, project)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }

    const template = await prisma.taskTemplate.findUnique({
      where: { id: req.params.id },
      include: { checklists: { orderBy: { position: 'asc' } } }
    });
    if (!template) return res.status(404).json({ error: 'Template tidak ditemukan' });
    if (template.companyId !== project.companyId) {
      return res.status(400).json({ error: 'Template bukan dari brand proyek ini' });
    }

    // Get max position in project
    const maxPos = await prisma.task.aggregate({
      where: { projectId },
      _max: { position: true }
    });

    const task = await prisma.task.create({
      data: {
        title: template.name,
        description: template.description,
        priority: template.priority,
        projectId,
        position: (maxPos._max.position || 0) + 1,
        checklists: template.checklists.length > 0 ? {
          create: template.checklists.map(c => ({
            content: c.content,
            position: c.position
          }))
        } : undefined
      },
      include: { assignee: true, checklists: { orderBy: { position: 'asc' } }, labels: { include: { label: true } } }
    });

    await logActivity(prisma, req, {
      action: 'created_from_template',
      entityType: 'task',
      entityId: task.id,
      projectId,
      taskId: task.id,
      metadata: { templateId: template.id, templateName: template.name }
    });

    res.json({ success: true, task });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal buat task dari template' });
  }
});

module.exports = router;
