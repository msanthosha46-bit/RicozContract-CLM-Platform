const mongoose = require('mongoose');

const milestoneSchema = new mongoose.Schema({
  contract: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract', required: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  dueDate: { type: Date, required: true },
  status: { type: String, enum: ['Pending', 'In Progress', 'Completed', 'Overdue'], default: 'Pending' }
}, { timestamps: true });

module.exports = mongoose.model('Milestone', milestoneSchema);
