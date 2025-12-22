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
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    keep_forever: Boolean(settings.keep_forever),
    safety_cap_enabled: Boolean(settings.safety_cap_enabled),
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
