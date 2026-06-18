const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');
const { hasCompanyAccess, hasProjectAccess, isCompanyManager } = require('../lib/access');
const { notifyUser } = require('../lib/notify');

router.use(requireAuth);

// List projects or create new
router.get('/', async (req, res) => {
  const userId = req.session.user.id;
  const platformRole = req.session.user.platformRole || 'user';
  const companyId = req.query.companyId;

  let memberships = [];

  const activeProjects = {
    where: { archivedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      projectMembers: {
        include: { user: { select: { id: true, name: true, avatar: true } } }
      },
      tasks: {
        where: { status: { not: 'DONE' }, dueDate: { not: null } },
        orderBy: { dueDate: 'asc' },
        take: 1,
        select: { dueDate: true }
      }
    }
  };

  if (platformRole === 'owner') {
    const companies = await prisma.company.findMany({
      where: companyId ? { id: companyId } : {},
      include: { projects: activeProjects },
      orderBy: { createdAt: 'desc' }
    });
    memberships = companies.map(company => ({ role: 'owner', company }));
  } else if (platformRole === 'partner') {
    const workspaceRoles = await prisma.workspacePartner.findMany({
      where: { userId },
      include: {
        workspace: {
          include: {
            brands: { include: { projects: activeProjects } }
          }
        }
      }
    });
    const accesses = await prisma.partnerAccess.findMany({
      where: { userId, ...(companyId ? { companyId } : {}) },
      include: { company: { include: { projects: activeProjects } } }
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
      include: { company: { include: { projects: activeProjects } } }
    });
  }

  // Plain "member" only sees projects they're explicitly assigned to.
  // Brand "admin" (and owner/partner above) see every project in the brand.
  memberships = memberships.map(m => {
    if (m.role === 'member') {
      return { ...m, company: { ...m.company, projects: m.company.projects.filter(p => p.projectMembers.some(pm => pm.userId === userId)) } };
    }
    return m;
  });

  const workspaceIds = [...new Set(memberships.map(m => m.company?.workspaceId).filter(Boolean))];
  const workspaceBrands = workspaceIds.length > 0
    ? await prisma.company.findMany({
        where: { workspaceId: { in: workspaceIds } },
        select: { id: true, name: true, workspaceId: true },
        orderBy: { createdAt: 'asc' }
      })
    : [];
  const manageableCompanyIds = platformRole === 'owner'
    ? memberships.map(m => m.company.id)
    : memberships.filter(m => m.role !== 'member').map(m => m.company.id);

  res.render('projects/index', { memberships, currentRole: platformRole, workspaceBrands, manageableCompanyIds });
});

// Archived projects (Owner only)
router.get('/archived', async (req, res) => {
  if (req.session.user.platformRole !== 'owner') {
    req.flash('error', 'Hanya Owner yang bisa melihat arsip proyek');
    return res.redirect('/projects');
  }

  const projects = await prisma.project.findMany({
    where: { archivedAt: { not: null } },
    include: { company: true },
    orderBy: { archivedAt: 'desc' }
  });

  res.render('projects/archived', { projects });
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
    res.redirect(`/projects/${project.id}`);
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
      select: { id: true, companyId: true }
    });
    if (!project || !await hasProjectAccess(req.session.user, project)) {
      return res.status(403).send('Akses ditolak');
    }

    res.redirect(`/tasks/${task.id}`);
  } catch (error) {
    console.error(error);
    res.status(500).send('Terjadi kesalahan');
  }
});

// Update project detail (Brand manager / Owner)
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim();

    if (!name) {
      return res.status(400).json({ error: 'Nama proyek wajib diisi' });
    }

    const project = await prisma.project.update({
      where: { id: req.params.id },
      data: {
        name,
        description: description || null
      }
    });

    await logActivity(prisma, req, {
      action: 'updated',
      entityType: 'project',
      entityId: project.id,
      projectId: project.id,
      metadata: { name: project.name, description: project.description }
    });

    res.json({ success: true, project });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal memperbarui proyek' });
  }
});

