const express = require('express');
const router = express.Router();
const {
  readSettings,
  writeSettings,
  maskToken,
  normalizeTelegramEvents,
} = require('../services/settingsService');
const { sendTestMessage } = require('../services/telegramService');

router.get('/', async (_req, res) => {
  try {
    const settings = await readSettings();
    const response = { ...settings };
    delete response.telegram_bot_token;
    response.telegram_bot_token_masked = maskToken(settings.telegram_bot_token);
    res.json({ settings: response });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Failed to load settings' });
  }
});

router.put('/', async (req, res) => {
  try {
    const allowed = [
      'timezone',
      'language',
      'retention_days',
      'keep_forever',
      'safety_cap_enabled',
      'benchmark_profile',
      'telegram_enabled',
      'telegram_chat_id',
      'telegram_bot_token',
      'telegram_events',
      'license_tier',
    ];
    const payload = {};
    allowed.forEach((key) => {
      if (typeof req.body[key] !== 'undefined') payload[key] = req.body[key];
    });
    if (payload.keep_forever != null) payload.keep_forever = payload.keep_forever ? 1 : 0;
    if (payload.safety_cap_enabled != null) payload.safety_cap_enabled = payload.safety_cap_enabled ? 1 : 0;
    if (payload.telegram_enabled != null) payload.telegram_enabled = payload.telegram_enabled ? 1 : 0;

    if (!payload.keep_forever) {
      const days = Number(payload.retention_days);
      if (!Number.isFinite(days)) {
        return res.status(400).json({ message: 'Retention days must be a number' });
      }
      if (days < 1 || days > 3650) {
        return res.status(400).json({ message: 'Retention days must be between 1 and 3650' });
      }
      payload.retention_days = Math.round(days);
    }

    if (payload.telegram_chat_id != null && payload.telegram_chat_id !== '') {
      if (typeof payload.telegram_chat_id !== 'string') {
        return res.status(400).json({ message: 'Chat ID must be a string' });
      }
      if (!payload.telegram_chat_id.trim()) {
        return res.status(400).json({ message: 'Chat ID cannot be empty' });
      }
      payload.telegram_chat_id = payload.telegram_chat_id.trim();
    }

    if (payload.telegram_events) {
      if (typeof payload.telegram_events !== 'object') {
        return res.status(400).json({ message: 'telegram_events must be an object' });
      }
      payload.telegram_events = normalizeTelegramEvents(payload.telegram_events);
    }
    if (payload.license_tier) {
      const allowedTiers = ['basic', 'premium', 'ultimate'];
      if (!allowedTiers.includes(String(payload.license_tier).toLowerCase())) {
        return res.status(400).json({ message: 'license_tier must be basic, premium, or ultimate' });
      }
      payload.license_tier = String(payload.license_tier).toLowerCase();
    }
    const settings = await writeSettings(payload);
    const response = { ...settings };
    delete response.telegram_bot_token;
    response.telegram_bot_token_masked = maskToken(settings.telegram_bot_token);
    res.json({ settings: response });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to update settings' });
  }
});

router.post('/telegram/test', async (req, res) => {
  try {
    const settings = await readSettings();
    const token = req.body.telegram_bot_token || settings.telegram_bot_token;
    const chatId = req.body.telegram_chat_id || settings.telegram_chat_id;
    if (!token || !chatId) {
      return res.status(400).json({ message: 'Bot token and chat ID are required to test Telegram' });
    }
    await sendTestMessage(token, chatId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Telegram test failed' });
  }
});

router.all('*', (_req, res) => {
  res.status(404).json({ message: 'Not found' });
});

module.exports = router;
