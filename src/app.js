require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const flash = require('connect-flash');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'cicle-secret-key-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 days
}));

app.use(flash());

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Make prisma and user available in views
app.use(async (req, res, next) => {
  res.locals.prisma = prisma;
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.flash();
  res.locals.currentPath = req.path;
  res.locals.currentCompany = null;
  res.locals.userRole = 'member';

  if (req.session.user) {
    try {
      const membership = await prisma.membership.findFirst({
        where: { userId: req.session.user.id },
        include: { company: true }
      });
      if (membership) {
        res.locals.currentCompany = membership.company;
        res.locals.userRole = membership.role;
      }
    } catch (_) {}
  }

  next();
});

// Routes
const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const taskRoutes = require('./routes/tasks');
const chatRoutes = require('./routes/chat');
const checklistRoutes = require('./routes/checklist');
const myTasksRoutes = require('./routes/my-tasks');
const panduanRoutes = require('./routes/panduan');
const membersRoutes = require('./routes/members');

app.use('/auth', authRoutes);
app.use('/projects', projectRoutes);
app.use('/tasks', taskRoutes);
app.use('/chat', chatRoutes);
app.use('/checklist', checklistRoutes);
app.use('/my-tasks', myTasksRoutes);
app.use('/panduan', panduanRoutes);
app.use('/members', membersRoutes);

// Home / Dashboard
app.get('/', async (req, res) => {
  if (!req.session.user) {
    return res.redirect('/auth/login');
  }

  const userId = req.session.user.id;
  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: { company: true }
  });

  const companies = memberships.map(m => m.company);

  let projects = [];
  let tasksDone = 0;
  let tasksPending = 0;

  if (companies.length > 0) {
    const companyId = companies[0].id;
    projects = await prisma.project.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: 6
    });
    tasksDone = await prisma.task.count({
      where: { project: { companyId }, status: 'DONE' }
    });
    tasksPending = await prisma.task.count({
      where: { project: { companyId }, status: { in: ['TODO', 'IN_PROGRESS'] } }
    });
  }

  res.render('dashboard', {
    companies,
    projects,
    activeCompany: companies[0] || null,
    tasksDone,
    tasksPending
  });
});

// Socket.io for real-time
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-project', (projectId) => {
    socket.join(`project-${projectId}`);
    console.log(`User joined project room: project-${projectId}`);
  });

  socket.on('task-updated', (data) => {
    // Broadcast to project room
    io.to(`project-${data.projectId}`).emit('task-updated', data);
  });

  socket.on('new-message', (data) => {
    io.to(`project-${data.projectId}`).emit('new-message', data);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Cicle Clone running on port ${PORT} (listening on 0.0.0.0)`);
  console.log('Ready for EasyPanel deployment!');
});
