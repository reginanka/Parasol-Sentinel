const mongoose = require('mongoose');

const CitySchema = new mongoose.Schema({
    name: { type: String, required: true },
    lat: { type: Number, required: true },
    lon: { type: Number, required: true },
    externalId: { type: String, unique: true }, // e.g., "50.450,30.523" to prevent duplicates
    timezone: { type: String }, // IANA timezone e.g. "Europe/Kyiv", "America/New_York"
    eveningState: {
        temp: Number,
        weatherCode: Number,
        updatedAt: Date, // legacy; prefer days[date].asOf for alerts
        forecast: Array, // full multi-day Weatherbit snapshot (messages + fallback)
        hourlyPrecip: Array, // legacy flat multi-day hourly (compat)
        hourlyPrecipUpdatedAt: Date, // legacy
        // Day-scoped baseline: one asOf + data per calendar day (YYYY-MM-DD)
        // { asOf, min_temp, max_temp, hourlyPrecip: [{ time, precip, prob? }] }
        days: { type: mongoose.Schema.Types.Mixed, default: {} },
        // Legacy (no longer written by evening forecast; check owns geomag state)
        forecastedKp: Number,
        forecastedKpDate: String
    },
    // Geomag state owned exclusively by cron-check (LOGIC E)
    // rank: 0 quiet | 1 unsettled | 2 storm
    lastGeomagAlert: {
        date: String,   // YYYY-MM-DD local
        maxKp: Number,
        rank: Number,   // 0 | 1 | 2
        level: String   // 'quiet' | 'unsettled' | 'storm'
    },
    lastAqiAlert: {
        date: String,
        tier: Number,
        aqi: Number
    },
    // Weatherbit soil-frost cross-check (evening cron ~21:00 local)
    lastFrostWbAlert: {
        date: String,   // YYYY-MM-DD (local)
        type: String,   // 'confirm' | 'warn' | 'deny'
        soilEst: Number
    },
    // Snapshot for dashboard — filled by crons; weather-data reads this first
    dashboardSnapshot: {
        updatedAtOm: Date,   // last Open-Meteo write (hourly / current OM)
        updatedAtWb: Date,   // last Weatherbit write (current + daily)
        current: Object,       // primary current for UI (prefer Weatherbit)
        currentOm: Object,     // latest Open-Meteo current (fallback / freshness)
        currentSource: String, // 'weatherbit' | 'open-meteo'
        hourly: Object,        // Open-Meteo hourly (incl. soil_temperature_0cm / 6cm)
        daily: Array,          // Weatherbit daily cards (preferred)
        dailyOm: Object,       // Open-Meteo daily { time, temperature_2m_mean } for frost
        dailySource: String,   // 'weatherbit' | 'open-meteo'
        aqi: Object,           // Open-Meteo air-quality hourly (optional)
        waqi: Object,          // WAQI live sensors (optional)
        geomag: Object,        // NOAA Kp { maxKp, badge, level, rank, updatedAt }
        lat: Number,
        lon: Number,
        timezone: String
    },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.City || mongoose.model('City', CitySchema);
