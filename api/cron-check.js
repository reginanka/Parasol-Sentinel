require('dotenv').config();
const axios = require('axios');
const getBot = require('../utils/bot');
const bot = getBot();
const logToTelegram = require('../utils/logger');
const User = require('../models/User');
const City = require('../models/City');
const connectDB = require('../utils/db');
const { getWeatherDesc } = require('../utils/weather');
const { sleep, formatUrl, generateSignature, escapeHTML } = require('../utils/helpers');

const API_KEY = process.env.WEATHERBIT_KEY;

module.exports = async (req, res) => {
    const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
    const log = (text) => logToTelegram(bot, LOG_CHAT_ID, text);
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).send('Unauthorized');

    const startTime = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

    try {
        await connectDB();
        const users = await User.find({ notificationsEnabled: true });

        // --- GROUP USERS BY UNIQUE CITY ---
        const uniqueCities = {};
        for (const user of users) {
             if (!user.lat || !user.lon) continue;
             const key = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
             if (!uniqueCities[key]) uniqueCities[key] = { lat: user.lat, lon: user.lon, name: user.city, users: [] };
             uniqueCities[key].users.push(user);
        }

        let alertsTotal = 0;
        let errors = 0;
        const logLines = [];

        const alertsDict = {
            uk: {
                temp: "⚠️ **Увага! Погода змінилася порівняно з вечором!**\nТемпература зараз: {temp}, що на {delta}°C {dir} ніж очікувалось.",
                precip: "⛈️ **Попередження про опади!**\nПогода у місті {city} погіршилась. Зараз: {desc}.",
                details: "🔗 Детальний прогноз",
                warmer: "вище",
                cooler: "нижче"
            },
            en: {
                temp: "⚠️ **Attention! Weather changed since evening!**\nTemp is now {temp}, which is {delta}°C {dir} than expected.",
                precip: "⛈️ **Precipitation alert!**\nWeather in {city} has worsened. Now: {desc}.",
                details: "🔗 Detailed forecast",
                warmer: "warmer",
                cooler: "cooler"
            }
        };

        const formatTemp = (c, unit) => {
            if (unit === 'f') return `${Math.round(c * 9/5 + 32)}°F`;
            return `${Math.round(c)}°C`;
        };

        for (const [key, cityInfo] of Object.entries(uniqueCities)) {
            try {
                // 1. Fetch CURRENT weather
                const response = await axios.get(`https://api.weatherbit.io/v2.0/current?lat=${cityInfo.lat}&lon=${cityInfo.lon}&key=${API_KEY}`);
                const current = response.data.data[0];
                const newTemp = current.temp;
                const newCode = current.weather.code;

                // 2. Load EVENING state for comparison
                const cityDoc = await City.findOne({ externalId: key });
                const evening = cityDoc?.eveningState;

                let cityAlertsTriggered = false;
                const oldTemp = evening?.temp ?? newTemp;
                const oldCode = evening?.weatherCode ?? 800;
                const deltaT = newTemp - oldTemp;
                const absDelta = Math.abs(deltaT);

                // --- Conditions for Alert ---
                const isTempJump = absDelta >= 5;
                const isPrecipStart = (oldCode >= 800 && newCode < 700);

                if (isTempJump || isPrecipStart) {
                    cityAlertsTriggered = true;
                    for (const user of cityInfo.users) {
                        await sleep(40);
                        const lang = user.language || 'uk';
                        const tempUnit = user.units?.temp || 'c';
                        let alerts = [];

                        if (isTempJump) {
                            const dir = deltaT > 0 ? alertsDict[lang].warmer : alertsDict[lang].cooler;
                            alerts.push(alertsDict[lang].temp
                                .replace('{temp}', formatTemp(newTemp, tempUnit))
                                .replace('{delta}', absDelta.toFixed(1))
                                .replace('{dir}', dir));
                        }
                        if (isPrecipStart) {
                            alerts.push(alertsDict[lang].precip
                                .replace('{city}', user.city)
                                .replace('{desc}', current.weather.description));
                        }

                        const sig = generateSignature(user.telegramId, process.env.CRON_SECRET);
                        await bot.telegram.sendMessage(user.telegramId, alerts.join('\n\n'), {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: alertsDict[lang].details, url: formatUrl(process.env.DOMAIN, `/?user=${user.telegramId}&sig=${sig}`) }
                                ]]
                            }
                        });
                        alertsTotal++;
                    }
                }

                // Log entry for admin
                const desc = getWeatherDesc(newCode, 'uk');
                const statusText = cityAlertsTriggered ? '🚨 Стрімка зміна' : '✅ без змін';
                logLines.push(`• ${cityInfo.name} | ${newTemp}°C (Δ${deltaT.toFixed(1)}) | ${desc} | ${statusText}`);

                // Update lastState for site display consistency
                for (const user of cityInfo.users) {
                    user.lastState = { ...user.lastState, temp: newTemp, weatherCode: newCode, updatedAt: new Date() };
                    await user.save();
                }

            } catch (err) {
                errors++;
                logLines.push(`• ${cityInfo.name} | ❌ помилка: ${err.message}`);
            }
        }

        const summary = [
            `📋 <b>Перевірка погоди</b> — ${startTime}`,
            `👥 Користувачів перевірено: ${users.length}`,
            `🚨 Сповіщень надіслано: ${alertsTotal}`,
            `❌ Помилок: ${errors}`,
            ``,
            ...logLines
        ].join('\n');
        await log(summary);
        res.status(200).send(`Processed ${users.length} users`);
    } catch (error) {
        console.error(error);
        await log(`❌ <b>Weather Check FAILED</b>\n<code>${escapeHTML(error.message)}</code>`);
        res.status(500).send('Cron Check Error');
    }
}
