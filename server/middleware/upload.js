const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const uploadDirectory = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDirectory, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, uploadDirectory);
  },
  filename(req, file, cb) {
    const extension = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${extension}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['.pdf', '.docx', '.doc'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedTypes.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only PDF, DOCX and DOC documents are allowed.'));
  }
};

// Validate that the on-disk file content matches its claimed extension by
// checking the file "magic bytes". This prevents arbitrary executable bytes
// from being stored under a harmless .pdf/.docx/.doc name.
const validateFileSignature = (filePath, originalname) => {
  const ext = path.extname(originalname).toLowerCase();
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(8);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    if (bytesRead < 4) return false;

    if (ext === '.pdf') return header.subarray(0, 4).equals(Buffer.from('%PDF'));

    if (ext === '.docx') {
      // ZIP container (PK\x03\x04) as used by Office Open XML.
      return header.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    }

    if (ext === '.doc') {
      // Microsoft Compound File/OLECF (D0 CF 11 E0 A1 B1 1A E1).
      return header.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    }

    return false;
  } finally {
    fs.closeSync(fd);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});
module.exports = upload;
module.exports.validateFileSignature = validateFileSignature;