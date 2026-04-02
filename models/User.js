const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true },
    username: String,
    city: { type: String, required: true },
    lat: Number,
    lon: Number,
    timezone: String,
    lastState: {
        temp: Number,
        weatherCode: Number,
        updatedAt: { type: Date, default: Date.now },
        fullData: Object // Storing the complete response for site display
    },
    notificationsEnabled: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', UserSchema);
