const mongoose = require('mongoose');

const obligationSchema = new mongoose.Schema({
  contract: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract', required: true },
  title: { type: String, required: true },
  description: { type: String },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  dueDate: { type: Date, required: true },
  status: { type: String, enum: ['Pending', 'In Progress', 'Completed', 'Overdue'], default: 'Pending' }
}, { timestamps: true });

obligationSchema.index({ status: 1 });
obligationSchema.index({ assignedTo: 1, status: 1 });
obligationSchema.index({ dueDate: 1 });
// GET /api/obligations is `filter by assignee (Employee) or nothing
// (Admin/Manager), sorted by dueDate ascending`, and the overdue notification
// feed adds `status: 'Overdue'` to the same assignee filter. The compound keys
// below match filter + sort so the query is index-served instead of filtering
// and then blocking-sorting every obligation in the collection.
obligationSchema.index({ assignedTo: 1, dueDate: 1 });
obligationSchema.index({ status: 1, dueDate: 1 });

module.exports = mongoose.model('Obligation', obligationSchema);