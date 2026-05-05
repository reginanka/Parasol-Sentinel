require('dotenv').config();
const axios = require('axios');
const getBot = require('../utils/bot');
const bot = getBot();
const logToTelegram = require('../utils/logger');
const User = require('../models/User');
const City = require('../models/City');
const connectDB = require('../utils/db');
const { getWeatherDesc } = require('../utils/weather');
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
                forecastShift: "📊 **Прогноз на сьогодні змінився!**\nОчікували: {oldMin}..{oldMax}°C\nЗараз прогнозують: {newMin}..{newMax}°C\nРізниця піку: {delta}°C.",
                precip: "⛈️ **Попередження про опади!**\nЗараз: {desc}.",
                warmer: "вище",
                cooler: "нижче"
            },
            en: {
                tempAnomaly: "⚠️ **Temperature anomaly!**\nNow: {temp}, which is {dir} than expected for this time ({expected}°C).",
                forecastShift: "📊 **Today's forecast has changed!**\nExpected: {oldMin}..{oldMax}°C\nNow predicting: {newMin}..{newMax}°C\nPeak difference: {delta}°C.",
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
                        for (const user of cityInfo.users) {
                            const lang = user.language || 'uk';
                            const msg = alertsDict[lang].forecastShift
                                .replace('{oldMin}', oldMin).replace('{oldMax}', oldMax)
                                .replace('{newMin}', newMin).replace('{newMax}', newMax)
                                .replace('{delta}', maxShift > 0 ? `+${maxShift.toFixed(1)}` : maxShift.toFixed(1));
                            alerts.push({ userId: user.telegramId, text: msg });
                        }
                        alertTriggered = true;
                    }

                    // --- LOGIC B: Current Temp Anomaly vs "Safe Zone" ---
                    const curTemp = current.temp;
                    let isAnomaly = false;
                    let expectedBase = 0;
                    let direction = '';

                    if (localHour < 12) {
                        // Morning: check if it's much colder than expected min, or already past max
                        if (curTemp < (oldMin - 4)) {
                            isAnomaly = true;
                            expectedBase = oldMin;
                            direction = 'cooler';
                        } else if (curTemp > (oldMax + 2)) {
                            isAnomaly = true;
                            expectedBase = oldMax;
                            direction = 'warmer';
                        }
                        // Note: if temp is between min and max, it's just normal morning warming.
                    } else {
                        // Day/Evening: check if it's much hotter than expected max, or dropped below min
                        if (curTemp > (oldMax + 4)) {
                            isAnomaly = true;
                            expectedBase = oldMax;
                            direction = 'warmer';
                        } else if (curTemp < (oldMin - 2)) {
                            isAnomaly = true;
                            expectedBase = oldMin;
                            direction = 'cooler';
                        }
                    }

                    if (isAnomaly) {
                        reasons.push("аномалія темп.");
                        for (const user of cityInfo.users) {
                            const lang = user.language || 'uk';
                            const unit = user.units?.temp || 'c';
                            const fmtTemp = (c) => unit === 'f' ? `${Math.round(c * 9/5 + 32)}°F` : `${Math.round(c)}°C`;
                            
                            const msg = alertsDict[lang].tempAnomaly
                                .replace('{temp}', fmtTemp(curTemp))
                                .replace('{expected}', fmtTemp(expectedBase))
                                .replace('{delta}', Math.abs(curTemp - expectedBase).toFixed(1))
                                .replace('{dir}', alertsDict[lang][direction]);
                            alerts.push({ userId: user.telegramId, text: msg });
                        }
                        alertTriggered = true;
                    }
                }

                // --- LOGIC C: Precipitation Start ---
                const oldCode = evening?.weatherCode ?? 800;
                const newCode = current.weather.code;
                if (oldCode >= 800 && newCode < 700) {
                    reasons.push("початок опадів");
                    for (const user of cityInfo.users) {
                        const lang = user.language || 'uk';
                        const msg = alertsDict[lang].precip.replace('{desc}', getWeatherDesc(newCode, lang));
                        alerts.push({ userId: user.telegramId, text: msg });
                    }
                    alertTriggered = true;
                }

                // --- SENDING ALERTS ---
                const uniqueAlerts = {}; // prevent duplicate messages to same user
                for (const a of alerts) {
                    if (!uniqueAlerts[a.userId]) uniqueAlerts[a.userId] = [];
                    uniqueAlerts[a.userId].push(a.text);
                }

                for (const userId of Object.keys(uniqueAlerts)) {
                    await sleep(50);
                    await bot.telegram.sendMessage(userId, uniqueAlerts[userId].join('\n\n'), { parse_mode: 'Markdown' });
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
                logLines.push(`• ${cityInfo.name} | ${current.temp}°C | ${weatherDesc} | ${statusStr}`);

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