router.post('/:id/move-brand', requireAdmin, async (req, res) => {
  const targetCompanyId = String(req.body.targetCompanyId || '').trim();
  const nextUrl = String(req.body.next || req.get('referer') || '/projects');

  try {
    if (!targetCompanyId) {
      req.flash('error', 'Pilih brand tujuan dulu');
      return res.redirect(nextUrl);
    }

    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        company: { select: { id: true, name: true, workspaceId: true } },
        projectMembers: { select: { userId: true } },
        tasks: { select: { assigneeId: true } }
      }
    });
    if (!project) {
      req.flash('error', 'Proyek tidak ditemukan');
      return res.redirect(nextUrl);
    }

    if (project.companyId === targetCompanyId) {
      req.flash('error', 'Proyek sudah ada di brand itu');
      return res.redirect(nextUrl);
    }

    const targetCompany = await prisma.company.findUnique({
      where: { id: targetCompanyId },
      select: { id: true, name: true, workspaceId: true }
    });
    if (!targetCompany) {
      req.flash('error', 'Brand tujuan tidak ditemukan');
      return res.redirect(nextUrl);
    }

    if (!project.company.workspaceId || project.company.workspaceId !== targetCompany.workspaceId) {
      req.flash('error', 'Proyek hanya bisa dipindahkan ke brand lain dalam workspace yang sama');
      return res.redirect(nextUrl);
    }

    const [canManageSource, canManageTarget] = await Promise.all([
      isCompanyManager(req.session.user, project.companyId),
      isCompanyManager(req.session.user, targetCompanyId)
    ]);
    if (!canManageSource || !canManageTarget) {
      req.flash('error', 'Kamu harus punya akses kelola ke brand sumber dan tujuan');
      return res.redirect(nextUrl);
    }

    const relatedUserIds = [...new Set([
      ...project.projectMembers.map(member => member.userId),
      ...project.tasks.map(task => task.assigneeId).filter(Boolean)
    ])];

    await prisma.$transaction(async (tx) => {
      if (relatedUserIds.length > 0) {
        const workspaceMembers = await tx.membership.findMany({
          where: {
            userId: { in: relatedUserIds },
            company: { workspaceId: targetCompany.workspaceId }
          },
          select: { userId: true },
          distinct: ['userId']
        });

        if (workspaceMembers.length > 0) {
          await tx.membership.createMany({
            data: workspaceMembers.map(member => ({
              userId: member.userId,
              companyId: targetCompany.id,
              role: 'member'
            })),
            skipDuplicates: true
          });
        }
      }

      await tx.project.update({
        where: { id: project.id },
        data: { companyId: targetCompany.id }
      });
    });

    await logActivity(prisma, req, {
      action: 'moved_brand',
      entityType: 'project',
      entityId: project.id,
      projectId: project.id,
      metadata: {
        name: project.name,
        fromCompany: project.company.name,
        toCompany: targetCompany.name
      }
    });

    req.flash('success', `Proyek "${project.name}" dipindahkan ke brand "${targetCompany.name}"`);
    res.redirect(nextUrl);
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal memindahkan proyek ke brand lain');
    res.redirect(nextUrl);
  }
});

// Gantt Chart View
router.get('/:id/gantt', async (req, res) => {
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
          checklists: { select: { id: true, content: true, isDone: true } }
        },
        orderBy: [{ status: 'asc' }, { position: 'asc' }]
      }
    }
  });

  if (!project) {
    return res.status(404).send('Proyek tidak ditemukan');
  }
  if (!await hasProjectAccess(req.session.user, project)) {
    return res.status(403).send('Akses ditolak');
  }

  const members = await prisma.membership.findMany({
    where: { companyId: project.companyId },
    include: { user: true }
  });

  res.render('projects/gantt', {
    project,
    members: members.map(m => m.user),
    currentUserId: userId
  });
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
          checklists: { select: { id: true, content: true, isDone: true } },
          children: { select: { id: true } }
        },
        orderBy: [{ status: 'asc' }, { position: 'asc' }]
      }
    }
  });

  if (!project) {
    return res.status(404).send('Proyek tidak ditemukan');
  }
  if (!await hasProjectAccess(req.session.user, project)) {
    return res.status(403).send('Akses ditolak');
  }

  // Get company members for assignee dropdown + project members for access management
  const [members, projectMembers, recurringTemplates, allProjects] = await Promise.all([
    prisma.membership.findMany({
      where: { companyId: project.companyId },
      include: { user: true }
    }),
    prisma.projectMember.findMany({
      where: { projectId },
      include: { user: true }
    }),
    prisma.recurringTaskTemplate.findMany({
      where: { projectId },
      include: { assignee: true },
      orderBy: { createdAt: 'desc' }
    }),
    // All projects in the same company for bulk move dropdown
    prisma.project.findMany({
      where: { companyId: project.companyId, archivedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' }
    })
  ]);

  // Calculate health score
  const { calculateProjectHealthScore, getHealthIndicator, getHealthStatus } = require('../lib/health');
  const healthData = await calculateProjectHealthScore(projectId);

  res.render('projects/kanban', {
    project,
    members: members.map(m => m.user),
    projectMembers,
    recurringTemplates,
    currentUserId: userId,
    healthScore: healthData.score,
    healthBreakdown: healthData.breakdown,
    healthIndicator: getHealthIndicator(healthData.score),
    healthStatus: getHealthStatus(healthData.score),
    projects: allProjects
  });
});

// Archive project (Brand manager / Owner)
router.post('/:id/archive', requireAdmin, async (req, res) => {
  try {
    const project = await prisma.project.update({
      where: { id: req.params.id },
      data: { archivedAt: new Date() }
    });

    await logActivity(prisma, req, {
      action: 'archived',
      entityType: 'project',
      entityId: project.id,
      projectId: project.id,
      metadata: { name: project.name }
    });

    req.flash('success', `Proyek "${project.name}" diarsipkan`);
    res.redirect('/projects');
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal mengarsipkan proyek');
    res.redirect('back');
  }
});

