const mongoose = require('mongoose');

const contractDocumentSchema = new mongoose.Schema({
  contract: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract', required: true },
  filename: { type: String, required: true },
  originalname: { type: String, required: true },
  filePath: { type: String, select: false },
  // 'r2' is retained so rows written by the retired Cloudflare R2 backend stay
  // schema-valid; new documents are always written as 'supabase'.
  storageBackend: { type: String, enum: ['supabase', 'local', 'r2'], select: false },
  storageKey: { type: String, select: false },
  checksum: { type: String },
  fileSize: { type: Number },
  fileType: { type: String },
  version: { type: Number, default: 1 },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

contractDocumentSchema.index({ contract: 1, version: 1 }, { unique: true });

module.exports = mongoose.model('ContractDocument', contractDocumentSchema);
