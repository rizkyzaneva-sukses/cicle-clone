const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { upload, attachmentData } = require('../lib/upload');

router.use(requireAuth);

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

  if (companyIds.length === 0) return [];

  const [memberRows, partnerRows, owners] = await Promise.all([
    prisma.membership.findMany({
      where: { companyId: { in: companyIds } },
      include: { user: true }
    }),
    prisma.partnerAccess.findMany({
      where: { companyId: { in: companyIds } },
      include: { user: true }
    }),
    prisma.user.findMany({ where: { platformRole: 'owner' } })
  ]);

  const map = new Map();
  [...memberRows.map(m => m.user), ...partnerRows.map(p => p.user), ...owners].forEach(contact => {
    if (contact.id !== user.id) map.set(contact.id, contact);
  });

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function renderInbox(req, res, selectedUserId = null) {
  const currentUser = req.session.user;
  const contacts = await getContacts(currentUser);
  const selectedUser = selectedUserId
    ? contacts.find(contact => contact.id === selectedUserId) || null
    : contacts[0] || null;

  let messages = [];
  if (selectedUser) {
    await prisma.directMessage.updateMany({
      where: {
        senderId: selectedUser.id,
        receiverId: currentUser.id,
        readAt: null
      },
      data: { readAt: new Date() }
    });

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

    await prisma.notification.create({
      data: {
        userId: receiverId,
        content: `${req.session.user.name} mengirim pesan personal`,
        link: `/inbox/${senderId}`
      }
    });

    const io = req.app.get('io');
    if (io) {
      io.to(`user-${receiverId}`).emit('new-direct-message', fullMessage);
      io.to(`user-${receiverId}`).emit('new-notification');
    }

    res.json({ success: true, message: fullMessage });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal mengirim pesan' });
  }
});

module.exports = router;
