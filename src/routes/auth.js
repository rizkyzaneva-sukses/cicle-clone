const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { uniqueSlug } = require('../lib/slug');
const { isConfiguredOwner } = require('../lib/owners');
const { notifyUser } = require('../lib/notify');
const { sendTelegramMessage, enabled: telegramEnabled } = require('../lib/telegram');

const RESET_CODE_TTL_MS = 10 * 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;

async function getPasswordResetManagers(user) {
  const managerIds = new Set();

  const owners = await prisma.user.findMany({
    where: { platformRole: 'owner' },
    select: { id: true }
  });
  owners.forEach(owner => managerIds.add(owner.id));

  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    include: {
      company: {
        select: {
          id: true,
          name: true,
          workspaceId: true,
          workspace: {
            select: {
              ownerId: true,
              partners: { select: { userId: true } }
            }
          },
          memberships: {
            where: { role: 'admin' },
            select: { userId: true }
          },
          partnerAccess: { select: { userId: true } }
        }
      }
    }
  });

  for (const membership of memberships) {
    membership.company.memberships.forEach(admin => managerIds.add(admin.userId));
    membership.company.partnerAccess.forEach(partner => managerIds.add(partner.userId));
    membership.company.workspace?.partners?.forEach(partner => managerIds.add(partner.userId));
    if (membership.company.workspace?.ownerId) managerIds.add(membership.company.workspace.ownerId);
  }

  const partnerAccess = await prisma.partnerAccess.findMany({
    where: { userId: user.id },
    include: {
      company: {
        select: {
          id: true,
          workspace: { select: { ownerId: true } }
        }
      }
    }
  });
  partnerAccess.forEach(access => {
    if (access.company.workspace?.ownerId) managerIds.add(access.company.workspace.ownerId);
  });

  managerIds.delete(user.id);
  return {
    managerIds: [...managerIds],
    primaryCompanyId: memberships[0]?.companyId || partnerAccess[0]?.companyId || null
  };
}

function forgotView(data = {}) {
  return {
    error: null,
    success: null,
    codeSent: false,
    email: '',
    fallbackToAdmin: false,
    ...data
  };
}

async function notifyPasswordResetManagers(req, user) {
  const { managerIds, primaryCompanyId } = await getPasswordResetManagers(user);
  const link = primaryCompanyId ? `/members?companyId=${primaryCompanyId}` : '/members';
  const io = req.app.get('io');

  for (const managerId of managerIds) {
    await notifyUser(io, managerId, `${user.name} meminta reset password`, link);
  }
}

router.get('/register', async (req, res) => {
  const userCount = await prisma.user.count();
  // Simpan invite token dari query ke session
  if (req.query.next && req.query.next === '/invite/join' && req.query.token) {
    req.session.inviteToken = req.query.token;
  }
  res.render('auth/register', { error: null, isFirstUser: userCount === 0, next: req.query.next || '/' });
});

router.post('/register', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const companyName = String(req.body.companyName || '').trim();

    // User pertama yang daftar = Owner platform
    const userCount = await prisma.user.count();
    const isFirstUser = userCount === 0;

    if (!name || !email || !password || (isFirstUser && !companyName)) {
      return res.render('auth/register', { error: 'Semua field wajib diisi', isFirstUser });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.render('auth/register', { error: 'Email sudah terdaftar', isFirstUser });
    }

    const platformRole = isFirstUser || isConfiguredOwner(email) ? 'owner' : 'user';

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email, password: hashedPassword, platformRole }
    });

    if (isFirstUser) {
      await prisma.workspace.create({
        data: {
          name: companyName,
          slug: uniqueSlug(companyName),
          ownerId: user.id
        }
      });
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      platformRole: user.platformRole
    };

    req.flash('success', platformRole === 'owner'
      ? 'Selamat datang, Owner! Maulana Corp Project Management siap digunakan.'
      : 'Akun berhasil dibuat. Bergabung ke brand via link invite...'
    );
    const nextUrl = req.body.next || '/';
    res.redirect(nextUrl === '/invite/join' ? '/invite/join' : '/');
  } catch (error) {
    console.error(error);
    const userCount = await prisma.user.count().catch(() => 1);
    res.render('auth/register', { error: 'Terjadi kesalahan. Coba lagi.', isFirstUser: userCount === 0, next: '/' });
  }
});

router.get('/login', (req, res) => {
  res.render('auth/login', { error: null, next: req.query.next || '/' });
});

