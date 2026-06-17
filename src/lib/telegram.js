const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || null;
const enabled = Boolean(BOT_TOKEN);

async function sendTelegramMessage(chatId, text) {
  if (!enabled || !chatId) return null;

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram send failed:', data.description);
    return data;
  } catch (err) {
    console.error('Telegram send error:', err.message);
    return null;
  }
}

module.exports = { sendTelegramMessage, enabled, botUsername: BOT_USERNAME };
