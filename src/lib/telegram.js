const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || null;
const enabled = Boolean(BOT_TOKEN);

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
  if (!BOT_USERNAME) return null;
  const payload = String(userId || '').trim();
  return payload
    ? `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(payload)}`
    : `https://t.me/${BOT_USERNAME}`;
}

module.exports = { 
  sendTelegramMessage, 
  sendTaskReminder,
  sendDeadlineAlert,
  getDeepLink,
  enabled, 
  botUsername: BOT_USERNAME 
 };
