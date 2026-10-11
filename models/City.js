const mongoose = require('mongoose');

const CitySchema = new mongoose.Schema({
    name: { type: String, required: true },
    lat: { type: Number, required: true },
    lon: { type: Number, required: true },
    externalId: { type: String, unique: true },
    timezone: { type: String },
    eveningState: {
        temp: Number,
        weatherCode: Number,
        updatedAt: Date,
        forecast: Array,
        hourlyPrecip: Array,
        hourlyPrecipUpdatedAt: Date,
        days: { type: mongoose.Schema.Types.Mixed, default: {} },
        forecastedKp: Number,
        forecastedKpDate: String
    },
    lastGeomagAlert: {
        date: String,
        maxKp: Number,
        rank: Number,
        level: String
    },
    /**
     * Evening-planned max geomag level per calendar day (YYYY-MM-DD).
     * Written only by cron-forecast:
     *   - tomorrow: always refresh
     *   - today: seed only if missing
     * Read by cron-check quiet mode as planRank for todayStr.
     * Shape: { "2026-10-11": { maxRank, maxKp, asOf }, ... }
     */
    eveningGeomag: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastAqiAlert: {
        date: String,
        tier: Number,
        aqi: Number
    },
    lastFrostWbAlert: {
        date: String,
        type: String,
        soilEst: Number
    },
    dashboardSnapshot: {
        updatedAtOm: Date,
        updatedAtWb: Date,
        current: Object,
        currentOm: Object,
        currentSource: String,
        hourly: Object,
        daily: Array,
        dailyOm: Object,
        dailySource: String,
        aqi: Object,
        waqi: Object,
        geomag: Object,
        lat: Number,
        lon: Number,
        timezone: String
    },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.City || mongoose.model('City', CitySchema);
