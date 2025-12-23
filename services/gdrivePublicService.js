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
const HTML_LOG_SLICE = 500;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function extractFileId(input) {
  if (!input) return null;
  if (/^[A-Za-z0-9_-]{10,}$/.test(input)) return input;
  try {
    const parsed = new URL(input);
    if (!parsed.hostname.includes('drive.google.com')) return null;
    const fileMatch = parsed.pathname.match(/\/file\/d\/([^/]+)/);
    if (fileMatch) return fileMatch[1];
    const openId = parsed.searchParams.get('id');
    if (openId) return openId;
    return null;
  } catch (err) {
    return null;
  }
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

async function requestDownload(client, { fileId, confirmToken }) {
  const params = { export: 'download', id: fileId };
  if (confirmToken) params.confirm = confirmToken;
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

function logHtmlDebug(res, html) {
  try {
    const finalUrl = res?.request?.res?.responseUrl || res?.config?.url;
    const snippet = html.slice(0, HTML_LOG_SLICE).replace(/\s+/g, ' ').trim();
    console.warn('[gdrive] html response', {
      status: res?.status,
      url: finalUrl,
      type: res?.headers?.['content-type'],
      preview: snippet,
    });
  } catch (e) {
    // swallow logging issues
  }
}

async function resolveDownloadResponse(client, fileId) {
  let res = await requestDownload(client, { fileId });
  let contentDisposition = res.headers['content-disposition'] || '';

  if (isHtmlResponse(res)) {
    const html = await streamToStringLimited(res.data, HTML_PREVIEW_LIMIT);
    logHtmlDebug(res, html);
    const confirmToken = findConfirmToken(html);
    if (confirmToken) {
      res = await requestDownload(client, { fileId, confirmToken });
      contentDisposition = res.headers['content-disposition'] || contentDisposition;
      if (isHtmlResponse(res)) {
        const htmlAfter = await streamToStringLimited(res.data, HTML_PREVIEW_LIMIT);
        logHtmlDebug(res, htmlAfter);
        if (sniffPermissionHtml(htmlAfter)) {
          throw buildPermissionError();
        }
        const err = new Error('Unexpected Google Drive HTML response after confirm');
        err.status = 400;
        throw err;
      }
    } else {
      if (sniffPermissionHtml(html)) {
        throw buildPermissionError();
      }
      const err = new Error('Unexpected Google Drive HTML response. Try again or use OAuth for private files.');
      err.status = 400;
      throw err;
    }
  }

  return { res, contentDisposition };
}

async function preflightPublicFile(fileId) {
  if (!fileId) {
    const err = new Error('Missing Google Drive file id');
    err.status = 400;
    throw err;
  }
  const jar = new CookieJar();
  const client = buildClient(jar);
  const { res, contentDisposition } = await resolveDownloadResponse(client, fileId);
  if (res.data?.destroy) {
    res.data.destroy();
  }
  return {
    filename: parseFilename(contentDisposition, `${fileId}`),
    mimeType: res.headers['content-type'] || null,
    sizeBytes: res.headers['content-length'] ? Number(res.headers['content-length']) : null,
  };
}

async function downloadPublicFile({ fileId, targetPath, preferredName, onProgress }) {
  if (!fileId) {
    const err = new Error('Missing Google Drive file id');
    err.status = 400;
    throw err;
  }
  const jar = new CookieJar();
  const client = buildClient(jar);
  const { res, contentDisposition } = await resolveDownloadResponse(client, fileId);

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
  preflightPublicFile,
  downloadPublicFile,
};
