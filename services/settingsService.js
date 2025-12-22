const { SettingsRepository } = require('../db/repositories');
const { encryptSecret, decryptSecret } = require('../utils/crypto');

const DEFAULT_TELEGRAM_EVENTS = {
  stream_start: true,
  stream_stop: true,
  stream_fail: true,
  retry_gave_up: true,
  license_fail: true,
  license_grace_started: true,
  license_grace_ended: true,
};

const DEFAULT_SETTINGS = {
  timezone: 'UTC',
  language: 'en',
  retention_days: 30,
  keep_forever: 0,
  safety_cap_enabled: 0,
  benchmark_profile: 'safe',
  telegram_enabled: 0,
  telegram_bot_token_enc: null,
  telegram_chat_id: '',
  telegram_events: DEFAULT_TELEGRAM_EVENTS,
  telegram_events_json: JSON.stringify(DEFAULT_TELEGRAM_EVENTS),
};

function normalizeTelegramEvents(raw) {
  const events = { ...DEFAULT_TELEGRAM_EVENTS };
  if (!raw) return events;
  Object.keys(events).forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      events[key] = !!raw[key];
    }
  });
  return events;
}

async function ensureSettingsRow() {
  const existing = await SettingsRepository.read();
  if (!existing) {
    await SettingsRepository.write(DEFAULT_SETTINGS);
    return DEFAULT_SETTINGS;
  }
  return existing;
}

function parseTelegramEventsFromRow(row) {
  if (!row) return { ...DEFAULT_TELEGRAM_EVENTS };
  if (row.telegram_events_json) {
    try {
      const parsed = JSON.parse(row.telegram_events_json);
      return normalizeTelegramEvents(parsed);
    } catch (err) {
      return { ...DEFAULT_TELEGRAM_EVENTS };
    }
  }
  if (row.telegram_events) {
    return normalizeTelegramEvents(row.telegram_events);
  }
  return { ...DEFAULT_TELEGRAM_EVENTS };
}

function maskToken(token) {
  if (!token) return '';
  if (token.length <= 6) return '*'.repeat(token.length);
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

async function readSettings(options = {}) {
  const includeSecrets = options.includeSecrets !== false;
  const row = (await ensureSettingsRow()) || DEFAULT_SETTINGS;
  const merged = { ...DEFAULT_SETTINGS, ...row };
  merged.telegram_events = parseTelegramEventsFromRow(row);
  let tokenPlain = '';
  if (merged.telegram_bot_token_enc) {
    try {
      tokenPlain = decryptSecret(merged.telegram_bot_token_enc);
    } catch (err) {
      tokenPlain = '';
    }
  }

  if (!merged.keep_forever) {
    let days = Number(merged.retention_days);
    if (!Number.isFinite(days)) days = DEFAULT_SETTINGS.retention_days;
    merged.retention_days = Math.max(1, Math.min(3650, Math.round(days)));
  }

  const normalized = {
    ...merged,
    keep_forever: Boolean(merged.keep_forever),
    safety_cap_enabled: Boolean(merged.safety_cap_enabled),
    telegram_enabled: Boolean(merged.telegram_enabled),
    telegram_bot_token_enc: merged.telegram_bot_token_enc || null,
  };

  if (includeSecrets) {
    normalized.telegram_bot_token = tokenPlain;
  }

  return normalized;
}

async function writeSettings(newSettings) {
  const current = await readSettings();
  const merged = { ...current, ...newSettings };
  const toPersist = { ...merged };
  if (merged.telegram_events) {
    toPersist.telegram_events_json = JSON.stringify(normalizeTelegramEvents(merged.telegram_events));
  }
  if (Object.prototype.hasOwnProperty.call(newSettings, 'telegram_bot_token')) {
    const token = newSettings.telegram_bot_token || '';
    toPersist.telegram_bot_token_enc = token ? encryptSecret(token) : null;
  }
  delete toPersist.telegram_bot_token;
  return SettingsRepository.write(toPersist);
}

module.exports = {
  readSettings,
  writeSettings,
  DEFAULT_SETTINGS,
  DEFAULT_TELEGRAM_EVENTS,
  maskToken,
  normalizeTelegramEvents,
};
