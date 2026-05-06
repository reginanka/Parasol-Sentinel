const mongoose = require('mongoose');

const HistorySchema = new mongoose.Schema({
    externalId: { type: String, required: true, index: true }, // 'lat,lon'
    date: { type: String, required: true, index: true },       // 'YYYY-MM-DD'
    temp_max: Number,
    temp_min: Number,
    temp_avg: Number,
    precip: Number,
    uv_max: Number,
    rh_avg: Number,
    wind_spd_max: Number,
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 60 * 60 * 24 * 1095 // Automatically delete after 1 year (in seconds)
    }
});


// Unique index to prevent duplicate records for the same day/city
HistorySchema.index({ externalId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('History', HistorySchema);
