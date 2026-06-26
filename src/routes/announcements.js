const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { notifyUser } = require('../lib/notify');
const { upload } = require('../lib/upload');
const { sendTelegramMessage, sendTelegramPhoto } = require('../lib/telegram');
const {
  AnnouncementScope,
  buildAnnouncementVisibilityWhere,
  getAnnouncementScopeLabel
} = require('../lib/announcementAudience');

router.use(requireAuth);

const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');

function escapeTelegramHtml(value) {
  return String(value || '').replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
}

function buildPublicBaseUrl(req) {
  if (process.env.APP_URL) return String(process.env.APP_URL).replace(/\/+$/, '');

  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol;
  return `${protocol}://${req.get('host')}`;
}

async function sendAnnouncementTelegram(chatId, publicImageUrl, telegramContent) {
  if (!chatId) return { ok: false, reason: 'missing-chat-id' };

  if (publicImageUrl) {
    const photoResult = await sendTelegramPhoto(chatId, publicImageUrl, telegramContent.slice(0, 1024));
    if (photoResult?.ok) return photoResult;
  }

  const textWithImageFallback = publicImageUrl
    ? `${telegramContent}\n\n[Image] ${escapeTelegramHtml(publicImageUrl)}`
    : telegramContent;

  return sendTelegramMessage(chatId, textWithImageFallback);
}

