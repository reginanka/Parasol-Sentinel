require('dotenv').config();
const axios = require('axios');
const getBot = require('../utils/bot');
const bot = getBot();
const logToTelegram = require('../utils/logger');
const User = require('../models/User');
const City = require('../models/City');
const History = require('../models/History');
const connectDB = require('../utils/db');
const { sleep, escapeHTML } = require('../utils/helpers');

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
                tempAnomaly: "⚠️ **Аномальна температура!**\nЗараз: {temp}, що значно {dir} ніж очікувалось на цей час ({expected}°C).",
                forecastShift: "📊 **Прогноз на сьогодні змінився!**\nОчікували: {oldMin}..{oldMax}°C\nЗараз: {newMin}..{newMax}°C\nЗміна: ніч {minDelta}°C, день {maxDelta}°C",
                warmer: "вище",
                cooler: "нижче"
            },
            en: {
                tempAnomaly: "⚠️ **Temperature anomaly!**\nNow: {temp}, which is {dir} than expected for this time ({expected}°C).",
                forecastShift: "📊 **Today's forecast has changed!**\nExpected: {oldMin}..{oldMax}°C\nNow: {newMin}..{newMax}°C\nChange: night {minDelta}°C, day {maxDelta}°C",
                warmer: "warmer",
                cooler: "cooler"
            }
        };

        for (const [key, cityInfo] of Object.entries(uniqueCities)) {
            try {
                // --- Open-Meteo: current + daily + hourly precip (single request) ---
                const omUrl =
                    `https://api.open-meteo.com/v1/forecast?latitude=${cityInfo.lat}&longitude=${cityInfo.lon}` +
                    `&current=temperature_2m,weather_code,wind_speed_10m` +
                    `&daily=temperature_2m_min,temperature_2m_max` +
                    `&hourly=precipitation` +
                    `&timezone=auto&forecast_days=1`;

                const omRes = await axios.get(omUrl, { timeout: 12000 });
                const om = omRes.data;
                if (!om || !om.current) {
                    throw new Error('Open-Meteo: empty response');
                }

                const curTemp = om.current.temperature_2m;
                const newMin = om.daily?.temperature_2m_min?.[0];
                const newMax = om.daily?.temperature_2m_max?.[0];
                const cityTimezone = om.timezone || 'Europe/Kyiv';

                const cityDoc = await City.findOne({ externalId: key });
                const evening = cityDoc?.eveningState;

                const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: cityTimezone }));
                const todayStr = localNow.toLocaleDateString('en-CA', { timeZone: cityTimezone });

                const eveningToday = evening?.forecast?.find(d =>
                    (d.valid_date || d.datetime || '').startsWith(todayStr)
                );

                const alerts = [];
                let alertTriggered = false;
                let reasons = [];

                // --- LOGIC A + B: Forecast shift & temp anomaly (using Open-Meteo daily/current) ---
                if (eveningToday && newMin != null && newMax != null) {
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
                            const msg = alertsDict[lang].forecastShift
                                .replace('{oldMin}', oldMin).replace('{oldMax}', oldMax)
                                .replace('{newMin}', newMin).replace('{newMax}', newMax)
                                .replace('{minDelta}', fmtDelta(minShift))
                                .replace('{maxDelta}', fmtDelta(maxShift));
                            alerts.push({ userId: user.telegramId, text: msg, lang });
                        }
                        alertTriggered = true;
                    }

                    let isAnomaly = false;
                    let expectedBase = 0;
                    let direction = '';

                    if (curTemp < (oldMin - 5)) {
                        isAnomaly = true;
                        expectedBase = oldMin;
                        direction = 'cooler';
                    } else if (curTemp > (oldMax + 5)) {
                        isAnomaly = true;
                        expectedBase = oldMax;
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

                            const msg = alertsDict[lang].tempAnomaly
                                .replace('{temp}', fmtTemp(curTemp))
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
                    const oldPrecipArr = evening?.hourlyPrecip || [];

                    const oldByHour = {};
                    for (const o of oldPrecipArr) {
                        if (o.time && o.time.startsWith(todayStr)) {
                            const h = new Date(o.time).getHours();
                            oldByHour[h] = o.precip || 0;
                        }
                    }

                    const newByHour = {};
                    for (let i = 0; i < allTimes.length; i++) {
                        if (allTimes[i].startsWith(todayStr)) {
                            const h = new Date(allTimes[i]).getHours();
                            newByHour[h] = allPrecip[i] || 0;
                        }
                    }

                    const calcStats = (byHour) => {
                        let total = 0;
                        const hours = [];
                        for (let h = 0; h < 24; h++) {
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

                    const oldS = calcStats(oldByHour);
                    const newS = calcStats(newByHour);

                    if (oldPrecipArr.length === 0) {
                        const updatedHourly = [];
                        for (let i = 0; i < allTimes.length; i++) {
                            if (allTimes[i].startsWith(todayStr)) {
                                updatedHourly.push({ time: allTimes[i], precip: allPrecip[i] });
                            }
                        }
                        await City.findOneAndUpdate(
                            { externalId: key },
                            { $set: { "eveningState.hourlyPrecip": updatedHourly } }
                        );
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
                            let alertMsg = '';

                            if (fullyCanceled) {
                                alertMsg = `☀️ Чудові новини! Усі очікувані на сьогодні опади скасовано, дощу не передбачається.`;
                            } else if (significantAmountUp) {
                                alertMsg = `⚠️ Прогноз змінився: очікується більше опадів!\n` +
                                    `Було ~${oldS.total.toFixed(1)} мм → зараз ~${newS.total.toFixed(1)} мм.\n` +
                                    `Дощ: ${fmtBlocks(newS)}.`;
                            } else if (significantLonger) {
                                alertMsg = `🌤 Опади триватимуть довше, ніж очікувалось.\n` +
                                    `Було: ${fmtBlocks(oldS)}\nЗараз: ${fmtBlocks(newS)} (сумарно ${newS.total.toFixed(1)} мм).`;
                            } else if (significantShift) {
                                if (oldS.start == null) {
                                    alertMsg = `⚠️ З'явилися опади, яких не було в прогнозі!\n` +
                                        `Дощ: ${fmtBlocks(newS)} (сумарно ${newS.total.toFixed(1)} мм).`;
                                } else {
                                    alertMsg = `🌤 Час опадів змістився.\n` +
                                        `Було: ${fmtBlocks(oldS)}\nЗараз: ${fmtBlocks(newS)} (сумарно ${newS.total.toFixed(1)} мм).`;
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

                            const updatedHourly = [];
                            for (let i = 0; i < allTimes.length; i++) {
                                if (allTimes[i].startsWith(todayStr)) {
                                    updatedHourly.push({ time: allTimes[i], precip: allPrecip[i] });
                                }
                            }
                            await City.findOneAndUpdate(
                                { externalId: key },
                                { $set: { "eveningState.hourlyPrecip": updatedHourly } }
                            );
                        }
                    }
                } catch (omErr) {
                    console.error('Open-Meteo precip logic error in light check:', omErr.message);
                }

                // --- LOGIC E: Geomagnetic (same as main cron-check) ---
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
