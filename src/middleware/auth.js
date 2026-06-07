const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Middleware: Require user to be logged in
 */
function requireAuth(req, res, next) {
  if (!req.session.user) {
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/auth/login');
  }
  next();
}

/**
 * Middleware: Check if user is Admin in the company
 */
async function requireAdmin(req, res, next) {
  try {
    const userId = req.session.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Get companyId from params, body, or query
    let companyId = req.params.companyId || req.body.companyId || req.query.companyId;

    // If no companyId, try to get from project
    if (!companyId && req.params.projectId) {
      const project = await prisma.project.findUnique({
        where: { id: req.params.projectId },
        select: { companyId: true }
      });
      if (project) companyId = project.companyId;
    }

    if (!companyId) {
      return res.status(400).json({ error: 'Company ID required' });
    }

    const membership = await prisma.membership.findFirst({
      where: {
        userId,
        companyId,
        role: 'admin'
      }
    });

    if (!membership) {
      if (req.xhr || req.headers.accept?.includes('json')) {
        return res.status(403).json({ error: 'Hanya Admin yang diizinkan' });
      }
      req.flash('error', 'Hanya Admin yang bisa melakukan aksi ini');
      return res.redirect('back');
    }

    next();
  } catch (error) {
    console.error('Admin check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  requireAuth,
  requireAdmin
};
