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

async function getProjectForChat(projectId) {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      companyId: true,
      company: {
        select: {
          workspaceId: true,
          workspace: { select: { ownerId: true } }
        }
      }
    }
  });
}

function dedupeUsers(users) {
  const seen = new Map();
  users.forEach(user => {
    if (user?.id && !seen.has(user.id)) seen.set(user.id, user);
  });
  return [...seen.values()];
}

async function getProjectChatAudience(project) {
  const workspaceId = project.company?.workspaceId || null;

  const [projectMembers, companyAdmins, companyPartners, workspacePartners, workspaceOwner] = await Promise.all([
    prisma.projectMember.findMany({
      where: { projectId: project.id },
      include: { user: { select: { id: true, name: true, email: true } } }
    }),
    prisma.membership.findMany({
      where: { companyId: project.companyId, role: 'admin' },
      include: { user: { select: { id: true, name: true, email: true } } }
    }),
    prisma.partnerAccess.findMany({
      where: { companyId: project.companyId },
      include: { user: { select: { id: true, name: true, email: true } } }
    }),
    workspaceId ? prisma.workspacePartner.findMany({
      where: { workspaceId },
      include: { user: { select: { id: true, name: true, email: true } } }
    }) : [],
    project.company?.workspace?.ownerId
      ? prisma.user.findUnique({
          where: { id: project.company.workspace.ownerId },
          select: { id: true, name: true, email: true }
        })
      : null
  ]);

  return dedupeUsers([
    ...projectMembers.map(row => row.user),
    ...companyAdmins.map(row => row.user),
    ...companyPartners.map(row => row.user),
    ...workspacePartners.map(row => row.user),
    workspaceOwner
  ]);
}

function buildReactionSummary(reactions = []) {
  const grouped = new Map();
  reactions.forEach(reaction => {
    if (!grouped.has(reaction.emoji)) grouped.set(reaction.emoji, []);
    grouped.get(reaction.emoji).push({
      id: reaction.user.id,
      name: reaction.user.name
    });
  });
  return [...grouped.entries()];
}

function serializeChatMessage(message, audience, readRows) {
  const senderId = message.userId || message.user?.id || null;
  const comparableDate = new Date(message.createdAt);

  const viewers = audience.filter(user => user.id !== senderId);
  const seenBy = [];
  const unseenBy = [];

  viewers.forEach(user => {
    const readRow = readRows.find(row => row.userId === user.id);
    if (readRow && new Date(readRow.lastReadAt) >= comparableDate) {
      seenBy.push({ id: user.id, name: user.name });
    } else {
      unseenBy.push({ id: user.id, name: user.name });
    }
  });

  return {
    ...message,
    reactionsSummary: buildReactionSummary(message.reactions || []),
    seenBy,
    unseenBy
  };
}

