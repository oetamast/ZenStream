const { SettingsRepository } = require('../db/repositories');

const DEFAULT_SETTINGS = {
  timezone: 'UTC',
  language: 'en',
  retention_days: 30,
  keep_forever: 0,
  safety_cap_enabled: 0,
  benchmark_profile: 'safe'
};

async function ensureSettingsRow() {
  const existing = await SettingsRepository.read();
  if (!existing) {
    await SettingsRepository.write(DEFAULT_SETTINGS);
    return DEFAULT_SETTINGS;
  }
  return existing;
}

async function readSettings() {
  const settings = (await ensureSettingsRow()) || DEFAULT_SETTINGS;
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  if (!merged.keep_forever) {
    let days = Number(merged.retention_days);
    if (!Number.isFinite(days)) days = DEFAULT_SETTINGS.retention_days;
    merged.retention_days = Math.max(1, Math.min(3650, Math.round(days)));
  }
  return {
    ...merged,
    keep_forever: Boolean(merged.keep_forever),
    safety_cap_enabled: Boolean(merged.safety_cap_enabled),
  };
}

async function writeSettings(newSettings) {
  const current = await readSettings();
  const merged = { ...current, ...newSettings };
  return SettingsRepository.write(merged);
}

module.exports = {
  readSettings,
  writeSettings,
  DEFAULT_SETTINGS
};
