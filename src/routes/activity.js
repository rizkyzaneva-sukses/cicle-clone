const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { hasProjectAccess } = require('../lib/access');

router.use(requireAuth);

const ACTIVITY_ACTION_LABELS = {
  created: 'membuat',
  updated: 'mengupdate',
  status_changed: 'mengubah status',
  deleted: 'menghapus',
  archived: 'mengarsipkan',
  unarchived: 'memulihkan',
  commented: 'mengomentari',
  added_checklist: 'menambah checklist di',
  completed_checklist: 'menyelesaikan checklist di',
  reopened_checklist: 'membuka kembali checklist di',
  deleted_checklist: 'menghapus checklist di',
  uploaded_attachment: 'mengunggah file ke',
  added_label: 'menambah label ke',
  removed_label: 'menghapus label dari',
  assigned: 'ditugaskan ke',
  unassigned: 'dihapus dari',
  set_due_date: 'atur deadline',
  cleared_due_date: 'hapus deadline',
  priority_changed: 'ubah prioritas',
  focus_session: 'menyelesaikan sesi fokus',
  created_template: 'membuat template dari',
  created_from_template: 'membuat task dari template',
  progress_updated: 'memperbarui progress',
  progress_deleted: 'menghapus progress',
  moved: 'memindahkan task'
};

const ACTIVITY_ENTITY_LABELS = {
  project: 'proyek',
  task: 'tugas',
  workspace: 'workspace'
};

function describeActivityLog(log) {
  const target = log.project?.name || log.task?.title || log.metadata?.name || log.metadata?.title || '(tidak ada nama)';
  return {
    id: log.id,
    actor: log.user?.name || 'System',
    actionLabel: ACTIVITY_ACTION_LABELS[log.action] || log.action.replace(/_/g, ' '),
    entityLabel: ACTIVITY_ENTITY_LABELS[log.entityType] || log.entityType,
    target,
    createdAt: log.createdAt
  };
}

function getDateGroup(date) {
  const now = new Date();
  const d = new Date(date);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday); startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfWeek = new Date(startOfToday); startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

  if (d >= startOfToday) return 'Hari Ini';
  if (d >= startOfYesterday) return 'Kemarin';
  if (d >= startOfWeek) return 'Minggu Ini';
  if (d >= new Date(startOfWeek.getTime() - 7 * 86400000)) return 'Minggu Lalu';
  return d.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
}

// GET /activity — Activity Log page
router.get('/', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { platformRole } = req.session.user;

    // Get accessible brands based on role
    let brands;
    if (platformRole === 'owner') {
      brands = await prisma.company.findMany({ orderBy: { name: 'asc' } });
    } else if (platformRole === 'partner') {
      const access = await prisma.partnerAccess.findMany({ where: { userId }, include: { company: true } });
      brands = access.map(a => a.company);
    } else {
      const memberships = await prisma.membership.findMany({ where: { userId }, include: { company: true } });
      brands = memberships.map(m => m.company);
    }

    const brandIds = brands.map(b => b.id);

    // Filter by brand (from query param)
    const selectedBrand = req.query.brand || 'ALL';

    // Build where clause
    let activityWhere = {};
    if (platformRole === 'owner' && selectedBrand === 'ALL') {
      activityWhere = {};
    } else if (selectedBrand !== 'ALL') {
      activityWhere = {
        OR: [
          { project: { companyId: selectedBrand } },
          { task: { project: { companyId: selectedBrand } } }
        ]
      };
    } else {
      activityWhere = {
        OR: [
          { project: { companyId: { in: brandIds } } },
          { task: { project: { companyId: { in: brandIds } } } }
        ]
      };
    }

    // Pagination
    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const skip = (page - 1) * limit;

    const [activityLogsRaw, totalCount] = await Promise.all([
      prisma.activityLog.findMany({
        where: activityWhere,
        include: {
          user: true,
          project: { select: { name: true, companyId: true } },
          task: { select: { title: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.activityLog.count({ where: activityWhere })
    ]);

    const activityLogs = activityLogsRaw.map(describeActivityLog);

    // Group by date
    const groups = {};
    activityLogs.forEach(log => {
      const group = getDateGroup(log.createdAt);
      if (!groups[group]) groups[group] = [];
      groups[group].push(log);
    });

    const totalPages = Math.ceil(totalCount / limit);

    res.render('activity', {
      title: 'Aktivitas Tim',
      brands,
      selectedBrand,
      activityGroups: groups,
      currentPage: page,
      totalPages,
      totalCount
    });
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal membuka halaman aktivitas');
    res.redirect('/');
  }
});

// GET /activity/timeline — Enhanced timeline view with filters
router.get('/timeline', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { platformRole } = req.session.user;
    const { project: filterProject, user: filterUser, date: filterDate } = req.query;

    // Get accessible brands
    let brands;
    if (platformRole === 'owner') {
      brands = await prisma.company.findMany({ orderBy: { name: 'asc' } });
    } else {
      const memberships = await prisma.membership.findMany({ where: { userId }, include: { company: true } });
      brands = memberships.map(m => m.company);
    }
    const brandIds = brands.map(b => b.id);

    // Get projects for filter dropdown
    const projects = await prisma.project.findMany({
      where: { companyId: { in: brandIds }, archivedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' }
    });

    // Get users for filter dropdown
    const users = await prisma.user.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' }
    });

    // Build where clause
    const where = {
      OR: [
        { project: { companyId: { in: brandIds } } },
        { task: { project: { companyId: { in: brandIds } } } }
      ]
    };
    if (filterProject) {
      where.AND = [{ projectId: filterProject }];
    }
    if (filterUser) {
      where.userId = filterUser;
    }
    if (filterDate) {
      const dayStart = new Date(filterDate);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      where.createdAt = { gte: dayStart, lt: dayEnd };
    }

    const logs = await prisma.activityLog.findMany({
      where,
      include: {
        user: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
        task: { select: { id: true, title: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 200
    });

    res.render('activity/timeline', {
      title: 'Activity Timeline',
      logs,
      projects,
      users,
      brands,
      filterProject: filterProject || '',
      filterUser: filterUser || '',
      filterDate: filterDate || ''
    });
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal membuka timeline');
    res.redirect('/activity');
  }
});

module.exports = router;
