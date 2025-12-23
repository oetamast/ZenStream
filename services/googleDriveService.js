const path = require('path');
const fs = require('fs-extra');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const { recordEvent } = require('./eventService');
const { readGoogleOAuth, saveGoogleTokens, writeSettings } = require('./settingsService');

const OAUTH_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const stateCache = new Map();

function cleanupStates() {
  const now = Date.now();
  for (const [key, expires] of stateCache.entries()) {
    if (expires < now) stateCache.delete(key);
  }
}

function rememberState() {
  cleanupStates();
  const state = uuidv4();
  stateCache.set(state, Date.now() + 10 * 60 * 1000);
  return state;
}

function validateState(state) {
  cleanupStates();
  if (!state || !stateCache.has(state)) return false;
  stateCache.delete(state);
  return true;
}

function deriveRedirectUri(req, fallback) {
  if (fallback) return fallback;
  if (!req) return '';
  const host = req.get('host');
  const proto = req.protocol || 'http';
  return `${proto}://${host}/api/assets/google-drive/auth/callback`;
}

async function buildOAuthClient(redirectUri) {
  const settings = await readGoogleOAuth(true);
  const finalRedirect = redirectUri || settings.redirect_uri || '';
  if (!settings.client_id || !(settings.client_secret || settings.google_client_secret_masked)) {
    const err = new Error('Google OAuth client ID/secret required');
    err.status = 400;
    throw err;
  }
  const clientSecret = settings.client_secret || '';
  const oauth2Client = new google.auth.OAuth2(settings.client_id, clientSecret, finalRedirect || undefined);
  if (settings.access_token || settings.refresh_token) {
    oauth2Client.setCredentials({
      access_token: settings.access_token,
      refresh_token: settings.refresh_token,
      expiry_date: settings.token_expiry,
    });
  }
  return { oauth2Client, settings, redirectUri: finalRedirect };
}

async function startAuth(req) {
  const fallbackRedirect = deriveRedirectUri(req);
  const { oauth2Client, redirectUri } = await buildOAuthClient(fallbackRedirect);
  const state = rememberState();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: OAUTH_SCOPES,
    state,
    prompt: 'consent',
    redirect_uri: redirectUri || undefined,
  });
  return { authUrl, state, redirectUri };
}

async function handleAuthCallback(req) {
  const { code, state } = req.query;
  const fallbackRedirect = deriveRedirectUri(req);
  if (!validateState(state)) {
    const err = new Error('Invalid or expired OAuth state');
    err.status = 400;
    throw err;
  }
  const { oauth2Client, redirectUri } = await buildOAuthClient(fallbackRedirect);
  const { tokens } = await oauth2Client.getToken({ code, redirect_uri: redirectUri || undefined });
  oauth2Client.setCredentials(tokens);
  await saveGoogleTokens(tokens);
  await recordEvent({
    event_type: 'google_drive_authorized',
    message: 'Google Drive connected',
    metadata: { has_refresh: Boolean(tokens.refresh_token) },
    notify: false,
  });
  return tokens;
}

async function ensureAuthorized(redirectUri) {
  const { oauth2Client, settings } = await buildOAuthClient(redirectUri);
  if (!settings.refresh_token) {
    const err = new Error('Google Drive is not connected');
    err.status = 400;
    throw err;
  }
  if (settings.token_expiry && settings.token_expiry - Date.now() < 60 * 1000) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    await saveGoogleTokens(credentials);
    oauth2Client.setCredentials(credentials);
  }
  return { oauth2Client, settings };
}

async function listFiles({ query } = {}) {
  const { oauth2Client } = await ensureAuthorized();
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const qParts = ["trashed = false", "(mimeType contains 'video/' or mimeType contains 'audio/')"];
  if (query) {
    const safe = query.replace(/['"]/g, '');
    qParts.push(`name contains '${safe}'`);
  }
  const res = await drive.files.list({
    q: qParts.join(' and '),
    pageSize: 25,
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,size,modifiedTime)',
  });
  return res.data.files || [];
}

async function getFileMetadata(fileId) {
  const { oauth2Client } = await ensureAuthorized();
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const res = await drive.files.get({
    fileId,
    fields: 'id,name,mimeType,size',
    supportsAllDrives: true,
  });
  return res.data;
}

async function downloadFile(fileId, targetPath, onProgress) {
  const { oauth2Client } = await ensureAuthorized();
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  await fs.ensureDir(path.dirname(targetPath));
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  const total = Number(res.headers['content-length']) || null;
  let downloaded = 0;
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(targetPath);
    res.data
      .on('data', (chunk) => {
        downloaded += chunk.length;
        if (onProgress && total) {
          onProgress(Math.min(100, Math.round((downloaded / total) * 100)));
        }
      })
      .on('error', reject)
      .pipe(writer);
    writer.on('finish', () => resolve({ downloaded, total }));
    writer.on('error', reject);
  });
}

async function authStatus() {
  const settings = await readGoogleOAuth();
  return {
    configured: Boolean(settings.client_id && settings.google_client_secret_masked),
    connected: Boolean(settings.google_refresh_token_present),
    redirect_uri: settings.google_redirect_uri || '',
  };
}

async function clearTokens() {
  await writeSettings({
    google_access_token: null,
    google_refresh_token: null,
    google_token_expiry: null,
  });
}

module.exports = {
  startAuth,
  handleAuthCallback,
  listFiles,
  getFileMetadata,
  downloadFile,
  authStatus,
  ensureAuthorized,
  clearTokens,
};
