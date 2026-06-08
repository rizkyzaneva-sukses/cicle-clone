const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const uploadRoot = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(uploadRoot, { recursive: true });

function safeName(name) {
  const ext = path.extname(name || '').slice(0, 12).toLowerCase();
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadRoot),
  filename: (_req, file, cb) => cb(null, safeName(file.originalname))
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 8
  }
});

function attachmentData(file, userId, extra = {}) {
  return {
    filename: file.filename,
    originalName: file.originalname || file.filename,
    mimeType: file.mimetype || 'application/octet-stream',
    size: file.size || 0,
    url: `/uploads/${file.filename}`,
    uploadedById: userId,
    ...extra
  };
}

module.exports = { upload, attachmentData };
