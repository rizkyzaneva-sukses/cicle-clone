const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { sendTelegramMessage, sendTaskReminder, sendDeadlineAlert, enabled } = require('../lib/telegram');
const { requireAuth } = require('../middleware/auth');

// Webhook endpoint for Telegram Bot
router.post('/webhook/:botToken', async (req, res) => {
  try {
    const { botToken } = req.params;
    const expectedToken = process.env.TELEGRAM_BOT_TOKEN;
    
    // Verify bot token
    if (botToken !== expectedToken) {
      return res.status(403).json({ error: 'Invalid bot token' });
    }

    const update = req.body;
    
    // Handle /start command
    if (update.message?.text?.startsWith('/start')) {
      const chatId = update.message.chat.id;
      const userId = update.message.text.split(' ')[1]; // /start connect
      
      if (userId) {
        // Link Telegram chat to user
        await prisma.user.update({
          where: { id: userId },
          data: { telegramChatId: chatId.toString() }
        });
        
        await sendTelegramMessage(chatId, 
          '✅ Telegram berhasil terhubung!\n\n' +
          'Kamu akan menerima reminder dan notifikasi dari Cicle di sini.'
        );
      } else {
        await sendTelegramMessage(chatId, 
          '👋 Selamat datang di Cicle Bot!\n\n' +
          'Hubungkan akunmu di profil untuk menerima notifikasi.'
        );
      }
    }
    
    res.json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Test endpoint to send a message
router.get('/test', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.session.user.id }
    });
    
    if (!user.telegramChatId) {
      req.flash('error', 'Telegram Chat ID belum diatur. Silakan hubungkan Telegram di profil.');
      return res.redirect('/profile');
    }
    
    const result = await sendTelegramMessage(
      user.telegramChatId,
      '🧪 <b>Test Message</b>\n\nIni adalah pesan test dari Cicle. Jika kamu menerima ini, berarti Telegram sudah terhubung!'
    );
    
    if (result && result.ok) {
      req.flash('success', 'Pesan test berhasil dikirim ke Telegram!');
    } else {
      req.flash('error', 'Gagal mengirim pesan test. Pastikan Chat ID benar.');
    }
    
    res.redirect('/profile');
  } catch (error) {
    console.error('Telegram test error:', error);
    req.flash('error', 'Gagal mengirim pesan test');
    res.redirect('/profile');
  }
});

// Send task reminder via Telegram
router.post('/reminder/:taskId', requireAuth, async (req, res) => {
  try {
    const task = await prisma.task.findUnique({
      where: { id: req.params.taskId },
      include: { 
        project: { select: { name: true } },
        assignee: true
      }
    });
    
    if (!task || !task.assignee) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    if (!task.assignee.telegramChatId) {
      return res.status(400).json({ error: 'User has no Telegram connected' });
    }
    
    const result = await sendTaskReminder(task.assignee.telegramChatId, task);
    res.json({ success: result?.ok || false });
  } catch (error) {
    console.error('Send reminder error:', error);
    res.status(500).json({ error: 'Failed to send reminder' });
  }
});

module.exports = router;
