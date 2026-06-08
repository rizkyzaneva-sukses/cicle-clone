async function logActivity(prisma, req, data) {
  try {
    await prisma.activityLog.create({
      data: {
        action: data.action,
        entityType: data.entityType,
        entityId: data.entityId,
        metadata: data.metadata || undefined,
        userId: req.session.user?.id || null,
        projectId: data.projectId || null,
        taskId: data.taskId || null
      }
    });
  } catch (error) {
    console.error('Activity log failed:', error.message);
  }
}

module.exports = { logActivity };
