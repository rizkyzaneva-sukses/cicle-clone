const prisma = require('./prisma');
const { notifyUser } = require('./notify');
const { sendTelegramMessage } = require('./telegram');
const { getCompanyManagerIds } = require('./managers');

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const weekNum = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${weekNum}`;
}

let lastReportWeek = null;

// Sends a per-brand weekly performance summary to that brand's managers, every Monday.
async function maybeRunWeeklyReport(io, now = new Date()) {
  if (now.getDay() !== 1) return; // Monday only

  const week = isoWeekKey(now);
  if (lastReportWeek === week) return;
  lastReportWeek = week;

  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const companies = await prisma.company.findMany({ select: { id: true, name: true } });

  for (const company of companies) {
    const [doneCount, overdueCount, doneTasks] = await Promise.all([
      prisma.task.count({
        where: { project: { companyId: company.id }, status: 'DONE', updatedAt: { gte: sevenDaysAgo } }
      }),
      prisma.task.count({
        where: { project: { companyId: company.id }, status: { not: 'DONE' }, dueDate: { lt: now } }
      }),
      prisma.task.findMany({
        where: { project: { companyId: company.id }, status: 'DONE', updatedAt: { gte: sevenDaysAgo }, assigneeId: { not: null } },
        select: { assigneeId: true }
      })
    ]);

    if (doneCount === 0 && overdueCount === 0) continue;

    const countByAssignee = {};
    doneTasks.forEach(t => { countByAssignee[t.assigneeId] = (countByAssignee[t.assigneeId] || 0) + 1; });
    const topId = Object.keys(countByAssignee).sort((a, b) => countByAssignee[b] - countByAssignee[a])[0];
    let topLine = '';
    if (topId) {
      const top = await prisma.user.findUnique({ where: { id: topId }, select: { name: true } });
      if (top) topLine = `\n🏆 Top performer: ${top.name} (${countByAssignee[topId]} task selesai)`;
    }

    const content = `📊 Laporan Mingguan - ${company.name}\n✅ ${doneCount} task selesai minggu ini\n🔴 ${overdueCount} task overdue saat ini${topLine}`;

    const managerIds = await getCompanyManagerIds(company.id);
    for (const managerId of managerIds) {
      await notifyUser(io, managerId, content, '/performance');
      const manager = await prisma.user.findUnique({ where: { id: managerId }, select: { telegramChatId: true } });
      if (manager?.telegramChatId) await sendTelegramMessage(manager.telegramChatId, content);
    }
  }
}

module.exports = { maybeRunWeeklyReport };
