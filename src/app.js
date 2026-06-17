require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const flash = require('connect-flash');
const prisma = require('./lib/prisma');
const { isConfiguredOwner } = require('./lib/owners');
const { cleanupOrphanRecords, ensureDefaultWorkspace, backfillProjectMembers } = require('./lib/maintenance');
const { startDailyScheduler } = require('./lib/scheduler');
const { runDailyReminders } = require('./lib/reminderScheduler');
const { runRecurringTaskGenerator } = require('./lib/recurringTasks');
const { maybeRunWeeklyReport } = require('./lib/weeklyReport');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.set('io', io);
let maintenancePromise = null;

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

// Global locals
app.use(async (req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.flash();
  res.locals.currentPath = req.path;
  res.locals.currentCompany = null;
  res.locals.userRole = 'member';
  res.locals.unreadNotifications = 0;
  res.locals.unreadDirectMessages = 0;
  res.locals.latestAnnouncement = null;

  if (req.session.user) {
    let { id: userId, platformRole } = req.session.user;
    try {
      maintenancePromise ||= Promise.all([cleanupOrphanRecords(), backfillProjectMembers()]).catch((err) => {
        maintenancePromise = null;
        console.error('Maintenance cleanup failed:', err);
      });
      await maintenancePromise;

      res.locals.latestAnnouncement = await prisma.announcement.findFirst({ orderBy: { createdAt: 'desc' } });

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

      const [unreadCount, directUnreadCount] = await Promise.all([
        prisma.notification.count({ where: { userId, isRead: false } }),
        prisma.directMessage.count({ where: { receiverId: userId, readAt: null } })
      ]);
      res.locals.unreadNotifications = unreadCount;
      res.locals.unreadDirectMessages = directUnreadCount;

      // Current workspace/brand context (untuk sidebar label)
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

// Routes
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

// Dashboard — tampil berbeda per role
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
              projects: true,
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
              brands: { include: { projects: true, memberships: true } }
            }
          }
        }
      });
      const workspaceBrands = workspaceRoles.flatMap(role => role.workspace.brands);
      const partnerBrands = await prisma.partnerAccess.findMany({
        where: { userId },
        include: {
          company: {
            include: { projects: true, memberships: true }
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

    // Admin/Member: brand mereka saja
    const memberships = await prisma.membership.findMany({
      where: { userId },
      include: { company: true }
    });
    const companies = memberships.map(m => m.company);

    let projects = [], tasksDone = 0, tasksPending = 0;
    if (companies.length > 0) {
      const companyId = companies[0].id;
      [projects, tasksDone, tasksPending] = await Promise.all([
        prisma.project.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' }, take: 6 }),
        prisma.task.count({ where: { project: { companyId }, status: 'DONE' } }),
        prisma.task.count({ where: { project: { companyId }, status: { in: ['TODO', 'IN_PROGRESS'] } } })
      ]);
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

// Socket.io
io.on('connection', (socket) => {
  socket.on('join-project', (projectId) => socket.join(`project-${projectId}`));
  socket.on('join-user', (userId) => socket.join(`user-${userId}`));
  socket.on('task-updated', (data) => io.to(`project-${data.projectId}`).emit('task-updated', data));
  socket.on('new-message', (data) => io.to(`project-${data.projectId}`).emit('new-message', data));
  socket.on('direct-message', (data) => io.to(`user-${data.receiverId}`).emit('new-direct-message', data));
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Maulana Corp Project Management running on port ${PORT} (listening on 0.0.0.0)`);
  console.log('Ready for EasyPanel deployment!');
  startDailyScheduler(io, [runDailyReminders, runRecurringTaskGenerator, maybeRunWeeklyReport]);
});
