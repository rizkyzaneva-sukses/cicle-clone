const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');
const { hasCompanyAccess, hasProjectAccess, isCompanyManager } = require('../lib/access');
const { notifyUser } = require('../lib/notify');
const { generateRecurringTask } = require('../lib/recurringTasks');

router.use(requireAuth);

const DEFAULT_REPORT_COLUMNS = [
  { key: 'target', label: 'Target', type: 'number' },
  { key: 'generate', label: 'Generate', type: 'number' },
  { key: 'upload', label: 'Upload', type: 'number' }
];

function normalizeReportColumns(rawColumns) {
  const cleaned = Array.isArray(rawColumns)
    ? rawColumns.filter(column => {
        const label = String(column?.label || '').trim();
        const key = String(column?.key || '').trim();
        return Boolean(label || key);
      })
    : [];
  const source = cleaned.length > 0 ? cleaned : DEFAULT_REPORT_COLUMNS;
  const seen = new Set();

  return source.map((column, index) => {
    const label = String(column?.label || column?.key || `Kolom ${index + 1}`).trim().slice(0, 40);
    const fallbackKey = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `metric_${index + 1}`;
    let key = String(column?.key || fallbackKey).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || `metric_${index + 1}`;
    if (seen.has(key)) key = `${key}_${index + 1}`;
    seen.add(key);
    return {
      key,
      label: label || `Kolom ${index + 1}`,
      type: column?.type === 'text' ? 'text' : 'number'
    };
  }).slice(0, 8);
}

function startOfDay(date = new Date()) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function endOfDay(date = new Date()) {
  const value = new Date(date);
  value.setHours(23, 59, 59, 999);
  return value;
}

function toDateInputValue(date = new Date()) {
  const value = new Date(date);
  value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
  return value.toISOString().slice(0, 10);
}

function sumMetrics(entries, columns) {
  const totals = Object.fromEntries(columns.map(column => [column.key, 0]));
  entries.forEach(entry => {
    const values = entry.values || {};
    columns.forEach(column => {
      totals[column.key] += Number(values[column.key] || 0);
    });
  });
  return totals;
}

function buildTrendData(entries, columns, daysBack) {
  const columnKeys = columns.map(column => column.key);
  const grouped = new Map();

  entries.forEach(entry => {
    const key = new Date(entry.reportDate).toISOString().slice(0, 10);
    if (!grouped.has(key)) {
      grouped.set(key, { date: key, values: Object.fromEntries(columnKeys.map(metric => [metric, 0])) });
    }
    const bucket = grouped.get(key);
    columnKeys.forEach(metric => {
      bucket.values[metric] += Number(entry.values?.[metric] || 0);
    });
  });

  const rows = [];
  for (let offset = daysBack - 1; offset >= 0; offset--) {
    const date = startOfDay(new Date());
    date.setDate(date.getDate() - offset);
    const key = date.toISOString().slice(0, 10);
    rows.push(grouped.get(key) || { date: key, values: Object.fromEntries(columnKeys.map(metric => [metric, 0])) });
  }
  return rows;
}

function buildBreakdown(entries, columns, workspaceBrands) {
  const brandsById = new Map(workspaceBrands.map(brand => [brand.id, brand]));
  const rows = new Map();

  entries.forEach(entry => {
    const brandKey = entry.companyId || 'project_total';
    if (!rows.has(brandKey)) {
      const brand = entry.companyId ? brandsById.get(entry.companyId) : null;
      rows.set(brandKey, {
        companyId: entry.companyId || '',
        label: brand?.name || 'Tanpa Breakdown Brand',
        values: Object.fromEntries(columns.map(column => [column.key, 0])),
        count: 0
      });
    }
    const row = rows.get(brandKey);
    row.count += 1;
    columns.forEach(column => {
      row.values[column.key] += Number(entry.values?.[column.key] || 0);
    });
  });

  return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label, 'id'));
}

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

router.get('/:id/report/export.csv', async (req, res) => {
  try {
    const companyFilter = String(req.query.companyId || '').trim();
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { company: true }
    });
    if (!project || !await hasProjectAccess(req.session.user, project)) {
      return res.status(403).send('Akses ditolak');
    }

    const config = await prisma.projectReportConfig.findUnique({ where: { projectId: project.id } });
    const columns = normalizeReportColumns(config?.columns);
    const workspaceBrands = project.company.workspaceId
      ? await prisma.company.findMany({
          where: { workspaceId: project.company.workspaceId },
          select: { id: true, name: true },
          orderBy: { createdAt: 'asc' }
        })
      : [];
    const brandsById = new Map(workspaceBrands.map(brand => [brand.id, brand.name]));

    const entries = await prisma.projectReportEntry.findMany({
      where: {
        projectId: project.id,
        ...(companyFilter ? { companyId: companyFilter } : {})
      },
      orderBy: [{ reportDate: 'asc' }, { createdAt: 'asc' }]
    });

    const header = ['Tanggal', 'Brand', ...columns.map(column => column.label), 'Catatan'];
    const rows = entries.map(entry => {
      const values = entry.values || {};
      return [
        new Date(entry.reportDate).toISOString().slice(0, 10),
        entry.companyId ? (brandsById.get(entry.companyId) || '-') : '',
        ...columns.map(column => String(values[column.key] ?? 0)),
        String(entry.note || '')
      ];
    });

    const csv = [header, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report-${project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error(error);
    res.status(500).send('Gagal export report');
  }
});

