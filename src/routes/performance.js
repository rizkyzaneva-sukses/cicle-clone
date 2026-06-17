const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');

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
  removed_label: 'menghapus label dari'
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

// Dashboard Kinerja
router.get('/', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { platformRole } = req.session.user;

    // Get accessible brands
    let brands;
    if (platformRole === 'owner') {
      brands = await prisma.company.findMany({ orderBy: { name: 'asc' } });
    } else if (platformRole === 'partner') {
      const access = await prisma.partnerAccess.findMany({
        where: { userId },
        include: { company: true }
      });
      brands = access.map(a => a.company);
    } else {
      const memberships = await prisma.membership.findMany({
        where: { userId },
        include: { company: true }
      });
      brands = memberships.map(m => m.company);
    }

    const brandIds = brands.map(b => b.id);

    // Overall stats
    const [total, done, active, overdue] = await Promise.all([
      prisma.task.count({ where: { project: { companyId: { in: brandIds } } } }),
      prisma.task.count({ where: { project: { companyId: { in: brandIds } }, status: 'DONE' } }),
      prisma.task.count({ where: { project: { companyId: { in: brandIds } }, status: { in: ['TODO', 'IN_PROGRESS'] } } }),
      prisma.task.count({ where: { project: { companyId: { in: brandIds } }, status: { in: ['TODO', 'IN_PROGRESS'] }, dueDate: { lt: new Date() } } })
    ]);

    // Per member stats
    const members = await prisma.membership.findMany({
      where: { companyId: { in: brandIds } },
      include: { user: true, company: true }
    });

    const memberStats = [];
    for (const membership of members) {
      const userTasks = await prisma.task.findMany({
        where: {
          assigneeId: membership.userId,
          project: { companyId: membership.companyId }
        },
        select: { id: true, status: true, dueDate: true }
      });

      const totalTasks = userTasks.length;
      const doneTasks = userTasks.filter(t => t.status === 'DONE').length;
      const activeTasks = userTasks.filter(t => t.status !== 'DONE').length;
      const overdueTasks = userTasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date() && t.status !== 'DONE').length;
      const completionRate = totalTasks > 0 ? Math.round(doneTasks / totalTasks * 100) : 0;

      memberStats.push({
        id: membership.user.id,
        name: membership.user.name,
        email: membership.user.email,
        brandId: membership.companyId,
        brandName: membership.company.name,
        totalTasks,
        doneTasks,
        activeTasks,
        overdueTasks,
        completionRate
      });
    }

    // Sort by completion rate desc
    memberStats.sort((a, b) => b.completionRate - a.completionRate);

    // Workload view: who's carrying the most active tasks right now
    const workloadMembers = [...memberStats].sort((a, b) => b.activeTasks - a.activeTasks);

    // Team activity feed
    const activityWhere = platformRole === 'owner' ? {} : {
      OR: [
        { project: { companyId: { in: brandIds } } },
        { task: { project: { companyId: { in: brandIds } } } }
      ]
    };
    const activityLogsRaw = await prisma.activityLog.findMany({
      where: activityWhere,
      include: {
        user: true,
        project: { select: { name: true } },
        task: { select: { title: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    const activityLogs = activityLogsRaw.map(describeActivityLog);

    res.render('performance', {
      title: 'Dashboard Kinerja',
      brands,
      stats: { total, done, active, overdue },
      members: memberStats,
      workloadMembers,
      activityLogs
    });
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal membuka dashboard kinerja');
    res.redirect('/');
  }
});

module.exports = router;
