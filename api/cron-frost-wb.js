/**
 * Evening Weatherbit soil-frost cross-check (~21:00 local per city).
 *
 * Free Weatherbit has no soil temperature — we estimate surface (0 cm) from
 * air temp, dew point, clouds and wind, then compare with Open-Meteo frost
 * already stored in dashboardSnapshot (or fetched live as fallback).
 *
 * Messages (always evaluated; silent if both sources say no frost):
 * - OM frost + WB frost  → confirmation
 * - no OM + WB frost     → attention warning
 * - OM frost + no WB     → WB does not see the risk
 */
require('dotenv').config();
const axios = require('axios');
const getBot = require('../utils/bot');
const bot = getBot();
const logToTelegram = require('../utils/logger');
const User = require('../models/User');
const City = require('../models/City');
const connectDB = require('../utils/db');
const { sleep, escapeHTML, getLocalDateStr } = require('../utils/helpers');
const {
    getSoilFrostInfo,
    estimateSoilTemp0,
    formatSoilTemp
} = require('../utils/weather');

const API_KEY = process.env.WEATHERBIT_KEY;
const SOIL_FROST_THRESHOLD = 0.5; // °C — same as OM rule

module.exports = async (req, res) => {
    const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
    const log = (text) => logToTelegram(bot, LOG_CHAT_ID, text);

    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).send('Unauthorized');
    }
    if (!API_KEY) {
        return res.status(500).send('WEATHERBIT_KEY is not set');
    }

    const startTime = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

    try {
        await connectDB();
        const users = await User.find({ notificationsEnabled: true });

        const uniqueCities = {};
        for (const user of users) {
            if (!user.lat || !user.lon) continue;
            const key = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
            if (!uniqueCities[key]) {
                uniqueCities[key] = {
                    lat: user.lat,
                    lon: user.lon,
                    name: user.city,
                    users: []
                };
            }
            uniqueCities[key].users.push(user);
        }

        let alertsTotal = 0;
        let errorsCount = 0;
        const logLines = [];

        const msgDict = {
            uk: {
                confirm:
                    '✅ **Weatherbit підтвердив заморозок по ґрунту {soil}**\n' +
                    'Оцінка поверхні з температури повітря, точки роси, хмарності та вітру (k={k}).\n' +
                    'Open-Meteo: мін. ґрунт {omSoil}.',
                warn:
                    '⚠️ **Увага! Weatherbit бачить ризик заморозку по ґрунту {soil}**\n' +
                    'Open-Meteo цього заморозку не показував. Можливе радіаційне вихолоджування поверхні цієї ночі (k={k}).',
                deny:
                    'ℹ️ **Weatherbit не підтверджує ризик заморозку**\n' +
                    'Оцінка ґрунту за поточними умовами: **{soil}** (k={k}).\n' +
                    'Open-Meteo раніше показував заморозок (мін. ґрунт {omSoil}).'
            },
            en: {
                confirm:
                    '✅ **Weatherbit confirmed soil frost at {soil}**\n' +
                    'Surface estimate from air temp, dew point, clouds and wind (k={k}).\n' +
                    'Open-Meteo min soil: {omSoil}.',
                warn:
                    '⚠️ **Attention! Weatherbit sees soil frost risk at {soil}**\n' +
                    'Open-Meteo did not show this frost. Possible radiative cooling at the surface tonight (k={k}).',
                deny:
                    'ℹ️ **Weatherbit does not confirm frost risk**\n' +
                    'Current soil estimate: **{soil}** (k={k}).\n' +
                    'Open-Meteo earlier indicated frost (min soil {omSoil}).'
            }
        };

        for (const [key, cityInfo] of Object.entries(uniqueCities)) {
            try {
                const cityDoc = await City.findOne({ externalId: key }).lean();
                const timezone = cityDoc?.timezone
                    || cityDoc?.dashboardSnapshot?.timezone
                    || 'Europe/Kyiv';

                // Target: coming night → tomorrow morning (local)
                const todayStr = getLocalDateStr(timezone, 0);
                const tomorrowStr = getLocalDateStr(timezone, 1);

                // One alert type per city per local day
                if (cityDoc?.lastFrostWbAlert?.date === todayStr) {
                    logLines.push(`• ${cityInfo.name} | ⏭ вже було сповіщення сьогодні`);
                    continue;
                }

                // --- Weatherbit current (temp, dewpt, clouds, wind) ---
                const wbUrl =
                    `https://api.weatherbit.io/v2.0/current?lat=${cityInfo.lat}&lon=${cityInfo.lon}&key=${API_KEY}`;
                const wbRes = await axios.get(wbUrl, { timeout: 12000 });
                const cur = wbRes.data?.data?.[0];
                if (!cur) {
                    throw new Error('Weatherbit: empty current');
                }

                const tempAir = cur.temp;
                const dewpt = cur.dewpt;
                const clouds = cur.clouds != null ? cur.clouds : 50;
                const windMs = cur.wind_spd != null ? cur.wind_spd : 2;

                const est = estimateSoilTemp0(tempAir, dewpt, clouds, windMs);
                if (!est) {
                    throw new Error('Cannot estimate soil (missing temp/dewpt)');
                }

                const wbFrost = est.soilEst <= SOIL_FROST_THRESHOLD;

                // --- Open-Meteo frost for tomorrow (snapshot or live) ---
                let omSoil0 = cityDoc?.dashboardSnapshot?.hourly?.soil_temperature_0cm || [];
                let omTimes = cityDoc?.dashboardSnapshot?.hourly?.time || [];
                let dailyOm = cityDoc?.dashboardSnapshot?.dailyOm || null;

                const snapHasSoil = Array.isArray(omSoil0) && omSoil0.length > 0
                    && Array.isArray(omTimes) && omTimes.some(t => String(t).startsWith(tomorrowStr));

                if (!snapHasSoil || !dailyOm?.temperature_2m_mean) {
                    try {
                        const omUrl =
                            `https://api.open-meteo.com/v1/forecast?latitude=${cityInfo.lat}&longitude=${cityInfo.lon}` +
                            `&hourly=soil_temperature_0cm` +
                            `&daily=temperature_2m_mean` +
                            `&timezone=auto&forecast_days=3`;
                        const omRes = await axios.get(omUrl, { timeout: 12000 });
                        if (omRes.data?.hourly) {
                            omTimes = omRes.data.hourly.time || [];
                            omSoil0 = omRes.data.hourly.soil_temperature_0cm || [];
                        }
                        if (omRes.data?.daily) {
                            dailyOm = {
                                time: omRes.data.daily.time || [],
                                temperature_2m_mean: omRes.data.daily.temperature_2m_mean || []
                            };
                        }
                    } catch (omErr) {
                        console.error('OM frost fetch error:', omErr.message);
                    }
                }

                const soilForTomorrow = [];
                for (let i = 0; i < omTimes.length; i++) {
                    if (String(omTimes[i]).startsWith(tomorrowStr) && omSoil0[i] != null) {
                        soilForTomorrow.push(omSoil0[i]);
                    }
                }
                let meanTomorrow = null;
                if (dailyOm?.time && dailyOm?.temperature_2m_mean) {
                    const dIdx = dailyOm.time.findIndex(t => String(t).startsWith(tomorrowStr));
                    if (dIdx >= 0) meanTomorrow = dailyOm.temperature_2m_mean[dIdx];
                }

                // Also consider tonight (remaining hours of today) for OM min soil
                const soilTonight = [];
                for (let i = 0; i < omTimes.length; i++) {
                    if (String(omTimes[i]).startsWith(todayStr) && omSoil0[i] != null) {
                        const hour = parseInt(String(omTimes[i]).slice(11, 13), 10);
                        if (hour >= 21 || hour <= 8) soilTonight.push(omSoil0[i]);
                    }
                }
                let meanToday = null;
                if (dailyOm?.time && dailyOm?.temperature_2m_mean) {
                    const dIdx = dailyOm.time.findIndex(t => String(t).startsWith(todayStr));
                    if (dIdx >= 0) meanToday = dailyOm.temperature_2m_mean[dIdx];
                }

                const omInfoTomorrow = getSoilFrostInfo(soilForTomorrow, meanTomorrow);
                const omInfoTonight = getSoilFrostInfo(
                    soilTonight.length ? soilTonight : soilForTomorrow,
                    meanToday != null ? meanToday : meanTomorrow
                );
                const omFrost = omInfoTomorrow.frost || omInfoTonight.frost;
                const omMinSoil = (() => {
                    const vals = [];
                    if (omInfoTomorrow.minSoil != null) vals.push(omInfoTomorrow.minSoil);
                    if (omInfoTonight.minSoil != null) vals.push(omInfoTonight.minSoil);
                    return vals.length ? Math.min(...vals) : null;
                })();

                // Decide message type
                let alertType = null; // confirm | warn | deny
                if (omFrost && wbFrost) alertType = 'confirm';
                else if (!omFrost && wbFrost) alertType = 'warn';
                else if (omFrost && !wbFrost) alertType = 'deny';
                // both false → silent

                if (!alertType) {
                    logLines.push(
                        `• ${cityInfo.name} | T=${tempAir}° Td=${dewpt}° soil≈${est.soilEst.toFixed(1)}° k=${est.k} | ✅ без ризику`
                    );
                    await sleep(1100);
                    continue;
                }

                const soilStr = formatSoilTemp(est.soilEst);
                const omSoilStr = formatSoilTemp(omMinSoil);
                const kStr = String(est.k);

                for (const user of cityInfo.users) {
                    const lang = user.language || 'uk';
                    const tpl = msgDict[lang]?.[alertType] || msgDict.uk[alertType];
                    const text = tpl
                        .replace('{soil}', soilStr)
                        .replace('{omSoil}', omSoilStr)
                        .replace('{k}', kStr);

                    try {
                        await bot.telegram.sendMessage(user.telegramId, text, { parse_mode: 'Markdown' });
                        alertsTotal++;
                    } catch (sendErr) {
                        console.error(`Frost WB send to ${user.telegramId}:`, sendErr.message);
                    }
                    await sleep(50);
                }

                await City.findOneAndUpdate(
                    { externalId: key },
                    {
                        $set: {
                            lastFrostWbAlert: {
                                date: todayStr,
                                type: alertType,
                                soilEst: Math.round(est.soilEst * 10) / 10
                            }
                        }
                    },
                    { upsert: true }
                );

                const typeIcon = alertType === 'confirm' ? '✅' : alertType === 'warn' ? '⚠️' : 'ℹ️';
                logLines.push(
                    `• ${cityInfo.name} | ${typeIcon} ${alertType} | WB soil≈${est.soilEst.toFixed(1)}° | OM ${omFrost ? omSoilStr : 'ні'}`
                );

                await sleep(1100);
            } catch (err) {
                errorsCount++;
                logLines.push(`• ${cityInfo.name} | ❌ ${err.message}`);
                console.error('cron-frost-wb city error:', err.message);
            }
        }

        const summary = [
            `📋 <b>Перевірка заморозку (Weatherbit)</b> — ${startTime}`,
            `👥 Міст: ${Object.keys(uniqueCities).length}`,
            `🚨 Сповіщень: ${alertsTotal}`,
            `❌ Помилок: ${errorsCount}`,
            ``,
            ...logLines
        ].join('\n');
        await log(summary);
        res.status(200).send('Processed (frost-wb)');
    } catch (error) {
        console.error(error);
        await log(`❌ <b>Frost WB Check FAILED</b>\n<code>${escapeHTML(error.message)}</code>`);
        res.status(500).send('Error');
    }
};
