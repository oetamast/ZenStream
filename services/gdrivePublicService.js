const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const fs = require('fs-extra');
const path = require('path');
const { pipeline } = require('stream');
const { promisify } = require('util');

const pipelineAsync = promisify(pipeline);
const DOWNLOAD_URL = 'https://drive.google.com/uc';
const HTML_PREVIEW_LIMIT = 1024 * 1024; // 1MB
const HTML_LOG_SLICE = 800;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function extractFileInfo(input) {
  if (!input) return { fileId: null, resourceKey: null };
  if (/^[A-Za-z0-9_-]{10,}$/.test(input)) {
    return { fileId: input, resourceKey: null };
  }
  try {
    const parsed = new URL(input);
    if (!parsed.hostname.includes('drive.google.com')) return { fileId: null, resourceKey: null };
    const fileMatch = parsed.pathname.match(/\/file\/d\/([^/]+)/);
    const openId = parsed.searchParams.get('id');
    const fileId = fileMatch ? fileMatch[1] : openId;
    const resourceKey = parsed.searchParams.get('resourcekey');
    return { fileId, resourceKey };
  } catch (err) {
    return { fileId: null, resourceKey: null };
  }
}

function extractFileId(input) {
  return extractFileInfo(input).fileId;
}

function parseFilename(contentDisposition, fallback) {
  if (!contentDisposition) return fallback;
  const filenameStarMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (filenameStarMatch) return decodeURIComponent(filenameStarMatch[1]);
  const filenameMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  if (filenameMatch) return filenameMatch[1];
  return fallback;
}

