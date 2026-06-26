function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function trimTrailingPunctuation(url) {
  let cleanUrl = String(url || '');
  let trailing = '';

  while (/[),.!?;:\]}]/.test(cleanUrl.slice(-1))) {
    trailing = cleanUrl.slice(-1) + trailing;
    cleanUrl = cleanUrl.slice(0, -1);
  }

  return { cleanUrl, trailing };
}

function normalizeUrl(url) {
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

function renderPlainText(text) {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

function renderAnnouncementHtml(content) {
  const text = String(content ?? '');
  const urlPattern = /((?:https?:\/\/|www\.)[^\s<]+)/gi;
  let lastIndex = 0;
  let html = '';

  for (const match of text.matchAll(urlPattern)) {
    const [rawUrl] = match;
    const matchIndex = match.index ?? 0;
    const { cleanUrl, trailing } = trimTrailingPunctuation(rawUrl);

    html += renderPlainText(text.slice(lastIndex, matchIndex));

    if (cleanUrl) {
      const href = escapeHtml(normalizeUrl(cleanUrl));
      html += `<a href="${href}" target="_blank" rel="noopener noreferrer" class="font-medium underline underline-offset-2 break-all">${escapeHtml(cleanUrl)}</a>`;
    }

    if (trailing) html += escapeHtml(trailing);
    lastIndex = matchIndex + rawUrl.length;
  }

  html += renderPlainText(text.slice(lastIndex));
  return html;
}

module.exports = {
  escapeHtml,
  renderAnnouncementHtml
};
