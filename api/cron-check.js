require('dotenv').config();
const axios = require('axios');
const getBot = require('../utils/bot');
const bot = getBot();
const logToTelegram = require('../utils/logger');
const User = require('../models/User');
const connectDB = require('../utils/db');
const { getWeatherDesc } = require('../utils/weather');
const { sleep, formatUrl, generateSignature, escapeHTML } = require('../utils/helpers');

const API_KEY = process.env.WEATHERBIT_KEY;
// Main Handler
module.exports = async (req, res) => {
    const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
    
    // Wrapper for the shared logger
    const log = (text) => logToTelegram(bot, LOG_CHAT_ID, text);
    // Basic auth/token check
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).send('Unauthorized');

    const startTime = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

    try {
        await connectDB();
        const users = await User.find({ notificationsEnabled: true });

        let alertsSent = 0;
        let errors = 0;
        const userLines = [];

        const alertsDict = {
            uk: {
                temp: "⚠️ **Увага! Погода різко змінилася!**\nТемпература стрибнула на {delta}°C і зараз становить {temp}°C.",
                precip: "⛈️ **Попередження про опади!**\nСхоже, погода у місті {city} погіршується. Зараз: {desc}.",
                details: "🔗 Детальний прогноз"
            },
            en: {
                temp: "⚠️ **Attention! Weather change alert!**\nTemperature jumped by {delta}°C and is now {temp}°C.",
                precip: "⛈️ **Precipitation alert!**\nWeather in {city} seems to be getting worse. Now: {desc}.",
                details: "🔗 Detailed forecast"
            }
        };

        for (const user of users) {
             try {
                // Throttling for Telegram limits
                await sleep(40);
                const lang = user.language || 'uk';

                const response = await axios.get(`https://api.weatherbit.io/v2.0/current?lat=${user.lat}&lon=${user.lon}&key=${API_KEY}&lang=${lang}`);
                const current = response.data.data[0];

                const oldTemp = user.lastState?.temp || current.temp;
                const newTemp = current.temp;
                const deltaT = Math.abs(newTemp - oldTemp);
                const oldCode = user.lastState?.weatherCode || 800;
                const newCode = current.weather.code;

                let alerts = [];

                // Condition 1: Sharp temperature change (>= 5°C)
                if (deltaT >= 5) {
                    alerts.push(alertsDict[lang].temp
                        .replace('{delta}', deltaT.toFixed(1))
                        .replace('{temp}', newTemp));
                }

                // Condition 2: From Clear/Clouds to Rain/Snow/Storm
                if (oldCode >= 800 && newCode < 700) {
                    alerts.push(alertsDict[lang].precip
                        .replace('{city}', user.city)
                        .replace('{desc}', current.weather.description));
                }

                if (alerts.length > 0) {
                    const alertMessage = alerts.join('\n\n');
                    await bot.telegram.sendMessage(user.telegramId, alertMessage, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: alertsDict[lang].details, url: formatUrl(process.env.DOMAIN, `/?user=${user.telegramId}&sig=${generateSignature(user.telegramId, process.env.CRON_SECRET)}`) }
                            ]]
                        }
                    });
                    alertsSent++;
                }

                // Collect per-user info for the log
                const alertIcon = alerts.length > 0 ? '🚨 сповіщення надіслано' : '✅ без змін';
                const desc = getWeatherDesc(newCode, 'uk'); // Keep admin logs in Ukrainian
                userLines.push(`• ${user.city} | ${newTemp}°C (Δ${deltaT.toFixed(1)}°C) | ${desc} | ${alertIcon}`);

                // Update state in DB
                user.lastState = {
                    temp: newTemp,
                    weatherCode: newCode,
                    updatedAt: new Date()
                };
                await user.save();

            } catch (err) {
                errors++;
                userLines.push(`• ${user.city} | ❌ error: ${escapeHTML(err.message)}`);
                console.error(`Error processing user ${user.telegramId}:`, err.message);
            }
        }

        // Send summary log to private channel
        const summary = [
            `📋 <b>Перевірка погоди</b> — ${startTime}`,
            `👥 Користувачів перевірено: ${users.length}`,
            `🚨 Сповіщень надіслано: ${alertsSent}`,
            `❌ Помилок: ${errors}`,
            ``,
            ...userLines
        ].join('\n');

        await log(summary);

        res.status(200).send(`Processed ${users.length} users`);
    } catch (error) {
        console.error(error);
        await log(`❌ <b>Перевірка погоди ПРОВАЛИЛАСЬ</b> — ${startTime}\n<code>${escapeHTML(error.message)}</code>`);
        res.status(500).send('Cron Check Error');
    }
}
