const crypto = require('crypto');

const INSTALL_SECRET = process.env.INSTALL_SECRET || process.env.SESSION_SECRET || 'zenstream-default-secret-change-me';

function getKey() {
  const hash = crypto.createHash('sha256').update(INSTALL_SECRET).digest();
  return hash;
}

function encryptSecret(plaintext) {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${encrypted.toString('base64')}:${tag.toString('base64')}`;
}

function decryptSecret(payload) {
  if (!payload) return '';
  const parts = payload.split(':');
  if (parts.length !== 3) throw new Error('Invalid secret payload');
  const [ivB64, dataB64, tagB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = {
  encryptSecret,
  decryptSecret,
  INSTALL_SECRET,
};
