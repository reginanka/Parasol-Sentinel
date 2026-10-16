const mongoose = require('mongoose');

/**
 * Nested optional blocks without `default: null` on every field.
 * Defaults on nested paths make Mongoose mark them modified on load →
 * concurrent cron `.save()` hits VersionError
 * ("No matching document found for id … version N modifiedPaths …").
 */
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
        dayKey: { type: String, default: null }, // 'YYYY-MM-DD' (Europe/Kyiv)
        eveningThisMonth: { type: Number, default: 0 },
        alertsThisMonth: { type: Number, default: 0 },
        eveningToday: { type: Number, default: 0 },
        alertsToday: { type: Number, default: 0 },
        eveningTotal: { type: Number, default: 0 },
        alertsTotal: { type: Number, default: 0 }
    },

    /**
     * Support chat mirror in TOPIC_HISTORY / HISTORY_MSG_ID:
     * one editable Telegram message per user with running transcript.
     * No nested defaults — avoid dirtying document on cron load/save.
     */
    supportHistory: {
        messageId: Number,
        fileMessageId: Number,
        notifyMessageIds: [Number],
        transcript: String,
        assetSeq: Number,
        updatedAt: Date
    },

    /**
     * Snapshot of Telegram User flags for admin «Системні».
     * No nested defaults — same VersionError protection as supportHistory.
     */
    tgMeta: {
        isBot: Boolean,
        isPremium: Boolean,
        addedToAttachmentMenu: Boolean,
        canJoinGroups: Boolean,
        canReadAllGroupMessages: Boolean,
        supportsInlineQueries: Boolean,
        canConnectToBusiness: Boolean,
        hasMainWebApp: Boolean,
        joinToSendMessages: Boolean,
        hasGuestQueries: Boolean,
        updatedAt: Date
    },

    /**
     * Text input mode for free-form messages:
     *  - idle          — ignore free text (admin still notified)
     *  - awaiting_city — Nominatim city search
     *  - support       — accept as support ticket (after Help)
     */
    botMode: {
        type: String,
        enum: ['idle', 'awaiting_city', 'support'],
        default: 'idle'
    },

    lastActivityAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
