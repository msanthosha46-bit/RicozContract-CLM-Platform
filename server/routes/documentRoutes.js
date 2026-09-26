const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const router = express.Router();
const upload = require('../middleware/upload');
const Contract = require('../models/Contract');
const ContractDocument = require('../models/ContractDocument');
const { protect } = require('../middleware/auth');
const createRateLimiter = require('../middleware/rateLimit');
const logActivity = require('../utils/activityLogger');
const { canAccessContract } = require('../utils/access');
const { getStorageAdapter, StorageError } = require('../services/storage');
const {
  sanitizeOriginalName,
  extensionFor,
  canonicalMimeTypeFor,
  validateDocumentFile
} = upload;

const MAX_VERSION_ATTEMPTS = 10;

// Uploads cost real storage and bandwidth, so they are capped per signed-in
// user. Keying on the user id means one account cannot exhaust the allowance of
// everyone else sharing an IP.
const uploadLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many uploads. Please try again in 15 minutes.',
  keyResolver: (req) => (req.user && req.user._id ? String(req.user._id) : null)
});

const loadAccessibleContract = async (req, res) => {
  const contract = await Contract.findById(req.params.contractId);
  if (!contract) {
    res.status(404).json({ message: 'Contract not found' });
    return null;
  }
  if (!canAccessContract(req.user, contract)) {
    res.status(403).json({ message: 'You do not have access to this contract' });
    return null;
  }
  return contract;
};

const resolveContractBeforeUpload = async (req, res, next) => {
  try {
    if (!req.params.contractId) {
      return res.status(400).json({ message: 'A contract is required' });
    }
    const contract = await Contract.findById(req.params.contractId);
    if (!contract) {
      return res.status(404).json({ message: 'Contract not found' });
    }
    if (!canAccessContract(req.user, contract)) {
      return res.status(403).json({ message: 'You do not have access to this contract' });
    }
    if (contract.isArchived) {
      return res.status(400).json({ message: 'Documents cannot be uploaded to archived contracts' });
    }
    req.contract = contract;
    next();
  } catch (error) {
    next(error);
  }
};

const INTERNAL_DOCUMENT_FIELDS = ['storageKey', 'storageBackend', 'filePath'];

const toPublicDocument = (doc) => {
  const plain = typeof doc?.toObject === 'function' ? doc.toObject() : { ...doc };
  for (const field of INTERNAL_DOCUMENT_FIELDS) delete plain[field];
  return plain;
};

const contentDispositionFor = (filename) => {
  const safeName = String(filename || 'document').replace(/[\r\n"]/g, '_');
  const asciiName = safeName.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
};

const sendRouteError = (error, res, next) => {
  if (error instanceof StorageError || (error.expose && Number.isInteger(error.status))) {
    return res.status(error.status).json({ message: error.message });
  }
  return next(error);
};

const nextVersionFor = async (contractId) => {
  const latest = await ContractDocument.findOne({ contract: contractId })
    .sort({ version: -1 })
    .select({ version: 1 })
    .lean();
  return Math.max(0, Number(latest?.version) || 0) + 1;
};

const versionUnavailableError = () => {
  const error = new Error('Unable to allocate a document version. Please retry.');
  error.status = 503;
  error.expose = true;
  return error;
};

const createDocumentWithVersion = async (payload) => {
  for (let attempt = 0; attempt < MAX_VERSION_ATTEMPTS; attempt += 1) {
    const version = await nextVersionFor(payload.contract);
    try {
      return await ContractDocument.create({ ...payload, version });
    } catch (error) {
      if (error.code !== 11000) throw error;
      if (attempt === MAX_VERSION_ATTEMPTS - 1) throw versionUnavailableError();
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
  throw versionUnavailableError();
};

router.post('/upload/:contractId', protect, uploadLimiter, resolveContractBeforeUpload, upload.single('document'), async (req, res, next) => {
  const storage = getStorageAdapter();
  const originalname = sanitizeOriginalName(req.file?.originalname);
  let storageKey = null;
  let metadataCreated = false;

  try {
    if (!req.file?.buffer) return res.status(400).json({ message: 'Please upload a file' });
    if (!validateDocumentFile(req.file.buffer, originalname)) {
      return res.status(400).json({ message: 'File content does not match its extension (PDF, DOCX or DOC only)' });
    }

    storageKey = storage.createObjectKey(extensionFor(originalname));
    const checksum = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

    await storage.upload({
      key: storageKey,
      body: req.file.buffer,
      contentType: canonicalMimeTypeFor(originalname),
      checksum,
      filename: originalname
    });

    try {
      const doc = await createDocumentWithVersion({
        contract: req.contract._id,
        filename: path.basename(storageKey),
        originalname,
        storageBackend: storage.backend,
        storageKey,
        checksum,
        fileSize: req.file.size,
        fileType: canonicalMimeTypeFor(originalname),
        uploadedBy: req.user._id
      });
      metadataCreated = true;

      await logActivity(req.user._id, 'Document Uploaded', req.contract._id, `Uploaded version v${doc.version}: ${doc.originalname}`);
      return res.status(201).json(toPublicDocument(doc));
    } catch (error) {
      try {
        await storage.delete({ backend: storage.backend, key: storageKey }, { authorizedBy: req.user._id });
      } catch (cleanupError) {
        console.error('Failed to remove an incomplete document upload');
      }
      throw error;
    }
  } catch (error) {
    if (storageKey && metadataCreated) {
      console.error('Document metadata was created but the response could not be completed');
    }
    return sendRouteError(error, res, next);
  }
});

router.get('/contract/:contractId', protect, async (req, res, next) => {
  try {
    const contract = await loadAccessibleContract(req, res);
    if (!contract) return;
    const docs = await ContractDocument.find({ contract: contract._id })
      .sort({ version: 1, createdAt: 1 })
      .populate('uploadedBy', 'name');
    res.json(docs.map(toPublicDocument));
  } catch (error) {
    sendRouteError(error, res, next);
  }
});

router.get('/download/:id', protect, async (req, res, next) => {
  try {
    const doc = await ContractDocument.findById(req.params.id).select('+filePath +storageKey +storageBackend');
    if (!doc) return res.status(404).json({ message: 'Document not found' });
    const contract = await Contract.findById(doc.contract);
    if (!canAccessContract(req.user, contract)) {
      return res.status(403).json({ message: 'You do not have access to this document' });
    }

    const object = await getStorageAdapter().download({
      backend: doc.storageBackend || 'local',
      key: doc.storageKey,
      filePath: doc.filePath
    });
    const stream = typeof object.body?.pipe === 'function' ? object.body : Readable.from(object.body);
    const contentLength = Number.isInteger(object.contentLength) ? object.contentLength : doc.fileSize;

    res.status(200);
    res.setHeader('Content-Type', canonicalMimeTypeFor(doc.originalname));
    if (Number.isInteger(contentLength)) res.setHeader('Content-Length', contentLength);
    res.setHeader('Content-Disposition', contentDispositionFor(doc.originalname));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    stream.once('error', (error) => {
      if (res.headersSent) return res.destroy(error);
      sendRouteError(new StorageError('Document download failed', { status: 503 }), res, next);
    });
    res.once('close', () => {
      if (!res.writableEnded) stream.destroy();
    });
    stream.pipe(res);
  } catch (error) {
    sendRouteError(error, res, next);
  }
});

module.exports = router;
