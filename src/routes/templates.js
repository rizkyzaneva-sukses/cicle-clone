const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// Get templates for a brand
router.get('/brand/:companyId', async (req, res) => {
  try {
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

    const template = await prisma.taskTemplate.create({
      data: {
        name,
        description: description || null,
        priority: priority || 'NONE',
        companyId,
        checklists: checklists && checklists.length > 0 ? {
          create: checklists.map((c, i) => ({ content: c, position: i }))
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

// Delete template
router.delete('/:id', async (req, res) => {
  try {
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

    const template = await prisma.taskTemplate.findUnique({
      where: { id: req.params.id },
      include: { checklists: { orderBy: { position: 'asc' } } }
    });
    if (!template) return res.status(404).json({ error: 'Template tidak ditemukan' });

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

    res.json({ success: true, task });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal buat task dari template' });
  }
});

module.exports = router;
