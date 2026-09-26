const path = require('path');
const multer = require('multer');

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.doc'];
const MIME_BY_EXTENSION = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword'
};

const OLE_HEADER = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_END_RECORD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const WORD_DOCUMENT_STREAM = Buffer.from('WordDocument', 'utf16le');
const ZIP_MAX_COMMENT_LENGTH = 65535;

const sanitizeOriginalName = (originalname) => {
  const withoutPath = String(originalname || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!withoutPath) return 'document';
  return withoutPath.length > 255 ? withoutPath.slice(-255) : withoutPath;
};

const extensionFor = (originalname) => path.extname(sanitizeOriginalName(originalname)).toLowerCase();

const isAllowedExtension = (originalname) => ALLOWED_EXTENSIONS.includes(extensionFor(originalname));

const canonicalMimeTypeFor = (originalname) => MIME_BY_EXTENSION[extensionFor(originalname)] || 'application/octet-stream';

const hasZipEndRecord = (buffer) => {
  const start = Math.max(0, buffer.length - ZIP_END_RECORD.length - ZIP_MAX_COMMENT_LENGTH);
  for (let index = buffer.length - ZIP_END_RECORD.length; index >= start; index -= 1) {
    if (buffer.subarray(index, index + ZIP_END_RECORD.length).equals(ZIP_END_RECORD)) return true;
  }
  return false;
};

const validateDocumentFile = (buffer, originalname) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  const extension = extensionFor(originalname);

  if (extension === '.pdf') {
    const headerWindow = buffer.subarray(0, Math.min(buffer.length, 1024));
    return headerWindow.includes(Buffer.from('%PDF-')) && buffer.includes(Buffer.from('%%EOF'));
  }

  if (extension === '.docx') {
    return buffer.subarray(0, 4).equals(ZIP_LOCAL_HEADER)
      && hasZipEndRecord(buffer)
      && buffer.includes(Buffer.from('[Content_Types].xml'))
      && buffer.includes(Buffer.from('word/document.xml'));
  }

  if (extension === '.doc') {
    return buffer.subarray(0, 8).equals(OLE_HEADER) && buffer.includes(WORD_DOCUMENT_STREAM);
  }

  return false;
};

const fileFilter = (req, file, cb) => {
  if (isAllowedExtension(file.originalname)) return cb(null, true);
  return cb(new Error('Only PDF, DOCX and DOC documents are allowed.'));
};

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }
});

module.exports = upload;
module.exports.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;
module.exports.ALLOWED_EXTENSIONS = ALLOWED_EXTENSIONS;
module.exports.sanitizeOriginalName = sanitizeOriginalName;
module.exports.extensionFor = extensionFor;
module.exports.canonicalMimeTypeFor = canonicalMimeTypeFor;
module.exports.validateDocumentFile = validateDocumentFile;
