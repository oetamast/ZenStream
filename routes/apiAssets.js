const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const {
  MAX_ASSET_SIZE_BYTES,
  handleUploadedFile,
  listAssets,
  analyzeAssetById,
  startGoogleDriveImport,
  listImpactedJobsForAsset,
  deleteAsset,
  getGoogleImportStatus,
} = require('../services/assetService');
const { getUniqueFilename, dataRoot } = require('../utils/storage');
const { AssetsRepository } = require('../db/repositories');
const googleDriveService = require('../services/googleDriveService');

const router = express.Router();
const tempDir = path.join(dataRoot, 'tmp/assets');

const uploadStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      await fs.ensureDir(tempDir);
      cb(null, tempDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    cb(null, getUniqueFilename(file.originalname));
  },
});

const uploader = multer({ storage: uploadStorage, limits: { fileSize: MAX_ASSET_SIZE_BYTES } });
const allowedTypes = ['video', 'audio', 'sfx'];

router.get('/', async (req, res) => {
  try {
    const { type, query } = req.query;
    if (type && !allowedTypes.includes(type)) {
      return res.status(400).json({ message: 'Invalid asset type filter' });
    }
    const assets = await listAssets({ type, query: query || undefined });
    res.json({ assets });
  } catch (err) {
    console.error('Failed to list assets', err);
    res.status(500).json({ message: 'Failed to list assets' });
  }
});

router.post('/upload', (req, res) => {
  uploader.single('file')(req, res, async (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds 500MB limit' : err.message || 'Upload failed';
      return res.status(400).json({ message });
    }
    try {
      const assetType = req.body.asset_type;
      const asset = await handleUploadedFile(req.file, assetType);
      res.json({ asset });
    } catch (error) {
      if (req.file?.path) {
        await fs.remove(req.file.path).catch(() => {});
      }
      const status = error.status || 500;
      res.status(status).json({ message: status === 500 ? 'Failed to upload asset' : error.message });
    }
  });
});

router.get('/google-drive/auth/status', async (req, res) => {
  try {
    const status = await googleDriveService.authStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ message: 'Failed to load Google Drive status' });
  }
});

router.post('/google-drive/auth/start', async (req, res) => {
  try {
    const result = await googleDriveService.startAuth(req);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: err.message || 'Failed to start Google OAuth' });
  }
});

router.get('/google-drive/auth/callback', async (req, res) => {
  try {
    await googleDriveService.handleAuthCallback(req);
    res.send(`Google Drive connected. You can close this window and return to ZenStream.`);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).send(err.message || 'Failed to complete Google OAuth');
  }
});

router.get('/google-drive/files', async (req, res) => {
  try {
    const files = await googleDriveService.listFiles({ query: req.query.query });
    res.json({ files });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: err.message || 'Failed to list Google Drive files' });
  }
});

async function handleDriveImport(req, res) {
  try {
    const { share_url, file_id, asset_type } = req.body;
    const result = await startGoogleDriveImport({ shareUrl: share_url, fileId: file_id, assetType: asset_type });
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: err.message || 'Google Drive import failed' });
  }
}

router.post('/google-drive/import', handleDriveImport);
router.post('/import/google-drive', handleDriveImport);

router.get('/google-drive/status/:id', (req, res) => {
  const status = getGoogleImportStatus(req.params.id);
  res.json(status);
});

router.post('/:id/analyze', async (req, res) => {
  try {
    const asset = await analyzeAssetById(req.params.id);
    res.json({ asset });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: status === 500 ? 'Asset analysis failed' : err.message });
  }
});

router.get('/:id/impacted-jobs', async (req, res) => {
  try {
    const jobs = await listImpactedJobsForAsset(req.params.id);
    res.json({
      impacted_jobs: jobs.map((j) => ({ id: j.id, name: j.name })).slice(0, 50),
      total: jobs.length,
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load impacted jobs' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const impacted = await listImpactedJobsForAsset(req.params.id);
    const force = req.query.force === 'true' || req.query.force === '1';
    if (impacted.length && !force) {
      return res.status(400).json({
        message: 'Asset is used by existing jobs',
        impacted_jobs: impacted.map((j) => ({ id: j.id, name: j.name })).slice(0, 50),
        total: impacted.length,
      });
    }
    const result = await deleteAsset(req.params.id);
    if (!result) return res.status(404).json({ message: 'Asset not found' });
    res.json({
      deleted: true,
      impacted_jobs: (result.impactedJobs || []).map((j) => ({ id: j.id, name: j.name })).slice(0, 50),
      total: result.impactedJobs?.length || 0,
    });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Failed to delete asset' });
  }
});

router.get('/:id/thumbnail', async (req, res) => {
  try {
    const asset = await AssetsRepository.findById(req.params.id);
    if (!asset || !asset.thumbnail_path) {
      return res.status(404).json({ message: 'Thumbnail not found' });
    }
    const filePath = path.resolve(asset.thumbnail_path);
    if (!(await fs.pathExists(filePath))) {
      return res.status(404).json({ message: 'Thumbnail not found' });
    }
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ message: 'Failed to load thumbnail' });
  }
});

module.exports = router;