router.post('/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.render('auth/login', { error: 'Email atau password salah' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.render('auth/login', { error: 'Email atau password salah' });

    if (isConfiguredOwner(user.email) && user.platformRole !== 'owner') {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { platformRole: 'owner' }
      });
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      platformRole: user.platformRole
    };

    const nextUrl = req.query.next || req.body.next || '/';
    res.redirect(nextUrl === '/invite/join' ? '/invite/join' : '/');
  } catch (error) {
    console.error(error);
    res.render('auth/login', { error: 'Terjadi kesalahan' });
  }
});

router.get('/forgot', (req, res) => {
  res.render('auth/forgot', forgotView());
});

router.post('/forgot', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const genericSuccess = 'Jika email terdaftar, instruksi reset password sudah dikirim.';

  try {
    if (!email) {
      return res.render('auth/forgot', forgotView({ error: 'Email wajib diisi' }));
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true, email: true, telegramChatId: true }
    });
    if (user) {
      if (telegramEnabled && user.telegramChatId) {
        const code = crypto.randomInt(100000, 1000000).toString();
        req.session.passwordReset = {
          userId: user.id,
          email: user.email,
          codeHash: await bcrypt.hash(code, 10),
          expiresAt: Date.now() + RESET_CODE_TTL_MS,
          attempts: 0
        };

        const sent = await sendTelegramMessage(
          user.telegramChatId,
          `<b>Kode Reset Password</b>\n\nKode kamu: <b>${code}</b>\nBerlaku 10 menit. Jangan bagikan kode ini ke siapa pun.`
        );

        if (sent?.ok) {
          return res.render('auth/forgot', forgotView({
            success: 'Kode reset sudah dikirim ke Telegram kamu. Masukkan kode dan password baru di bawah.',
            codeSent: true,
            email: user.email
          }));
        }

        delete req.session.passwordReset;
      }

      await notifyPasswordResetManagers(req, user);
      return res.render('auth/forgot', forgotView({
        success: 'Telegram akun ini belum aktif/gagal dikirim. Request reset diteruskan ke Owner/Admin.',
        fallbackToAdmin: true
      }));
    }

    res.render('auth/forgot', forgotView({ success: genericSuccess }));
  } catch (error) {
    console.error(error);
    res.render('auth/forgot', forgotView({ error: 'Terjadi kesalahan. Coba lagi.' }));
  }
});

router.post('/forgot/reset', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const newPassword = String(req.body.newPassword || '');
  const confirmPassword = String(req.body.confirmPassword || '');
  const challenge = req.session.passwordReset;

  try {
    if (!challenge || challenge.email !== email) {
      return res.render('auth/forgot', forgotView({
        error: 'Sesi reset tidak ditemukan. Minta kode baru.',
        email
      }));
    }

    if (Date.now() > challenge.expiresAt) {
      delete req.session.passwordReset;
      return res.render('auth/forgot', forgotView({
        error: 'Kode reset sudah kedaluwarsa. Minta kode baru.',
        email
      }));
    }

    if (newPassword !== confirmPassword) {
      return res.render('auth/forgot', forgotView({
        error: 'Konfirmasi password tidak cocok',
        codeSent: true,
        email
      }));
    }

    if (newPassword.length < 6) {
      return res.render('auth/forgot', forgotView({
        error: 'Password baru minimal 6 karakter',
        codeSent: true,
        email
      }));
    }

    const codeValid = await bcrypt.compare(code, challenge.codeHash);
    if (!codeValid) {
      challenge.attempts = (challenge.attempts || 0) + 1;
      req.session.passwordReset = challenge;
      if (challenge.attempts >= RESET_MAX_ATTEMPTS) {
        delete req.session.passwordReset;
        return res.render('auth/forgot', forgotView({
          error: 'Kode salah terlalu banyak. Minta kode baru.',
          email
        }));
      }

      return res.render('auth/forgot', forgotView({
        error: 'Kode reset tidak valid',
        codeSent: true,
        email
      }));
    }

    await prisma.user.update({
      where: { id: challenge.userId },
      data: { password: await bcrypt.hash(newPassword, 10) }
    });

    delete req.session.passwordReset;
    req.flash('success', 'Password berhasil direset. Silakan masuk dengan password baru.');
    res.redirect('/auth/login');
  } catch (error) {
    console.error(error);
    res.render('auth/forgot', forgotView({
      error: 'Gagal reset password. Coba lagi.',
      codeSent: !!challenge,
      email
    }));
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/auth/login'));
});

module.exports = router;