router.post('/:id/report/config', requireAdmin, async (req, res) => {
  try {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) {
      req.flash('error', 'Proyek tidak ditemukan');
      return res.redirect('/projects');
    }

    const labels = (Array.isArray(req.body.columnLabels)
      ? req.body.columnLabels
      : req.body.columnLabels ? [req.body.columnLabels] : [])
      .map(label => String(label || '').trim())
      .filter(Boolean);
    const columns = normalizeReportColumns(labels.map(label => ({ label, type: 'number' })));

    await prisma.projectReportConfig.upsert({
      where: { projectId: project.id },
      update: { columns },
      create: { projectId: project.id, columns }
    });

    req.flash('success', 'Kolom report project berhasil diperbarui');
    res.redirect(`/projects/${project.id}/report`);
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal menyimpan konfigurasi report');
    res.redirect(`/projects/${req.params.id}/report`);
  }
});

router.post('/:id/report/entries', async (req, res) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { company: true }
    });
    if (!project || !await hasProjectAccess(req.session.user, project)) {
      req.flash('error', 'Akses ditolak');
      return res.redirect('/projects');
    }

    const config = await prisma.projectReportConfig.findUnique({ where: { projectId: project.id } });
    const columns = normalizeReportColumns(config?.columns);
    const reportDateRaw = String(req.body.reportDate || '').trim();
    if (!reportDateRaw) {
      req.flash('error', 'Tanggal report wajib diisi');
      return res.redirect(`/projects/${project.id}/report`);
    }

    const reportDate = new Date(`${reportDateRaw}T00:00:00`);
    if (Number.isNaN(reportDate.getTime())) {
      req.flash('error', 'Tanggal report tidak valid');
      return res.redirect(`/projects/${project.id}/report`);
    }

    const companyId = String(req.body.companyId || '').trim() || null;
    if (companyId) {
      const targetCompany = await prisma.company.findUnique({
        where: { id: companyId },
        select: { workspaceId: true }
      });
      if (!targetCompany || targetCompany.workspaceId !== project.company.workspaceId) {
        req.flash('error', 'Brand breakdown harus berasal dari workspace yang sama');
        return res.redirect(`/projects/${project.id}/report`);
      }
    }

    const values = {};
    columns.forEach(column => {
      const rawValue = req.body[`metric_${column.key}`];
      values[column.key] = column.type === 'number' ? Number(rawValue || 0) : String(rawValue || '').trim();
      if (column.type === 'number' && Number.isNaN(values[column.key])) values[column.key] = 0;
    });

    const entry = await prisma.projectReportEntry.create({
      data: {
        projectId: project.id,
        reportDate,
        companyId,
        values,
        note: String(req.body.note || '').trim() || null,
        createdById: req.session.user.id
      }
    });

    await logActivity(prisma, req, {
      action: 'project_report_added',
      entityType: 'project_report_entry',
      entityId: entry.id,
      projectId: project.id,
      metadata: { reportDate: reportDateRaw, companyId, values }
    });

    req.flash('success', 'Data progres harian berhasil ditambahkan');
    res.redirect(`/projects/${project.id}/report`);
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal menyimpan data report');
    res.redirect(`/projects/${req.params.id}/report`);
  }
});

router.post('/:id/report/entries/:entryId/edit', requireAdmin, async (req, res) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { company: true }
    });
    const entry = await prisma.projectReportEntry.findUnique({
      where: { id: req.params.entryId },
      select: { id: true, projectId: true }
    });
    if (!project || !entry || entry.projectId !== project.id) {
      req.flash('error', 'Data report tidak ditemukan');
      return res.redirect(`/projects/${req.params.id}/report`);
    }

    const reportDateRaw = String(req.body.reportDate || '').trim();
    const reportDate = new Date(`${reportDateRaw}T00:00:00`);
    if (!reportDateRaw || Number.isNaN(reportDate.getTime())) {
      req.flash('error', 'Tanggal report tidak valid');
      return res.redirect(`/projects/${project.id}/report`);
    }

    const companyId = String(req.body.companyId || '').trim() || null;
    if (companyId) {
      const targetCompany = await prisma.company.findUnique({
        where: { id: companyId },
        select: { workspaceId: true }
      });
      if (!targetCompany || targetCompany.workspaceId !== project.company.workspaceId) {
        req.flash('error', 'Brand breakdown harus berasal dari workspace yang sama');
        return res.redirect(`/projects/${project.id}/report`);
      }
    }

    const config = await prisma.projectReportConfig.findUnique({ where: { projectId: project.id } });
    const columns = normalizeReportColumns(config?.columns);
    const values = {};
    columns.forEach(column => {
      const rawValue = req.body[`metric_${column.key}`];
      values[column.key] = column.type === 'number' ? Number(rawValue || 0) : String(rawValue || '').trim();
      if (column.type === 'number' && Number.isNaN(values[column.key])) values[column.key] = 0;
    });

    await prisma.projectReportEntry.update({
      where: { id: entry.id },
      data: {
        reportDate,
        companyId,
        values,
        note: String(req.body.note || '').trim() || null
      }
    });

    await logActivity(prisma, req, {
      action: 'project_report_updated',
      entityType: 'project_report_entry',
      entityId: entry.id,
      projectId: project.id,
      metadata: { reportDate: reportDateRaw, companyId, values }
    });

    req.flash('success', 'Data report berhasil diperbarui');
    res.redirect(`/projects/${project.id}/report`);
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal memperbarui data report');
    res.redirect(`/projects/${req.params.id}/report`);
  }
});

