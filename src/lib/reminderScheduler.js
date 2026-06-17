const prisma = require('./prisma');
const { sendTelegramMessage } = require('./telegram');
const { notifyUser } = require('./notify');

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

// Whole-day difference between two dates, ignoring time-of-day (local server time).
function daysBetween(from, to) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const utcFrom = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const utcTo = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((utcTo - utcFrom) / msPerDay);
}

function bucketFor(daysUntilDue) {
  if (daysUntilDue === 2) return 'H-2';
  if (daysUntilDue === 1) return 'H-1';
  if (daysUntilDue === 0) return 'H';
  if (daysUntilDue < 0) return 'OVERDUE';
  return null;
}

function messageFor(bucket, task, daysOverdue) {
  const due = new Date(task.dueDate).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const where = `${task.project.name} • ${task.project.company.name}`;
  switch (bucket) {
    case 'H-2': return `⏰ Reminder: tugas "${task.title}" (${where}) deadline 2 hari lagi, ${due}.`;
    case 'H-1': return `⏰ Reminder: tugas "${task.title}" (${where}) deadline besok, ${due}.`;
    case 'H': return `🔴 Reminder: tugas "${task.title}" (${where}) deadline HARI INI, ${due}.`;
    case 'OVERDUE': return `🚨 Tugas "${task.title}" (${where}) sudah lewat deadline (${due}), ${daysOverdue} hari lalu, dan masih belum selesai.`;
    default: return '';
  }
}

async function runDailyReminders(io) {
  const now = new Date();
  const today = dateKey(now);

  const tasks = await prisma.task.findMany({
    where: { status: { not: 'DONE' }, dueDate: { not: null }, assigneeId: { not: null } },
    include: { assignee: true, project: { include: { company: true } } }
  });

  let sent = 0;
  for (const task of tasks) {
    const daysUntilDue = daysBetween(now, new Date(task.dueDate));
    const bucket = bucketFor(daysUntilDue);
    if (!bucket) continue;

    const alreadySent = await prisma.telegramReminderLog.findUnique({
      where: { taskId_bucket_sentDate: { taskId: task.id, bucket, sentDate: today } }
    });
    if (alreadySent) continue;

    const content = messageFor(bucket, task, -daysUntilDue);

    await notifyUser(io, task.assigneeId, content, `/tasks/${task.id}`);
    if (task.assignee?.telegramChatId) {
      await sendTelegramMessage(task.assignee.telegramChatId, content);
    }

    await prisma.telegramReminderLog.create({
      data: { taskId: task.id, bucket, sentDate: today }
    });
    sent++;
  }

  if (sent > 0) console.log(`[Reminder] Sent ${sent} deadline reminder(s) for ${today}`);
}

let lastRunDate = null;

// Checks periodically and runs the daily batch once per day, after the given hour (server local time).
function startReminderScheduler(io, { hour = 8, intervalMs = 30 * 60 * 1000 } = {}) {
  async function tick() {
    const now = new Date();
    const today = dateKey(now);
    if (now.getHours() >= hour && lastRunDate !== today) {
      lastRunDate = today;
      try {
        await runDailyReminders(io);
      } catch (err) {
        console.error('Reminder scheduler failed:', err);
        lastRunDate = null; // allow retry on next tick
      }
    }
  }

  tick();
  setInterval(tick, intervalMs);
}

module.exports = { startReminderScheduler, runDailyReminders };