async function streamToStringLimited(stream, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const remaining = limit - total;
    if (remaining <= 0) break;
    chunks.push(chunk.slice(0, remaining));
    total += chunk.length;
    if (total >= limit) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function buildPermissionError() {
  const err = new Error(
    "This Google Drive link requires permission. Set sharing to 'Anyone with the link' or connect Google Drive (OAuth)."
  );
  err.status = 403;
  err.code = 'GDRIVE_PERMISSION_REQUIRED';
  return err;
}

function buildClient(jar) {
  return wrapper(
    axios.create({
      jar,
      withCredentials: true,
      responseType: 'stream',
      timeout: 30000,
      maxRedirects: 5,
      validateStatus: (status) => status < 500,
      headers: {
        'User-Agent': USER_AGENT,
      },
    })
  );
}

async function requestDownload(client, { fileId, confirmToken, resourceKey }) {
  const params = { export: 'download', id: fileId };
  if (confirmToken) params.confirm = confirmToken;
  if (resourceKey) params.resourcekey = resourceKey;
  return client.get(DOWNLOAD_URL, { params });
}

function isHtmlResponse(res) {
  const type = res.headers['content-type'] || '';
  return type.includes('text/html');
}

function sniffPermissionHtml(html = '') {
  const lowered = html.toLowerCase();
  return (
    lowered.includes('accounts.google.com') ||
    lowered.includes('servicelogin') ||
    lowered.includes('you need access') ||
    lowered.includes('request access') ||
    lowered.includes('sign in')
  );
}

function findConfirmToken(html = '') {
  const hrefToken = html.match(/confirm=([0-9A-Za-z_]+)/i);
  if (hrefToken) return hrefToken[1];
  const inputToken = html.match(/name="confirm"\s+value="([0-9A-Za-z_]+)"/i);
  if (inputToken) return inputToken[1];
  return null;
}

function findDownloadForm(html = '') {
  const formMatch = html.match(/<form[^>]*id=["']download-form["'][^>]*>([\s\S]*?)<\/form>/i);
  if (!formMatch) return null;
  const formTag = html.match(/<form[^>]*id=["']download-form["'][^>]*>/i);
  const actionMatch = formTag?.[0]?.match(/action=["']([^"']+)/i);
  const action = actionMatch ? actionMatch[1] : null;
  const params = {};
  const inputs = formMatch[1].match(/<input[^>]*type=["']hidden["'][^>]*>/gi) || [];
  inputs.forEach((input) => {
    const nameMatch = input.match(/name=["']([^"']+)["']/i);
    const valueMatch = input.match(/value=["']([^"']*)["']/i);
    if (nameMatch) {
      params[nameMatch[1]] = valueMatch ? valueMatch[1] : '';
    }
  });
  if (action) {
    return { action, params };
  }
  return null;
}

function logHtmlDebug(res, html, context = 'html', force = false) {
  try {
    if (!force && process.env.GDRIVE_DEBUG !== '1') return;
    const finalUrl = res?.request?.res?.responseUrl || res?.config?.url;
    const snippet = html
      .slice(0, HTML_LOG_SLICE)
      .replace(/\s+/g, ' ')
      .replace(/confirm=[0-9A-Za-z_-]+/gi, 'confirm=<redacted>')
      .trim();
    const setCookies = Array.isArray(res?.headers?.['set-cookie']) ? res.headers['set-cookie'].length : 0;
    console.warn('[gdrive] html response', {
      context,
      status: res?.status,
      url: finalUrl,
      type: res?.headers?.['content-type'],
      set_cookies: setCookies,
      preview: snippet,
    });
  } catch (e) {
    // swallow logging issues
  }
}

function isRateLimitHtml(html = '') {
  const lowered = html.toLowerCase();
  return lowered.includes('too many users have viewed') || lowered.includes('too many users have downloaded');
}

function isBotBlockHtml(html = '') {
  const lowered = html.toLowerCase();
  return lowered.includes('automated queries') || lowered.includes('unusual traffic') || lowered.includes('captcha');
}

function normalizeActionUrl(action) {
  if (!action) return null;
  if (action.startsWith('http://') || action.startsWith('https://')) return action;
  if (action.startsWith('drive.usercontent.google.com')) return `https://${action}`;
  if (action.startsWith('//')) return `https:${action}`;
  if (action.startsWith('/')) return `https://drive.google.com${action}`;
  return action;
}

async function resolveHtmlResponse(client, { res, fileId, resourceKey, contentDisposition }) {
  const html = await streamToStringLimited(res.data, HTML_PREVIEW_LIMIT);
  logHtmlDebug(res, html, 'html_initial');
  const confirmToken = findConfirmToken(html);
  const downloadForm = findDownloadForm(html);

  if (downloadForm) {
    const normalized = normalizeActionUrl(downloadForm.action);
    let actionUrl = normalized;
    const params = { ...downloadForm.params };
    try {
      const parsed = new URL(normalized);
      actionUrl = `${parsed.origin}${parsed.pathname}`;
      parsed.searchParams.forEach((value, key) => {
        if (params[key] === undefined) params[key] = value;
      });
    } catch (e) {
      // fall back to normalized action
    }
    if (resourceKey && !params.resourcekey) params.resourcekey = resourceKey;
    res = await client.get(actionUrl, { params });
    contentDisposition = res.headers['content-disposition'] || contentDisposition;
    if (!isHtmlResponse(res)) {
      return { res, contentDisposition };
    }
    const htmlAfterForm = await streamToStringLimited(res.data, HTML_PREVIEW_LIMIT);
    return handleTerminalHtml(res, htmlAfterForm, contentDisposition);
  }

  if (confirmToken) {
    res = await requestDownload(client, { fileId, confirmToken, resourceKey });
    contentDisposition = res.headers['content-disposition'] || contentDisposition;
    if (!isHtmlResponse(res)) {
      return { res, contentDisposition };
    }
    const htmlAfter = await streamToStringLimited(res.data, HTML_PREVIEW_LIMIT);
    return handleTerminalHtml(res, htmlAfter, contentDisposition);
  }

  return handleTerminalHtml(res, html, contentDisposition);
}

function handleTerminalHtml(res, html, contentDisposition) {
  logHtmlDebug(res, html, 'html_terminal', true);
  if (sniffPermissionHtml(html)) {
    throw buildPermissionError();
  }
  if (isRateLimitHtml(html)) {
    const err = new Error(
      'Google Drive rate-limited this file. Try again later or copy it to another Drive and share that.'
    );
    err.status = 429;
    err.code = 'GDRIVE_RATE_LIMIT';
    throw err;
  }
  if (isBotBlockHtml(html)) {
    const err = new Error(
      'Google Drive blocked automated downloads from this server IP. Try OAuth import or host the file elsewhere.'
    );
    err.status = 429;
    err.code = 'GDRIVE_BOT_BLOCKED';
    throw err;
  }
  const err = new Error('Google Drive returned an unexpected page. Check server logs for the HTML snippet.');
  err.status = 502;
  err.code = 'GDRIVE_UNEXPECTED_HTML';
  err.details = { contentDisposition };
  throw err;
}

async function resolveDownloadResponse(client, { fileId, resourceKey }) {
  let res = await requestDownload(client, { fileId, resourceKey });
  let contentDisposition = res.headers['content-disposition'] || '';

  if (isHtmlResponse(res)) {
    ({ res, contentDisposition } = await resolveHtmlResponse(client, { res, fileId, resourceKey, contentDisposition }));
  }

  return { res, contentDisposition };
}

async function preflightPublicFile({ fileId, resourceKey }) {
  if (!fileId) {
    const err = new Error('Missing Google Drive file id');
    err.status = 400;
    throw err;
  }
  const jar = new CookieJar();
  const client = buildClient(jar);
  const { res, contentDisposition } = await resolveDownloadResponse(client, { fileId, resourceKey });
  if (res.data?.destroy) {
    res.data.destroy();
  }
  return {
    filename: parseFilename(contentDisposition, `${fileId}`),
    mimeType: res.headers['content-type'] || null,
    sizeBytes: res.headers['content-length'] ? Number(res.headers['content-length']) : null,
  };
}

async function downloadPublicFile({ fileId, resourceKey, targetPath, preferredName, onProgress }) {
  if (!fileId) {
    const err = new Error('Missing Google Drive file id');
    err.status = 400;
    throw err;
  }
  const jar = new CookieJar();
  const client = buildClient(jar);
  const { res, contentDisposition } = await resolveDownloadResponse(client, { fileId, resourceKey });

  const filename = parseFilename(contentDisposition, preferredName || `${fileId}`);
  await fs.ensureDir(path.dirname(targetPath));
  const writer = fs.createWriteStream(targetPath);
  const total = Number(res.headers['content-length'] || 0);
  let downloaded = 0;
  if (onProgress && total > 0) {
    res.data.on('data', (chunk) => {
      downloaded += chunk.length;
      onProgress(Math.min(100, Math.round((downloaded / total) * 100)));
    });
  }

  await pipelineAsync(res.data, writer);
  const stats = await fs.stat(targetPath);
  return {
    filename,
    mimeType: res.headers['content-type'] || null,
    sizeBytes: stats.size,
  };
}

module.exports = {
  extractFileId,
  extractFileInfo,
  preflightPublicFile,
  downloadPublicFile,
};
