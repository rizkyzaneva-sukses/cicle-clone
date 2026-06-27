const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// Get dependencies for a task
router.get('/task/:taskId', async (req, res) => {
  try {
    const deps = await prisma.taskDependency.findMany({
      where: { taskId: req.params.taskId },
      include: { dependsOn: { select: { id: true, title: true, status: true } } }
    });
    const blockedBy = await prisma.taskDependency.findMany({
      where: { dependsOnId: req.params.taskId },
      include: { task: { select: { id: true, title: true, status: true } } }
    });
    res.json({ deps, blockedBy });
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengambil dependencies' });
  }
});

// Add dependency
router.post('/task/:taskId', async (req, res) => {
  try {
    const { dependsOnId } = req.body;
    if (req.params.taskId === dependsOnId) return res.status(400).json({ error: 'Task tidak bisa bergantung pada diri sendiri' });

    const dep = await prisma.taskDependency.create({
      data: { taskId: req.params.taskId, dependsOnId },
      include: { dependsOn: { select: { id: true, title: true, status: true } } }
    });
    res.json({ success: true, dep });
  } catch (error) {
    if (error.code === 'P2002') return res.status(400).json({ error: 'Sudah ada dependency ini' });
    res.status(500).json({ error: 'Gagal tambah dependency' });
  }
});

// Remove dependency
router.delete('/:id', async (req, res) => {
  try {
    await prisma.taskDependency.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Gagal hapus dependency' });
  }
});

// Dependency graph visualization page
router.get('/graph/:projectId', async (req, res) => {
  try {
    const { hasProjectAccess } = require('../lib/access');
    const project = await prisma.project.findUnique({
      where: { id: req.params.projectId },
      select: { id: true, companyId: true, name: true }
    });

    if (!project || !await hasProjectAccess(req.session.user, project)) {
      return res.status(403).send('Akses ditolak');
    }

    // Get all tasks with dependencies in this project
    const tasks = await prisma.task.findMany({
      where: { projectId: project.id },
      select: { id: true, title: true, status: true, priority: true },
      orderBy: { createdAt: 'asc' }
    });

    const deps = await prisma.taskDependency.findMany({
      where: {
        OR: [
          { task: { projectId: project.id } },
          { dependsOn: { projectId: project.id } }
        ]
      },
      include: {
        task: { select: { id: true, title: true, status: true } },
        dependsOn: { select: { id: true, title: true, status: true } }
      }
    });

    // Only include tasks that have dependencies
    const taskIdsWithDeps = new Set();
    deps.forEach(d => {
      taskIdsWithDeps.add(d.taskId);
      taskIdsWithDeps.add(d.dependsOnId);
    });

    const filteredTasks = tasks.filter(t => taskIdsWithDeps.has(t.id));

    res.render('tasks/dependencies', {
      title: `Dependencies - ${project.name}`,
      projectId: project.id,
      projectName: project.name,
      tasks: filteredTasks,
      deps
    });
  } catch (error) {
    console.error('Dependency graph error:', error);
    req.flash('error', 'Gagal membuka dependency graph');
    res.redirect('/projects');
  }
});

module.exports = router;
