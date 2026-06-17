const prisma = require('./prisma');

/**
 * Calculate project health score based on multiple factors
 * @param {string} projectId - Project ID
 * @returns {Promise<{score: number, breakdown: object}>}
 */
async function calculateProjectHealthScore(projectId) {
  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Get project with tasks
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      tasks: true,
      messages: {
        where: { createdAt: { gte: oneWeekAgo } }
      }
    }
  });

  if (!project) return { score: 0, breakdown: {} };

  const tasks = project.tasks;
  const totalTasks = tasks.length;

  if (totalTasks === 0) {
    return { score: 50, breakdown: { note: 'No tasks yet' } };
  }

  // 1. Overdue Rate (40% weight)
  const overdueTasks = tasks.filter(t => 
    t.dueDate && new Date(t.dueDate) < now && t.status !== 'DONE'
  ).length;
  const overdueRate = totalTasks > 0 ? (overdueTasks / totalTasks) * 100 : 0;
  const overdueScore = Math.max(0, 100 - overdueRate * 2); // Higher overdue = lower score

  // 2. Completion Rate (30% weight)
  const completedTasks = tasks.filter(t => t.status === 'DONE').length;
  const completionRate = (completedTasks / totalTasks) * 100;
  const completionScore = completionRate;

  // 3. Activity Level - messages/comments this week (20% weight)
  const recentMessages = project.messages.length;
  const activityScore = Math.min(100, recentMessages * 10); // Cap at 100

  // 4. Member Engagement (10% weight)
  const projectMembers = await prisma.projectMember.findMany({
    where: { projectId }
  });
  const totalMembers = projectMembers.length;
  
  let activeMembers = 0;
  if (totalMembers > 0) {
    // Check who was active this week via activity logs
    const activeUserIds = await prisma.activityLog.findMany({
      where: {
        projectId,
        createdAt: { gte: oneWeekAgo }
      },
      select: { userId: true },
      distinct: ['userId']
    });
    activeMembers = activeUserIds.length;
  }
  
  const engagementRate = totalMembers > 0 ? (activeMembers / totalMembers) * 100 : 0;
  const engagementScore = engagementRate;

  // Calculate weighted score
  const score = Math.round(
    (overdueScore * 0.4) +
    (completionScore * 0.3) +
    (activityScore * 0.2) +
    (engagementScore * 0.1)
  );

  return {
    score: Math.max(0, Math.min(100, score)),
    breakdown: {
      overdue: { rate: Math.round(overdueRate), score: Math.round(overdueScore), weight: 40 },
      completion: { rate: Math.round(completionRate), score: Math.round(completionScore), weight: 30 },
      activity: { messages: recentMessages, score: Math.round(activityScore), weight: 20 },
      engagement: { rate: Math.round(engagementRate), score: Math.round(engagementScore), weight: 10 }
    }
  };
}

/**
 * Get health indicator emoji based on score
 * @param {number} score 
 * @returns {string}
 */
function getHealthIndicator(score) {
  if (score > 80) return '🟢';
  if (score >= 50) return '🟡';
  return '🔴';
}

/**
 * Get health status label
 * @param {number} score 
 * @returns {string}
 */
function getHealthStatus(score) {
  if (score > 80) return 'Baik';
  if (score >= 50) return 'Sedang';
  return 'Kritis';
}

module.exports = {
  calculateProjectHealthScore,
  getHealthIndicator,
  getHealthStatus
};
