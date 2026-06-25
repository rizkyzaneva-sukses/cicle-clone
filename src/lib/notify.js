const prisma = require('./prisma');
const { sendPushToUser } = require('./push');

const NotificationType = Object.freeze({
  PROJECT_TASK: 'PROJECT_TASK',
  DIRECT_CHAT: 'DIRECT_CHAT',
  OTHER: 'OTHER'
});

function inferNotificationType(link) {
  if (!link) return NotificationType.OTHER;
  if (link.startsWith('/projects') || link.startsWith('/tasks')) return NotificationType.PROJECT_TASK;
  if (link.startsWith('/inbox')) return NotificationType.DIRECT_CHAT;
  return NotificationType.OTHER;
}

// Single entry point for personal notifications: DB record + live socket badge + browser push.
async function notifyUser(io, userId, content, link = null, options = {}) {
  const type = options.type || inferNotificationType(link);
  const notification = await prisma.notification.create({
    data: { userId, content, link, type }
  });

  if (io) io.to(`user-${userId}`).emit('new-notification', { type });

  sendPushToUser(userId, { title: 'Maulana Corp', body: content, url: link || '/', tag: type }).catch((err) => {
    console.error('Push notify failed:', err.message);
  });

  return notification;
}

module.exports = { notifyUser, NotificationType };
