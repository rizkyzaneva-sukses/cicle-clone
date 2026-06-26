const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'zanevabasecamp_bot';
const enabled = Boolean(BOT_TOKEN);
let webhookSetupPromise = null;
let webhookSetupUrl = '';

async function sendTelegramMessage(chatId, text) {
  if (!enabled || !chatId) return null;

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram send failed:', data.description);
    return data;
  } catch (err) {
    console.error('Telegram send error:', err.message);
    return null;
  }
}

async function sendTelegramPhoto(chatId, photoUrl, caption = '') {
  if (!enabled || !chatId || !photoUrl) return null;

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption,
        parse_mode: 'HTML'
      })
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram photo send failed:', data.description);
    return data;
  } catch (err) {
    console.error('Telegram photo send error:', err.message);
    return null;
  }
}

async function sendTaskReminder(chatId, task) {
  const text = `📋 <b>Task Reminder</b>\n\n` +
    `<b>${task.title}</b>\n` +
    `Proyek: ${task.project?.name || 'Unknown'}\n` +
    `Status: ${task.status}\n` +
    `Batas: ${task.dueDate ? new Date(task.dueDate).toLocaleDateString('id-ID') : 'Tidak ada'}`;
  
  return sendTelegramMessage(chatId, text);
}

async function sendDeadlineAlert(chatId, task) {
  const dueDate = new Date(task.dueDate);
  const now = new Date();
  const diffDays = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));
  
  let urgency = '⏰';
  let timeLabel = '';
  
  if (diffDays < 0) {
    urgency = '🚨';
    timeLabel = `OVERDUE ${Math.abs(diffDays)} hari!`;
  } else if (diffDays === 0) {
    timeLabel = 'Hari ini!';
  } else if (diffDays === 1) {
    timeLabel = 'Besok!';
  } else {
    timeLabel = `${diffDays} hari lagi`;
  }
  
  const text = `${urgency} <b>Deadline Alert</b>\n\n` +
    `<b>${task.title}</b>\n` +
    `Proyek: ${task.project?.name || 'Unknown'}\n` +
    `Deadline: ${dueDate.toLocaleDateString('id-ID')}\n` +
    `Sisa waktu: ${timeLabel}`;
  
  return sendTelegramMessage(chatId, text);
}

function getDeepLink(userId = '') {
  const payload = String(userId || '').trim();
  return payload
    ? `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(payload)}`
    : `https://t.me/${BOT_USERNAME}`;
}

async function ensureTelegramWebhook(appUrl = process.env.APP_URL) {
  if (!enabled || !appUrl) return null;

  const baseUrl = String(appUrl).replace(/\/+$/, '');
  const webhookUrl = `${baseUrl}/telegram/webhook/${BOT_TOKEN}`;
  if (webhookSetupPromise && webhookSetupUrl === webhookUrl) return webhookSetupPromise;

  webhookSetupUrl = webhookUrl;
  webhookSetupPromise = (async () => {
    try {
      const infoRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
      const info = await infoRes.json();
      if (info?.ok && info.result?.url === webhookUrl) return info.result;

      const setRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          allowed_updates: ['message']
        })
      });
      const data = await setRes.json();
      if (!data.ok) console.error('Telegram webhook setup failed:', data.description);
      else console.log('Telegram webhook configured:', webhookUrl.replace(BOT_TOKEN, '[token]'));
      return data;
    } catch (err) {
      console.error('Telegram webhook setup error:', err.message);
      webhookSetupPromise = null;
      return null;
    }
  })();

  return webhookSetupPromise;
}

module.exports = { 
  sendTelegramMessage, 
  sendTelegramPhoto,
  sendTaskReminder,
  sendDeadlineAlert,
  getDeepLink,
  ensureTelegramWebhook,
  enabled, 
  botUsername: BOT_USERNAME 
 };
