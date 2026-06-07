const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth);

// List projects or create new
router.get('/', async (req, res) => {
  const userId = req.session.user.id;

  // Get user's companies
  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: { company: { include: { projects: true } } }
  });

  res.render('projects/index', { memberships });
});

// Create new project (Admin only)
router.post('/create', requireAdmin, async (req, res) => {
  try {
    const { name, description, companyId } = req.body;

    await prisma.project.create({
      data: {
        name,
        description: description || null,
        companyId
      }
    });

    req.flash('success', 'Proyek berhasil dibuat!');
    res.redirect('/');
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal membuat proyek');
    res.redirect('/');
  }
});

// Project detail + Kanban
router.get('/:id', async (req, res) => {
  const projectId = req.params.id;
  const userId = req.session.user.id;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      company: true,
      tasks: {
        include: { assignee: true },
        orderBy: [{ status: 'asc' }, { position: 'asc' }]
      }
    }
  });

  if (!project) {
    return res.status(404).send('Proyek tidak ditemukan');
  }

  // Get company members for assignee dropdown
  const members = await prisma.membership.findMany({
    where: { companyId: project.companyId },
    include: { user: true }
  });

  res.render('projects/kanban', { 
    project, 
    members: members.map(m => m.user),
    currentUserId: userId 
  });
});

module.exports = router;
