const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const { pipeline } = require('stream');
const { promisify } = require('util');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { getUniqueFilename, paths, dataRoot } = require('../utils/storage');
const { AssetsRepository, JobsRepository } = require('../db/repositories');
const { recordEvent } = require('./eventService');
const { invalidateJobs } = require('./jobService');
const googleDriveService = require('./googleDriveService');
const gdrivePublicService = require('./gdrivePublicService');

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

function parseGoogleDriveId(urlOrId) {
  if (!urlOrId) return null;
  if (/^[A-Za-z0-9_-]{10,}$/.test(urlOrId)) return urlOrId;
  try {
    const parsed = new URL(urlOrId);
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

const importStatuses = new Map();

function updateImportStatus(importId, patch) {
  const current = importStatuses.get(importId) || {};
  importStatuses.set(importId, { ...current, ...patch, updated_at: new Date().toISOString() });
}

function inferAssetTypeFromMime(mimeType, fallback) {
  if (mimeType?.startsWith('video/')) return 'video';
  if (mimeType?.startsWith('audio/')) return 'audio';
  if (fallback) return fallback.toLowerCase();
  return null;
}

async function runGoogleDriveImport(importId, { shareUrl, fileId, assetType }) {
  let tempPath = null;
  try {
    const driveFileId = fileId || parseGoogleDriveId(shareUrl);
    if (!driveFileId) {
      const err = new Error('Invalid Google Drive link or file id');
      err.status = 400;
      throw err;
    }

    await recordEvent({
      event_type: 'asset_import_started',
      message: 'Google Drive import started',
      metadata: { asset_type: assetType || null, file_id: driveFileId },
    });

    await fs.ensureDir(TEMP_DIR);
    tempPath = path.join(TEMP_DIR, getUniqueFilename('gdrive-temp'));
    updateImportStatus(importId, {
      status: 'downloading',
      progress: 0,
    });

    let downloadResult = null;
    try {
      downloadResult = await gdrivePublicService.downloadPublicFile({
        fileId: driveFileId,
        targetPath: tempPath,
        preferredName: shareUrl || driveFileId,
        onProgress: (progress) => updateImportStatus(importId, { status: 'downloading', progress }),
      });
    } catch (err) {
      if (err.code === 'GDRIVE_PERMISSION_REQUIRED') {
        const metadata = await googleDriveService.getFileMetadata(driveFileId);
        downloadResult = {
          filename: metadata.name || `${driveFileId}`,
          mimeType: metadata.mimeType || null,
          sizeBytes: metadata.size ? Number(metadata.size) : null,
        };
        await googleDriveService.downloadFile(driveFileId, tempPath, (progress) => {
          updateImportStatus(importId, { status: 'downloading', progress });
        });
      } else {
        throw err;
      }
    }

    const inferredType = inferAssetTypeFromMime(downloadResult.mimeType, assetType);
    const normalizedType = (inferredType || '').toLowerCase();
    assertValidAssetType(normalizedType);

    const stats = await fs.stat(tempPath);
    if (stats.size > MAX_ASSET_SIZE_BYTES) {
      const err = new Error('File exceeds 500MB limit');
      err.status = 400;
      throw err;
    }

    const { finalName, finalPath, size } = await moveToFinalLocation(
      tempPath,
      normalizedType,
      downloadResult.filename || `${driveFileId}`
    );
    updateImportStatus(importId, { status: 'processing', progress: 100, filename: finalName });

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
      metadata: { asset_id: asset.id, filename: finalName, file_id: driveFileId },
    });
    updateImportStatus(importId, { status: 'completed', asset: analyzed });
  } catch (err) {
    if (tempPath) await fs.remove(tempPath).catch(() => {});
    await recordEvent({
      event_type: 'asset_import_failed',
      message: err.status === 400 ? err.message : 'Google Drive import failed',
      metadata: { error: err.message },
    });
    updateImportStatus(importId, {
      status: 'failed',
      error: err.message || 'Google Drive import failed',
    });
  }
}

async function startGoogleDriveImport({ shareUrl, fileId, assetType }) {
  const driveFileId = fileId || parseGoogleDriveId(shareUrl);
  if (!driveFileId) {
    const err = new Error('Invalid Google Drive link or file id');
    err.status = 400;
    throw err;
  }
  try {
    await gdrivePublicService.preflightPublicFile(driveFileId);
  } catch (err) {
    if (err.code === 'GDRIVE_PERMISSION_REQUIRED') {
      // Allow proceeding when OAuth is connected; otherwise surface a friendly error immediately.
      try {
        await googleDriveService.ensureAuthorized();
      } catch (authErr) {
        throw err;
      }
    } else {
      throw err;
    }
  }
  const importId = uuidv4();
  importStatuses.set(importId, { status: 'pending', progress: 0 });
  setImmediate(() => {
    runGoogleDriveImport(importId, { shareUrl, fileId, assetType }).catch((err) => {
      console.error('Google Drive import error', err);
      updateImportStatus(importId, { status: 'failed', error: err.message || 'Import failed' });
    });
  });
  return { import_id: importId };
}

function getGoogleImportStatus(importId) {
  return importStatuses.get(importId) || { status: 'unknown' };
}

module.exports = {
  MAX_ASSET_SIZE_BYTES,
  handleUploadedFile,
  listAssets,
  analyzeAssetById,
  startGoogleDriveImport,
  getGoogleImportStatus,
  listImpactedJobsForAsset,
  deleteAsset,
  paths,
};
