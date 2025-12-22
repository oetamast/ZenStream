const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const { spawn } = require('child_process');
const { pipeline } = require('stream');
const { promisify } = require('util');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { getUniqueFilename, paths, dataRoot } = require('../utils/storage');
const { AssetsRepository, JobsRepository } = require('../db/repositories');
const { recordEvent } = require('./eventService');
const { invalidateJobs } = require('./jobService');

const MAX_ASSET_SIZE_BYTES = 500 * 1024 * 1024;
const ALLOWED_TYPES = ['video', 'audio', 'sfx'];
const TEMP_DIR = path.join(dataRoot, 'tmp/assets');
const pipelineAsync = promisify(pipeline);

function assertValidAssetType(assetType) {
  if (!ALLOWED_TYPES.includes(assetType)) {
    const err = new Error('Invalid asset_type. Allowed: video, audio, sfx');
    err.status = 400;
    throw err;
  }
}

function getDestinationDir(assetType) {
  switch (assetType) {
    case 'video':
      return paths.videos;
    case 'audio':
      return paths.audios;
    case 'sfx':
      return paths.sfx;
    default:
      return paths.videos;
  }
}

function parseFrameRate(rateStr) {
  if (!rateStr) return null;
  if (typeof rateStr === 'number') return rateStr;
  const parts = rateStr.split('/');
  if (parts.length === 2 && Number(parts[1]) !== 0) {
    const fps = Number(parts[0]) / Number(parts[1]);
    return Number.isFinite(fps) ? fps : null;
  }
  const asNumber = Number(rateStr);
  return Number.isFinite(asNumber) ? asNumber : null;
}

async function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath];
    const child = spawn('ffprobe', args);
    let stdout = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', () => {});

    child.on('error', (err) => reject(err));

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error('ffprobe exited with an error'));
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch (err) {
        reject(new Error('Unable to parse ffprobe output'));
      }
    });
  });
}

function summarizeMetadata(probeJson, fileSize) {
  const videoStream = probeJson?.streams?.find((s) => s.codec_type === 'video');
  const audioStream = probeJson?.streams?.find((s) => s.codec_type === 'audio');
  const durationSec = probeJson?.format?.duration ? Number(probeJson.format.duration) : null;
  return {
    duration_sec: Number.isFinite(durationSec) ? durationSec : null,
    width: videoStream?.width || null,
    height: videoStream?.height || null,
    fps: parseFrameRate(videoStream?.r_frame_rate || videoStream?.avg_frame_rate),
    audio_channels: audioStream?.channels || null,
    sample_rate: audioStream?.sample_rate ? Number(audioStream.sample_rate) : null,
    video_codec: videoStream?.codec_name || null,
    audio_codec: audioStream?.codec_name || null,
    format_name: probeJson?.format?.format_name || null,
    size_bytes: fileSize ?? null,
    ffprobe: probeJson,
  };
}

function pickThumbnailSecond(metadata) {
  const duration = metadata?.duration_sec;
  if (duration && duration > 0) {
    return Math.max(Math.min(duration / 2, duration - 0.5), 0.5);
  }
  return 3;
}

async function generateThumbnail(assetId, sourcePath, metadata) {
  const targetSec = pickThumbnailSecond(metadata);
  await fs.ensureDir(paths.thumbnails);
  const outputPath = path.join(paths.thumbnails, `${assetId}.jpg`);

  return new Promise((resolve, reject) => {
    const args = ['-ss', String(targetSec), '-i', sourcePath, '-frames:v', '1', '-q:v', '2', '-y', outputPath];
    const child = spawn(ffmpegInstaller.path, args);
    let failed = false;
    child.on('error', (err) => {
      failed = true;
      reject(err);
    });
    child.on('close', (code) => {
      if (failed) return;
      if (code !== 0) {
        reject(new Error('FFmpeg failed to create thumbnail'));
      } else {
        resolve(outputPath);
      }
    });
  });
}

