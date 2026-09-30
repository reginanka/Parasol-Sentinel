/**
 * Evening Weatherbit soil-frost cross-check (~21:00 local per city).
 *
 * Goal: estimate **morning** soil frost risk (plants), not current evening surface.
 *
 * Free Weatherbit has no soil temperature. We estimate morning surface (0 cm):
 *   T_soil ≈ T_min − k · (T_min − T_dew)
 * where:
 *   - T_min  = Weatherbit forecast/daily min_temp for tomorrow (night → morning)
 *   - T_dew, clouds, wind = Weatherbit current at run time (evening proxy)
 *   - k from clouds + wind (clear + calm → stronger radiative cooling)
 *
 * Compared with Open-Meteo soil frost (snapshot or live):
 * - OM frost + WB frost  → confirmation
 * - no OM + WB frost     → attention warning
 * - OM frost + no WB     → WB does not see the risk
 * - both false           → silent
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
                    '✅ **Weatherbit підтвердив заморозок по ґрунту {soil} (під ранок)**\n' +
                    'Оцінка: мін. повітря {tMin}°C, точка роси {td}°C, k={k} (хмари/вітер).\n' +
                    'Open-Meteo: мін. ґрунт {omSoil}.',
                warn:
                    '⚠️ **Увага! Weatherbit бачить ризик заморозку по ґрунту {soil} (під ранок)**\n' +
                    'Open-Meteo цього не показував. Мін. повітря {tMin}°C, точка роси {td}°C, k={k}.',
                deny:
                    'ℹ️ **Weatherbit не підтверджує ризик заморозку під ранок**\n' +
                    'Оцінка ґрунту: **{soil}** (мін. повітря {tMin}°C, Td {td}°C, k={k}).\n' +
                    'Open-Meteo показував заморозок (мін. ґрунт {omSoil}).'
            },
            en: {
                confirm:
                    '✅ **Weatherbit confirmed morning soil frost at {soil}**\n' +
                    'Estimate: air min {tMin}°C, dew point {td}°C, k={k} (clouds/wind).\n' +
                    'Open-Meteo min soil: {omSoil}.',
                warn:
                    '⚠️ **Attention! Weatherbit sees morning soil frost risk at {soil}**\n' +
                    'Open-Meteo did not show this. Air min {tMin}°C, dew point {td}°C, k={k}.',
                deny:
                    'ℹ️ **Weatherbit does not confirm morning frost risk**\n' +
                    'Soil estimate: **{soil}** (air min {tMin}°C, Td {td}°C, k={k}).\n' +
                    'Open-Meteo indicated frost (min soil {omSoil}).'
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

                // --- Weatherbit: daily min_temp (tomorrow) + current dewpt/clouds/wind ---
                const [wbDailyRes, wbCurRes] = await Promise.all([
                    axios.get(
                        `https://api.weatherbit.io/v2.0/forecast/daily?lat=${cityInfo.lat}&lon=${cityInfo.lon}&key=${API_KEY}&days=3`,
                        { timeout: 12000 }
                    ),
                    axios.get(
                        `https://api.weatherbit.io/v2.0/current?lat=${cityInfo.lat}&lon=${cityInfo.lon}&key=${API_KEY}`,
                        { timeout: 12000 }
                    )
                ]);

                const dailyArr = wbDailyRes.data?.data || [];
                const dayKey = (d) => String(d?.valid_date || d?.datetime || '').slice(0, 10);
                const tomorrowDaily = dailyArr.find(d => dayKey(d) === tomorrowStr) || dailyArr[1];
                if (!tomorrowDaily || tomorrowDaily.min_temp == null) {
                    throw new Error('Weatherbit: no min_temp for tomorrow');
                }
                const tMin = Number(tomorrowDaily.min_temp);

                const cur = wbCurRes.data?.data?.[0];
                if (!cur || cur.dewpt == null) {
                    throw new Error('Weatherbit: empty current / dewpt');
                }
                const dewpt = Number(cur.dewpt);
                const clouds = cur.clouds != null ? cur.clouds : 50;
                const windMs = cur.wind_spd != null ? cur.wind_spd : 2;

                // Morning soil estimate: use forecast min air temp, not evening current temp
                const est = estimateSoilTemp0(tMin, dewpt, clouds, windMs);
                if (!est) {
                    throw new Error('Cannot estimate soil (missing tMin/dewpt)');
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
                // Overnight hours on "today" after 21:00 also matter for soil min into morning
                for (let i = 0; i < omTimes.length; i++) {
                    if (String(omTimes[i]).startsWith(todayStr) && omSoil0[i] != null) {
                        const hour = parseInt(String(omTimes[i]).slice(11, 13), 10);
                        if (hour >= 21) soilForTomorrow.push(omSoil0[i]);
                    }
                }

                let meanTomorrow = null;
                if (dailyOm?.time && dailyOm?.temperature_2m_mean) {
                    const dIdx = dailyOm.time.findIndex(t => String(t).startsWith(tomorrowStr));
                    if (dIdx >= 0) meanTomorrow = dailyOm.temperature_2m_mean[dIdx];
                }
                // Radiation frost: positive mean day + cold night — also accept today's mean if still positive
                let meanToday = null;
                if (dailyOm?.time && dailyOm?.temperature_2m_mean) {
                    const dIdx = dailyOm.time.findIndex(t => String(t).startsWith(todayStr));
                    if (dIdx >= 0) meanToday = dailyOm.temperature_2m_mean[dIdx];
                }
                const meanForOm = (meanTomorrow != null && meanTomorrow > 0)
                    ? meanTomorrow
                    : (meanToday != null && meanToday > 0 ? meanToday : meanTomorrow);

                const omInfo = getSoilFrostInfo(soilForTomorrow, meanForOm);
                const omFrost = omInfo.frost;
                const omMinSoil = omInfo.minSoil;

                // Decide message type
                let alertType = null; // confirm | warn | deny
                if (omFrost && wbFrost) alertType = 'confirm';
                else if (!omFrost && wbFrost) alertType = 'warn';
                else if (omFrost && !wbFrost) alertType = 'deny';
                // both false → silent

                if (!alertType) {
                    logLines.push(
                        `• ${cityInfo.name} | Tmin=${tMin}° Td=${dewpt}° soil≈${est.soilEst.toFixed(1)}° k=${est.k} | ✅ без ризику під ранок`
                    );
                    await sleep(1100);
                    continue;
                }

                const soilStr = formatSoilTemp(est.soilEst);
                const omSoilStr = formatSoilTemp(omMinSoil);
                const kStr = String(est.k);
                const tMinStr = Number(tMin).toFixed(1);
                const tdStr = Number(dewpt).toFixed(1);

                for (const user of cityInfo.users) {
                    const lang = user.language || 'uk';
                    const tpl = msgDict[lang]?.[alertType] || msgDict.uk[alertType];
                    const text = tpl
                        .replace(/\{soil\}/g, soilStr)
                        .replace(/\{omSoil\}/g, omSoilStr)
                        .replace(/\{k\}/g, kStr)
                        .replace(/\{tMin\}/g, tMinStr)
                        .replace(/\{td\}/g, tdStr);

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
                                soilEst: Math.round(est.soilEst * 10) / 10,
                                tMin: Math.round(tMin * 10) / 10
                            }
                        }
                    },
                    { upsert: true }
                );

                const typeIcon = alertType === 'confirm' ? '✅' : alertType === 'warn' ? '⚠️' : 'ℹ️';
                logLines.push(
                    `• ${cityInfo.name} | ${typeIcon} ${alertType} | Tmin=${tMin}° soil≈${est.soilEst.toFixed(1)}° | OM ${omFrost ? omSoilStr : 'ні'}`
                );

                await sleep(1100);
            } catch (err) {
                errorsCount++;
                logLines.push(`• ${cityInfo.name} | ❌ ${err.message}`);
                console.error('cron-frost-wb city error:', err.message);
            }
        }

        const summary = [
            `📋 <b>Перевірка заморозку під ранок (Weatherbit)</b> — ${startTime}`,
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