// Restore project from archive (Owner only)
router.post('/:id/unarchive', async (req, res) => {
  try {
    if (req.session.user.platformRole !== 'owner') {
      req.flash('error', 'Hanya Owner yang bisa memulihkan proyek');
      return res.redirect('/projects/archived');
    }

    const project = await prisma.project.update({
      where: { id: req.params.id },
      data: { archivedAt: null }
    });

    await logActivity(prisma, req, {
      action: 'unarchived',
      entityType: 'project',
      entityId: project.id,
      projectId: project.id,
      metadata: { name: project.name }
    });

    req.flash('success', `Proyek "${project.name}" dipulihkan`);
    res.redirect('/projects/archived');
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal memulihkan proyek');
    res.redirect('/projects/archived');
  }
});

// Permanently delete project (Owner only, must be archived first)
router.delete('/:id', async (req, res) => {
  try {
    if (req.session.user.platformRole !== 'owner') {
      return res.status(403).json({ error: 'Hanya Owner yang bisa menghapus permanen' });
    }

    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) {
      return res.status(404).json({ error: 'Proyek tidak ditemukan' });
    }
    if (!project.archivedAt) {
      return res.status(400).json({ error: 'Proyek harus diarsipkan dulu sebelum dihapus permanen' });
    }

    await logActivity(prisma, req, {
      action: 'deleted',
      entityType: 'project',
      entityId: project.id,
      projectId: project.id,
      metadata: { name: project.name }
    });

    await prisma.project.delete({ where: { id: project.id } });

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal menghapus proyek' });
  }
});

// Add a brand member to this project's access list (Brand manager / Owner)
router.post('/:id/members', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return res.status(404).json({ error: 'Proyek tidak ditemukan' });

    const membership = await prisma.membership.findUnique({
      where: { userId_companyId: { userId, companyId: project.companyId } },
      include: { user: true }
    });
    if (!membership) return res.status(400).json({ error: 'User bukan anggota brand ini' });

    const projectMember = await prisma.projectMember.upsert({
      where: { userId_projectId: { userId, projectId: project.id } },
      update: {},
      create: { userId, projectId: project.id },
      include: { user: true }
    });

    if (userId !== req.session.user.id) {
      try {
        await notifyUser(req.app.get('io'), userId, `Kamu ditambahkan ke proyek "${project.name}"`, `/projects/${project.id}`);
      } catch (notifyError) {
        console.error('Project member notify failed:', notifyError.message);
      }
    }

    res.json({ success: true, member: projectMember });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal menambah anggota proyek' });
  }
});

// Remove a member's access to this project (Brand manager / Owner)
router.delete('/:id/members/:userId', requireAdmin, async (req, res) => {
  try {
    await prisma.projectMember.delete({
      where: { userId_projectId: { userId: req.params.userId, projectId: req.params.id } }
    }).catch(() => {});
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal menghapus anggota proyek' });
  }
});

// Create a recurring task template (Brand manager / Owner)
router.post('/:id/recurring', requireAdmin, async (req, res) => {
  try {
    const { title, description, priority, assigneeId, frequency, weekday } = req.body;
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return res.status(404).json({ error: 'Proyek tidak ditemukan' });
    if (!title || !frequency) return res.status(400).json({ error: 'Judul dan frekuensi wajib diisi' });

    const template = await prisma.recurringTaskTemplate.create({
      data: {
        title,
        description: description || null,
        priority: priority || 'NONE',
        projectId: project.id,
        assigneeId: assigneeId || null,
        frequency,
        weekday: frequency === 'WEEKLY' && weekday !== undefined && weekday !== '' ? parseInt(weekday) : null
      },
      include: { assignee: true }
    });

    res.json({ success: true, template });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal membuat tugas berulang' });
  }
});

// Pause/resume a recurring task template (Brand manager / Owner)
router.post('/:id/recurring/:templateId/toggle', requireAdmin, async (req, res) => {
  try {
    const template = await prisma.recurringTaskTemplate.findUnique({ where: { id: req.params.templateId } });
    if (!template || template.projectId !== req.params.id) return res.status(404).json({ error: 'Template tidak ditemukan' });

    const updated = await prisma.recurringTaskTemplate.update({
      where: { id: template.id },
      data: { active: !template.active }
    });

    res.json({ success: true, active: updated.active });
  } catch (error) {
    res.status(500).json({ error: 'Gagal update tugas berulang' });
  }
});

// Delete a recurring task template (Brand manager / Owner)
router.delete('/:id/recurring/:templateId', requireAdmin, async (req, res) => {
  try {
    await prisma.recurringTaskTemplate.deleteMany({
      where: { id: req.params.templateId, projectId: req.params.id }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Gagal menghapus tugas berulang' });
  }
});

module.exports = router;
