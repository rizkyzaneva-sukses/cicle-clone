const { logActivity } = require('./activity');

async function syncProjectArchiveState(prisma, projectId, req = null) {
  if (!projectId) return { changed: false };

  const [project, taskCount, openTaskCount] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, archivedAt: true }
    }),
    prisma.task.count({ where: { projectId } }),
    prisma.task.count({ where: { projectId, status: { not: 'DONE' } } })
  ]);

  if (!project) return { changed: false };

  if (taskCount > 0 && openTaskCount === 0 && !project.archivedAt) {
    const archivedAt = new Date();
    await prisma.project.update({
      where: { id: project.id },
      data: { archivedAt }
    });
    if (req) {
      await logActivity(prisma, req, {
        action: 'archived',
        entityType: 'project',
        entityId: project.id,
        projectId: project.id,
        metadata: { name: project.name, auto: true }
      });
    }
    return { changed: true, status: 'archived', archivedAt };
  }

  if (openTaskCount > 0 && project.archivedAt) {
    await prisma.project.update({
      where: { id: project.id },
      data: { archivedAt: null }
    });
    if (req) {
      await logActivity(prisma, req, {
        action: 'unarchived',
        entityType: 'project',
        entityId: project.id,
        projectId: project.id,
        metadata: { name: project.name, auto: true }
      });
    }
    return { changed: true, status: 'unarchived' };
  }

  return { changed: false };
}

module.exports = { syncProjectArchiveState };
