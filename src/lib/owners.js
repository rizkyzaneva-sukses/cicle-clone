const DEFAULT_OWNER_EMAILS = ['rizkyzaneva@gmail.com'];

function configuredOwnerEmails() {
  const raw = process.env.OWNER_EMAILS || DEFAULT_OWNER_EMAILS.join(',');
  return raw
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

function isConfiguredOwner(email) {
  return configuredOwnerEmails().includes(String(email || '').toLowerCase());
}

module.exports = { isConfiguredOwner };
