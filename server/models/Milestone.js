const mongoose = require('mongoose');

const milestoneSchema = new mongoose.Schema({
  contract: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract', required: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  dueDate: { type: Date, required: true },
  status: { type: String, enum: ['Pending', 'In Progress', 'Completed', 'Overdue'], default: 'Pending' }
}, { timestamps: true });

milestoneSchema.index({ status: 1 });
milestoneSchema.index({ assignedTo: 1, status: 1 });
milestoneSchema.index({ dueDate: 1 });
// See the note in models/Obligation.js: obligations and milestones are the same
// query shape, so they must carry the same filter + sort indexes.
milestoneSchema.index({ assignedTo: 1, dueDate: 1 });
milestoneSchema.index({ status: 1, dueDate: 1 });

module.exports = mongoose.model('Milestone', milestoneSchema);
