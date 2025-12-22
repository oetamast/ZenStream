const axios = require('axios');
const { DateTime } = require('luxon');
const { EventsRepository } = require('../db/repositories');
const { readSettings } = require('./settingsService');

const EVENT_LABELS = {
  stream_start: 'Stream started',
  stream_stop: 'Stream stopped',
  stream_fail: 'Stream failed',
  retry_gave_up: 'Retry gave up',
  license_fail: 'License failed',
  license_grace_started: 'License grace started',
  license_grace_ended: 'License grace ended',
  telegram_send_failed: 'Telegram send failed',
};

function formatTimestamp(ts) {
  if (!ts) return DateTime.utc().toISO();
  const dt = DateTime.fromISO(ts, { zone: 'utc' });
  if (dt.isValid) return dt.toISO();
  return DateTime.utc().toISO();
}

async function sendTelegramMessage(token, chatId, text) {
  if (!token || !chatId) throw new Error('Missing Telegram token or chat id');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  const res = await axios.post(url, payload);
  if (!res.data || res.data.ok !== true) {
    throw new Error(res.data?.description || 'Telegram returned an error');
  }
  return true;
}

function buildMessage(eventKey, context = {}) {
  const label = EVENT_LABELS[eventKey] || 'Notification';
  const jobName = context.job?.name || 'Unknown job';
  const destinationName = context.destination?.name || context.destination?.platform || 'Unknown destination';
  const sessionId = context.event?.session_id || 'n/a';
  const message = context.event?.message || '';
  const timestamp = formatTimestamp(context.event?.created_at);
  return `ZenStream\n${label}\nJob: ${jobName}\nDestination: ${destinationName}\nSession: ${sessionId}\nTime: ${timestamp}\n${message}`;
}

async function notifyEvent(eventKey, context) {
  const settings = await readSettings();
  if (!settings.telegram_enabled) return;
  const events = settings.telegram_events || {};
  if (!events[eventKey]) return;
  const token = settings.telegram_bot_token;
  const chatId = settings.telegram_chat_id;
  if (!token || !chatId) return;

  const text = buildMessage(eventKey, context);
  try {
    await sendTelegramMessage(token, chatId, text);
  } catch (err) {
    console.error('Telegram send error:', err.message);
    await EventsRepository.create({
      event_type: 'telegram_send_failed',
      message: `Telegram send failed: ${err.message}`,
      metadata_json: JSON.stringify({ event_key: eventKey, error: err.message }),
    });
  }
}

async function sendTestMessage(token, chatId) {
  return sendTelegramMessage(token, chatId, 'ZenStream test message');
}

module.exports = {
  notifyEvent,
  sendTestMessage,
};
