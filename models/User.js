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
        fullData: Object // Storing the complete response for site display
    },
    language: { type: String, default: 'uk' },
    notificationsEnabled: { type: Boolean, default: true },
    units: {
        wind: { type: String, default: 'ms' },       // 'ms' = м/с, 'kmh' = км/год
        pressure: { type: String, default: 'mmhg' }, // 'mmhg' = мм рт.ст., 'hpa' = гПа
        temp: { type: String, default: 'c' }         // 'c' = Цельсій, 'f' = Фаренгейт
    },
    crops: [String], // IDs of selected plants (e.g., 'tomato', 'cucumber')
    forecastSettings: {
        daysCount: { type: Number, default: 3 },
        enabledMetrics: { 
            type: [String], 
            default: ['condition', 'temp', 'precip', 'wind', 'pressure'] 
        }
    },
    createdAt: { type: Date, default: Date.now }

});

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
