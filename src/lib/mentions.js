// Frontend inserts the mentioned user's exact full name after "@", so a plain substring
// match against "@<name>" is reliable enough without a full markup/markdown mention syntax.
function extractMentionedUserIds(content, candidates) {
  if (!content) return [];
  const ids = new Set();

  // Check for @team mention — returns all candidate IDs (broadcast to everyone)
  if (/@team\b/i.test(content)) {
    for (const candidate of candidates) {
      if (candidate?.id) {
        ids.add(candidate.id);
      }
    }
    return [...ids];
  }

  for (const candidate of candidates) {
    if (candidate?.name && content.includes(`@${candidate.name}`)) {
      ids.add(candidate.id);
    }
  }
  return [...ids];
}

module.exports = { extractMentionedUserIds };
