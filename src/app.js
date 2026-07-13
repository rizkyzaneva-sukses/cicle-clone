require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const flash = require('connect-flash');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const prisma = require('./lib/prisma');
const { isConfiguredOwner } = require('./lib/owners');
const { ensureBrandProfileFields, ensureProjectReportTables, ensureProjectChatReadTable, ensureTaskProgressUpdateTable, ensureAnnouncementImageFields, ensureAnnouncementScopeFields, cleanupOrphanRecords, ensureDefaultWorkspace, backfillProjectMembers, applyAccountHotfixes, ensureOnboardingField, ensureDndFields, ensureMyDayField, ensureChatMessageParentField, ensurePerformanceIndexes } = require('./lib/maintenance');
const { startDailyScheduler } = require('./lib/scheduler');
const { runDailyReminders } = require('./lib/reminderScheduler');
const { runRecurringTaskGenerator } = require('./lib/recurringTasks');
const { maybeRunWeeklyReport } = require('./lib/weeklyReport');
const { ensureTelegramWebhook } = require('./lib/telegram');
const { renderAnnouncementHtml } = require('./lib/announcementFormatter');
const { getLatestAnnouncementForUser, getAnnouncementScopeLabel } = require('./lib/announcementAudience');
const { errorHandler } = require('./lib/errorHandler');

// ==========================================
// 1. SESSION SECRET VALIDATION
// ==========================================
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'cicle-secret-key-change-in-prod')) {
  console.error('FATAL: SESSION_SECRET must be set in production. Refusing to start.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Memperbaiki deteksi IP asli di balik reverse proxy (EasyPanel/Traefik)
const server = http.createServer(app);

// ==========================================
// 2. SOCKET.IO WITH AUTH MIDDLEWARE
// ==========================================
const io = new Server(server);

// Socket.io auth middleware - verify session
io.use((socket, next) => {
  const userId = socket.handshake.auth?.userId;
  const userName = socket.handshake.auth?.userName;
  if (userId) {
    socket.data.userId = userId;
    socket.data.userName = userName || 'User';
    return next();
  }
  // Allow connection without auth for backward compat, but mark as unauthenticated
  socket.data.userId = null;
  next();
});

app.set('io', io);

// ==========================================
// 3. MAINTENANCE LOCK (prevents parallel runs)
// ==========================================
let maintenancePromise = null;
let maintenanceRunning = false;

async function runMaintenance() {
  if (maintenanceRunning) return maintenancePromise;
  maintenanceRunning = true;
  maintenancePromise = Promise.all([
    ensureBrandProfileFields(),
    ensureProjectReportTables(),
    ensureProjectChatReadTable(),
    ensureTaskProgressUpdateTable(),
    ensureAnnouncementImageFields(),
    ensureAnnouncementScopeFields(),
    cleanupOrphanRecords(),
    backfillProjectMembers(),
    applyAccountHotfixes(),
    ensureOnboardingField(),
    ensureDndFields(),
    ensureMyDayField(),
    ensureChatMessageParentField(),
    ensurePerformanceIndexes()
  ]).catch((err) => {
    console.error('Maintenance cleanup failed:', err);
  }).finally(() => {
    maintenanceRunning = false;
  });
  return maintenancePromise;
}

// ==========================================
// 4. RATE LIMITING
// ==========================================
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.' },
  standardHeaders: true,
  legacyHeaders: false
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Terlalu banyak pendaftaran. Coba lagi dalam 1 jam.' },
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: { error: 'Terlalu banyak request. Coba lagi nanti.' },
  standardHeaders: true,
  legacyHeaders: false
});

