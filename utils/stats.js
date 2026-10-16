/**
 * Daily / rolling counters for admin analytics.
 * Used by admin.js (touch, notify, user errors), logger.js (cron ok/fail).
 */

function kyivDayKey(d = new Date()) {
    try {
        // en-CA → YYYY-MM-DD
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Europe/Kyiv',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(d);
    } catch {
        return d.toISOString().slice(0, 10);
    }
}

/** dayKey N days ago (Kyiv calendar). */
function kyivDayKeyDaysAgo(n) {
    const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
    return kyivDayKey(d);
}

/**
 * Atomically increment a DailyStat field for today (Kyiv).
 * field: 'activity' | 'actions' | 'cronOk' | 'cronFail' | 'userFail'
 */
async function incDailyStat(field, n = 1) {
    const allowed = new Set(['activity', 'actions', 'cronOk', 'cronFail', 'userFail']);
    if (!allowed.has(field) || !n) return;
    try {
        const connectDB = require('./db');
        const DailyStat = require('../models/DailyStat');
        await connectDB();
        const dayKey = kyivDayKey();
        await DailyStat.updateOne(
            { dayKey },
            { $inc: { [field]: n }, $setOnInsert: { dayKey } },
            { upsert: true }
        );
    } catch (e) {
        console.error('[stats] incDailyStat failed:', field, e.message);
    }
}

/**
 * Sum DailyStat fields for dayKeys >= sinceKey (inclusive).
 * Returns { activity, actions, cronOk, cronFail, userFail }.
 */
async function sumDailyStatsSince(sinceKey) {
    const empty = { activity: 0, actions: 0, cronOk: 0, cronFail: 0, userFail: 0 };
    try {
        const connectDB = require('./db');
        const DailyStat = require('../models/DailyStat');
        await connectDB();
        const rows = await DailyStat.aggregate([
            { $match: { dayKey: { $gte: sinceKey } } },
            {
                $group: {
                    _id: null,
                    activity: { $sum: '$activity' },
                    actions: { $sum: '$actions' },
                    cronOk: { $sum: '$cronOk' },
                    cronFail: { $sum: '$cronFail' },
                    userFail: { $sum: '$userFail' }
                }
            }
        ]);
        return rows[0]
            ? {
                  activity: rows[0].activity || 0,
                  actions: rows[0].actions || 0,
                  cronOk: rows[0].cronOk || 0,
                  cronFail: rows[0].cronFail || 0,
                  userFail: rows[0].userFail || 0
              }
            : empty;
    } catch (e) {
        console.error('[stats] sumDailyStatsSince failed:', e.message);
        return empty;
    }
}

async function getTodayStats() {
    return sumDailyStatsSince(kyivDayKey());
}

module.exports = {
    kyivDayKey,
    kyivDayKeyDaysAgo,
    incDailyStat,
    sumDailyStatsSince,
    getTodayStats
};