async function deleteAnnouncementImage(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith('/uploads/')) return;

  const filename = path.basename(imageUrl);
  const targetPath = path.join(uploadsDir, filename);
  if (!targetPath.startsWith(uploadsDir)) return;

  try {
    await fs.unlink(targetPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function getRecipientsForAnnouncement(scope, workspaceId, companyId) {
  if (scope === AnnouncementScope.APP) {
    return prisma.user.findMany({ select: { id: true, telegramChatId: true } });
  }

  if (scope === AnnouncementScope.HOLDING) {
    const brands = await prisma.company.findMany({
      where: { workspaceId },
      select: { id: true }
    });
    const brandIds = brands.map((brand) => brand.id);
    const or = [
      { platformRole: 'owner' },
      { workspaceRoles: { some: { workspaceId } } }
    ];

    if (brandIds.length > 0) {
      or.push({ memberships: { some: { companyId: { in: brandIds } } } });
      or.push({ partnerAccess: { some: { companyId: { in: brandIds } } } });
    }

    return prisma.user.findMany({
      where: { OR: or },
      select: { id: true, telegramChatId: true }
    });
  }

  const or = [
    { platformRole: 'owner' },
    { memberships: { some: { companyId } } },
    { partnerAccess: { some: { companyId } } }
  ];

  if (workspaceId) {
    or.push({ workspaceRoles: { some: { workspaceId } } });
  }

  return prisma.user.findMany({
    where: { OR: or },
    select: { id: true, telegramChatId: true }
  });
}

async function enrichAnnouncements(announcements) {
  const workspaceIds = [...new Set(announcements.map((item) => item.workspaceId).filter(Boolean))];
  const companyIds = [...new Set(announcements.map((item) => item.companyId).filter(Boolean))];

  const [workspaces, companies] = await Promise.all([
    workspaceIds.length > 0
      ? prisma.workspace.findMany({
          where: { id: { in: workspaceIds } },
          select: { id: true, name: true }
        })
      : [],
    companyIds.length > 0
      ? prisma.company.findMany({
          where: { id: { in: companyIds } },
          select: { id: true, name: true }
        })
      : []
  ]);

  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const companyNames = new Map(companies.map((company) => [company.id, company.name]));

  return announcements.map((announcement) => ({
    ...announcement,
    scopeLabel: getAnnouncementScopeLabel(announcement.scope),
    targetName:
      announcement.scope === AnnouncementScope.HOLDING
        ? workspaceNames.get(announcement.workspaceId) || '-'
        : announcement.scope === AnnouncementScope.BRAND
          ? companyNames.get(announcement.companyId) || '-'
          : 'Semua user app'
  }));
}

router.get('/', async (req, res) => {
  const visibilityWhere = await buildAnnouncementVisibilityWhere(req.session.user);
  const [announcementRows, workspaces] = await Promise.all([
    prisma.announcement.findMany({
      where: visibilityWhere,
      include: { createdBy: true },
      orderBy: { createdAt: 'desc' },
      take: 50
    }),
    req.session.user.platformRole === 'owner'
      ? prisma.workspace.findMany({
          include: {
            brands: {
              select: { id: true, name: true },
              orderBy: { name: 'asc' }
            }
          },
          orderBy: { name: 'asc' }
        })
      : []
  ]);

  const announcements = await enrichAnnouncements(announcementRows);
  res.render('announcements', { title: 'Pengumuman', announcements, workspaces, AnnouncementScope });
});

router.post('/', upload.single('image'), async (req, res) => {
  try {
    if (req.session.user.platformRole !== 'owner') {
      req.flash('error', 'Hanya Owner yang bisa membuat pengumuman');
      return res.redirect('/announcements');
    }

    const content = (req.body.content || '').trim();
    if (!content) {
      req.flash('error', 'Isi pengumuman wajib diisi');
      return res.redirect('/announcements');
    }

    const rawScope = String(req.body.scope || AnnouncementScope.APP).trim().toUpperCase();
    const scope = Object.values(AnnouncementScope).includes(rawScope) ? rawScope : AnnouncementScope.APP;
    let workspaceId = null;
    let companyId = null;
    let targetName = 'Semua user app';

    if (scope === AnnouncementScope.HOLDING) {
      workspaceId = String(req.body.workspaceId || '').trim();
      if (!workspaceId) {
        req.flash('error', 'Pilih holding tujuan untuk pengumuman ini');
        return res.redirect('/announcements');
      }

      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, name: true }
      });
      if (!workspace) {
        req.flash('error', 'Holding tujuan tidak ditemukan');
        return res.redirect('/announcements');
      }

      targetName = workspace.name;
    }

    if (scope === AnnouncementScope.BRAND) {
      companyId = String(req.body.companyId || '').trim();
      if (!companyId) {
        req.flash('error', 'Pilih brand tujuan untuk pengumuman ini');
        return res.redirect('/announcements');
      }

      const company = await prisma.company.findUnique({
        where: { id: companyId },
        select: { id: true, name: true, workspaceId: true }
      });
      if (!company) {
        req.flash('error', 'Brand tujuan tidak ditemukan');
        return res.redirect('/announcements');
      }

      workspaceId = company.workspaceId || null;
      targetName = company.name;
    }

    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
    const imageName = req.file?.originalname || null;

    await prisma.announcement.create({
      data: {
        scope,
        workspaceId,
        companyId,
        content,
        imageUrl,
        imageName,
        createdById: req.session.user.id
      }
    });

    const users = await getRecipientsForAnnouncement(scope, workspaceId, companyId);
    const io = req.app.get('io');
    const scopeLabel = getAnnouncementScopeLabel(scope);
    const notifContent = `📢 ${scopeLabel} (${targetName}): ${content}`;
    const telegramContent = `📢 <b>${escapeTelegramHtml(scopeLabel)}</b>\n<b>Target:</b> ${escapeTelegramHtml(targetName)}\n\n${escapeTelegramHtml(content)}`;
    const appUrl = buildPublicBaseUrl(req);
    const publicImageUrl = imageUrl ? `${appUrl}${imageUrl}` : null;
    let appNotificationCount = 0;
    let telegramConnectedCount = 0;
    let telegramSuccessCount = 0;
    let telegramFailedCount = 0;

    for (const user of users) {
      try {
        await notifyUser(io, user.id, notifContent, '/announcements');
        appNotificationCount += 1;
      } catch (error) {
        console.error(`Announcement app notification failed for user ${user.id}:`, error.message);
      }

      if (user.telegramChatId) {
        telegramConnectedCount += 1;
        const telegramResult = await sendAnnouncementTelegram(user.telegramChatId, publicImageUrl, telegramContent);
        if (telegramResult?.ok) telegramSuccessCount += 1;
        else telegramFailedCount += 1;
      }
    }

    req.flash(
      'success',
      `${scopeLabel} untuk ${targetName} tersimpan. Notif app: ${appNotificationCount} user. Telegram: ${telegramSuccessCount}/${telegramConnectedCount} terkirim.`
    );
    if (telegramFailedCount > 0) {
      req.flash('error', `Telegram gagal ke ${telegramFailedCount} user. Cek Chat ID / status bot untuk user terkait.`);
    }
    res.redirect('/announcements');
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal membuat pengumuman');
    res.redirect('/announcements');
  }
});

router.post('/:id/delete', async (req, res) => {
  try {
    if (req.session.user.platformRole !== 'owner') {
      req.flash('error', 'Hanya Owner yang bisa menghapus pengumuman');
      return res.redirect('/announcements');
    }

    const announcement = await prisma.announcement.findUnique({
      where: { id: req.params.id },
      select: { id: true, imageUrl: true }
    });

    if (!announcement) {
      req.flash('error', 'Pengumuman tidak ditemukan');
      return res.redirect('/announcements');
    }

    await prisma.announcement.delete({ where: { id: announcement.id } });
    await deleteAnnouncementImage(announcement.imageUrl);

    req.flash('success', 'Pengumuman berhasil dihapus');
    res.redirect('/announcements');
  } catch (error) {
    console.error(error);
    req.flash('error', 'Gagal menghapus pengumuman');
    res.redirect('/announcements');
  }
});

module.exports = router;
