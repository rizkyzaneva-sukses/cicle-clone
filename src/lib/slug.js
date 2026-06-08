function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workspace';
}

function uniqueSlug(value) {
  return `${slugify(value)}-${Date.now()}`;
}

module.exports = { slugify, uniqueSlug };
