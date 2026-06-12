const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth, requireOwner } = require('../middleware/auth');

const RESET_CONFIRMATION = 'RESET';

router.post('/reset-data', requireAuth, requireOwner, async (req, res) => {
  const keepEmail = String(req.body.keepEmail || req.session.user.email || '').trim().toLowerCase();
  const confirmation = String(req.body.confirmation || '').trim();

  if (confirmation !== RESET_CONFIRMATION) {
    req.flash('error', `Ketik ${RESET_CONFIRMATION} untuk konfirmasi reset data.`);
    return res.redirect('/');
  }

  const keepUser = await prisma.user.findUnique({ where: { email: keepEmail } });
  if (!keepUser) {
    req.flash('error', `User ${keepEmail} tidak ditemukan. Reset dibatalkan.`);
    return res.redirect('/');
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const before = {
        users: await tx.user.count(),
        workspaces: await tx.workspace.count(),
        companies: await tx.company.count(),
        projects: await tx.project.count(),
        tasks: await tx.task.count()
      };

      await tx.attachment.deleteMany({});
      await tx.taskLabel.deleteMany({});
      await tx.checklistItem.deleteMany({});
      await tx.comment.deleteMany({});
      await tx.chatMessage.deleteMany({});
      await tx.directMessage.deleteMany({});
      await tx.notification.deleteMany({});
      await tx.activityLog.deleteMany({});
      await tx.task.deleteMany({});
      await tx.project.deleteMany({});
      await tx.label.deleteMany({});
      await tx.partnerAccess.deleteMany({});
      await tx.workspacePartner.deleteMany({});
      await tx.membership.deleteMany({});
      await tx.company.deleteMany({});
      await tx.workspace.deleteMany({});
      await tx.user.deleteMany({ where: { id: { not: keepUser.id } } });

      await tx.user.update({
        where: { id: keepUser.id },
        data: { platformRole: 'owner' }
      });

      return before;
    });

    req.session.user = {
      ...req.session.user,
      id: keepUser.id,
      email: keepUser.email,
      name: keepUser.name,
      platformRole: 'owner'
    };

    req.flash(
      'success',
      `Reset selesai. Tersisa akun ${keepUser.email}; terhapus ${result.users - 1} user, ${result.workspaces} workspace, ${result.companies} brand, ${result.projects} proyek, ${result.tasks} task.`
    );
    res.redirect('/');
  } catch (err) {
    console.error('Reset data failed:', err);
    req.flash('error', 'Reset data gagal. Cek logs server untuk detail.');
    res.redirect('/');
  }
});

module.exports = router;
