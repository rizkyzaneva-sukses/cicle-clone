const prisma = require('./prisma');
const { sendPushToUser } = require('./push');

const NotificationType = Object.freeze({
  PROJECT_TASK: 'PROJECT_TASK',
  DIRECT_CHAT: 'DIRECT_CHAT',
  OTHER: 'OTHER'
});

// Batching state: track recent notifications per user
const batchWindow = new Map(); // userId -> [{content, link, type, timestamp}]
const BATCH_THRESHOLD = 10;
const BATCH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// Priority levels
const PRIORITY = { URGENT: 3, HIGH: 2, MEDIUM: 1, LOW: 0, NONE: 0 };

function inferNotificationType(link) {
  if (!link) return NotificationType.OTHER;
  if (link.startsWith('/projects') || link.startsWith('/tasks')) return NotificationType.PROJECT_TASK;
  if (link.startsWith('/inbox')) return NotificationType.DIRECT_CHAT;
  return NotificationType.OTHER;
}

function isDndActive(user) {
  if (!user?.dndStart || !user?.dndEnd) return false;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const current = `${hh}:${mm}`;
  const { dndStart, dndEnd } = user;
  if (dndStart <= dndEnd) {
    return current >= dndStart && current < dndEnd;
  }
  // Overnight DND (e.g., 22:00 - 08:00)
  return current >= dndStart || current < dndEnd;
}

async function smartNotify(io, userId, content, link = null, options = {}) {
  const type = options.type || inferNotificationType(link);
  const priority = options.priority || 'NONE';
  const preview = options.preview || null;

  // Check DND
  if (PRIORITY[priority] < PRIORITY.HIGH) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { dndStart: true, dndEnd: true }
      });
      if (user && isDndActive(user)) {
        // Queue for later, don't send now
        addToBatch(userId, content, link, type);
        return null;
      }
    } catch (_) {}
  }

  // URGENT: send immediately
  if (PRIORITY[priority] >= PRIORITY.URGENT) {
    return sendImmediate(io, userId, content, link, type, preview);
  }

  // Check batching
  const userBatch = batchWindow.get(userId) || [];
  const recentCount = userBatch.filter(b => Date.now() - b.timestamp < BATCH_WINDOW_MS).length;

  if (recentCount >= BATCH_THRESHOLD) {
    // Send batch summary
    await sendBatchSummary(io, userId);
    return sendImmediate(io, userId, content, link, type, preview);
  }

  // Normal send
  addToBatch(userId, content, link, type);
  return sendImmediate(io, userId, content, link, type, preview);
}

function addToBatch(userId, content, link, type) {
  if (!batchWindow.has(userId)) batchWindow.set(userId, []);
  const arr = batchWindow.get(userId);
  arr.push({ content, link, type, timestamp: Date.now() });
  // Keep only last 50 entries
  if (arr.length > 50) arr.splice(0, arr.length - 50);
}

async function sendImmediate(io, userId, content, link, type, preview) {
  const notification = await prisma.notification.create({
    data: { userId, content, link, type }
  });

  if (io) {
    io.to(`user-${userId}`).emit('new-notification', {
      type,
      content,
      link,
      preview,
      id: notification.id
    });
  }

  sendPushToUser(userId, {
    title: 'Maulana Corp',
    body: content,
    url: link || '/',
    tag: type
  }).catch((err) => {
    console.error('Push notify failed:', err.message);
  });

  return notification;
}

async function sendBatchSummary(io, userId) {
  const userBatch = batchWindow.get(userId) || [];
  const recent = userBatch.filter(b => Date.now() - b.timestamp < BATCH_WINDOW_MS);
  if (recent.length < 2) return;

  const summaryContent = `${recent.length} pembaruan dalam 5 menit terakhir. Klik untuk melihat detail.`;
  batchWindow.set(userId, []);

  await prisma.notification.create({
    data: {
      userId,
      content: summaryContent,
      link: '/notifications',
      type: 'OTHER'
    }
  });

  if (io) {
    io.to(`user-${userId}`).emit('new-notification', {
      type: 'OTHER',
      content: summaryContent,
      link: '/notifications'
    });
  }
}

// Prepare digest email structure (for nodemailer integration)
async function prepareDigestEmail(userId) {
  const yesterday = new Date(Date.now() - 86400000);
  const notifications = await prisma.notification.findMany({
    where: {
      userId,
      isRead: false,
      createdAt: { gte: yesterday }
    },
    orderBy: { createdAt: 'desc' },
    take: 50
  });

  if (notifications.length === 0) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true }
  });

  return {
    to: user.email,
    subject: `[Maulana Corp] ${notifications.length} notifikasi belum dibaca`,
    html: `
      <h2>Halo ${user.name},</h2>
      <p>Kamu punya ${notifications.length} notifikasi belum dibaca:</p>
      <ul>
        ${notifications.map(n => `<li>${n.content} <small>(${new Date(n.createdAt).toLocaleString('id-ID')})</small></li>`).join('')}
      </ul>
      <p><a href="${process.env.APP_URL || 'http://localhost:3000'}/notifications">Lihat semua notifikasi</a></p>
    `
  };
}

// Legacy-compatible notifyUser that uses smartNotify
async function notifyUser(io, userId, content, link = null, options = {}) {
  return smartNotify(io, userId, content, link, options);
}

module.exports = { notifyUser, smartNotify, prepareDigestEmail, NotificationType };
