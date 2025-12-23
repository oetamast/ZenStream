const { SettingsRepository, JobsRepository } = require('../db/repositories');
const { encryptSecret, decryptSecret } = require('../utils/crypto');
const { recordEvent } = require('./eventService');
const { refreshJobStatus } = require('./jobStatusService');

const LICENSE_TIERS = ['basic', 'premium', 'ultimate'];

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
  license_tier: 'basic',
  setup_completed: 0,
};

function normalizeTier(tier) {
  if (!tier) return 'basic';
  const normalized = String(tier).toLowerCase();
  return LICENSE_TIERS.includes(normalized) ? normalized : 'basic';
}

function isTierAtLeast(current, required) {
  const currentIdx = LICENSE_TIERS.indexOf(normalizeTier(current));
  const requiredIdx = LICENSE_TIERS.indexOf(normalizeTier(required));
  return currentIdx >= requiredIdx;
}

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
  merged.license_tier = normalizeTier(merged.license_tier);
  merged.setup_completed = merged.setup_completed ? 1 : 0;
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

async function convertJobsOnDowngrade(fromTier, toTier) {
  const fromRank = LICENSE_TIERS.indexOf(normalizeTier(fromTier));
  const toRank = LICENSE_TIERS.indexOf(normalizeTier(toTier));
  if (fromRank <= toRank) return;

  const jobs = await JobsRepository.list();
  let converted = 0;
  for (const job of jobs) {
    const updates = {};
    if (toRank < LICENSE_TIERS.indexOf('premium')) {
      if (job.auto_recovery_enabled) updates.auto_recovery_enabled = 0;
      if (job.audio_replace_config) updates.audio_replace_config = null;
      if (job.hot_swap_mode) updates.hot_swap_mode = null;
    }
    if (toRank < LICENSE_TIERS.indexOf('ultimate')) {
      if (job.scenes_json) updates.scenes_json = null;
      if (job.swap_rules_json) updates.swap_rules_json = null;
    }
    if (Object.keys(updates).length) {
      updates.invalid_reason = 'Converted on downgrade';
      await JobsRepository.update(job.id, updates);
      await refreshJobStatus(job.id);
      converted += 1;
    }
  }
  if (converted > 0) {
    await recordEvent({
      event_type: 'license_downgrade_converted_jobs',
      message: `Converted ${converted} jobs after license downgrade`,
      metadata: { from: fromTier, to: toTier, converted },
      notify: false,
    });
  }
}

async function writeSettings(newSettings) {
  const current = await readSettings();
  const merged = { ...current, ...newSettings };
  merged.license_tier = normalizeTier(merged.license_tier);

  if (!LICENSE_TIERS.includes(merged.license_tier)) {
    throw new Error('license_tier must be basic, premium, or ultimate');
  }

  await convertJobsOnDowngrade(current.license_tier, merged.license_tier);

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
  normalizeTier,
  isTierAtLeast,
};