// ==========================================
// 5. CSRF PROTECTION
// ==========================================
function generateCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function csrfProtection(req, res, next) {
  // Skip for GET, HEAD, OPTIONS (safe methods)
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    res.locals.csrfToken = generateCsrfToken(req);
    return next();
  }

  // Skip for JSON API requests (they use session auth)
  if (req.is('json') || req.headers.accept?.includes('json')) {
    return next();
  }

  // Skip for file uploads (multipart)
  if (req.is('multipart/*')) {
    return next();
  }

  // Skip for same-origin fetch/XHR calls. Sec-Fetch-Site is set by the
  // browser itself and cannot be spoofed by a cross-site attacker page,
  // so this safely covers in-app AJAX calls that don't carry a _csrf field.
  if (req.headers['sec-fetch-site'] === 'same-origin') {
    return next();
  }

  const token = req.body._csrf || req.headers['x-csrf-token'];
  const sessionToken = req.session.csrfToken;

  if (!token || !sessionToken || token !== sessionToken) {
    return res.status(403).send('CSRF token tidak valid');
  }

  res.locals.csrfToken = generateCsrfToken(req);
  next();
}

// ==========================================
// MIDDLEWARE SETUP
// ==========================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'cicle-secret-key-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

app.use(flash());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Apply CSRF to form routes
app.use(csrfProtection);

// Global locals
app.use(async (req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.flash();
  res.locals.currentPath = req.path;
  res.locals.currentCompany = null;
  res.locals.userRole = 'member';
  res.locals.unreadNotifications = 0;
  res.locals.unreadNotificationGroups = { PROJECT_TASK: 0, DIRECT_CHAT: 0, OTHER: 0 };
  res.locals.unreadDirectMessages = 0;
  res.locals.latestAnnouncement = null;
  res.locals.renderAnnouncementHtml = renderAnnouncementHtml;
  res.locals.getAnnouncementScopeLabel = getAnnouncementScopeLabel;
  res.locals.csrfToken = req.session?.csrfToken || '';

  if (req.session.user) {
    let { id: userId, platformRole } = req.session.user;
    try {
      await runMaintenance();

      res.locals.latestAnnouncement = await getLatestAnnouncementForUser(req.session.user);

      if (isConfiguredOwner(req.session.user.email) && platformRole !== 'owner') {
        await prisma.user.update({
          where: { id: userId },
          data: { platformRole: 'owner' }
        });
        req.session.user.platformRole = 'owner';
        platformRole = 'owner';
        res.locals.currentUser = req.session.user;
      }
      await ensureDefaultWorkspace(prisma, req.session.user);

      const [unreadCount, unreadNotificationGroups, directUnreadCount] = await Promise.all([
        prisma.notification.count({ where: { userId, isRead: false } }),
        prisma.notification.groupBy({
          by: ['type'],
          where: { userId, isRead: false },
          _count: { _all: true }
        }),
        prisma.directMessage.count({ where: { receiverId: userId, readAt: null } })
      ]);
      res.locals.unreadNotifications = unreadCount;
      unreadNotificationGroups.forEach((group) => {
        res.locals.unreadNotificationGroups[group.type] = group._count._all;
      });
      res.locals.unreadDirectMessages = directUnreadCount;

      // Current workspace/brand context
      if (platformRole === 'owner') {
        res.locals.currentCompany = await prisma.workspace.findFirst({ orderBy: { createdAt: 'asc' } });
      } else if (platformRole === 'partner') {
        const wp = await prisma.workspacePartner.findFirst({
          where: { userId },
          include: { workspace: true }
        });
        if (wp) {
          res.locals.currentCompany = wp.workspace;
        } else {
          const pa = await prisma.partnerAccess.findFirst({
            where: { userId }, include: { company: true }
          });
          res.locals.currentCompany = pa?.company || null;
        }
      } else {
        const m = await prisma.membership.findFirst({
          where: { userId }, include: { company: true }
        });
        res.locals.currentCompany = m?.company || null;
        res.locals.userRole = m?.role || 'member';
      }
    } catch (_) {}
  }

  next();
});

