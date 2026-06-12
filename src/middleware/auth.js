const prisma = require('../lib/prisma');

function requireAuth(req, res, next) {
  if (!req.session.user) {
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/auth/login');
  }
  next();
}

// Hanya Owner platform
function requireOwner(req, res, next) {
  if (req.session.user?.platformRole !== 'owner') {
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.status(403).json({ error: 'Hanya Owner yang diizinkan' });
    }
    req.flash('error', 'Hanya Owner yang bisa melakukan aksi ini');
    return res.redirect('/');
  }
  next();
}

// Owner ATAU Partner yang punya akses ke brand ini ATAU Admin brand
async function requireBrandManager(req, res, next) {
  try {
    const { id: userId, platformRole } = req.session.user || {};
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    if (platformRole === 'owner') return next();

    const companyId = await resolveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Brand tidak ditemukan' });

    if (platformRole === 'partner') {
      const access = await prisma.partnerAccess.findUnique({
        where: { userId_companyId: { userId, companyId } }
      });
      if (access) return next();

      const brand = await prisma.company.findUnique({
        where: { id: companyId },
        select: { workspaceId: true }
      });
      if (brand?.workspaceId) {
        const workspaceAccess = await prisma.workspacePartner.findUnique({
          where: { userId_workspaceId: { userId, workspaceId: brand.workspaceId } }
        });
        if (workspaceAccess) return next();
      }
    }

    const membership = await prisma.membership.findFirst({
      where: { userId, companyId, role: 'admin' }
    });
    if (membership) return next();

    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }
    req.flash('error', 'Kamu tidak punya akses untuk aksi ini');
    return res.redirect('back');
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Alias agar route lama tidak perlu diubah
const requireAdmin = requireBrandManager;

// Helper: ambil companyId dari berbagai sumber request
async function resolveCompanyId(req) {
  let companyId = req.params.companyId || req.body.companyId || req.query.companyId;
  if (!companyId && req.params.projectId) {
    const p = await prisma.project.findUnique({
      where: { id: req.params.projectId },
      select: { companyId: true }
    });
    if (p) companyId = p.companyId;
  }
  if (!companyId && req.params.id) {
    const p = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { companyId: true }
    }).catch(() => null);
    if (p) companyId = p.companyId;
  }
  return companyId || null;
}

module.exports = { requireAuth, requireOwner, requireAdmin, requireBrandManager };
