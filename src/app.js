require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const flash = require('connect-flash');
const prisma = require('./lib/prisma');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.set('io', io);

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

  if (req.session.user) {
    const { id: userId, platformRole } = req.session.user;
    try {
      const [unreadCount, directUnreadCount] = await Promise.all([
        prisma.notification.count({ where: { userId, isRead: false } }),
        prisma.directMessage.count({ where: { receiverId: userId, readAt: null } })
      ]);
      res.locals.unreadNotifications = unreadCount;
      res.locals.unreadDirectMessages = directUnreadCount;

      // Current company context (untuk sidebar workspace label)
      if (platformRole === 'owner') {
        const c = await prisma.company.findFirst({ orderBy: { createdAt: 'asc' } });
        res.locals.currentCompany = c;
      } else if (platformRole === 'partner') {
        const pa = await prisma.partnerAccess.findFirst({
          where: { userId }, include: { company: true }
        });
        res.locals.currentCompany = pa?.company || null;
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

// Dashboard — tampil berbeda per role
app.get('/', async (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login');

  const { id: userId, platformRole } = req.session.user;

  if (platformRole === 'owner') {
    // Owner: semua brand + statistik global
    const brands = await prisma.company.findMany({
      include: {
        partnerAccess: { include: { user: true } },
        projects: true,
        memberships: true
      },
      orderBy: { createdAt: 'desc' }
    });

    const [totalTasks, tasksDone, tasksPending, totalMembers] = await Promise.all([
      prisma.task.count(),
      prisma.task.count({ where: { status: 'DONE' } }),
      prisma.task.count({ where: { status: { in: ['TODO', 'IN_PROGRESS'] } } }),
      prisma.membership.count()
    ]);

    return res.render('dashboard-owner', {
      title: 'Dashboard Owner',
      brands, totalTasks, tasksDone, tasksPending, totalMembers
    });
  }

  if (platformRole === 'partner') {
    // Partner: brand yang dia kelola
    const partnerBrands = await prisma.partnerAccess.findMany({
      where: { userId },
      include: {
        company: {
          include: { projects: true, memberships: true }
        }
      }
    });

    const brandIds = partnerBrands.map(p => p.companyId);
    const [tasksDone, tasksPending] = await Promise.all([
      prisma.task.count({ where: { project: { companyId: { in: brandIds } }, status: 'DONE' } }),
      prisma.task.count({ where: { project: { companyId: { in: brandIds } }, status: { in: ['TODO', 'IN_PROGRESS'] } } })
    ]);

    return res.render('dashboard-partner', {
      title: 'Dashboard Partner',
      brands: partnerBrands.map(p => p.company),
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
  console.log(`🚀 Cicle Clone running on port ${PORT} (listening on 0.0.0.0)`);
  console.log('Ready for EasyPanel deployment!');
});
