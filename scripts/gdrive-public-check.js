#!/usr/bin/env node
// Quick manual checker for public Google Drive links.
const { preflightPublicFile, extractFileInfo } = require('../services/gdrivePublicService');

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.log('Usage: node scripts/gdrive-public-check.js <drive-share-url-or-id>');
    process.exit(1);
  }
  const info = extractFileInfo(input);
  if (!info.fileId) {
    console.error('Could not parse Drive file id');
    process.exit(1);
  }
  try {
    const meta = await preflightPublicFile({ fileId: info.fileId, resourceKey: info.resourceKey });
    console.log('OK', meta);
  } catch (err) {
    console.error('Error', err.status || err.code || err.message, err.message);
    process.exit(1);
  }
}

main();