router.post('/:id/report/entries/:entryId/delete', requireAdmin, async (req, res) => {
  try {
    const entry = await prisma.projectReportEntry.findUnique({
      where: { id: req.params.entryId },
      select: { id: true, projectId: true }
    });
    if (!entry || entry.projectId !== req.params.id) {
      req.flash('error', 'Data report tidak ditemukan');
      return res.redirect(`/projects/${req.params.id}/report`);
    }

    await prisma.projectReportEntry.delete({ where: { id: entry.id } });

    await logActivity(prisma, req, {
      action: 'project_report_deleted',
      entityType: 'project_report_entry',
      entityId: entry.id,
      projectId: req.params.id
    });

    req.flash('success', 'Data report berhasil dihapus');
    res.redirect(`/projects/${req.params.id}/report`);
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal menghapus data report');
    res.redirect(`/projects/${req.params.id}/report`);
  }
});

router.get('/:id/report', async (req, res) => {
  try {
    const projectId = req.params.id;
    const userId = req.session.user.id;
    const daysBack = Math.max(7, Math.min(90, parseInt(req.query.days, 10) || 14));
    const companyFilter = String(req.query.companyId || '').trim();

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { company: true }
    });
    if (!project) return res.status(404).send('Proyek tidak ditemukan');
    if (!await hasProjectAccess(req.session.user, project)) return res.status(403).send('Akses ditolak');

    const canManageProject = await isCompanyManager(req.session.user, project.companyId);
    const config = await prisma.projectReportConfig.findUnique({ where: { projectId } });
    const columns = normalizeReportColumns(config?.columns);
    const workspaceBrands = project.company.workspaceId
      ? await prisma.company.findMany({
          where: { workspaceId: project.company.workspaceId },
          select: { id: true, name: true },
          orderBy: { createdAt: 'asc' }
        })
      : [{ id: project.company.id, name: project.company.name }];

    const where = {
      projectId,
      ...(companyFilter ? { companyId: companyFilter } : {})
    };

    const entries = await prisma.projectReportEntry.findMany({
      where,
      include: {
        company: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } }
      },
      orderBy: [{ reportDate: 'desc' }, { createdAt: 'desc' }]
    });

    const trendCutoff = startOfDay(new Date());
    trendCutoff.setDate(trendCutoff.getDate() - (daysBack - 1));
    const trendEntries = entries.filter(entry => new Date(entry.reportDate) >= trendCutoff);

    const todayStart = startOfDay();
    const todayEnd = endOfDay();
    const weekStart = startOfDay();
    weekStart.setDate(weekStart.getDate() - 6);
    const monthStart = startOfDay();
    monthStart.setDate(monthStart.getDate() - 29);

    const todayEntries = entries.filter(entry => {
      const date = new Date(entry.reportDate);
      return date >= todayStart && date <= todayEnd;
    });
    const weekEntries = entries.filter(entry => new Date(entry.reportDate) >= weekStart);
    const monthEntries = entries.filter(entry => new Date(entry.reportDate) >= monthStart);

    const summary = {
      today: sumMetrics(todayEntries, columns),
      week: sumMetrics(weekEntries, columns),
      month: sumMetrics(monthEntries, columns)
    };

    const trendData = buildTrendData(trendEntries, columns, daysBack);
    const breakdownRows = buildBreakdown(monthEntries, columns, workspaceBrands);

    res.render('projects/report', {
      title: `${project.name} | Report`,
      project,
      currentUserId: userId,
      canManageProject,
      columns,
      entries,
      summary,
      trendData,
      breakdownRows,
      workspaceBrands,
      daysBack,
      activeCompanyId: companyFilter,
      todayIso: toDateInputValue()
    });
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal membuka report proyek');
    res.redirect(`/projects/${req.params.id}`);
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
      include: {
        assignee: true,
        project: { select: { id: true, name: true } }
      }
    });

    const generatedTask = await generateRecurringTask(template, req.app.get('io'));

    res.json({ success: true, template, generatedTask });
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
