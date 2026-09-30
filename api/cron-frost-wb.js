/**
 * Evening soil-frost cross-check (~21:00 local per city).
 *
 * Data source: **Meteosource** hourly forecast (not Weatherbit).
 * We take the **coldest hour** in the overnight window (local 21:00 today → 08:00
 * tomorrow), then estimate morning soil surface:
 *   T_soil ≈ T − k · (T − T_dew)
 * with T, dew_point, cloud_cover, wind from that same forecast hour.
 *
 * Compared with Open-Meteo soil frost (snapshot or live):
 * - OM frost + MS frost  → confirmation
 * - no OM + MS frost     → attention warning
 * - OM frost + no MS     → Meteosource does not see the risk
 * - both false           → silent
 *
 * Env:
 *   METEOSOURCE_KEY  — required
 *   METEOSOURCE_TIER — optional, default "free" (url path /api/v1/{tier}/point)
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

const MS_KEY = process.env.METEOSOURCE_KEY;
const MS_TIER = process.env.METEOSOURCE_TIER || 'free';
const SOIL_FROST_THRESHOLD = 0.5; // °C — same as OM rule

/** Overnight hours local: from 21 today through 08 tomorrow (inclusive). */
function isOvernightHour(dateStr, hour, todayStr, tomorrowStr) {
    if (dateStr === todayStr && hour >= 21) return true;
    if (dateStr === tomorrowStr && hour <= 8) return true;
    return false;
}

/** Approximate dew point (°C) from air temp and RH% (Magnus). */
function dewPointFromHumidity(tempC, rh) {
    const T = Number(tempC);
    const RH = Number(rh);
    if (Number.isNaN(T) || Number.isNaN(RH) || RH <= 0) return null;
    const a = 17.625;
    const b = 243.04;
    const alpha = Math.log(Math.min(100, Math.max(0.1, RH)) / 100) + (a * T) / (b + T);
    return (b * alpha) / (a - alpha);
}

function parseHourFields(h) {
    const raw = String(h.date || h.time || '');
    // "2026-10-01T05:00:00" or with offset "2026-10-01T05:00:00+03:00"
    const dateStr = raw.slice(0, 10);
    const hour = parseInt(raw.slice(11, 13), 10);
    const t = h.temperature != null ? Number(h.temperature) : null;
    if (t == null || Number.isNaN(t) || Number.isNaN(hour) || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return null;
    }

    let clouds = 50;
    if (h.cloud_cover != null) {
        if (typeof h.cloud_cover === 'object' && h.cloud_cover.total != null) {
            clouds = Number(h.cloud_cover.total);
        } else if (typeof h.cloud_cover === 'number') {
            clouds = h.cloud_cover;
        }
    }

    let windMs = 2;
    if (h.wind != null) {
        if (typeof h.wind === 'object' && h.wind.speed != null) {
            windMs = Number(h.wind.speed);
        } else if (typeof h.wind === 'number') {
            windMs = h.wind;
        }
    }
    // Some responses use wind_speed at top level
    if ((windMs == null || Number.isNaN(windMs)) && h.wind_speed != null) {
        windMs = Number(h.wind_speed);
    }

    let dew = h.dew_point != null ? Number(h.dew_point) : null;
    if ((dew == null || Number.isNaN(dew)) && h.humidity != null) {
        dew = dewPointFromHumidity(t, h.humidity);
    }

    return {
        temperature: t,
        dew_point: (dew != null && !Number.isNaN(dew)) ? dew : null,
        clouds: Number.isNaN(clouds) ? 50 : clouds,
        windMs: Number.isNaN(windMs) ? 2 : windMs,
        date: dateStr,
        hour,
        soil_temperature: h.soil_temperature != null ? Number(h.soil_temperature) : null,
        surface_temperature: h.surface_temperature != null ? Number(h.surface_temperature) : null
    };
}

/**
 * Pick the coldest overnight hour from Meteosource hourly.data[].
 * Fallback: coldest hour among all returned hours (free tier may be short).
 */
function pickMorningHour(hourlyData, todayStr, tomorrowStr) {
    if (!Array.isArray(hourlyData) || hourlyData.length === 0) return null;

    const overnight = [];
    const all = [];
    for (const h of hourlyData) {
        const parsed = parseHourFields(h);
        if (!parsed) continue;
        all.push(parsed);
        if (isOvernightHour(parsed.date, parsed.hour, todayStr, tomorrowStr)) {
            overnight.push(parsed);
        }
    }

    const pool = overnight.length > 0 ? overnight : all;
    if (pool.length === 0) return null;

    // Prefer hours that have dew_point; among those (or all) pick coldest air temp
    const withDew = pool.filter(p => p.dew_point != null);
    const candidates = withDew.length > 0 ? withDew : pool;
    let best = candidates[0];
    for (const p of candidates) {
        if (p.temperature < best.temperature) best = p;
    }
    return best;
}