async function analyzeAsset(asset) {
  await AssetsRepository.update(asset.id, { status: 'analyzing' });
  try {
    const probeJson = await runFfprobe(asset.path);
    const metadata = summarizeMetadata(probeJson, asset.size_bytes);
    let thumbnailPath = asset.thumbnail_path;
    if (asset.type === 'video') {
      try {
        thumbnailPath = await generateThumbnail(asset.id, asset.path, metadata);
        await recordEvent({
          event_type: 'asset_thumbnail_created',
          message: 'Thumbnail generated',
          job_id: null,
          metadata: { asset_id: asset.id },
        });
      } catch (thumbErr) {
        // Thumbnail failure should not block metadata persistence
        console.error('Thumbnail generation failed', thumbErr);
      }
    }
    const updated = await AssetsRepository.update(asset.id, {
      status: 'ready',
      metadata_json: JSON.stringify(metadata),
      thumbnail_path: thumbnailPath || null,
    });
    await recordEvent({
      event_type: 'asset_analyzed',
      message: 'Asset analyzed',
      metadata: { asset_id: asset.id },
    });
    return updated;
  } catch (err) {
    await AssetsRepository.update(asset.id, { status: 'failed' });
    await recordEvent({
      event_type: 'asset_analyze_failed',
      message: 'Asset analysis failed',
      metadata: { asset_id: asset.id },
    });
    throw err;
  }
}

async function listImpactedJobsForAsset(assetId) {
  const jobs = await JobsRepository.findByAsset(assetId);
  return jobs || [];
}

async function deleteAsset(assetId) {
  const asset = await AssetsRepository.findById(assetId);
  if (!asset) return null;
  const impactedJobs = await listImpactedJobsForAsset(assetId);

  if (asset.path) {
    await fs.remove(asset.path).catch(() => {});
  }
  if (asset.thumbnail_path) {
    await fs.remove(asset.thumbnail_path).catch(() => {});
  }
  await AssetsRepository.remove(assetId);

  if (impactedJobs.length) {
    const reason = `Asset removed: ${asset.filename}. Please reassign an asset.`;
    await invalidateJobs(
      impactedJobs.map((j) => j.id),
      reason
    );
  }

  await recordEvent({
    event_type: 'asset_deleted',
    message: `Asset ${asset.filename} deleted (impacted ${impactedJobs.length} jobs)`,
    metadata: { asset_id: asset.id, impacted_jobs: impactedJobs.length },
  });

  return { asset, impactedJobs };
}

async function moveToFinalLocation(tempPath, assetType, originalName) {
  const destinationDir = getDestinationDir(assetType);
  await fs.ensureDir(destinationDir);
  const finalName = getUniqueFilename(originalName || `${assetType}-asset`);
  const finalPath = path.join(destinationDir, finalName);
  await fs.move(tempPath, finalPath, { overwrite: false });
  const stats = await fs.stat(finalPath);
  return { finalName, finalPath, size: stats.size };
}

async function handleUploadedFile(file, assetType) {
  const normalizedType = (assetType || '').toLowerCase();
  assertValidAssetType(normalizedType);
  if (!file) {
    const err = new Error('No file uploaded');
    err.status = 400;
    throw err;
  }
  if (file.size > MAX_ASSET_SIZE_BYTES) {
    const err = new Error('File exceeds 500MB limit');
    err.status = 400;
    throw err;
  }

  const { finalName, finalPath, size } = await moveToFinalLocation(file.path, normalizedType, file.originalname);
  const asset = await AssetsRepository.create({
    type: normalizedType,
    filename: finalName,
    path: finalPath,
    size_bytes: size,
    status: 'analyzing',
  });
  await recordEvent({
    event_type: 'asset_uploaded',
    message: 'Asset uploaded',
    metadata: { asset_id: asset.id, filename: finalName, asset_type: normalizedType },
  });
  const analyzed = await analyzeAsset(asset);
  return analyzed;
}

async function listAssets(filter) {
  const query = filter?.query ? filter.query.trim().toLowerCase() : undefined;
  return AssetsRepository.listFiltered({
    type: filter?.type,
    query,
  });
}

