const mongoose = require('mongoose');

/**
 * Денні лічильники для адмін-аналітики.
 * dayKey = YYYY-MM-DD (Europe/Kyiv).
 *
 *  - activity  — кожна взаємодія юзера (touchUserProfile)
 *  - actions   — успішні дії юзера, що пішли в notifyAdmin (кліки / текст)
 *  - cronOk    — успішний звіт крона в лог (без помилки)
 *  - cronFail  — звіт крона з помилкою
 *  - userFail  — бот відповів помилкою на дію юзера (notifyUserError)
 */
const DailyStatSchema = new mongoose.Schema({
    dayKey: { type: String, required: true, unique: true, index: true },
    activity: { type: Number, default: 0 },
    actions: { type: Number, default: 0 },
    cronOk: { type: Number, default: 0 },
    cronFail: { type: Number, default: 0 },
    userFail: { type: Number, default: 0 }
});

module.exports =
    mongoose.models.DailyStat || mongoose.model('DailyStat', DailyStatSchema);
