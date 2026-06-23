const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { sendTelegramMessage, sendTaskReminder } = require('../lib/telegram');
const { notifyUser } = require('../lib/notify');
const { requireAuth } = require('../middleware/auth');

// Webhook endpoint for Telegram Bot
router.post('/webhook/:botToken', async (req, res) => {
  try {
    const { botToken } = req.params;
    const expectedToken = process.env.TELEGRAM_BOT_TOKEN;

    if (botToken !== expectedToken) {
      return res.status(403).json({ error: 'Invalid bot token' });
    }

    const update = req.body;

    if (update.message?.text?.startsWith('/start')) {
      const chatId = update.message.chat.id;
      const text = String(update.message.text || '').trim();
      const userId = String(text.split(/\s+/)[1] || '').trim();

      if (userId) {
        const targetUser = await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, name: true }
        });

        if (targetUser) {
          await prisma.user.update({
            where: { id: userId },
            data: { telegramChatId: chatId.toString() }
          });

          req.app.get('io')?.to(`user-${userId}`).emit('telegram-connected', {
            connected: true,
            chatId: chatId.toString()
          });
          notifyUser(
            req.app.get('io'),
            userId,
            'Telegram berhasil terhubung ke akun kamu',
            '/profile'
          ).catch(() => {});

          await sendTelegramMessage(
            chatId,
            `Telegram berhasil terhubung ke akun ${targetUser.name}.\n\nKamu akan menerima reminder deadline dan notifikasi dari Basecamp Zaneva di sini.`
          );
        } else {
          await sendTelegramMessage(
            chatId,
            'Link hubungkan Telegram tidak valid atau sudah lama.\n\nSilakan buka Profil Saya di app lalu klik Hubungkan Telegram lagi.'
          );
        }
      } else {
        await sendTelegramMessage(
          chatId,
          'Telegram belum terhubung ke akun Basecamp.\n\nBuka Profil Saya di web, klik tombol Hubungkan via Telegram, lalu tekan Start dari tombol itu. Kalau hanya mengetik /start manual, bot belum tahu akun web mana yang harus dihubungkan.'
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
      '<b>Test Message</b>\n\nIni adalah pesan test dari Cicle. Jika kamu menerima ini, berarti Telegram sudah terhubung.'
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
