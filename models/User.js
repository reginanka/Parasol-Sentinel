const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true },
    username: String,
    city: { type: String, default: null },
    lat: Number,
    lon: Number,
    timezone: String,
    lastState: {
        temp: Number,
        weatherCode: Number,
        updatedAt: { type: Date, default: Date.now },
        fullData: Object
    },
    language: { type: String, default: 'uk' },
    notificationsEnabled: { type: Boolean, default: true },
    units: {
        wind: { type: String, default: 'ms' },
        pressure: { type: String, default: 'mmhg' },
        temp: { type: String, default: 'c' }
    },
    crops: [String],
    forecastSettings: {
        daysCount: { type: Number, default: 3 },
        enabledMetrics: {
            type: [String],
            default: ['condition', 'temp', 'precip', 'wind', 'pressure']
        }
    },
    alertTriggers: {
        temperature: { type: Boolean, default: true },
        precip: { type: Boolean, default: true },
        magneticStorm: { type: Boolean, default: true },
        airQuality: { type: Boolean, default: true }
    },
    /**
     * Geomagnetic storm notification mode:
     *  - 'active' — escalate + de-escalate (incl. intermediate drops)
     *  - 'quiet'  — escalate only above evening plan & above lastAlertedRank; better only full calm
     *  - 'off'    — no geomag alerts
     * Default for new users: quiet. Legacy magneticStorm===false migrates to off.
     */
    geomagMode: {
        type: String,
        enum: ['active', 'quiet', 'off'],
        default: 'quiet'
    },
    eveningForecastEnabled: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
