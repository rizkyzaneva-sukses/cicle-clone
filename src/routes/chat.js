const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { upload, attachmentData } = require('../lib/upload');
const { hasProjectAccess, ensureProjectMember } = require('../lib/access');
const { notifyUser } = require('../lib/notify');
const { extractMentionedUserIds } = require('../lib/mentions');

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

router.use(requireAuth);

// Get messages for project
router.get('/messages/:projectId', async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.projectId },
    select: { id: true, companyId: true }
  });
  if (!project || !await hasProjectAccess(req.session.user, project)) {
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

// Search project members for @mention autocomplete in chat
router.get('/members/:projectId', async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.projectId },
    select: { id: true, companyId: true }
  });
  if (!project || !await hasProjectAccess(req.session.user, project)) return res.json([]);

  const members = await prisma.membership.findMany({
    where: { companyId: project.companyId },
    include: { user: { select: { id: true, name: true, email: true } } }
  });

  const q = (req.query.q || '').toLowerCase();
  
  // Add @team option at the beginning
  const teamOption = { id: '__team__', name: 'team', email: 'Semua anggota tim' };
  
  const filtered = q
    ? [teamOption, ...members.filter(m => 
        m.user.name.toLowerCase().includes(q) || 
        m.user.email.toLowerCase().includes(q) ||
        'team'.includes(q)
      ).map(m => ({ id: m.user.id, name: m.user.name, email: m.user.email }))]
    : [teamOption, ...members.map(m => ({ id: m.user.id, name: m.user.name, email: m.user.email }))];

  res.json(filtered);
});

// Post new message (fallback if socket fails)
router.post('/messages/:projectId', upload.array('files', 8), async (req, res) => {
  try {
    const content = (req.body.content || '').trim();
    const projectId = req.params.projectId;
    const userId = req.session.user.id;
    const files = req.files || [];

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, companyId: true }
    });
    if (!project || !await hasProjectAccess(req.session.user, project)) {
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

    // Notify other project members: @mentions get a "kamu disebut" message,
    // everyone else gets a generic new-chat-message ping so they don't miss it.
    const [companyMembers, projectMembers] = await Promise.all([
      prisma.membership.findMany({
        where: { companyId: project.companyId },
        include: { user: { select: { id: true, name: true } } }
      }),
      prisma.projectMember.findMany({ where: { projectId }, select: { userId: true } })
    ]);

    // Get all member IDs for @team mention
    const allMemberIds = companyMembers.map(m => m.user.id);
    
    const mentionedIds = new Set(
      extractMentionedUserIds(content, companyMembers.map(m => m.user), allMemberIds).filter(id => id !== userId)
    );
    
    // Determine if @team was used
    const isTeamMention = content.includes('@team');
    
    const recipientIds = new Set([
      ...projectMembers.map(m => m.userId),
      ...mentionedIds
    ]);
    recipientIds.delete(userId);

    // Check for @team mention — notify ALL project members (not just mentioned)
    const isTeamBroadcast = /@team\b/i.test(content);
    if (isTeamBroadcast) {
      // Add all project members to recipients
      for (const pm of projectMembers) {
        recipientIds.add(pm.userId);
      }
      recipientIds.delete(userId);
    }

    const io = req.app.get('io');
    const snippet = content ? (content.length > 80 ? `${content.slice(0, 80)}...` : content) : '(mengirim file)';
    for (const recipientId of recipientIds) {
      if (isTeamMention && mentionedIds.has(recipientId)) {
        await ensureProjectMember(recipientId, projectId);
        await notifyUser(io, recipientId, `${fullMessage.user.name} menyebut @team di chat proyek "${project.name}"`, `/projects/${projectId}`);
      } else if (mentionedIds.has(recipientId)) {
        await ensureProjectMember(recipientId, projectId);
        await notifyUser(io, recipientId, `${fullMessage.user.name} menyebut kamu di chat proyek "${project.name}"`, `/projects/${projectId}`);
      } else {
        await notifyUser(io, recipientId, `${fullMessage.user.name} di chat proyek "${project.name}": ${snippet}`, `/projects/${projectId}`);
      }
    }

    res.json({ success: true, message: fullMessage });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal kirim pesan' });
  }
});

// Pin/unpin a chat message
router.post('/messages/:messageId/pin', async (req, res) => {
  try {
    const message = await prisma.chatMessage.findUnique({ where: { id: req.params.messageId } });
    if (!message) return res.status(404).json({ error: 'Pesan tidak ditemukan' });

    const project = await prisma.project.findUnique({
      where: { id: message.projectId },
      select: { id: true, companyId: true }
    });
    if (!project || !await hasProjectAccess(req.session.user, project)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }

    const updated = await prisma.chatMessage.update({
      where: { id: message.id },
      data: { pinned: !message.pinned }
    });

    res.json({ success: true, pinned: updated.pinned });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal pin pesan' });
  }
});

module.exports = router;
