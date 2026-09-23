require('dotenv').config();
const axios = require('axios');
const getBot = require('../utils/bot');
const bot = getBot();
const logToTelegram = require('../utils/logger');
const User = require('../models/User');
const City = require('../models/City');
const History = require('../models/History');
const connectDB = require('../utils/db');
const { sleep, escapeHTML, getLocalDateStr, formatLocalDateTime } = require('../utils/helpers');
const { dayKey, getDayBaseline, daySetPaths, mergeHourlyFlat } = require('../utils/baseline');

/**
 * Light weather check cron — identical alert logic to cron-check.js
 * but WITHOUT any Weatherbit API calls (to stay within free-tier limits).
 *
 * Data sources:
 * - Open-Meteo: current temp, daily min/max, hourly precip
 * - NOAA SWPC: geomagnetic Kp
 * - WAQI: air quality
 *
 * Intended to run frequently (e.g. every 30 min) via external scheduler.
 */
module.exports = async (req, res) => {
    const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
    const log = (text) => logToTelegram(bot, LOG_CHAT_ID, text);
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).send('Unauthorized');
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
                uniqueCities[key] = { lat: user.lat, lon: user.lon, name: user.city, users: [] };
            }
            uniqueCities[key].users.push(user);
        }

        let alertsTotal = 0;
        let errorsCount = 0;
        const logLines = [];

        const alertsDict = {
            uk: {
                tempAnomaly: "⚠️ **Аномальна температура!**\nЗараз: {temp}, що значно {dir} ніж очікувалось на цей час (станом на {asOf}: {expected}).",
                forecastShift: "📊 **Прогноз на сьогодні змінився!**\nОчікували (станом на {asOf}): {oldMin}..{oldMax}°C\nЗараз: {newMin}..{newMax}°C\nЗміна: ніч {minDelta}°C, день {maxDelta}°C",
                warmer: "вище",
                cooler: "нижче"
            },
            en: {
                tempAnomaly: "⚠️ **Temperature anomaly!**\nNow: {temp}, which is {dir} than expected for this time (as of {asOf}: {expected}).",
                forecastShift: "📊 **Today's forecast has changed!**\nExpected (as of {asOf}): {oldMin}..{oldMax}°C\nNow: {newMin}..{newMax}°C\nChange: night {minDelta}°C, day {maxDelta}°C",
                warmer: "warmer",
                cooler: "cooler"
            }
        };

        for (const [key, cityInfo] of Object.entries(uniqueCities)) {
            try {
                // --- Open-Meteo: current + daily + full hourly (alerts + dashboard snapshot) ---
                const omUrl =
                    `https://api.open-meteo.com/v1/forecast?latitude=${cityInfo.lat}&longitude=${cityInfo.lon}` +
                    `&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m,apparent_temperature,wind_direction_10m,surface_pressure` +
                    `&daily=temperature_2m_min,temperature_2m_max` +
                    `&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,precipitation_probability,surface_pressure,weather_code` +
                    `&timezone=auto&forecast_days=3`;

                const omRes = await axios.get(omUrl, { timeout: 12000 });
                const om = omRes.data;
                if (!om || !om.current) {
                    throw new Error('Open-Meteo: empty response');
                }

                const curTemp = om.current.temperature_2m;
                const cityTimezone = om.timezone || 'Europe/Kyiv';
                const { degToCard } = require('../utils/weather');
                const windDirCard = om.current.wind_direction_10m != null
                    ? degToCard(om.current.wind_direction_10m)
                    : 'N';

                const cityDoc = await City.findOne({ externalId: key });
                const evening = cityDoc?.eveningState;

                // Calendar-safe local date (no toLocaleString → Date anti-pattern)
                const todayStr = getLocalDateStr(cityTimezone, 0);

                // Open-Meteo daily.time[] is YYYY-MM-DD in the requested timezone
                const omDailyTimes = om.daily?.time || [];
                let omTodayIdx = omDailyTimes.findIndex(t => String(t).slice(0, 10) === todayStr);
                if (omTodayIdx < 0) omTodayIdx = 0;
                const newMin = om.daily?.temperature_2m_min?.[omTodayIdx];
                const newMax = om.daily?.temperature_2m_max?.[omTodayIdx];

                const dayBaseline = getDayBaseline(evening, todayStr, cityTimezone);
                let dayAsOf = dayBaseline?.asOf || evening?.updatedAt || null;
                const eveningToday = (dayBaseline && (dayBaseline.min_temp != null || dayBaseline.max_temp != null))
                    ? { min_temp: dayBaseline.min_temp, max_temp: dayBaseline.max_temp, valid_date: todayStr }
                    : (evening?.forecast || []).find(d => dayKey(d) === todayStr);

                const alerts = [];
                let alertTriggered = false;
                let reasons = [];

                // --- LOGIC A + B: Forecast shift & temp anomaly (using Open-Meteo daily/current) ---
                // Only compare when baseline is for the same calendar day as todayStr
                if (eveningToday && dayKey(eveningToday) === todayStr && newMin != null && newMax != null) {
                    const oldMin = eveningToday.min_temp;
                    const oldMax = eveningToday.max_temp;

                    const maxShift = newMax - oldMax;
                    const minShift = newMin - oldMin;

                    if (Math.abs(maxShift) >= 4 || Math.abs(minShift) >= 4) {
                        reasons.push("зміна прогнозу");
                        const fmtDelta = (d) => (d > 0 ? `+${d.toFixed(1)}` : d.toFixed(1));
                        for (const user of cityInfo.users) {
                            if (!user.notificationsEnabled || user.alertTriggers?.temperature === false) continue;
                            const lang = user.language || 'uk';
                            const asOf = formatLocalDateTime(dayAsOf, cityTimezone, lang);
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
                        const shiftNow = new Date();
                        const prevHp = getDayBaseline(evening, todayStr, cityTimezone)?.hourlyPrecip;
                        const shiftSet = {
                            "eveningState.forecast": updatedForecast,
                            "eveningState.updatedAt": shiftNow,
                            ...daySetPaths(todayStr, {
                                asOf: shiftNow,
                                min_temp: newMin,
                                max_temp: newMax
                            })
                        };
                        if (prevHp && prevHp.length) {
                            shiftSet[`eveningState.days.${todayStr}.hourlyPrecip`] = prevHp;
                        }
                        await City.findOneAndUpdate(
                            { externalId: key },
                            { $set: shiftSet }
                        );
                        if (evening) {
                            evening.forecast = updatedForecast;
                            evening.updatedAt = shiftNow;
                            if (!evening.days) evening.days = {};
                            evening.days[todayStr] = {
                                ...(evening.days[todayStr] || {}),
                                asOf: shiftNow,
                                min_temp: newMin,
                                max_temp: newMax,
                                hourlyPrecip: prevHp || evening.days[todayStr]?.hourlyPrecip || []
                            };
                        }
                        dayAsOf = shiftNow;
                    }

                    // Після можливого зсуву прогнозу порівнюємо з ОНОВЛЕНИМ baseline
                    // (evening.forecast уже оновлений вище), а не зі старими oldMin/oldMax.
                    const blAfter = getDayBaseline(evening, todayStr, cityTimezone);
                    const baselineMin = blAfter?.min_temp ?? oldMin;
                    const baselineMax = blAfter?.max_temp ?? oldMax;
                    let isAnomaly = false;
                    let expectedBase = 0;
                    let direction = '';

                    if (curTemp < (baselineMin - 5)) {
                        isAnomaly = true;
                        expectedBase = baselineMin;
                        direction = 'cooler';
                    } else if (curTemp > (baselineMax + 5)) {
                        isAnomaly = true;
                        expectedBase = baselineMax;
                        direction = 'warmer';
                    }

                    if (isAnomaly) {
                        reasons.push("аномалія темп.");
                        for (const user of cityInfo.users) {
                            if (!user.notificationsEnabled || user.alertTriggers?.temperature === false) continue;
                            const lang = user.language || 'uk';
                            const unit = user.units?.temp || 'c';
                            const fmtTemp = (c) =>
                                unit === 'f' ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`;
                            const asOf = formatLocalDateTime(dayAsOf, cityTimezone, lang);

                            const msg = alertsDict[lang].tempAnomaly
                                .replace('{temp}', fmtTemp(curTemp))
                                .replace('{asOf}', asOf)
                                .replace('{expected}', fmtTemp(expectedBase))
                                .replace('{dir}', alertsDict[lang][direction]);
                            alerts.push({ userId: user.telegramId, text: msg, lang });
                        }
                        alertTriggered = true;
                    }
                }

                // --- SMART HISTORY UPDATE ---
                try {
                    await History.findOneAndUpdate(
                        { externalId: key, date: todayStr },
                        {
                            $min: { temp_min: curTemp },
                            $max: { temp_max: curTemp }
                        },
                        { upsert: true }
                    );
                } catch (histErr) {
                    console.error('History smart update error:', histErr.message);
                }

                // LOGIC C (precip start via weather code) skipped — Weatherbit codes;
                // full-day precip changes are covered by LOGIC D below.

                // --- LOGIC D: Smart Full-Day Precipitation Check ---
                try {
                    const allTimes = om.hourly?.time || [];
                    const allPrecip = om.hourly?.precipitation || [];
                    const allProb = om.hourly?.precipitation_probability || [];
                    const dayBlPrecip = getDayBaseline(evening, todayStr, cityTimezone);
                    const oldPrecipArr = (dayBlPrecip?.hourlyPrecip?.length
                        ? dayBlPrecip.hourlyPrecip
                        : (evening?.hourlyPrecip || []));
                    const oldPrecipAsOf = dayBlPrecip?.asOf || dayAsOf || evening?.updatedAt || null;
                    const RAIN_PROB_THRESHOLD = 15;

                    // Parse hour from "YYYY-MM-DDTHH:MM" — avoid Date timezone bugs
                    const hourFromTime = (t) => parseInt(String(t).slice(11, 13), 10);

                    // Each entry: { precip, prob }. Rainy if precip > 0 OR prob > threshold.
                    const oldByHour = {};
                    for (const o of oldPrecipArr) {
                        if (o.time && o.time.startsWith(todayStr)) {
                            const h = hourFromTime(o.time);
                            if (!Number.isNaN(h)) {
                                oldByHour[h] = {
                                    precip: o.precip || 0,
                                    prob: (o.prob != null ? o.prob : 0)
                                };
                            }
                        }
                    }

                    const newByHour = {};
                    for (let i = 0; i < allTimes.length; i++) {
                        if (allTimes[i].startsWith(todayStr)) {
                            const h = hourFromTime(allTimes[i]);
                            if (!Number.isNaN(h)) {
                                newByHour[h] = {
                                    precip: allPrecip[i] || 0,
                                    prob: allProb[i] != null ? allProb[i] : 0
                                };
                            }
                        }
                    }

                    const isRainyHour = (entry) => {
                        const p = (entry && entry.precip) || 0;
                        const pr = (entry && entry.prob) || 0;
                        return p > 0 || pr > RAIN_PROB_THRESHOLD;
                    };
                    const calcStats = (byHour) => {
                        let total = 0;
                        const hours = [];
                        for (let h = 0; h < 24; h++) {
                            const entry = byHour[h] || { precip: 0, prob: 0 };
                            const p = entry.precip || 0;
                            if (isRainyHour(entry)) {
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

                    // Merge ONLY today's hours into existing array — never wipe tomorrow/other days
                    const mergeTodayBaseline = async () => {
                        const yesterdayStr = getLocalDateStr(cityTimezone, -1);
                        const todayHours = [];
                        for (let i = 0; i < allTimes.length; i++) {
                            if (allTimes[i].startsWith(todayStr)) {
                                todayHours.push({
                                    time: allTimes[i],
                                    precip: allPrecip[i] || 0,
                                    prob: allProb[i] != null ? allProb[i] : 0
                                });
                            }
                        }
                        const merged = mergeHourlyFlat(
                            evening?.hourlyPrecip || oldPrecipArr,
                            todayStr,
                            todayHours,
                            yesterdayStr
                        );
                        const mergeNow = new Date();
                        const curBl = getDayBaseline(evening, todayStr, cityTimezone);
                        const mergeSet = {
                            "eveningState.hourlyPrecip": merged,
                            "eveningState.hourlyPrecipUpdatedAt": mergeNow,
                            "eveningState.updatedAt": mergeNow,
                            ...daySetPaths(todayStr, {
                                asOf: mergeNow,
                                hourlyPrecip: todayHours
                            })
                        };
                        if (curBl?.min_temp != null) mergeSet[`eveningState.days.${todayStr}.min_temp`] = curBl.min_temp;
                        if (curBl?.max_temp != null) mergeSet[`eveningState.days.${todayStr}.max_temp`] = curBl.max_temp;

                        await City.findOneAndUpdate(
                            { externalId: key },
                            { $set: mergeSet }
                        );
                        if (evening) {
                            evening.hourlyPrecip = merged;
                            evening.hourlyPrecipUpdatedAt = mergeNow;
                            evening.updatedAt = mergeNow;
                            if (!evening.days) evening.days = {};
                            evening.days[todayStr] = {
                                ...(evening.days[todayStr] || {}),
                                asOf: mergeNow,
                                hourlyPrecip: todayHours,
                                min_temp: curBl?.min_temp ?? evening.days[todayStr]?.min_temp,
                                max_temp: curBl?.max_temp ?? evening.days[todayStr]?.max_temp
                            };
                        }
                        dayAsOf = mergeNow;
                    };

                    const oldS = calcStats(oldByHour);
                    const newS = calcStats(newByHour);

                    // No baseline for THIS calendar day (or all zeros / no high-prob hours) → set silently
                    // duration > 0 covers hours with precip=0 but prob > threshold
                    const hasTodayBaseline = Object.keys(oldByHour).length > 0 && (oldS.total > 0 || oldS.duration > 0);
                    if (!hasTodayBaseline) {
                        await mergeTodayBaseline();
                    } else {
                        const amountIncrease = newS.total - oldS.total;
                        const significantAmountUp = amountIncrease >= 1.5;
                        // Canceled when previous rainy window (mm or high-prob hours) is gone
                        const fullyCanceled = (oldS.total > 0 || oldS.duration > 0) && newS.total === 0 && newS.duration === 0;

                        let significantShift = false;
                        let significantLonger = false;
                        if (oldS.start != null && newS.start != null) {
                            const startDelta = Math.abs(newS.start - oldS.start);
                            const endDelta = Math.abs((newS.end ?? newS.start) - (oldS.end ?? oldS.start));
                            significantShift = startDelta >= 2 || endDelta >= 2;
                            significantLonger = (newS.duration - oldS.duration) >= 2;
                        } else if (oldS.start == null && newS.start != null && (newS.total >= 0.5 || newS.duration >= 1)) {
                            significantShift = true;
                        }

                        const shouldAlert = fullyCanceled || significantAmountUp || significantShift || significantLonger;

                        if (shouldAlert) {
                            const oldAsOfUk = formatLocalDateTime(oldPrecipAsOf, cityTimezone, 'uk');
                            const asOfSuffixUk = oldAsOfUk ? ` (станом на ${oldAsOfUk})` : '';

                            let alertMsg = '';

                            if (fullyCanceled) {
                                alertMsg = `☀️ Чудові новини! Усі очікувані на сьогодні опади скасовано, дощу не передбачається.\n` +
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

                            // Merge today only — preserve tomorrow and other days
                            await mergeTodayBaseline();
                        }
                    }
                } catch (omErr) {
                    console.error('Open-Meteo precip logic error in light check:', omErr.message);
                }

                // --- LOGIC E: Geomagnetic (same as main cron-check) ---
                let snapGeomag = null;
                let snapWaqi = null;
                try {
                    const noaaRes = await axios.get(
                        'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
                        { timeout: 8000 }
                    );
                    if (noaaRes.data && Array.isArray(noaaRes.data) && noaaRes.data.length > 0) {
                        const nowTs = Date.now();
                        const next12h = noaaRes.data
                            .filter(r => {
                                const t = new Date(r.time_tag).getTime();
                                return t >= nowTs - 2 * 3600 * 1000 && t <= nowTs + 12 * 3600 * 1000;
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
                            const cityAlreadyAlerted = lastAlertDate === todayStr && currentMaxKp <= lastAlertKp;

                            if (!cityAlreadyAlerted) {
                                const isStorm = currentMaxKp >= 5;
                                const forecastedKp = evening?.forecastedKp;
                                const forecastedKpDate = evening?.forecastedKpDate;
                                let anyUserAlerted = false;

                                for (const user of cityInfo.users) {
                                    if (!user.notificationsEnabled || user.alertTriggers?.magneticStorm === false) continue;

                                    const metrics = user.forecastSettings?.enabledMetrics || [];
                                    const eveningOn = user.eveningForecastEnabled !== false;
                                    const geomagInEvening = metrics.includes('geomag');
                                    const eveningCoveredToday =
                                        forecastedKpDate === todayStr &&
                                        forecastedKp != null &&
                                        currentMaxKp <= forecastedKp;

                                    if (eveningOn && geomagInEvening && eveningCoveredToday) continue;

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

                                await City.findOneAndUpdate(
                                    { externalId: key },
                                    { $set: { "lastGeomagAlert": { date: todayStr, maxKp: currentMaxKp } } }
                                );
                            }
                        }
                    }
                } catch (geomagErr) {
                    console.error('Geomag check error in light cron:', geomagErr.message);
                }

                // --- LOGIC F: AQI transition (same as main cron-check) ---
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

                            await City.findOneAndUpdate(
                                { externalId: key },
                                { $set: { "lastAqiAlert": { date: todayStr, tier: currentTier, aqi: aqiVal } } }
                            );

                            if (currentTier > lastAqiTier) {
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
                        }
                    } catch (aqiErr) {
                        console.error('AQI check error in light cron:', aqiErr.message);
                    }
                }

                // --- SEND ALERTS ---
                const uniqueAlerts = {};
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

                if (cityTimezone && !cityDoc?.timezone) {
                    await City.findOneAndUpdate({ externalId: key }, { timezone: cityTimezone });
                }

                // --- Dashboard snapshot (Open-Meteo layer) — for website, no per-user fetch ---
                const hourlyBlock = om.hourly ? {
                    time: om.hourly.time || [],
                    temperature_2m: om.hourly.temperature_2m || [],
                    wind_speed_10m: om.hourly.wind_speed_10m || [],
                    wind_gusts_10m: om.hourly.wind_gusts_10m || [],
                    precipitation: om.hourly.precipitation || [],
                    precipitation_probability: om.hourly.precipitation_probability || [],
                    surface_pressure: om.hourly.surface_pressure || [],
                    weather_code: om.hourly.weather_code || []
                } : null;

                const omCurrentForUi = {
                    temp: curTemp,
                    app_temp: om.current.apparent_temperature,
                    rh: om.current.relative_humidity_2m,
                    wind_spd: om.current.wind_speed_10m,
                    wind_dir: om.current.wind_direction_10m,
                    wind_cdir: windDirCard,
                    pres: om.current.surface_pressure,
                    weather: { code: om.current.weather_code },
                    city_name: cityInfo.name,
                    lat: cityInfo.lat,
                    lon: cityInfo.lon,
                    timezone: cityTimezone,
                    source: 'open-meteo'
                };

                // Keep existing WB daily if present; only refresh OM fields
                const prevSnap = cityDoc?.dashboardSnapshot || {};
                const snapSet = {
                    'dashboardSnapshot.updatedAtOm': new Date(),
                    'dashboardSnapshot.hourly': hourlyBlock,
                    'dashboardSnapshot.lat': cityInfo.lat,
                    'dashboardSnapshot.lon': cityInfo.lon,
                    'dashboardSnapshot.timezone': cityTimezone
                };
                // If no Weatherbit current yet (or older than OM preference), set OM current
                if (!prevSnap.updatedAtWb || !prevSnap.current || prevSnap.currentSource !== 'weatherbit') {
                    snapSet['dashboardSnapshot.current'] = omCurrentForUi;
                    snapSet['dashboardSnapshot.currentSource'] = 'open-meteo';
                }
                // Always stash latest OM current as fallback field when WB is primary
                snapSet['dashboardSnapshot.currentOm'] = omCurrentForUi;
                if (snapGeomag) snapSet['dashboardSnapshot.geomag'] = snapGeomag;
                if (snapWaqi) snapSet['dashboardSnapshot.waqi'] = snapWaqi;

                await City.findOneAndUpdate(
                    { externalId: key },
                    { $set: snapSet },
                    { upsert: true }
                );

                for (const user of cityInfo.users) {
                    user.lastState = {
                        ...user.lastState,
                        temp: curTemp,
                        weatherCode: om.current.weather_code,
                        updatedAt: new Date()
                    };
                    await user.save();
                }

                const statusStr = alertTriggered ? `🚨 ${reasons.join(', ')}` : '✅ без змін';
                logLines.push(`• ${cityInfo.name} | ${curTemp}°C | ${statusStr}`);
            } catch (err) {
                errorsCount++;
                logLines.push(`• ${cityInfo.name} | ❌ помилка: ${err.message}`);
            }
        }

        const summary = [
            `📋 <b>Легка перевірка (без Weatherbit)</b> — ${startTime}`,
            `👥 Користувачів перевірено: ${users.length}`,
            `🚨 Сповіщень надіслано: ${alertsTotal}`,
            `❌ Помилок: ${errorsCount}`,
            ``,
            ...logLines
        ].join('\n');
        await log(summary);
        res.status(200).send('Processed (light)');
    } catch (error) {
        console.error(error);
        await log(`❌ <b>Light Weather Check FAILED</b>\n<code>${escapeHTML(error.message)}</code>`);
        res.status(500).send('Error');
    }
};
