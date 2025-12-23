#!/usr/bin/env node
const assetService = require('../services/assetService');

try {
  const id = assetService._createImportId();
  if (!id || typeof id !== 'string' || id.length < 8) {
    throw new Error('Import id not generated correctly');
  }
  console.log('Generated import id:', id);
  process.exit(0);
} catch (err) {
  console.error('Import id generation failed:', err.message);
  process.exit(1);
}
