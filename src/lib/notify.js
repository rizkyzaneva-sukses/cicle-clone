const prisma = require('./prisma');
const { sendPushToUser } = require('./push');

// Single entry point for personal notifications: DB record + live socket badge + browser push.
async function notifyUser(io, userId, content, link = null) {
  const notification = await prisma.notification.create({
    data: { userId, content, link }
  });

  if (io) io.to(`user-${userId}`).emit('new-notification');

  sendPushToUser(userId, { title: 'Maulana Corp', body: content, url: link || '/' }).catch((err) => {
    console.error('Push notify failed:', err.message);
  });

  return notification;
}

module.exports = { notifyUser };
