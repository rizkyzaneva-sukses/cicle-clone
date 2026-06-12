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

module.exports = router;
