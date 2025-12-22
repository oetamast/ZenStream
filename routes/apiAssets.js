const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const {
  MAX_ASSET_SIZE_BYTES,
  handleUploadedFile,
  listAssets,
  analyzeAssetById,
  importFromGoogleDrive,
} = require('../services/assetService');
const { getUniqueFilename, dataRoot } = require('../utils/storage');
const { AssetsRepository } = require('../db/repositories');

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

router.post('/import/google-drive', async (req, res) => {
  try {
    const { share_url, asset_type } = req.body;
    if (!share_url || !asset_type) {
      return res.status(400).json({ message: 'share_url and asset_type are required' });
    }
    const asset = await importFromGoogleDrive(share_url, asset_type);
    res.json({ asset });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: status === 500 ? 'Google Drive import failed' : err.message });
  }
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