async function buildChatPayload(projectId, currentUserId, markSeen = true, options = {}) {
  const project = await getProjectForChat(projectId);
  if (!project) return null;

  if (markSeen) {
    await prisma.projectChatRead.upsert({
      where: { projectId_userId: { projectId, userId: currentUserId } },
      update: { lastReadAt: new Date() },
      create: { projectId, userId: currentUserId, lastReadAt: new Date() }
    });
  }

  // Cursor-based pagination
  const limit = Math.min(parseInt(options.limit) || 50, 100);
  const before = options.before ? new Date(options.before) : null;

  const messageWhere = { projectId, parentId: null };
  if (before && !isNaN(before.getTime())) {
    messageWhere.createdAt = { lt: before };
  }

  const [audience, messages, readRows, totalCount] = await Promise.all([
    getProjectChatAudience(project),
    prisma.chatMessage.findMany({
      where: messageWhere,
      include: {
        user: true,
        attachments: true,
        reactions: { include: { user: { select: { id: true, name: true } } } },
        replies: {
          include: {
            user: { select: { id: true, name: true } },
            reactions: { include: { user: { select: { id: true, name: true } } } }
          },
          orderBy: { createdAt: 'asc' },
          take: 5
        },
        _count: { select: { replies: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1
    }),
    prisma.projectChatRead.findMany({ where: { projectId } }),
    prisma.chatMessage.count({ where: { projectId, parentId: null } })
  ]);

  const hasMore = messages.length > limit;
  const trimmedMessages = hasMore ? messages.slice(0, limit) : messages;
  // Reverse to chronological order
  trimmedMessages.reverse();

  return {
    project,
    audience: audience.map(user => ({ id: user.id, name: user.name })),
    messages: trimmedMessages.map(message => serializeChatMessage(message, audience, readRows)),
    pagination: {
      hasMore,
      oldestTimestamp: trimmedMessages.length > 0 ? trimmedMessages[0].createdAt : null,
      totalCount,
      limit
    }
  };
}

// Get messages for project (with pagination)
router.get('/messages/:projectId', async (req, res) => {
  const { before, limit } = req.query;
  const payload = await buildChatPayload(req.params.projectId, req.session.user.id, false, { before, limit });
  if (!payload || !await hasProjectAccess(req.session.user, payload.project)) {
    return res.status(403).json({ error: 'Akses ditolak' });
  }

  res.json({ messages: payload.messages, audience: payload.audience, pagination: payload.pagination });
});

router.post('/messages/:projectId/read', async (req, res) => {
  const project = await getProjectForChat(req.params.projectId);
  if (!project || !await hasProjectAccess(req.session.user, project)) {
    return res.status(403).json({ error: 'Akses ditolak' });
  }

  const readAt = new Date();
  await prisma.projectChatRead.upsert({
    where: { projectId_userId: { projectId: project.id, userId: req.session.user.id } },
    update: { lastReadAt: readAt },
    create: { projectId: project.id, userId: req.session.user.id, lastReadAt: readAt }
  });

  req.app.get('io')?.to(`project-${project.id}`).emit('project-chat-read', {
    projectId: project.id,
    userId: req.session.user.id,
    name: req.session.user.name,
    lastReadAt: readAt.toISOString()
  });

  res.json({ success: true, lastReadAt: readAt.toISOString() });
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

  const q = (req.query.q || '').trim().toLowerCase();
  const teamOption = { id: '__team__', name: 'team', email: 'Semua anggota tim' };
  const mappedMembers = members.map(m => ({ id: m.user.id, name: m.user.name, email: m.user.email }));
  const matchedMembers = q
    ? mappedMembers
        .filter(m => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
        .sort((a, b) => {
          const aStarts = a.name.toLowerCase().startsWith(q) || a.email.toLowerCase().startsWith(q);
          const bStarts = b.name.toLowerCase().startsWith(q) || b.email.toLowerCase().startsWith(q);
          return Number(bStarts) - Number(aStarts) || a.name.localeCompare(b.name);
        })
    : mappedMembers.sort((a, b) => a.name.localeCompare(b.name));

  const filtered = q
    ? [('team'.startsWith(q) ? teamOption : null), ...matchedMembers].filter(Boolean)
    : [teamOption, ...matchedMembers];

  res.json(filtered);
});

// Post new message
router.post('/messages/:projectId', upload.array('files', 8), async (req, res) => {
  try {
    const content = (req.body.content || '').trim();
    const projectId = req.params.projectId;
    const userId = req.session.user.id;
    const files = req.files || [];

    const project = await getProjectForChat(projectId);
    if (!project || !await hasProjectAccess(req.session.user, project)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }

    if (!content && files.length === 0) {
      return res.status(400).json({ error: 'Pesan atau file wajib diisi' });
    }

    // Threading support
    const parentId = req.body.parentId || null;
    if (parentId) {
      const parentMsg = await prisma.chatMessage.findUnique({ where: { id: parentId } });
      if (!parentMsg || parentMsg.projectId !== projectId) {
        return res.status(400).json({ error: 'Parent message tidak valid' });
      }
    }

    const message = await prisma.chatMessage.create({
      data: { content, projectId, userId, parentId }
    });

    if (files.length > 0) {
      await prisma.attachment.createMany({
        data: files.map(file => attachmentData(file, userId, {
          projectId,
          chatMessageId: message.id
        }))
      });
    }

    await prisma.projectChatRead.upsert({
      where: { projectId_userId: { projectId, userId } },
      update: { lastReadAt: new Date() },
      create: { projectId, userId, lastReadAt: new Date() }
    });

    const payload = await buildChatPayload(projectId, userId, false);
    const fullMessage = payload.messages.find(item => item.id === message.id);

    const companyMembers = await prisma.membership.findMany({
      where: { companyId: project.companyId },
      include: { user: { select: { id: true, name: true } } }
    });
    const projectMembers = await prisma.projectMember.findMany({ where: { projectId }, select: { userId: true } });
    const allMemberIds = companyMembers.map(m => m.user.id);
    const mentionedIds = new Set(
      extractMentionedUserIds(content, companyMembers.map(m => m.user), allMemberIds).filter(id => id !== userId)
    );
    const recipientIds = new Set([
      ...projectMembers.map(m => m.userId),
      ...mentionedIds
    ]);
    recipientIds.delete(userId);

    const isTeamBroadcast = /@team\b/i.test(content);
    if (isTeamBroadcast) {
      for (const member of projectMembers) recipientIds.add(member.userId);
      recipientIds.delete(userId);
    }

    const io = req.app.get('io');
    const snippet = content ? (content.length > 80 ? `${content.slice(0, 80)}...` : content) : '(mengirim file)';
    for (const recipientId of recipientIds) {
      if (isTeamBroadcast && mentionedIds.has(recipientId)) {
        await ensureProjectMember(recipientId, projectId);
        await notifyUser(io, recipientId, `${fullMessage.user.name} menyebut @team di chat proyek "${project.name}"`, `/projects/${projectId}`);
      } else if (mentionedIds.has(recipientId)) {
        await ensureProjectMember(recipientId, projectId);
        await notifyUser(io, recipientId, `${fullMessage.user.name} menyebut kamu di chat proyek "${project.name}"`, `/projects/${projectId}`);
      } else {
        await notifyUser(io, recipientId, `${fullMessage.user.name} di chat proyek "${project.name}": ${snippet}`, `/projects/${projectId}`);
      }
    }

    io?.to(`project-${projectId}`).emit('new-message', fullMessage);

    res.json({ success: true, message: fullMessage });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal kirim pesan' });
  }
});

router.post('/messages/:messageId/reactions', async (req, res) => {
  try {
    const emoji = String(req.body.emoji || '').trim();
    if (!emoji) return res.status(400).json({ error: 'Emoji wajib diisi' });

    const message = await prisma.chatMessage.findUnique({
      where: { id: req.params.messageId },
      include: { project: { select: { id: true, companyId: true } } }
    });
    if (!message || !await hasProjectAccess(req.session.user, message.project)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }

    const existing = await prisma.chatReaction.findUnique({
      where: {
        chatMessageId_userId_emoji: {
          chatMessageId: message.id,
          userId: req.session.user.id,
          emoji
        }
      }
    });

    if (existing) {
      await prisma.chatReaction.delete({ where: { id: existing.id } });
    } else {
      await prisma.chatReaction.create({
        data: {
          chatMessageId: message.id,
          userId: req.session.user.id,
          emoji
        }
      });
    }

    const reactions = await prisma.chatReaction.findMany({
      where: { chatMessageId: message.id },
      include: { user: { select: { id: true, name: true } } }
    });

    const reactionsSummary = buildReactionSummary(reactions);
    req.app.get('io')?.to(`project-${message.projectId}`).emit('chat-reaction-updated', {
      projectId: message.projectId,
      messageId: message.id,
      reactionsSummary
    });

    res.json({ success: true, reactionsSummary });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal update reaction' });
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
