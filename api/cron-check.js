require('dotenv').config();
const axios = require('axios');
const getBot = require('../utils/bot');
const bot = getBot();
const logToTelegram = require('../utils/logger');
const User = require('../models/User');
const City = require('../models/City');
const History = require('../models/History');
const connectDB = require('../utils/db');
const { getWeatherDesc, getWindDir } = require('../utils/weather');
const { sleep, escapeHTML, getLocalDateStr, formatLocalDateTime } = require('../utils/helpers');

const API_KEY = process.env.WEATHERBIT_KEY;

module.exports = async (req, res) => {
    const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
    const log = (text) => logToTelegram(bot, LOG_CHAT_ID, text);
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).send('Unauthorized');

    const startTime = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

    try {
        await connectDB();
        const users = await User.find({ notificationsEnabled: true });

        const uniqueCities = {};
        for (const user of users) {
             if (!user.lat || !user.lon) continue;
             const key = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
             if (!uniqueCities[key]) uniqueCities[key] = { lat: user.lat, lon: user.lon, name: user.city, users: [] };
             uniqueCities[key].users.push(user);
        }

        let alertsTotal = 0;
        let errorsCount = 0;
        const logLines = [];

        const alertsDict = {
            uk: {
                tempAnomaly: "⚠️ **Аномальна температура!**\nЗараз: {temp}, що значно {dir} ніж очікувалось на цей час (станом на {asOf}: {expected}).",
                forecastShift: "📊 **Прогноз на сьогодні змінився!**\nОчікували (станом на {asOf}): {oldMin}..{oldMax}°C\nЗараз: {newMin}..{newMax}°C\nЗміна: ніч {minDelta}°C, день {maxDelta}°C",
                precip: "⛈️ **Попередження про опади!**\nВечірній прогноз (станом на {asOf}) опадів не показував — зараз: {desc}.",
                warmer: "вище",
                cooler: "нижче"
            },
            en: {
                tempAnomaly: "⚠️ **Temperature anomaly!**\nNow: {temp}, which is {dir} than expected for this time (as of {asOf}: {expected}).",
                forecastShift: "📊 **Today's forecast has changed!**\nExpected (as of {asOf}): {oldMin}..{oldMax}°C\nNow: {newMin}..{newMax}°C\nChange: night {minDelta}°C, day {maxDelta}°C",
                precip: "⛈️ **Precipitation alert!**\nEvening forecast (as of {asOf}) showed no rain — now: {desc}.",
                warmer: "warmer",
                cooler: "cooler"
            }
        };

        for (const [key, cityInfo] of Object.entries(uniqueCities)) {
            try {
                // 1. Fetch CURRENT weather and updated DAILY forecast (7 days for dashboard snapshot)
                const [currResp, foreResp] = await Promise.all([
                    axios.get(`https://api.weatherbit.io/v2.0/current?lat=${cityInfo.lat}&lon=${cityInfo.lon}&key=${API_KEY}`),
                    axios.get(`https://api.weatherbit.io/v2.0/forecast/daily?lat=${cityInfo.lat}&lon=${cityInfo.lon}&key=${API_KEY}&days=7`)
                ]);

                const current = currResp.data.data[0];
                const dailyAll = foreResp.data.data || [];
                
                const cityDoc = await City.findOne({ externalId: key });
                const evening = cityDoc?.eveningState;

                const cityTimezone = current.timezone || cityDoc?.timezone || 'Europe/Kyiv';
                // Robust local hour (avoid toLocaleString → Date timezone pitfalls)
                const hourParts = new Intl.DateTimeFormat('en-US', {
                    timeZone: cityTimezone,
                    hour: 'numeric',
                    hour12: false
                }).formatToParts(new Date());
                const localHour = parseInt(hourParts.find(p => p.type === 'hour')?.value || '0', 10) % 24;
                const todayStr = getLocalDateStr(cityTimezone, 0);

                // Match BOTH baseline and current forecast by the same local calendar date.
                // Never trust data[0] alone — near day boundary Weatherbit can shift.
                const dayKey = (d) => String(d?.valid_date || d?.datetime || '').slice(0, 10);
                const eveningToday = evening?.forecast?.find(d => dayKey(d) === todayStr);
                const newToday = dailyAll.find(d => dayKey(d) === todayStr) || dailyAll[0];

                const alerts = [];
                let alertTriggered = false;
                let reasons = [];

                if (eveningToday && newToday) {
                    const oldMin = eveningToday.min_temp;
                    const oldMax = eveningToday.max_temp;
                    const newMin = newToday.min_temp;
                    const newMax = newToday.max_temp;

                    // Guard: only compare if both sides refer to the same calendar day
                    if (dayKey(eveningToday) === todayStr && dayKey(newToday) === todayStr) {
                        // --- LOGIC A: Forecast Shift (e.g. 25°C -> 32°C) ---
                        const maxShift = newMax - oldMax;
                        const minShift = newMin - oldMin;

                        if (Math.abs(maxShift) >= 4 || Math.abs(minShift) >= 4) {
                            reasons.push("зміна прогнозу");
                            const fmtDelta = (d) => d > 0 ? `+${d.toFixed(1)}` : d.toFixed(1);
                            for (const user of cityInfo.users) {
                                if (!user.notificationsEnabled || user.alertTriggers?.temperature === false) continue;
                                const lang = user.language || 'uk';
                                const asOf = formatLocalDateTime(evening?.updatedAt, cityTimezone, lang);
                                const msg = alertsDict[lang].forecastShift
                                    .replace('{asOf}', asOf)
                                    .replace('{oldMin}', oldMin).replace('{oldMax}', oldMax)
                                    .replace('{newMin}', newMin).replace('{newMax}', newMax)
                                    .replace('{minDelta}', fmtDelta(minShift))
                                    .replace('{maxDelta}', fmtDelta(maxShift));
                                alerts.push({ userId: user.telegramId, text: msg, lang });
                            }
                            alertTriggered = true;

                            // Значна зміна → оновлюємо baseline + timestamp,
                            // щоб наступний алерт показував «станом на» саме цей момент.
                            const updatedForecast = (evening?.forecast || []).map(d => {
                                if (dayKey(d) === todayStr) {
                                    return { ...d, min_temp: newMin, max_temp: newMax };
                                }
                                return d;
                            });
                            await City.findOneAndUpdate(
                                { externalId: key },
                                { $set: {
                                    "eveningState.forecast": updatedForecast,
                                    "eveningState.updatedAt": new Date()
                                }}
                            );
                            // Локальний evening теж оновлюємо, щоб LOGIC B у цьому ж прогоні
                            // вже порівнював з новим baseline (і asOf був свіжий, якщо знадобиться).
                            if (evening) {
                                evening.forecast = updatedForecast;
                                evening.updatedAt = new Date();
                            }
                        }

                        // --- LOGIC B: Current Temp Anomaly vs "Safe Zone" (±5°C threshold) ---
                        const curTemp = current.temp;
                        let isAnomaly = false;
                        let expectedBase = 0;
                        let direction = '';

                        if (curTemp < (oldMin - 5)) {
                            // More than 5°C colder than expected minimum → anomaly
                            isAnomaly = true;
                            expectedBase = oldMin;
                            direction = 'cooler';
                        } else if (curTemp > (oldMax + 5)) {
                            // More than 5°C hotter than expected maximum → anomaly
                            isAnomaly = true;
                            expectedBase = oldMax;
                            direction = 'warmer';
                        }
                        // If temp is within min..max or within ±5°C of them → no alert needed

                        if (isAnomaly) {
                            reasons.push("аномалія темп.");
                            for (const user of cityInfo.users) {
                                if (!user.notificationsEnabled || user.alertTriggers?.temperature === false) continue;
                                const lang = user.language || 'uk';
                                const unit = user.units?.temp || 'c';
                                const fmtTemp = (c) => unit === 'f' ? `${Math.round(c * 9/5 + 32)}°F` : `${Math.round(c)}°C`;
                                const asOf = formatLocalDateTime(evening?.updatedAt, cityTimezone, lang);

                                const msg = alertsDict[lang].tempAnomaly
                                    .replace('{temp}', fmtTemp(curTemp))
                                    .replace('{asOf}', asOf)
                                    .replace('{expected}', fmtTemp(expectedBase))
                                    .replace('{delta}', Math.abs(curTemp - expectedBase).toFixed(1))
                                    .replace('{dir}', alertsDict[lang][direction]);
                                alerts.push({ userId: user.telegramId, text: msg, lang });
                            }
                            alertTriggered = true;
                        }
                    }
                }

                // --- SMART HISTORY UPDATE ---
                // Use $min/$max so MongoDB only updates if the current temp
                // is a new extreme for today. Values inside min..max are ignored.
                try {
                    await History.findOneAndUpdate(
                        { externalId: key, date: todayStr },
                        {
                            $min: { temp_min: current.temp },
                            $max: { temp_max: current.temp }
                        },
                        { upsert: true }
                    );
                } catch (histErr) {
                    console.error('History smart update error:', histErr.message);
                }

                // --- LOGIC C: Precipitation Start ---
                const oldCode = evening?.weatherCode ?? 800;
                const newCode = current.weather.code;
                if (oldCode >= 800 && newCode < 700) {
                    reasons.push("початок опадів");
                    for (const user of cityInfo.users) {
                        if (!user.notificationsEnabled || user.alertTriggers?.precip === false) continue;
                        const lang = user.language || 'uk';
                        const asOf = formatLocalDateTime(evening?.updatedAt, cityTimezone, lang);
                        const msg = alertsDict[lang].precip
                            .replace('{asOf}', asOf)
                            .replace('{desc}', getWeatherDesc(newCode, lang));
                        alerts.push({ userId: user.telegramId, text: msg, lang });
                    }
                    alertTriggered = true;
                }

                // --- LOGIC D: Smart Precipitation Check (Open-Meteo) ---
                // Rules:
                // - Compare only FUTURE hours of today (from localHour onward) — past rain is irrelevant
                // - No baseline for today → set baseline silently, never treat as "was 0.0 mm"
                // - "Canceled" only if remaining planned rain drops to 0
                // - Significant amount change: remaining total increased by ≥ 1.5 mm
                // - Significant timing change: rain window shifted by ≥ 2 h OR duration +≥ 2 h
                // - When updating baseline, MERGE today's hours into existing array (keep other days)
                // Also stores full hourly block for dashboard snapshot
                let omHourlyForSnap = null;
                try {
                    const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${cityInfo.lat}&longitude=${cityInfo.lon}` +
                        `&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,precipitation_probability,surface_pressure,weather_code` +
                        `&timezone=auto&forecast_days=3`;
                    const omRes = await axios.get(omUrl);
                    if (omRes.data && omRes.data.hourly) {
                        const allTimes = omRes.data.hourly.time;
                        const allPrecip = omRes.data.hourly.precipitation;
                        omHourlyForSnap = {
                            time: allTimes,
                            temperature_2m: omRes.data.hourly.temperature_2m || [],
                            wind_speed_10m: omRes.data.hourly.wind_speed_10m || [],
                            wind_gusts_10m: omRes.data.hourly.wind_gusts_10m || [],
                            precipitation: allPrecip,
                            precipitation_probability: omRes.data.hourly.precipitation_probability || [],
                            surface_pressure: omRes.data.hourly.surface_pressure || [],
                            weather_code: omRes.data.hourly.weather_code || []
                        };
                        const oldPrecipArr = evening?.hourlyPrecip || [];
                        // Timestamp of that baseline — fall back to evening.updatedAt for older
                        // City docs that don't have hourlyPrecipUpdatedAt yet.
                        const oldPrecipAsOf = evening?.hourlyPrecipUpdatedAt || evening?.updatedAt || null;

                        // Parse hour from "YYYY-MM-DDTHH:MM" — avoid Date timezone bugs
                        const hourFromTime = (t) => parseInt(String(t).slice(11, 13), 10);

                        // Build maps for FUTURE hours only (hour >= localHour)
                        const oldByHour = {};
                        for (const o of oldPrecipArr) {
                            if (o.time && o.time.startsWith(todayStr)) {
                                const h = hourFromTime(o.time);
                                if (h >= localHour) oldByHour[h] = o.precip || 0;
                            }
                        }

                        const newByHour = {};
                        for (let i = 0; i < allTimes.length; i++) {
                            if (allTimes[i].startsWith(todayStr)) {
                                const h = hourFromTime(allTimes[i]);
                                if (h >= localHour) newByHour[h] = allPrecip[i] || 0;
                            }
                        }

                        // Helpers: total, rainy hours, consecutive blocks (only over remaining hours)
                        const calcStats = (byHour) => {
                            let total = 0;
                            const hours = [];
                            for (let h = localHour; h < 24; h++) {
                                const p = byHour[h] || 0;
                                if (p > 0) {
                                    total += p;
                                    hours.push(h);
                                }
                            }
                            const blocks = [];
                            for (const h of hours) {
                                if (blocks.length && h === blocks[blocks.length - 1][1] + 1) {
                                    blocks[blocks.length - 1][1] = h;
                                } else {
                                    blocks.push([h, h]);
                                }
                            }
                            const start = hours.length ? hours[0] : null;
                            const end = hours.length ? hours[hours.length - 1] : null;
                            const duration = hours.length;
                            return { total, hours, blocks, start, end, duration };
                        };

                        const fmtBlocks = (s) => {
                            if (!s.blocks || s.blocks.length === 0) return '';
                            return s.blocks.map(([a, b]) => {
                                const from = `${String(a).padStart(2, '0')}:00`;
                                const to = `${String(b + 1).padStart(2, '0')}:00`;
                                return a === b ? from : `${from}–${to}`;
                            }).join(', ');
                        };

                        // Merge today's OM hours into existing hourlyPrecip (preserve other days)
                        const mergeTodayBaseline = async () => {
                            const byKey = {};
                            for (const o of oldPrecipArr) {
                                if (o.time) byKey[o.time] = o.precip || 0;
                            }
                            for (let i = 0; i < allTimes.length; i++) {
                                if (allTimes[i].startsWith(todayStr)) {
                                    byKey[allTimes[i]] = allPrecip[i] || 0;
                                }
                            }
                            const yesterdayStr = getLocalDateStr(cityTimezone, -1);
                            const merged = Object.keys(byKey)
                                .filter(t => t.slice(0, 10) >= yesterdayStr)
                                .sort()
                                .map(time => ({ time, precip: byKey[time] }));
                            await City.findOneAndUpdate(
                                { externalId: key },
                                { $set: {
                                    "eveningState.hourlyPrecip": merged,
                                    "eveningState.hourlyPrecipUpdatedAt": new Date()
                                }}
                            );
                        };

                        const oldS = calcStats(oldByHour);
                        const newS = calcStats(newByHour);

                        // No baseline for remaining hours today → set silently, do NOT alert
                        if (Object.keys(oldByHour).length === 0) {
                            await mergeTodayBaseline();
                        } else {
                            const amountIncrease = newS.total - oldS.total;
                            const significantAmountUp = amountIncrease >= 1.5;

                            const fullyCanceled = oldS.total > 0 && newS.total === 0;

                            let significantShift = false;
                            let significantLonger = false;
                            if (oldS.start != null && newS.start != null) {
                                const startDelta = Math.abs(newS.start - oldS.start);
                                const endDelta = Math.abs((newS.end ?? newS.start) - (oldS.end ?? oldS.start));
                                significantShift = startDelta >= 2 || endDelta >= 2;
                                significantLonger = (newS.duration - oldS.duration) >= 2;
                            } else if (oldS.start == null && newS.start != null && newS.total >= 0.5) {
                                significantShift = true;
                            }

                            const shouldAlert = fullyCanceled || significantAmountUp || significantShift || significantLonger;

                            if (shouldAlert) {
                                // "було" завжди означає той самий момент — коли hourlyPrecip
                                // востаннє записувався в базу (вечірній крон АБО попередній мердж).
                                const oldAsOfUk = formatLocalDateTime(oldPrecipAsOf, cityTimezone, 'uk');
                                const asOfSuffixUk = oldAsOfUk ? ` (станом на ${oldAsOfUk})` : '';

                                let alertMsg = null;
                                if (fullyCanceled) {
                                    alertMsg = `☀️ Гарні новини! Опади на сьогодні скасовано.\n` +
                                        `Було${asOfSuffixUk} ~${oldS.total.toFixed(1)} мм → зараз 0 мм.`;
                                } else if (significantAmountUp) {
                                    alertMsg = `⚠️ Прогноз змінився: очікується більше опадів!\n` +
                                        `Було${asOfSuffixUk} ~${oldS.total.toFixed(1)} мм → зараз ~${newS.total.toFixed(1)} мм.\n` +
                                        `Дощ: ${fmtBlocks(newS)}.`;
                                } else if (significantLonger) {
                                    alertMsg = `🌤 Опади триватимуть довше, ніж очікувалось.\n` +
                                        `Було${asOfSuffixUk}: ${fmtBlocks(oldS)}\nЗараз: ${fmtBlocks(newS)} (сумарно ${newS.total.toFixed(1)} мм).`;
                                } else if (significantShift) {
                                    if (oldS.start == null) {
                                        alertMsg = `⚠️ З'явилися опади, яких не було в прогнозі!\n` +
                                            `Дощ: ${fmtBlocks(newS)} (сумарно ${newS.total.toFixed(1)} мм).`;
                                    } else {
                                        alertMsg = `🌤 Час опадів змістився.\n` +
                                            `Було${asOfSuffixUk}: ${fmtBlocks(oldS)}\nЗараз: ${fmtBlocks(newS)} (сумарно ${newS.total.toFixed(1)} мм).`;
                                    }
                                }

                                if (alertMsg) {
                                    reasons.push("зміна опадів");
                                    for (const user of cityInfo.users) {
                                        if (!user.notificationsEnabled || user.alertTriggers?.precip === false) continue;
                                        alerts.push({ userId: user.telegramId, text: alertMsg, lang: user.language || 'uk' });
                                    }
                                    alertTriggered = true;
                                }

                                // Update baseline (merge) so we don't re-alert on the same change
                                await mergeTodayBaseline();
                            }
                        }
                    }
                } catch (omErr) {
                    console.error('Open-Meteo fetch error in check:', omErr.message);
                }

                // --- LOGIC E: Real-time Geomagnetic Activity (Magnetic Storms) ---
                // Rules:
                // - If evening forecast already told the user about this Kp level for today
                //   (evening enabled + geomag metric on + forecastedKp >= current) → skip for that user
                // - If user disabled evening forecast OR disabled geomag metric, but keeps
                //   alertTriggers.magneticStorm on → they want real-time alerts → send
                // - Always send if Kp escalated ABOVE what was forecasted / last alerted
                let snapGeomag = null;
                let snapWaqi = null;
                try {
                    const noaaRes = await axios.get(
                        'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
                        { timeout: 8000 }
                    );
                    if (noaaRes.data && Array.isArray(noaaRes.data) && noaaRes.data.length > 0) {
                        const now = Date.now();
                        const next12h = noaaRes.data
                            .filter(r => {
                                const t = new Date(r.time_tag).getTime();
                                return t >= now - 2 * 3600 * 1000 && t <= now + 12 * 3600 * 1000;
                            })
                            .map(r => parseFloat(r.kp))
                            .filter(v => !isNaN(v));

                        const currentMaxKp = next12h.length > 0 ? Math.max(...next12h) : null;

                        if (currentMaxKp !== null) {
                            let gBadge = '🟢';
                            if (currentMaxKp >= 5) gBadge = '🔴';
                            else if (currentMaxKp >= 4) gBadge = '🟡';
                            snapGeomag = { maxKp: currentMaxKp, badge: gBadge, updatedAt: new Date() };
                        }

                        if (currentMaxKp !== null && currentMaxKp >= 4) {
                            const lastAlertDate = cityDoc?.lastGeomagAlert?.date;
                            const lastAlertKp = cityDoc?.lastGeomagAlert?.maxKp || 0;

                            // City-level: already alerted this level today → no need to process further
                            // (unless escalated)
                            const cityAlreadyAlerted = lastAlertDate === todayStr && currentMaxKp <= lastAlertKp;

                            if (!cityAlreadyAlerted) {
                                const isStorm = currentMaxKp >= 5;
                                const forecastedKp = evening?.forecastedKp;
                                const forecastedKpDate = evening?.forecastedKpDate;
                                let anyUserAlerted = false;

                                for (const user of cityInfo.users) {
                                    if (!user.notificationsEnabled || user.alertTriggers?.magneticStorm === false) continue;

                                    // Did this user already see this (or higher) Kp in the evening forecast for today?
                                    const metrics = user.forecastSettings?.enabledMetrics || [];
                                    const eveningOn = user.eveningForecastEnabled !== false;
                                    const geomagInEvening = metrics.includes('geomag');
                                    const eveningCoveredToday =
                                        forecastedKpDate === todayStr &&
                                        forecastedKp != null &&
                                        currentMaxKp <= forecastedKp;

                                    const alreadyInformed = eveningOn && geomagInEvening && eveningCoveredToday;

                                    if (alreadyInformed) continue;

                                    // User either didn't get evening geomag info, or Kp is worse than forecasted
                                    const lang = user.language || 'uk';
                                    const isUk = lang === 'uk';
                                    const ukMsg = isStorm
                                        ? `🧲 **Увага! Магнітна буря (Kp ${currentMaxKp.toFixed(0)})!**\nФіксується активне збурення геомагнітного поля. Метеозалежним людям варто зменшити навантаження, пити більше води та тримати під рукою ліки.`
                                        : `🧲 **Увага! Спостерігається збурення магнітного поля (Kp ${currentMaxKp.toFixed(0)})!**\nМожливе незначне погіршення самопочуття у метеочутливих людей.`;
                                    const enMsg = isStorm
                                        ? `🧲 **Alert! Magnetic Storm (Kp ${currentMaxKp.toFixed(0)})!**\nActive geomagnetic field disturbance detected. Weather-sensitive people should reduce physical activity and drink plenty of water.`
                                        : `🧲 **Alert! Unsettled geomagnetic field (Kp ${currentMaxKp.toFixed(0)})!**\nMild discomfort possible for weather-sensitive individuals.`;

                                    alerts.push({ userId: user.telegramId, text: isUk ? ukMsg : enMsg, lang });
                                    anyUserAlerted = true;
                                }

                                if (anyUserAlerted) {
                                    reasons.push(isStorm ? "магнітна буря" : "збурення магн. поля");
                                    alertTriggered = true;
                                }

                                // Always bump lastGeomagAlert so we don't re-evaluate the same level
                                // (covers both "sent to someone" and "everyone already informed")
                                await City.findOneAndUpdate(
                                    { externalId: key },
                                    { $set: { "lastGeomagAlert": { date: todayStr, maxKp: currentMaxKp } } }
                                );
                            }
                        }
                    }
                } catch (geomagErr) {
                    console.error('Geomag check error in cron-check:', geomagErr.message);
                }

                // --- LOGIC F: Real-time AQI Transition Check (worsen OR improve to safe) ---
                // Rules:
                // - Alert only on transitions: safe → worse, or worse → safe
                // - Do NOT spam when level stays the same (safe→safe or bad→bad)
                // - When recovering to safe (tier 0), send a positive message
                const WAQI_TOKEN = process.env.WAQI_TOKEN;
                if (WAQI_TOKEN) {
                    try {
                        const waqiRes = await axios.get(
                            `https://api.waqi.info/feed/geo:${cityInfo.lat};${cityInfo.lon}/?token=${WAQI_TOKEN}`,
                            { timeout: 8000 }
                        );
                        if (waqiRes.data?.status === 'ok') {
                            const d = waqiRes.data.data;
                            const aqiVal = d.aqi;
                            const pm25 = d.iaqi?.pm25?.v ?? null;
                            const pm10 = d.iaqi?.pm10?.v ?? null;

                            let currentTier = 0;
                            let badge = '🟢';
                            if (aqiVal > 150) { currentTier = 3; badge = '🔴'; }
                            else if (aqiVal > 100) { currentTier = 2; badge = '🟠'; }
                            else if (aqiVal > 50) { currentTier = 1; badge = '🟡'; }

                            snapWaqi = {
                                aqi: aqiVal,
                                aqiBadge: badge,
                                pm25,
                                pm10,
                                pm1: d.iaqi?.pm1?.v ?? null,
                                station: d.city?.name || null
                            };

                            const lastAqiTier = cityDoc?.lastAqiAlert?.tier ?? 0;

                            // Always persist current state so next check has correct baseline
                            await City.findOneAndUpdate(
                                { externalId: key },
                                { $set: { "lastAqiAlert": { date: todayStr, tier: currentTier, aqi: aqiVal } } }
                            );

                            if (currentTier > lastAqiTier) {
                                // Deterioration: safe → worse, or worse → even worse
                                reasons.push("погіршення якості повітря");

                                for (const user of cityInfo.users) {
                                    if (!user.notificationsEnabled || user.alertTriggers?.airQuality === false) continue;
                                    const lang = user.language || 'uk';
                                    const isUk = lang === 'uk';

                                    let title = isUk
                                        ? `🍃 **Попередження: Погіршення якості повітря!**`
                                        : `🍃 **Alert: Air Quality Deterioration!**`;
                                    let mainBody = `${title}\n${badge} AQI ${aqiVal}`;
                                    if (pm25 != null) mainBody += ` | PM2.5: ${pm25}`;
                                    if (pm10 != null) mainBody += ` | PM10: ${pm10}`;

                                    const issues = [];
                                    if (pm25 != null && pm25 > 25) issues.push(isUk ? 'PM2.5 (дрібний пил/смог)' : 'PM2.5 (fine dust/smog)');
                                    if (pm10 != null && pm10 > 50) issues.push(isUk ? 'PM10 (великий пил)' : 'PM10 (coarse dust)');

                                    let advice = '';
                                    if (aqiVal > 150) {
                                        advice = isUk
                                            ? '\n🔴 **Небезпечний рівень забруднення!** Зачиніть вікна, увімкніть очищувач повітря та утримайтесь від виходу на вулицю.'
                                            : '\n🔴 **Dangerous air quality!** Close windows, turn on air purifiers, and refrain from going outside.';
                                    } else if (aqiVal > 100) {
                                        advice = isUk
                                            ? '\n🟠 **Шкідливо для чутливих груп!** Високий рівень пилу/смогу. Рекомендуємо зачинити вікна.'
                                            : '\n🟠 **Unhealthy for sensitive groups!** High dust/smog level. We recommend closing windows.';
                                    } else if (aqiVal > 50) {
                                        advice = isUk
                                            ? '\n🟡 **Повітря помірно забруднене.** Чутливим людям варто бути обережними.'
                                            : '\n🟡 **Moderate air pollution.** Sensitive individuals should take precautions.';
                                    }

                                    if (issues.length > 0) {
                                        advice += isUk ? `\n(Причина: ${issues.join(', ')})` : `\n(Reason: ${issues.join(', ')})`;
                                    }

                                    alerts.push({ userId: user.telegramId, text: `${mainBody}${advice}`, lang });
                                }
                                alertTriggered = true;
                            } else if (currentTier === 0 && lastAqiTier > 0) {
                                // Recovery: was worse → now safe
                                reasons.push("покращення якості повітря");

                                for (const user of cityInfo.users) {
                                    if (!user.notificationsEnabled || user.alertTriggers?.airQuality === false) continue;
                                    const lang = user.language || 'uk';
                                    const isUk = lang === 'uk';

                                    const goodMsg = isUk
                                        ? `🍃 **Гарні новини! Якість повітря покращилась.**\n🟢 AQI ${aqiVal} — повітря знову в безпечній зоні.\nМожна відкривати вікна та спокійно гуляти на вулиці.`
                                        : `🍃 **Good news! Air quality has improved.**\n🟢 AQI ${aqiVal} — air is back in the safe zone.\nYou can open the windows and safely go for a walk.`;

                                    alerts.push({ userId: user.telegramId, text: goodMsg, lang });
                                }
                                alertTriggered = true;
                            }
                            // Same tier (safe→safe or bad→bad) → no message
                        }
                    } catch (aqiErr) {
                        console.error('AQI check error in cron-check:', aqiErr.message);
                    }
                }

                // --- SENDING ALERTS ---
                const uniqueAlerts = {}; // prevent duplicate messages to same user
                for (const a of alerts) {
                    if (!uniqueAlerts[a.userId]) uniqueAlerts[a.userId] = { texts: [], lang: a.lang || 'uk' };
                    uniqueAlerts[a.userId].texts.push(a.text);
                }

                for (const userId of Object.keys(uniqueAlerts)) {
                    await sleep(50);
                    const userLang = uniqueAlerts[userId].lang || 'uk';
                    const btnText = userLang === 'uk' ? '⚙️ Налаштувати сповіщення' : '⚙️ Configure alerts';
                    await bot.telegram.sendMessage(userId, uniqueAlerts[userId].texts.join('\n\n'), {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: btnText, callback_data: 'alert_settings' }]
                            ]
                        }
                    });
                    alertsTotal++;
                }

                // Update city and users
                if (current.timezone && !cityDoc?.timezone) {
                    await City.findOneAndUpdate({ externalId: key }, { timezone: current.timezone });
                }

                // --- Dashboard snapshot (Weatherbit layer + OM hourly if fetched) ---
                const { degToCard } = require('../utils/weather');
                const wbCurrent = {
                    ...current,
                    wind_cdir: current.wind_dir != null ? degToCard(current.wind_dir) : (current.wind_cdir || 'N'),
                    source: 'weatherbit'
                };
                const wbDaily = dailyAll.map(d => ({
                    ...d,
                    max_temp: d.max_temp,
                    min_temp: d.min_temp,
                    pop: d.pop,
                    gust: d.wind_gust_spd,
                    vis: d.vis,
                    uv: d.uv,
                    sunrise: d.sunrise_ts ? d.sunrise_ts * 1000 : d.sunrise,
                    sunset: d.sunset_ts ? d.sunset_ts * 1000 : d.sunset,
                    wind_cdir: d.wind_dir != null ? degToCard(d.wind_dir) : (d.wind_cdir || 'N')
                }));

                const snapWb = {
                    'dashboardSnapshot.updatedAtWb': new Date(),
                    'dashboardSnapshot.current': wbCurrent,
                    'dashboardSnapshot.currentSource': 'weatherbit',
                    'dashboardSnapshot.daily': wbDaily,
                    'dashboardSnapshot.dailySource': 'weatherbit',
                    'dashboardSnapshot.lat': cityInfo.lat,
                    'dashboardSnapshot.lon': cityInfo.lon,
                    'dashboardSnapshot.timezone': cityTimezone
                };
                if (omHourlyForSnap) {
                    snapWb['dashboardSnapshot.hourly'] = omHourlyForSnap;
                    snapWb['dashboardSnapshot.updatedAtOm'] = new Date();
                }
                if (snapGeomag) snapWb['dashboardSnapshot.geomag'] = snapGeomag;
                if (snapWaqi) snapWb['dashboardSnapshot.waqi'] = snapWaqi;
                await City.findOneAndUpdate({ externalId: key }, { $set: snapWb }, { upsert: true });

                for (const user of cityInfo.users) {
                    user.lastState = { ...user.lastState, temp: current.temp, weatherCode: newCode, updatedAt: new Date() };
                    await user.save();
                }

                const statusStr = alertTriggered ? `🚨 ${reasons.join(', ')}` : '✅ без змін';
                const weatherDesc = getWeatherDesc(newCode, 'uk');
                const windDir = getWindDir(current.wind_cdir, 'uk');
                logLines.push(`• ${cityInfo.name} | ${current.temp}°C | ${weatherDesc} | ${windDir} | ${statusStr}`);

            } catch (err) {
                errorsCount++;
                logLines.push(`• ${cityInfo.name} | ❌ помилка: ${err.message}`);
            }
        }

        const summary = [
            `📋 <b>Перевірка погоди</b> — ${startTime}`,
            `👥 Користувачів перевірено: ${users.length}`,
            `🚨 Сповіщень надіслано: ${alertsTotal}`,
            `❌ Помилок: ${errorsCount}`,
            ``,
            ...logLines
        ].join('\n');
        await log(summary);
        res.status(200).send('Processed');

    } catch (error) {
        console.error(error);
        await log(`❌ <b>Weather Check FAILED</b>\n<code>${escapeHTML(error.message)}</code>`);
        res.status(500).send('Error');
    }
}
