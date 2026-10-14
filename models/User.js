const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true },
    username: String,
    firstName: String,
    lastName: String,
    languageCode: String, // raw Telegram language_code
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

    /**
     * Access control for paid / limited features.
     *  - 'none'      — немає доступу (заблокований / без підписки)
     *  - 'unlimited' — безліміт
     */
    accessLevel: {
        type: String,
        enum: ['none', 'unlimited'],
        default: 'unlimited'
    },

    /** Usage counters for admin analytics */
    usage: {
        monthKey: { type: String, default: null }, // 'YYYY-MM'
        eveningThisMonth: { type: Number, default: 0 },
        alertsThisMonth: { type: Number, default: 0 },
        eveningTotal: { type: Number, default: 0 },
        alertsTotal: { type: Number, default: 0 }
    },

    lastActivityAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
