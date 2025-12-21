const fs = require('fs');
const path = require('path');

const settingsPath = path.join(__dirname, '..', 'config', 'settings.json');

function readSettings() {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to read settings; falling back to defaults', err);
    return {
      timezone: 'UTC',
      language: 'en',
      retention_days: 30
    };
  }
}

function writeSettings(newSettings) {
  const current = readSettings();
  const merged = { ...current, ...newSettings };
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = {
  readSettings,
  writeSettings,
  settingsPath
};