// Onboarding redirect
app.use(async (req, res, next) => {
  if (req.session.user && !req.path.startsWith('/onboarding') && !req.path.startsWith('/auth') && !req.path.startsWith('/telegram/webhook') && req.method === 'GET') {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.session.user.id },
        select: { onboardingCompleted: true }
      });
      if (user && !user.onboardingCompleted) {
        return res.redirect('/onboarding');
      }
    } catch (_) {}
  }
  next();
});

// ==========================================
// 6. ROUTES
// ==========================================
// Apply rate limiters to specific routes
app.use('/auth/login', loginLimiter);
app.use('/auth/register', registerLimiter);
app.use('/api', apiLimiter);

// Existing routes
app.use('/auth', require('./routes/auth'));
app.use('/brands', require('./routes/brands'));
app.use('/projects', require('./routes/projects'));
app.use('/tasks', require('./routes/tasks'));
app.use('/chat', require('./routes/chat'));
app.use('/checklist', require('./routes/checklist'));
app.use('/my-tasks', require('./routes/my-tasks'));
app.use('/panduan', require('./routes/panduan'));
app.use('/members', require('./routes/members'));
app.use('/profile', require('./routes/profile'));
app.use('/notifications', require('./routes/notifications'));
app.use('/inbox', require('./routes/inbox'));
app.use('/search', require('./routes/search'));
app.use('/reminders', require('./routes/reminders'));
app.use('/workspaces', require('./routes/workspaces'));
app.use('/invite', require('./routes/invite'));
app.use('/admin', require('./routes/admin'));
app.use('/templates', require('./routes/templates'));
app.use('/performance', require('./routes/performance'));
app.use('/dependencies', require('./routes/dependencies'));
app.use('/calendar', require('./routes/calendar'));
app.use('/announcements', require('./routes/announcements'));
app.use('/focus', require('./routes/focus'));
app.use('/telegram', require('./routes/telegram'));
app.use('/activity', require('./routes/activity'));
app.use('/onboarding', require('./routes/onboarding'));

// NEW routes
app.use('/export', require('./routes/export'));
app.use('/workload', require('./routes/workload'));
app.use('/bulk', require('./routes/bulk'));
app.use('/my-day', require('./routes/my-day'));

