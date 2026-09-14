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
const { sleep, escapeHTML } = require('../utils/helpers');

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
                tempAnomaly: "⚠️ **Аномальна температура!**\nЗараз: {temp}, що значно {dir} ніж очікувалось на цей час ({expected}°C).",
                forecastShift: "📊 **Прогноз на сьогодні змінився!**\nОчікували: {oldMin}..{oldMax}°C\nЗараз: {newMin}..{newMax}°C\nЗміна: ніч {minDelta}°C, день {maxDelta}°C",
                precip: "⛈️ **Попередження про опади!**\nЗараз: {desc}.",
                warmer: "вище",
                cooler: "нижче"
            },
            en: {
                tempAnomaly: "⚠️ **Temperature anomaly!**\nNow: {temp}, which is {dir} than expected for this time ({expected}°C).",
                forecastShift: "📊 **Today's forecast has changed!**\nExpected: {oldMin}..{oldMax}°C\nNow: {newMin}..{newMax}°C\nChange: night {minDelta}°C, day {maxDelta}°C",
                precip: "⛈️ **Precipitation alert!**\nNow: {desc}.",
                warmer: "warmer",
                cooler: "cooler"
            }
        };

        for (const [key, cityInfo] of Object.entries(uniqueCities)) {
            try {
                // 1. Fetch CURRENT weather and updated DAILY forecast
                const [currResp, foreResp] = await Promise.all([
                    axios.get(`https://api.weatherbit.io/v2.0/current?lat=${cityInfo.lat}&lon=${cityInfo.lon}&key=${API_KEY}`),
                    axios.get(`https://api.weatherbit.io/v2.0/forecast/daily?lat=${cityInfo.lat}&lon=${cityInfo.lon}&key=${API_KEY}&days=1`)
                ]);

                const current = currResp.data.data[0];
                const newDaily = foreResp.data.data[0];
                
                const cityDoc = await City.findOne({ externalId: key });
                const evening = cityDoc?.eveningState;

                const cityTimezone = current.timezone || cityDoc?.timezone || 'Europe/Kyiv';
                const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: cityTimezone }));
                const localHour = localNow.getHours();
                const todayStr = localNow.toISOString().slice(0, 10);

                // Find the snapshot of today's forecast from last evening
                const eveningToday = evening?.forecast?.find(d => 
                    (d.valid_date || d.datetime || '').startsWith(todayStr)
                );

                const alerts = [];
                let alertTriggered = false;
                let reasons = [];

                if (eveningToday) {
                    const oldMin = eveningToday.min_temp;
                    const oldMax = eveningToday.max_temp;
                    const newMin = newDaily.min_temp;
                    const newMax = newDaily.max_temp;

                    // --- LOGIC A: Forecast Shift (e.g. 25°C -> 32°C) ---
                    const maxShift = newMax - oldMax;
                    const minShift = newMin - oldMin;

                    if (Math.abs(maxShift) >= 4 || Math.abs(minShift) >= 4) {
                        reasons.push("зміна прогнозу");
                        const fmtDelta = (d) => d > 0 ? `+${d.toFixed(1)}` : d.toFixed(1);
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
                            
                            const msg = alertsDict[lang].tempAnomaly
                                .replace('{temp}', fmtTemp(curTemp))
                                .replace('{expected}', fmtTemp(expectedBase))
                                .replace('{delta}', Math.abs(curTemp - expectedBase).toFixed(1))
                                .replace('{dir}', alertsDict[lang][direction]);
                            alerts.push({ userId: user.telegramId, text: msg, lang });
                        }
                        alertTriggered = true;
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
                        const msg = alertsDict[lang].precip.replace('{desc}', getWeatherDesc(newCode, lang));
                        alerts.push({ userId: user.telegramId, text: msg, lang });
                    }
                    alertTriggered = true;
                }

                // --- LOGIC D: Smart Hourly Precipitation Check (Open-Meteo) ---
                try {
                    const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${cityInfo.lat}&longitude=${cityInfo.lon}&hourly=precipitation&timezone=auto&forecast_days=1`;
                    const omRes = await axios.get(omUrl);
                    if (omRes.data && omRes.data.hourly) {
                        const allTimes = omRes.data.hourly.time;
                        const allPrecip = omRes.data.hourly.precipitation;
                        
                        const oldPrecip = evening?.hourlyPrecip || [];
                        let hasAdded = false;
                        let hasCanceled = false;
                        let newRemainingRain = 0;
                        const rainHours = [];
                        
                        let currentHourIso = new Date(localNow);
                        currentHourIso.setMinutes(0, 0, 0); 
                        
                        for (let i = 0; i < allTimes.length; i++) {
                            const timeStr = allTimes[i];
                            const hourDate = new Date(timeStr);
                            
                            if (hourDate >= currentHourIso && timeStr.startsWith(todayStr)) {
                                const newP = allPrecip[i];
                                const oldObj = oldPrecip.find(o => o.time === timeStr);
                                const oldP = oldObj ? oldObj.precip : 0;
                                
                                if (newP >= 0.5 && oldP < 0.5) hasAdded = true;
                                if (newP < 0.5 && oldP >= 0.5) hasCanceled = true;
                                
                                if (newP >= 0.5) {
                                    newRemainingRain += newP;
                                    rainHours.push(hourDate.getHours());
                                }
                            }
                        }

                        if (hasAdded || hasCanceled) {
                            let alertMsg = '';
                            
                            if (newRemainingRain === 0) {
                                alertMsg = `☀️ Чудові новини! Усі очікувані на сьогодні опади скасовано, дощу не передбачається.`;
                            } else {
                                const minH = Math.min(...rainHours);
                                const maxH = Math.max(...rainHours) + 1;
                                const hoursStr = minH === (maxH - 1) ? `о ${minH}:00` : `з ${minH}:00 до ${maxH}:00`;
                                
                                if (hasAdded) {
                                    alertMsg = `⚠️ Прогноз змінився: з'явилися нові опади!\nЗагалом сьогодні дощитиме ${hoursStr} (сумарно ${newRemainingRain.toFixed(1)} мм).`;
                                } else if (hasCanceled) {
                                    alertMsg = `🌤 Зміни у прогнозі: частину очікуваних опадів скасовано.\nАле обережно, дощ все ще очікується ${hoursStr} (сумарно ${newRemainingRain.toFixed(1)} мм).`;
                                }
                            }
                            
                            reasons.push("зміна опадів");
                            for (const user of cityInfo.users) {
                                if (!user.notificationsEnabled || user.alertTriggers?.precip === false) continue;
                                const lang = user.language || 'uk';
                                alerts.push({ userId: user.telegramId, text: alertMsg, lang });
                            }
                            alertTriggered = true;
                            
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
                    console.error('Open-Meteo fetch error in check:', omErr.message);
                }

                // --- LOGIC E: Check for Real-time Geomagnetic Activity (Magnetic Storms) ---
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
                        
                        if (currentMaxKp !== null && currentMaxKp >= 4) {
                            const lastAlertDate = cityDoc?.lastGeomagAlert?.date;
                            const lastAlertKp = cityDoc?.lastGeomagAlert?.maxKp || 0;

                            // Send alert if no alert sent today or if Kp escalated to a higher level
                            if (lastAlertDate !== todayStr || currentMaxKp > lastAlertKp) {
                                const isStorm = currentMaxKp >= 5;

                                reasons.push(isStorm ? "магнітна буря" : "збурення магн. поля");
                                for (const user of cityInfo.users) {
                                    if (!user.notificationsEnabled || user.alertTriggers?.magneticStorm === false) continue;
                                    const lang = user.language || 'uk';
                                    const isUk = lang === 'uk';
                                    const ukMsg = isStorm
                                        ? `🧲 **Увага! Магнітна буря (Kp ${currentMaxKp.toFixed(0)})!**\nФіксується активне збурення геомагнітного поля. Метеозалежним людям варто зменшити навантаження, пити більше води та тримати під рукою ліки.`
                                        : `🧲 **Увага! Спостерігається збурення магнітного поля (Kp ${currentMaxKp.toFixed(0)})!**\nМожливе незначне погіршення самопочуття у метеочутливих людей.`;
                                    const enMsg = isStorm
                                        ? `🧲 **Alert! Magnetic Storm (Kp ${currentMaxKp.toFixed(0)})!**\nActive geomagnetic field disturbance detected. Weather-sensitive people should reduce physical activity and drink plenty of water.`
                                        : `🧲 **Alert! Unsettled geomagnetic field (Kp ${currentMaxKp.toFixed(0)})!**\nMild discomfort possible for weather-sensitive individuals.`;
                                    
                                    alerts.push({ userId: user.telegramId, text: isUk ? ukMsg : enMsg, lang });
                                }
                                alertTriggered = true;

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

                // --- LOGIC F: Real-time AQI Deterioration Check ---
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

                            const lastAqiDate = cityDoc?.lastAqiAlert?.date;
                            const lastAqiTier = cityDoc?.lastAqiAlert?.tier ?? 0;

                            // Alert if air quality has deteriorated to a higher tier or if AQI > 100 on a new day
                            if (currentTier > 0 && (lastAqiDate !== todayStr || currentTier > lastAqiTier)) {
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

                                await City.findOneAndUpdate(
                                    { externalId: key },
                                    { $set: { "lastAqiAlert": { date: todayStr, tier: currentTier, aqi: aqiVal } } }
                                );
                            }
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
