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
  const templates = await prisma.recurringTaskTemplate.findMany({
    where: { active: true },
    include: { project: { select: { id: true, name: true } } }
  });

  let generated = 0;
  for (const template of templates) {
    const task = await generateRecurringTask(template, io, now);
    if (task) generated++;
  }

  if (generated > 0) console.log(`[Recurring] Generated ${generated} task(s) for ${dateKey(now)}`);

  return generated;
}

async function generateRecurringTask(template, io, now = new Date()) {
  if (!shouldRunToday(template, now)) return null;

  const today = dateKey(now);
  const task = await prisma.$transaction(async (tx) => {
    // Claim this template/day before creating the task so scheduler and HTTP requests
    // cannot generate the same recurring task concurrently.
    const claimed = await tx.recurringTaskTemplate.updateMany({
      where: {
        id: template.id,
        active: true,
        OR: [
          { lastRunDate: null },
          { lastRunDate: { not: today } }
        ]
      },
      data: { lastRunDate: today }
    });
    if (claimed.count === 0) return null;

    return tx.task.create({
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
  });

  if (!task) return null;

  try {
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
  } catch (error) {
    console.error('Recurring task post-create action failed:', error.message);
  }

  return task;
}

module.exports = { generateRecurringTask, runRecurringTaskGenerator };
