const express = require('express');
const router = express.Router();
const path = require('path');
const upload = require('../middleware/upload');
const Contract = require('../models/Contract');
const ContractDocument = require('../models/ContractDocument');
const { protect } = require('../middleware/auth');
const logActivity = require('../utils/activityLogger');
const { canAccessContract } = require('../utils/access');

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

router.post('/upload/:contractId', protect, upload.single('document'), async (req, res, next) => {
  try {
    const contract = await loadAccessibleContract(req, res);
    if (!contract) return;
    if (!req.file) return res.status(400).json({ message: 'Please upload a file' });

    const existingDocsCount = await ContractDocument.countDocuments({ contract: req.params.contractId });

    const doc = await ContractDocument.create({
      contract: req.params.contractId,
      filename: req.file.filename,
      originalname: req.file.originalname,
      filePath: req.file.path,
      fileSize: req.file.size,
      fileType: req.file.mimetype,
      version: existingDocsCount + 1,
      uploadedBy: req.user._id
    });

    await logActivity(req.user._id, 'Document Uploaded', req.params.contractId, `Uploaded version v${doc.version}: ${doc.originalname}`);
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
