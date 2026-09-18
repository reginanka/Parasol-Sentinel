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
        updatedAt: Date,
        forecast: Array, // 3-day forecast data
        hourlyPrecip: Array, // план опадів на завтра (відносно вечірньої відправки)
        forecastedKp: Number, // max Kp, що був у вечірньому прогнозі на target-день
        forecastedKpDate: String // YYYY-MM-DD — день, на який стосується forecastedKp
    },
    lastGeomagAlert: {
        date: String,
        maxKp: Number
    },
    lastAqiAlert: {
        date: String,
        tier: Number,
        aqi: Number
    },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.City || mongoose.model('City', CitySchema);
