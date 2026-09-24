const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const upload = require('../middleware/upload');
const Contract = require('../models/Contract');
const ContractDocument = require('../models/ContractDocument');
const { protect } = require('../middleware/auth');
const logActivity = require('../utils/activityLogger');
const { canAccessContract } = require('../utils/access');
const { validateFileSignature } = upload;

const loadAccessibleContract = async (req, res) => {
  const contract = await Contract.findById(req.params.contractId || req.body.contract);
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

// Resolve and authorize the contract BEFORE multer writes the file to disk so
// unauthorized/unknown contracts never create orphaned uploads.
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

const removeFile = (filePath) => {
  if (typeof filePath === 'string') fs.unlink(filePath, () => {});
};

router.post('/upload/:contractId', protect, resolveContractBeforeUpload, upload.single('document'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Please upload a file' });

    // Reject files whose content does not match their claimed documents
    // extension (content sniffing via magic bytes).
    if (!validateFileSignature(req.file.path, req.file.originalname)) {
      removeFile(req.file.path);
      return res.status(400).json({ message: 'File content does not match its extension (PDF, DOCX or DOC only)' });
    }

    let doc;
    try {
      const existingDocsCount = await ContractDocument.countDocuments({ contract: req.contract._id });

      doc = await ContractDocument.create({
        contract: req.contract._id,
        filename: req.file.filename,
        originalname: req.file.originalname,
        filePath: req.file.path,
        fileSize: req.file.size,
        fileType: req.file.mimetype,
        version: existingDocsCount + 1,
        uploadedBy: req.user._id
      });
    } catch (error) {
      removeFile(req.file.path);
      throw error;
    }

    await logActivity(req.user._id, 'Document Uploaded', req.contract._id, `Uploaded version v${doc.version}: ${doc.originalname}`);
    res.status(201).json(doc);
  } catch (error) {
    next(error);
  }
});

router.get('/contract/:contractId', protect, async (req, res, next) => {
  try {
    const contract = await loadAccessibleContract(req, res);
    if (!contract) return;
    const docs = await ContractDocument.find({ contract: req.params.contractId }).populate('uploadedBy', 'name');
    res.json(docs);
  } catch (error) {
    next(error);
  }
});

router.get('/download/:id', protect, async (req, res, next) => {
  try {
    const doc = await ContractDocument.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Document not found' });
    const contract = await Contract.findById(doc.contract);
    if (!canAccessContract(req.user, contract)) {
      return res.status(403).json({ message: 'You do not have access to this document' });
    }
    const fullPath = path.resolve(__dirname, '..', doc.filePath);
    res.download(fullPath, doc.originalname);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
