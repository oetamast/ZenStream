const fs = require('fs-extra');
const path = require('path');
const dataRoot = process.env.DATA_DIR || '/data';
const ensureDirectories = () => {
  const dirs = [
    path.join(dataRoot, 'assets/videos'),
    path.join(dataRoot, 'assets/audios'),
    path.join(dataRoot, 'assets/sfx'),
    path.join(dataRoot, 'assets/avatars'),
    path.join(dataRoot, 'thumbs'),
    path.join(dataRoot, 'logs')
  ];

  dirs.forEach(dir => {
    fs.ensureDirSync(dir);
  });
};
const getUniqueFilename = (originalFilename) => {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000000);
  const ext = path.extname(originalFilename);
  const basename = path.basename(originalFilename, ext)
    .replace(/[^a-z0-9]/gi, '-')
    .toLowerCase();
  return `${basename}-${timestamp}-${random}${ext}`;
};
module.exports = {
  ensureDirectories,
  getUniqueFilename,
  paths: {
    videos: path.join(dataRoot, 'assets/videos'),
    thumbnails: path.join(dataRoot, 'thumbs'),
    avatars: path.join(dataRoot, 'assets/avatars'),
    audios: path.join(dataRoot, 'assets/audios'),
    sfx: path.join(dataRoot, 'assets/sfx'),
    logs: path.join(dataRoot, 'logs')
  },
  dataRoot
};