// Dashboard
app.get('/', async (req, res) => {
  try {
    if (!req.session.user) return res.redirect('/auth/login');

    const { id: userId, platformRole } = req.session.user;

    if (platformRole === 'owner') {
      await ensureDefaultWorkspace(prisma, req.session.user);
      const workspaces = await prisma.workspace.findMany({
        include: {
          partners: { include: { user: true } },
          brands: {
            include: {
              partnerAccess: { include: { user: true } },
              projects: { where: { archivedAt: null } },
              memberships: true
            },
            orderBy: { createdAt: 'desc' }
          }
        },
        orderBy: { createdAt: 'desc' }
      });
      const brands = workspaces.flatMap(workspace => workspace.brands);

      const [totalTasks, tasksDone, tasksPending, totalMembers] = await Promise.all([
      prisma.task.count(),
      prisma.task.count({ where: { status: 'DONE' } }),
      prisma.task.count({ where: { status: { in: ['TODO', 'IN_PROGRESS'] } } }),
      prisma.membership.count()
      ]);

      return res.render('dashboard-owner', {
      title: 'Dashboard Owner',
      workspaces, brands, totalTasks, tasksDone, tasksPending, totalMembers
      });
    }

    if (platformRole === 'partner') {
      const workspaceRoles = await prisma.workspacePartner.findMany({
        where: { userId },
        include: {
          workspace: {
            include: {
              brands: { include: { projects: { where: { archivedAt: null } }, memberships: true } }
            }
          }
        }
      });
      const workspaceBrands = workspaceRoles.flatMap(role => role.workspace.brands);
      const partnerBrands = await prisma.partnerAccess.findMany({
        where: { userId },
        include: {
          company: {
            include: { projects: { where: { archivedAt: null } }, memberships: true }
          }
        }
      });

      const brandsById = new Map();
      [...workspaceBrands, ...partnerBrands.map(p => p.company)].forEach(brand => {
        if (brand) brandsById.set(brand.id, brand);
      });
      const brands = [...brandsById.values()];
      const brandIds = brands.map(brand => brand.id);
      const [tasksDone, tasksPending] = await Promise.all([
        prisma.task.count({ where: { project: { companyId: { in: brandIds } }, status: 'DONE' } }),
        prisma.task.count({ where: { project: { companyId: { in: brandIds } }, status: { in: ['TODO', 'IN_PROGRESS'] } } })
      ]);

      return res.render('dashboard-partner', {
      title: 'Dashboard Partner',
      workspaceRoles,
      brands,
      tasksDone, tasksPending
      });
    }

    // Admin/Member
    const memberships = await prisma.membership.findMany({
      where: { userId },
      include: { company: true }
    });
    const companies = memberships.map(m => m.company);

    let projects = [], tasksDone = 0, tasksPending = 0;
    if (companies.length > 0) {
      const companyId = companies[0].id;
      [projects, tasksDone, tasksPending] = await Promise.all([
        prisma.project.findMany({ where: { companyId, archivedAt: null }, orderBy: { createdAt: 'desc' }, take: 6 }),
        prisma.task.count({ where: { project: { companyId }, status: 'DONE' } }),
        prisma.task.count({ where: { project: { companyId }, status: { in: ['TODO', 'IN_PROGRESS'] } } })
      ]);
      
      const { calculateProjectHealthScore, getHealthIndicator } = require('./lib/health');
      for (const project of projects) {
        try {
          const { score } = await calculateProjectHealthScore(project.id);
          project.healthScore = score;
          project.healthIndicator = getHealthIndicator(score);
        } catch (healthErr) {
          console.error('Dashboard health score failed:', healthErr);
          project.healthScore = null;
          project.healthIndicator = null;
        }
      }
    }

    res.render('dashboard', {
      title: 'Dashboard',
      companies, projects, activeCompany: companies[0] || null, tasksDone, tasksPending
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Gagal membuka dashboard. Coba refresh beberapa saat lagi.');
  }
});

// ==========================================
// 7. SOCKET.IO WITH PROJECT ACCESS CHECK
// ==========================================
io.on('connection', (socket) => {
  socket.on('join-project', async (projectId) => {
    // Verify project access before allowing join
    if (socket.data.userId) {
      try {
        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { id: true, companyId: true }
        });
        if (project) {
          const { hasProjectAccess } = require('./lib/access');
          const user = await prisma.user.findUnique({
            where: { id: socket.data.userId },
            select: { id: true, platformRole: true }
          });
          if (user) {
            const hasAccess = await hasProjectAccess(user, project);
            if (hasAccess) {
              socket.join(`project-${projectId}`);
              return;
            }
          }
        }
      } catch (_) {}
    }
    // Fallback: allow join for backward compat
    socket.join(`project-${projectId}`);
  });

  socket.on('join-user', (userId) => {
    if (socket.data.userId && socket.data.userId !== userId) return;
    socket.join(`user-${userId}`);
  });

  socket.on('task-updated', (data) => io.to(`project-${data.projectId}`).emit('task-updated', data));
  socket.on('new-message', (data) => io.to(`project-${data.projectId}`).emit('new-message', data));
  socket.on('direct-message', (data) => io.to(`user-${data.receiverId}`).emit('new-direct-message', data));
});

// ==========================================
// 8. ERROR HANDLER WITH ERROR ID
// ==========================================
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Maulana Corp Project Management running on port ${PORT} (listening on 0.0.0.0)`);
  console.log('Ready for EasyPanel deployment!');
  applyAccountHotfixes().catch((err) => console.error('Startup account hotfix failed:', err));
  ensureTelegramWebhook().catch((err) => console.error('Telegram webhook setup failed:', err));
  startDailyScheduler(io, [runDailyReminders, runRecurringTaskGenerator, maybeRunWeeklyReport]);
});
