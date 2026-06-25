const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { upload, attachmentData } = require('../lib/upload');
const { notifyUser } = require('../lib/notify');

router.use(requireAuth);

async function markConversationAsRead(req, otherUserId) {
  const currentUserId = req.session.user.id;
  const link = `/inbox/${otherUserId}`;
  const [unreadMessages, notificationResult] = await prisma.$transaction([
    prisma.directMessage.findMany({
      where: {
        senderId: otherUserId,
        receiverId: currentUserId,
        readAt: null
      },
      select: { id: true, senderId: true }
    }),
    prisma.notification.updateMany({
      where: {
        userId: currentUserId,
        link,
        isRead: false
      },
      data: { isRead: true }
    })
  ]);

  if (unreadMessages.length === 0) {
    return { readAt: null, messageIds: [], notificationCount: notificationResult.count };
  }

  const readAt = new Date();
  await prisma.directMessage.updateMany({
    where: { id: { in: unreadMessages.map(message => message.id) } },
    data: { readAt }
  });

  const io = req.app.get('io');
  const groupedBySender = new Map();
  unreadMessages.forEach(message => {
    if (!groupedBySender.has(message.senderId)) groupedBySender.set(message.senderId, []);
    groupedBySender.get(message.senderId).push(message.id);
  });

  groupedBySender.forEach((messageIds, senderId) => {
    io?.to(`user-${senderId}`).emit('direct-message-read', {
      readerId: currentUserId,
      messageIds,
      readAt: readAt.toISOString()
    });
  });

  return { readAt, messageIds: unreadMessages.map(message => message.id), notificationCount: notificationResult.count };
}

async function getContacts(user) {
  if (user.platformRole === 'owner') {
    return prisma.user.findMany({
      where: { id: { not: user.id } },
      orderBy: { name: 'asc' }
    });
  }

  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    select: { companyId: true }
  });
  const [partnerAccess, workspaceAccess] = await Promise.all([
    prisma.partnerAccess.findMany({
      where: { userId: user.id },
      select: { companyId: true }
    }),
    prisma.workspacePartner.findMany({
      where: { userId: user.id },
      include: { workspace: { select: { brands: { select: { id: true } } } } }
    })
  ]);
  const companyIds = [...new Set([
    ...memberships.map(m => m.companyId),
    ...partnerAccess.map(p => p.companyId),
    ...workspaceAccess.flatMap(access => access.workspace.brands.map(brand => brand.id))
  ])];

  const [memberRows, partnerRows, owners, dmContacts] = await Promise.all([
    companyIds.length > 0 ? prisma.membership.findMany({
      where: { companyId: { in: companyIds } },
      include: { user: true }
    }) : [],
    companyIds.length > 0 ? prisma.partnerAccess.findMany({
      where: { companyId: { in: companyIds } },
      include: { user: true }
    }) : [],
    prisma.user.findMany({ where: { platformRole: 'owner' } }),
    prisma.directMessage.findMany({
      where: { OR: [{ receiverId: user.id }, { senderId: user.id }] },
      select: { senderId: true, receiverId: true, sender: true, receiver: true },
      distinct: ['senderId', 'receiverId']
    })
  ]);

  const map = new Map();
  [...memberRows.map(m => m.user), ...partnerRows.map(p => p.user), ...owners].forEach(contact => {
    if (contact.id !== user.id) map.set(contact.id, contact);
  });
  dmContacts.forEach(dm => {
    [dm.sender, dm.receiver].forEach(contact => {
      if (contact && contact.id !== user.id) map.set(contact.id, contact);
    });
  });

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function renderInbox(req, res, selectedUserId = null) {
  const currentUser = req.session.user;
  const contacts = await getContacts(currentUser);
  let selectedUser = selectedUserId
    ? contacts.find(contact => contact.id === selectedUserId) || null
    : contacts[0] || null;

  // If user came from a notification link, load the sender even if not in contacts yet
  if (selectedUserId && !selectedUser) {
    selectedUser = await prisma.user.findUnique({ where: { id: selectedUserId } }) || null;
    if (selectedUser && !contacts.some(c => c.id === selectedUser.id)) {
      contacts.push(selectedUser);
      contacts.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  let messages = [];
  let readResult = { readAt: null, messageIds: [], notificationCount: 0 };
  if (selectedUser) {
    readResult = await markConversationAsRead(req, selectedUser.id);

    messages = await prisma.directMessage.findMany({
      where: {
        OR: [
          { senderId: currentUser.id, receiverId: selectedUser.id },
          { senderId: selectedUser.id, receiverId: currentUser.id }
        ]
      },
      include: {
        sender: true,
        receiver: true,
        attachments: true
      },
      orderBy: { createdAt: 'asc' },
      take: 200
    });
  }

  res.render('inbox', {
    title: 'Inbox',
    contacts,
    selectedUser,
    messages,
    readResult,
    currentUserId: currentUser.id
  });
}

router.get('/', async (req, res) => {
  try {
    await renderInbox(req, res);
  } catch (error) {
    console.error(error);
    res.status(500).send('Gagal membuka inbox');
  }
});

router.get('/:userId', async (req, res) => {
  try {
    await renderInbox(req, res, req.params.userId);
  } catch (error) {
    console.error(error);
    res.status(500).send('Gagal membuka chat');
  }
});

router.post('/:userId/read', async (req, res) => {
  try {
    const contacts = await getContacts(req.session.user);
    if (!contacts.some(contact => contact.id === req.params.userId)) {
      return res.status(403).json({ error: 'Kontak tidak tersedia' });
    }

    const result = await markConversationAsRead(req, req.params.userId);
    res.json({
      success: true,
      messageIds: result.messageIds,
      readAt: result.readAt ? result.readAt.toISOString() : null,
      notificationCount: result.notificationCount
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal update seen chat' });
  }
});

router.post('/:userId/messages', upload.array('files', 8), async (req, res) => {
  try {
    const senderId = req.session.user.id;
    const receiverId = req.params.userId;
    const content = (req.body.content || '').trim();
    const files = req.files || [];

    if (!content && files.length === 0) {
      return res.status(400).json({ error: 'Pesan atau file wajib diisi' });
    }

    const contacts = await getContacts(req.session.user);
    if (!contacts.some(contact => contact.id === receiverId)) {
      return res.status(403).json({ error: 'Kontak tidak tersedia' });
    }

    const message = await prisma.directMessage.create({
      data: {
        content,
        senderId,
        receiverId
      }
    });

    if (files.length > 0) {
      await prisma.attachment.createMany({
        data: files.map(file => attachmentData(file, senderId, { directMessageId: message.id }))
      });
    }

    const fullMessage = await prisma.directMessage.findUnique({
      where: { id: message.id },
      include: { sender: true, receiver: true, attachments: true }
    });

    const io = req.app.get('io');
    const snippet = content ? (content.length > 80 ? `${content.slice(0, 80)}...` : content) : '(mengirim file)';
    await notifyUser(io, receiverId, `${req.session.user.name}: ${snippet}`, `/inbox/${senderId}`);
    if (io) io.to(`user-${receiverId}`).emit('new-direct-message', fullMessage);

    res.json({ success: true, message: fullMessage });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal mengirim pesan' });
  }
});

module.exports = router;
