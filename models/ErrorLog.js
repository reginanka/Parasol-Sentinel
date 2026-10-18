const mongoose = require('mongoose');

/**
 * Lightweight error / cron failure log for admin analytics.
 * Written automatically from logger when message looks like a failure.
 */
const ErrorLogSchema = new mongoose.Schema({
    source: { type: String, default: 'cron' },
    message: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

// Single index + TTL (~90 days). Do not also set index: true on the field — duplicate warning.
ErrorLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.models.ErrorLog || mongoose.model('ErrorLog', ErrorLogSchema);