async function analyzeAssetById(assetId) {
  const asset = await AssetsRepository.findById(assetId);
  if (!asset) {
    const err = new Error('Asset not found');
    err.status = 404;
    throw err;
  }
  return analyzeAsset(asset);
}

function extractFilenameFromHeaders(headers) {
  const disposition = headers['content-disposition'];
  if (!disposition) return null;
  const match = disposition.match(/filename="?([^";]+)"?/i);
  return match ? match[1] : null;
}

function parseGoogleDriveId(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('drive.google.com')) return null;
    const fileIdMatch = parsed.pathname.match(/\/file\/d\/([^/]+)/);
    if (fileIdMatch) return fileIdMatch[1];
    const idParam = parsed.searchParams.get('id');
    if (idParam) return idParam;
    return null;
  } catch (err) {
    return null;
  }
}

async function downloadGoogleDriveFile(shareUrl, targetPath) {
  const fileId = parseGoogleDriveId(shareUrl);
  if (!fileId) {
    const err = new Error('Invalid Google Drive link');
    err.status = 400;
    throw err;
  }
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  const response = await axios.get(downloadUrl, {
    responseType: 'stream',
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400,
  });
  if (response.status >= 300) {
    const err = new Error('Google Drive link is not publicly downloadable');
    err.status = 400;
    throw err;
  }
  const contentType = response.headers['content-type'];
  if (contentType && contentType.includes('text/html')) {
    const err = new Error('Google Drive link requires authentication or is not accessible');
    err.status = 400;
    throw err;
  }
  const contentLength = response.headers['content-length'] ? Number(response.headers['content-length']) : null;
  if (contentLength && contentLength > MAX_ASSET_SIZE_BYTES) {
    const err = new Error('File exceeds 500MB limit');
    err.status = 400;
    throw err;
  }

  let downloaded = 0;
  response.data.on('data', (chunk) => {
    downloaded += chunk.length;
    if (downloaded > MAX_ASSET_SIZE_BYTES) {
      response.data.destroy(new Error('File exceeds 500MB limit'));
    }
  });

  try {
    await pipelineAsync(response.data, fs.createWriteStream(targetPath));
  } catch (err) {
    if (err.message && err.message.includes('500MB')) {
      err.status = 400;
    }
    throw err;
  }

  const stats = await fs.stat(targetPath);
  return { size: stats.size, filename: extractFilenameFromHeaders(response.headers) || `${fileId}` };
}

async function importFromGoogleDrive(shareUrl, assetType) {
  const normalizedType = (assetType || '').toLowerCase();
  assertValidAssetType(normalizedType);
  await fs.ensureDir(TEMP_DIR);
  const tempPath = path.join(TEMP_DIR, getUniqueFilename('gdrive-temp'));
  await recordEvent({
    event_type: 'asset_import_started',
    message: 'Google Drive import started',
    metadata: { asset_type: normalizedType },
  });

  try {
    const downloadInfo = await downloadGoogleDriveFile(shareUrl, tempPath);
    const { finalName, finalPath, size } = await moveToFinalLocation(
      tempPath,
      normalizedType,
      downloadInfo.filename || 'google-drive-import'
    );
    const asset = await AssetsRepository.create({
      type: normalizedType,
      filename: finalName,
      path: finalPath,
      size_bytes: size,
      status: 'analyzing',
    });
    const analyzed = await analyzeAsset(asset);
    await recordEvent({
      event_type: 'asset_import_completed',
      message: 'Google Drive import completed',
      metadata: { asset_id: asset.id, filename: finalName },
    });
    return analyzed;
  } catch (err) {
    await fs.remove(tempPath);
    await recordEvent({
      event_type: 'asset_import_failed',
      message: err.status === 400 ? err.message : 'Google Drive import failed',
      metadata: { asset_type: normalizedType },
    });
    throw err;
  }
}

module.exports = {
  MAX_ASSET_SIZE_BYTES,
  handleUploadedFile,
  listAssets,
  analyzeAssetById,
  importFromGoogleDrive,
  listImpactedJobsForAsset,
  deleteAsset,
  paths,
};
