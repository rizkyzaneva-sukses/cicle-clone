const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');

router.use(requireAuth);

async function hasCompanyAccess(user, companyId) {
  if (user.platformRole === 'owner') return true;

  if (user.platformRole === 'partner') {
    const access = await prisma.partnerAccess.findUnique({
      where: { userId_companyId: { userId: user.id, companyId } }
    });
    if (access) return true;

    const brand = await prisma.company.findUnique({
      where: { id: companyId },
      select: { workspaceId: true }
    });
    if (brand?.workspaceId) {
      const workspaceAccess = await prisma.workspacePartner.findUnique({
        where: { userId_workspaceId: { userId: user.id, workspaceId: brand.workspaceId } }
      });
      if (workspaceAccess) return true;
    }
  }

  const membership = await prisma.membership.findUnique({
    where: { userId_companyId: { userId: user.id, companyId } }
  });
  return Boolean(membership);
}

// List projects or create new
router.get('/', async (req, res) => {
  const userId = req.session.user.id;
  const platformRole = req.session.user.platformRole || 'user';
  const companyId = req.query.companyId;

  let memberships = [];

  if (platformRole === 'owner') {
    const companies = await prisma.company.findMany({
      where: companyId ? { id: companyId } : {},
      include: { projects: { orderBy: { createdAt: 'desc' } } },
      orderBy: { createdAt: 'desc' }
    });
    memberships = companies.map(company => ({ role: 'owner', company }));
  } else if (platformRole === 'partner') {
    const workspaceRoles = await prisma.workspacePartner.findMany({
      where: { userId },
      include: {
        workspace: {
          include: {
            brands: { include: { projects: { orderBy: { createdAt: 'desc' } } } }
          }
        }
      }
    });
    const accesses = await prisma.partnerAccess.findMany({
      where: { userId, ...(companyId ? { companyId } : {}) },
      include: { company: { include: { projects: { orderBy: { createdAt: 'desc' } } } } }
    });
    const rows = [];
    workspaceRoles.forEach(access => {
      access.workspace.brands.forEach(company => rows.push({ role: access.role.toLowerCase(), company }));
    });
    accesses.forEach(access => rows.push({ role: 'partner', company: access.company }));
    const seen = new Set();
    memberships = rows.filter(row => {
      if (!row.company || seen.has(row.company.id)) return false;
      if (companyId && row.company.id !== companyId) return false;
      seen.add(row.company.id);
      return true;
    });
  } else {
    memberships = await prisma.membership.findMany({
      where: { userId, ...(companyId ? { companyId } : {}) },
      include: { company: { include: { projects: { orderBy: { createdAt: 'desc' } } } } }
    });
  }

  res.render('projects/index', { memberships });
});

// Create new project (Admin only)
router.post('/create', requireAdmin, async (req, res) => {
  try {
    const { name, description, companyId } = req.body;

    const project = await prisma.project.create({
      data: {
        name,
        description: description || null,
        companyId
      }
    });

    await logActivity(prisma, req, {
      action: 'created',
      entityType: 'project',
      entityId: project.id,
      projectId: project.id,
      metadata: { name: project.name }
    });

    req.flash('success', 'Proyek berhasil dibuat!');
    res.redirect('/');
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal membuat proyek');
    res.redirect('/');
  }
});

// Backward-compatible task detail URL:
// /projects/:projectId/tasks/:taskId -> /tasks/:taskId
router.get('/:projectId/tasks/:taskId', async (req, res) => {
  try {
    const { projectId, taskId } = req.params;
    const task = await prisma.task.findFirst({
      where: { id: taskId, projectId },
      select: { id: true }
    });

    if (!task) return res.status(404).send('Task tidak ditemukan');

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { companyId: true }
    });
    if (!project || !await hasCompanyAccess(req.session.user, project.companyId)) {
      return res.status(403).send('Akses ditolak');
    }

    res.redirect(`/tasks/${task.id}`);
  } catch (error) {
    console.error(error);
    res.status(500).send('Terjadi kesalahan');
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
        include: {
          assignee: true,
          labels: { include: { label: true } },
          checklists: { select: { id: true, isDone: true } }
        },
        orderBy: [{ status: 'asc' }, { position: 'asc' }]
      }
    }
  });

  if (!project) {
    return res.status(404).send('Proyek tidak ditemukan');
  }
  if (!await hasCompanyAccess(req.session.user, project.companyId)) {
    return res.status(403).send('Akses ditolak');
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
