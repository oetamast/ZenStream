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
    })
  );
}

async function requestDownload(client, { fileId, confirmToken }) {
  const params = { export: 'download', id: fileId };
  if (confirmToken) params.confirm = confirmToken;
  return client.get(DOWNLOAD_URL, { params });
}

async function resolveDownloadResponse(client, fileId) {
  let res = await requestDownload(client, { fileId });
  let contentDisposition = res.headers['content-disposition'] || '';
  const initialType = res.headers['content-type'] || '';

  if (initialType.includes('text/html')) {
    const html = await streamToStringLimited(res.data, HTML_PREVIEW_LIMIT);
    const tokenMatch = html.match(/confirm=([0-9A-Za-z_]+)/i);
    if (!tokenMatch) {
      throw buildPermissionError();
    }
    const confirmToken = tokenMatch[1];
    res = await requestDownload(client, { fileId, confirmToken });
    contentDisposition = res.headers['content-disposition'] || contentDisposition;
    const afterType = res.headers['content-type'] || '';
    if (afterType.includes('text/html')) {
      throw buildPermissionError();
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
