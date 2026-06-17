const prisma = require('./prisma');
const { logActivity } = require('./activity');
const { notifyUser } = require('./notify');
const { ensureProjectMember } = require('./access');

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function shouldRunToday(template, now) {
  if (template.lastRunDate === dateKey(now)) return false;
  if (template.frequency === 'DAILY') return true;
  if (template.frequency === 'WEEKDAYS') return now.getDay() >= 1 && now.getDay() <= 5;
  if (template.frequency === 'WEEKLY') return now.getDay() === template.weekday;
  return false;
}

async function runRecurringTaskGenerator(io, now = new Date()) {
  const today = dateKey(now);

  const templates = await prisma.recurringTaskTemplate.findMany({
    where: { active: true },
    include: { project: { select: { id: true, name: true } } }
  });

  let generated = 0;
  for (const template of templates) {
    if (!shouldRunToday(template, now)) continue;

    const task = await prisma.task.create({
      data: {
        title: template.title,
        description: template.description,
        priority: template.priority,
        projectId: template.projectId,
        assigneeId: template.assigneeId,
        dueDate: now,
        status: 'TODO'
      }
    });

    await prisma.recurringTaskTemplate.update({
      where: { id: template.id },
      data: { lastRunDate: today }
    });

    await logActivity(prisma, { session: { user: null } }, {
      action: 'created',
      entityType: 'task',
      entityId: task.id,
      projectId: template.projectId,
      taskId: task.id,
      metadata: { title: task.title, source: 'recurring' }
    });

    if (template.assigneeId) {
      await ensureProjectMember(template.assigneeId, template.projectId);
      await notifyUser(io, template.assigneeId, `Tugas rutin baru: "${task.title}" (${template.project.name})`, `/tasks/${task.id}`);
    }

    generated++;
  }

  if (generated > 0) console.log(`[Recurring] Generated ${generated} task(s) for ${today}`);
}

module.exports = { runRecurringTaskGenerator };
