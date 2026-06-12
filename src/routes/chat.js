const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { upload, attachmentData } = require('../lib/upload');

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

router.use(requireAuth);

async function hasProjectAccess(user, projectId) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { companyId: true }
  });
  if (!project) return false;
  if (user.platformRole === 'owner') return true;

  if (user.platformRole === 'partner') {
    const access = await prisma.partnerAccess.findUnique({
      where: { userId_companyId: { userId: user.id, companyId: project.companyId } }
    });
    if (access) return true;

    const brand = await prisma.company.findUnique({
      where: { id: project.companyId },
      select: { workspaceId: true }
    });
    if (brand?.workspaceId) {
      const workspaceAccess = await prisma.workspacePartner.findUnique({
        where: { userId_workspaceId: { userId: user.id, workspaceId: brand.workspaceId } }
      });
      if (workspaceAccess) return true;
    }
  }

  const membership = await prisma.membership.findUnique({
    where: { userId_companyId: { userId: user.id, companyId: project.companyId } }
  });
  return Boolean(membership);
}

// Get messages for project
router.get('/messages/:projectId', async (req, res) => {
  if (!await hasProjectAccess(req.session.user, req.params.projectId)) {
    return res.status(403).json({ error: 'Akses ditolak' });
  }

  const messages = await prisma.chatMessage.findMany({
    where: { projectId: req.params.projectId },
    include: { user: true, attachments: true },
    orderBy: { createdAt: 'asc' },
    take: 100
  });
  res.json(messages);
});

// Post new message (fallback if socket fails)
router.post('/messages/:projectId', upload.array('files', 8), async (req, res) => {
  try {
    const content = (req.body.content || '').trim();
    const projectId = req.params.projectId;
    const userId = req.session.user.id;
    const files = req.files || [];

    if (!await hasProjectAccess(req.session.user, projectId)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }

    if (!content && files.length === 0) {
      return res.status(400).json({ error: 'Pesan atau file wajib diisi' });
    }

    const message = await prisma.chatMessage.create({
      data: { content, projectId, userId }
    });

    if (files.length > 0) {
      await prisma.attachment.createMany({
        data: files.map(file => attachmentData(file, userId, {
          projectId,
          chatMessageId: message.id
        }))
      });
    }

    const fullMessage = await prisma.chatMessage.findUnique({
      where: { id: message.id },
      include: { user: true, attachments: true }
    });

    res.json({ success: true, message: fullMessage });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal kirim pesan' });
  }
});

module.exports = router;
