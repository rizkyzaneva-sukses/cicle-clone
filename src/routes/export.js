const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { hasProjectAccess } = require('../lib/access');

router.use(requireAuth);

// GET /export/tasks/:projectId - Export tasks to CSV or XLSX
router.get('/tasks/:projectId', async (req, res) => {
  try {
    const { format = 'csv', status, priority, assignee } = req.query;
    const project = await prisma.project.findUnique({
      where: { id: req.params.projectId },
      select: { id: true, name: true, companyId: true }
    });

    if (!project || !await hasProjectAccess(req.session.user, project)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }

    const where = { projectId: project.id };
    if (status && ['TODO', 'IN_PROGRESS', 'DONE'].includes(status)) where.status = status;
    if (priority && ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(priority)) where.priority = priority;
    if (assignee) where.assignees = { some: { id: assignee } };

    const tasks = await prisma.task.findMany({
      where,
      include: {
        assignees: { select: { name: true, email: true } },
        labels: { include: { label: true } },
        checklists: { where: { parentId: null }, include: { children: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const rows = tasks.map(t => ({
      ID: t.id,
      Title: t.title,
      Description: t.description || '',
      Status: t.status,
      Priority: t.priority,
      Assignee: (t.assignees || []).map(a => a.name).join(', '),
      'Assignee Email': (t.assignees || []).map(a => a.email).join(', '),
      'Due Date': t.dueDate ? new Date(t.dueDate).toISOString().split('T')[0] : '',
      Labels: t.labels.map(tl => tl.label.name).join(', '),
      'Checklist Done': t.checklists.filter(c => c.isDone).length,
      'Checklist Total': t.checklists.length,
      'Created At': new Date(t.createdAt).toISOString(),
      'Updated At': new Date(t.updatedAt).toISOString()
    }));

    if (format === 'xlsx') {
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Tasks');

      if (rows.length > 0) {
        sheet.columns = Object.keys(rows[0]).map(key => ({
          header: key,
          key,
          width: Math.max(key.length + 2, 15)
        }));
        rows.forEach(row => sheet.addRow(row));
      }

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${project.name}-tasks.xlsx"`);
      await workbook.xlsx.write(res);
      return res.end();
    }

    // Default: CSV
    if (rows.length === 0) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${project.name}-tasks.csv"`);
      return res.send('No tasks found');
    }

    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(','),
      ...rows.map(row => headers.map(h => {
        const val = String(row[h] || '');
        return val.includes(',') || val.includes('"') || val.includes('\n')
          ? `"${val.replace(/"/g, '""')}"` : val;
      }).join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${project.name}-tasks.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Gagal export' });
  }
});

// GET /export/my-tasks - Export my tasks
router.get('/my-tasks', async (req, res) => {
  try {
    const { format = 'csv' } = req.query;
    const userId = req.session.user.id;

    const tasks = await prisma.task.findMany({
      where: { assignees: { some: { id: userId } } },
      include: {
        project: { select: { name: true } },
        labels: { include: { label: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const rows = tasks.map(t => ({
      Title: t.title,
      Project: t.project.name,
      Status: t.status,
      Priority: t.priority,
      'Due Date': t.dueDate ? new Date(t.dueDate).toISOString().split('T')[0] : '',
      Labels: t.labels.map(tl => tl.label.name).join(', '),
      'Created At': new Date(t.createdAt).toISOString()
    }));

    if (format === 'xlsx') {
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('My Tasks');
      if (rows.length > 0) {
        sheet.columns = Object.keys(rows[0]).map(key => ({ header: key, key, width: Math.max(key.length + 2, 15) }));
        rows.forEach(row => sheet.addRow(row));
      }
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="my-tasks.xlsx"');
      await workbook.xlsx.write(res);
      return res.end();
    }

    if (rows.length === 0) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="my-tasks.csv"');
      return res.send('No tasks');
    }

    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(','),
      ...rows.map(row => headers.map(h => {
        const val = String(row[h] || '');
        return val.includes(',') || val.includes('"') || val.includes('\n')
          ? `"${val.replace(/"/g, '""')}"` : val;
      }).join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="my-tasks.csv"');
    res.send(csv);
  } catch (error) {
    console.error('Export my tasks error:', error);
    res.status(500).json({ error: 'Gagal export' });
  }
});

module.exports = router;
