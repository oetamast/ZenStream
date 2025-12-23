const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { dataRoot } = require('./storage');

const configDir = path.join(dataRoot, 'config');
const secretPath = path.join(configDir, 'session_secret');

function generateSecret() {
  return crypto.randomBytes(48).toString('hex');
}

function loadSessionSecret(logger = console) {
  const envSecret = (process.env.SESSION_SECRET || '').trim();
  if (envSecret) {
    logger.info('Using SESSION_SECRET from environment');
    return envSecret;
  }

  fs.ensureDirSync(configDir);

  if (fs.existsSync(secretPath)) {
    const fileSecret = (fs.readFileSync(secretPath, 'utf8') || '').trim();
    if (fileSecret) {
      logger.info(`Loaded session secret from ${secretPath}`);
      return fileSecret;
    }
  }

  const generated = generateSecret();
  fs.writeFileSync(secretPath, generated, { mode: 0o600 });
  logger.warn(`SESSION_SECRET not provided; generated new secret at ${secretPath}`);
  return generated;
}

module.exports = {
  loadSessionSecret,
  secretPath,
};