module.exports = async (req, res) => {
    const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
    const log = (text) => logToTelegram(bot, LOG_CHAT_ID, text);

    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).send('Unauthorized');
    }
    if (!MS_KEY) {
        return res.status(500).send('METEOSOURCE_KEY is not set');
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
                    '✅ **Meteosource підтвердив заморозок по ґрунту {soil} (під ранок ~{hour}:00)**\n' +
                    'Оцінка на найхолоднішу годину ночі: повітря {t}°C, точка роси {td}°C, k={k}.\n' +
                    'Open-Meteo: мін. ґрунт {omSoil}.',
                warn:
                    '⚠️ **Увага! Meteosource бачить ризик заморозку по ґрунту {soil} (під ранок ~{hour}:00)**\n' +
                    'Open-Meteo цього не показував. Повітря {t}°C, точка роси {td}°C, k={k}.',
                deny:
                    'ℹ️ **Meteosource не підтверджує ризик заморозку під ранок**\n' +
                    'Оцінка на ~{hour}:00: ґрунт **{soil}** (повітря {t}°C, Td {td}°C, k={k}).\n' +
                    'Open-Meteo показував заморозок (мін. ґрунт {omSoil}).'
            },
            en: {
                confirm:
                    '✅ **Meteosource confirmed morning soil frost at {soil} (~{hour}:00)**\n' +
                    'Coldest overnight hour: air {t}°C, dew point {td}°C, k={k}.\n' +
                    'Open-Meteo min soil: {omSoil}.',
                warn:
                    '⚠️ **Attention! Meteosource sees morning soil frost risk at {soil} (~{hour}:00)**\n' +
                    'Open-Meteo did not show this. Air {t}°C, dew point {td}°C, k={k}.',
                deny:
                    'ℹ️ **Meteosource does not confirm morning frost risk**\n' +
                    'Estimate at ~{hour}:00: soil **{soil}** (air {t}°C, Td {td}°C, k={k}).\n' +
                    'Open-Meteo indicated frost (min soil {omSoil}).'
            }
        };

        for (const [key, cityInfo] of Object.entries(uniqueCities)) {
            try {
                const cityDoc = await City.findOne({ externalId: key }).lean();
                const timezone = cityDoc?.timezone
                    || cityDoc?.dashboardSnapshot?.timezone
                    || 'Europe/Kyiv';

                const todayStr = getLocalDateStr(timezone, 0);
                const tomorrowStr = getLocalDateStr(timezone, 1);

                if (cityDoc?.lastFrostWbAlert?.date === todayStr) {
                    logLines.push(`• ${cityInfo.name} | ⏭ вже було сповіщення сьогодні`);
                    continue;
                }

                // --- Meteosource hourly (metric: °C, wind m/s) ---
                const msUrl =
                    `https://www.meteosource.com/api/v1/${encodeURIComponent(MS_TIER)}/point` +
                    `?lat=${cityInfo.lat}&lon=${cityInfo.lon}` +
                    `&sections=hourly` +
                    `&timezone=${encodeURIComponent(timezone)}` +
                    `&language=en&units=metric` +
                    `&key=${encodeURIComponent(MS_KEY)}`;

                const msRes = await axios.get(msUrl, { timeout: 15000 });
                // Support both shapes: hourly.data[] (docs) and hourly[] (some wrappers)
                const hourlyRaw = msRes.data?.hourly;
                const hourlyData = Array.isArray(hourlyRaw?.data)
                    ? hourlyRaw.data
                    : (Array.isArray(hourlyRaw) ? hourlyRaw : []);
                if (hourlyData.length === 0) {
                    const keys = msRes.data ? Object.keys(msRes.data).join(',') : 'null';
                    throw new Error(`Meteosource: empty hourly (response keys: ${keys})`);
                }
                const morning = pickMorningHour(hourlyData, todayStr, tomorrowStr);
                if (!morning) {
                    const sample = hourlyData[0] ? Object.keys(hourlyData[0]).join(',') : 'none';
                    throw new Error(`Meteosource: no usable hour (n=${hourlyData.length}, sample keys: ${sample})`);
                }
                if (morning.dew_point == null || Number.isNaN(morning.dew_point)) {
                    const sample = hourlyData[0] ? Object.keys(hourlyData[0]).join(',') : 'none';
                    throw new Error(`Meteosource: no dew_point/humidity (hour keys: ${sample})`);
                }

                const tAir = morning.temperature;
                const dewpt = morning.dew_point;
                // Avoid formula warming when Td > T at that hour
                const tdEff = Math.min(dewpt, tAir);

                const est = estimateSoilTemp0(tAir, tdEff, morning.clouds, morning.windMs);
                if (!est) {
                    throw new Error('Cannot estimate soil from Meteosource hour');
                }

                let soilEst = est.soilEst;
                if (morning.surface_temperature != null && !Number.isNaN(morning.surface_temperature)) {
                    soilEst = Math.min(soilEst, morning.surface_temperature);
                }
                if (morning.soil_temperature != null && !Number.isNaN(morning.soil_temperature)) {
                    soilEst = Math.min(soilEst, morning.soil_temperature);
                }

                const msFrost = soilEst <= SOIL_FROST_THRESHOLD;

                // --- Open-Meteo frost (snapshot or live) ---
                let omSoil0 = cityDoc?.dashboardSnapshot?.hourly?.soil_temperature_0cm || [];
                let omTimes = cityDoc?.dashboardSnapshot?.hourly?.time || [];
                let dailyOm = cityDoc?.dashboardSnapshot?.dailyOm || null;

                const snapHasSoil = Array.isArray(omSoil0) && omSoil0.length > 0
                    && Array.isArray(omTimes)
                    && (omTimes.some(t => String(t).startsWith(tomorrowStr))
                        || omTimes.some(t => String(t).startsWith(todayStr)));

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

                const soilForNight = [];
                for (let i = 0; i < omTimes.length; i++) {
                    const raw = String(omTimes[i]);
                    const d = raw.slice(0, 10);
                    const hour = parseInt(raw.slice(11, 13), 10);
                    if (omSoil0[i] == null || Number.isNaN(hour)) continue;
                    if (isOvernightHour(d, hour, todayStr, tomorrowStr)) {
                        soilForNight.push(omSoil0[i]);
                    }
                }

                let meanTomorrow = null;
                let meanToday = null;
                if (dailyOm?.time && dailyOm?.temperature_2m_mean) {
                    const iTmr = dailyOm.time.findIndex(t => String(t).startsWith(tomorrowStr));
                    const iTod = dailyOm.time.findIndex(t => String(t).startsWith(todayStr));
                    if (iTmr >= 0) meanTomorrow = dailyOm.temperature_2m_mean[iTmr];
                    if (iTod >= 0) meanToday = dailyOm.temperature_2m_mean[iTod];
                }
                const meanForOm = (meanTomorrow != null && meanTomorrow > 0)
                    ? meanTomorrow
                    : (meanToday != null && meanToday > 0 ? meanToday : meanTomorrow);

                const omInfo = getSoilFrostInfo(soilForNight, meanForOm);
                const omFrost = omInfo.frost;
                const omMinSoil = omInfo.minSoil;

                let alertType = null;
                if (omFrost && msFrost) alertType = 'confirm';
                else if (!omFrost && msFrost) alertType = 'warn';
                else if (omFrost && !msFrost) alertType = 'deny';

                if (!alertType) {
                    logLines.push(
                        `• ${cityInfo.name} | ~${String(morning.hour).padStart(2, '0')}:00 T=${tAir}° Td=${dewpt}° soil≈${soilEst.toFixed(1)}° k=${est.k} | ✅ без ризику`
                    );
                    await sleep(1100);
                    continue;
                }

                const soilStr = formatSoilTemp(soilEst);
                const omSoilStr = formatSoilTemp(omMinSoil);
                const kStr = String(est.k);
                const tStr = Number(tAir).toFixed(1);
                const tdStr = Number(dewpt).toFixed(1);
                const hourStr = String(morning.hour).padStart(2, '0');

                for (const user of cityInfo.users) {
                    const lang = user.language || 'uk';
                    const tpl = msgDict[lang]?.[alertType] || msgDict.uk[alertType];
                    const text = tpl
                        .replace(/\{soil\}/g, soilStr)
                        .replace(/\{omSoil\}/g, omSoilStr)
                        .replace(/\{k\}/g, kStr)
                        .replace(/\{t\}/g, tStr)
                        .replace(/\{td\}/g, tdStr)
                        .replace(/\{hour\}/g, hourStr);

                    try {
                        await bot.telegram.sendMessage(user.telegramId, text, { parse_mode: 'Markdown' });
                        alertsTotal++;
                    } catch (sendErr) {
                        console.error(`Frost MS send to ${user.telegramId}:`, sendErr.message);
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
                                soilEst: Math.round(soilEst * 10) / 10,
                                source: 'meteosource',
                                hour: morning.hour
                            }
                        }
                    },
                    { upsert: true }
                );

                const typeIcon = alertType === 'confirm' ? '✅' : alertType === 'warn' ? '⚠️' : 'ℹ️';
                logLines.push(
                    `• ${cityInfo.name} | ${typeIcon} ${alertType} | ~${hourStr}:00 T=${tAir}° soil≈${soilEst.toFixed(1)}° | OM ${omFrost ? omSoilStr : 'ні'}`
                );

                await sleep(1100);
            } catch (err) {
                errorsCount++;
                logLines.push(`• ${cityInfo.name} | ❌ ${err.message}`);
                console.error('cron-frost-wb city error:', err.message);
            }
        }

        const summary = [
            `📋 <b>Перевірка заморозку під ранок (Meteosource)</b> — ${startTime}`,
            `👥 Міст: ${Object.keys(uniqueCities).length}`,
            `🚨 Сповіщень: ${alertsTotal}`,
            `❌ Помилок: ${errorsCount}`,
            ``,
            ...logLines
        ].join('\n');
        await log(summary);
        res.status(200).send('Processed (frost-ms)');
    } catch (error) {
        console.error(error);
        await log(`❌ <b>Frost MS Check FAILED</b>\n<code>${escapeHTML(error.message)}</code>`);
        res.status(500).send('Error');
    }
};
