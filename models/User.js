const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true },
    username: String,
    firstName: String,
    lastName: String,
    languageCode: String, // raw Telegram language_code (mirror of tg.languageCode)

    /**
     * Snapshot of Telegram User fields from the last interaction (Bot API User).
     * Updated on every touchUserProfile / registration path that receives `from`.
     * @see https://core.telegram.org/bots/api#user
     */
    tg: {
        isBot: { type: Boolean, default: null },
        isPremium: { type: Boolean, default: null },
        addedToAttachmentMenu: { type: Boolean, default: null },
        languageCode: { type: String, default: null },
        /** Bot-only flags — still stored if Telegram ever sends them */
        canJoinGroups: { type: Boolean, default: null },
        canReadAllGroupMessages: { type: Boolean, default: null },
        supportsInlineQueries: { type: Boolean, default: null },
        canConnectToBusiness: { type: Boolean, default: null },
        hasMainWebApp: { type: Boolean, default: null },
        supportsJoinRequestQueries: { type: Boolean, default: null },
        supportsGuestQueries: { type: Boolean, default: null },
        /** ISO time of last successful TG field write */
        updatedAt: { type: Date, default: null }
    },

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
     */
    supportHistory: {
        messageId: { type: Number, default: null },
        fileMessageId: { type: Number, default: null },
        /** Recent admin-notify Telegram message_ids → for Reply resolution */
        notifyMessageIds: { type: [Number], default: [] },
        transcript: { type: String, default: '' },
        assetSeq: { type: Number, default: 0 },
        updatedAt: { type: Date, default: null }
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
