const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// My Tasks - semua tugas yang di-assign ke user
router.get('/', async (req, res) => {
  const userId = req.session.user.id;

  const tasks = await prisma.task.findMany({
    where: {
      assigneeId: userId
    },
    include: {
      project: {
        include: { company: true }
      },
      assignee: true
    },
    orderBy: [
      { status: 'asc' },
      { dueDate: 'asc' }
    ]
  });

  res.render('my-tasks', { tasks });
});

module.exports = router;
