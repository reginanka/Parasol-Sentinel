require('dotenv').config();
const connectDB = require('../utils/db');
const User = require('../models/User');
const { generateSignature, validateTelegramInitData } = require('../utils/helpers');

/**
 * PATCH /api/settings?user=ID&sig=SIG&initData=...
 * Body: { wind: 'ms'|'kmh', pressure: 'mmhg'|'hpa', temp: 'c'|'f' }
 */
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'PATCH' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        await connectDB();
        const { user: userIdFromUrl, sig, initData } = req.query;
        const SECRET = process.env.CRON_SECRET;
        const BOT_TOKEN = process.env.TG_TOKEN;

        let userId = userIdFromUrl;
        let authorized = false;

        // 1. Verify via initData (WebApp button)
        if (initData && BOT_TOKEN) {
            const isValid = validateTelegramInitData(initData, BOT_TOKEN);
            if (isValid) {
                const params = new URLSearchParams(initData);
                const userParam = params.get('user');
                if (userParam) {
                    const data = JSON.parse(userParam);
                    userId = data.id?.toString();
                    authorized = true;
                }
            }
        }

        // 2. Verify via Signature (Personal link)
        if (!authorized && userId && sig) {
            const expectedSig = generateSignature(userId, SECRET);
            if (sig === expectedSig) {
                authorized = true;
            }
        }

        if (!authorized) {
            return res.status(401).json({ error: 'Unauthorized: invalid signature or initData' });
        }

        const { wind, pressure, temp } = req.body || {};
        const updateFields = {};

        if (['ms', 'kmh'].includes(wind)) updateFields['units.wind'] = wind;
        if (['mmhg', 'hpa'].includes(pressure)) updateFields['units.pressure'] = pressure;
        if (['c', 'f'].includes(temp)) updateFields['units.temp'] = temp;

        if (Object.keys(updateFields).length === 0) {
            return res.status(400).json({ error: 'No valid settings provided' });
        }

        await User.updateOne(
            { telegramId: Number(userId) },
            { $set: updateFields }
        );

        return res.status(200).json({ ok: true, updated: updateFields });
    } catch (error) {
        console.error('Settings Error:', error.message);
        return res.status(500).json({ error: 'Failed to save settings' });
    }
};
