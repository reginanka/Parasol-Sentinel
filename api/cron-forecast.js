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

        let sent = 0;
        let errors = 0;
        const userLines = [];

        const fDict = {
            uk: {
                title: "🌆 **Прогноз на 3 дні для {city}**",
                temp: "🌡 **Темп:**",
                precip: "💧 **Вірог. опадів:**",
                wind: "💨 **Вітер:**",
                press: "🧭 **Тиск:**",
                details: "🔗 Детальний прогноз",
                loc: 'uk-UA'
            },
            en: {
                title: "🌆 **3-day forecast for {city}**",
                temp: "🌡 **Temp:**",
                precip: "💧 **Precip:**",
                wind: "💨 **Wind:**",
                press: "🧭 **Pressure:**",
                details: "🔗 Detailed forecast",
                loc: 'en-US'
            }
        };

        for (const user of users) {
            try {
                // Throttling: respect Telegram limits (~30 msg/sec). 
                await sleep(40);
                const lang = user.language || 'uk';

                const response = await axios.get(`https://api.weatherbit.io/v2.0/forecast/daily?lat=${user.lat}&lon=${user.lon}&key=${API_KEY}&days=4&lang=${lang}`);
                const forecastData = response.data.data.slice(1, 4); // tomorrow, day after, +1 more

                let message = `${fDict[lang].title.replace('{city}', user.city)}\n\n`;

                forecastData.forEach(day => {
                    const dateObj = new Date(day.valid_date || day.datetime);
                    const dayStr = dateObj.toLocaleDateString(fDict[lang].loc, { weekday: 'short', day: 'numeric', month: 'short' });
                    const capDay = dayStr.charAt(0).toUpperCase() + dayStr.slice(1);
                    const desc = getWeatherDesc(day.weather.code, lang);

                    message += `📅 **${capDay}**\n` +
                        `☁️ ${desc}\n` +
                        `${fDict[lang].temp} ${Math.round(day.min_temp)}°C ... ${Math.round(day.max_temp)}°C\n` +
                        `${fDict[lang].precip} ${day.pop}% (${day.precip.toFixed(1)} мм)\n` +
                        `${fDict[lang].wind} ${Math.round(day.wind_spd)} м/с (до ${Math.round(day.wind_gust_spd)} м/с)\n` +
                        `${fDict[lang].press} ${Math.round(day.pres)} мб\n\n`;
                });

                await bot.telegram.sendMessage(user.telegramId, message, {
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true,
                    reply_markup: {
                        inline_keyboard: [[
                            { text: fDict[lang].details, url: formatUrl(process.env.DOMAIN, `/?user=${user.telegramId}&sig=${generateSignature(user.telegramId, process.env.CRON_SECRET)}`) }
                        ]]
                    }
                });

                sent++;
                userLines.push(`• ${user.city} | ✅ надіслано`);

            } catch (err) {
                errors++;
                userLines.push(`• ${user.city} | ❌ помилка: ${escapeHTML(err.message)}`);
                console.error(`Error processing forecast for user ${user.telegramId}:`, err.message);
            }
        }

        // Send summary log to private channel
        const summary = [
            `📋 <b>Вечірній прогноз</b> — ${startTime}`,
            `👥 Користувачів перевірено: ${users.length}`,
            `📨 Прогнозів надіслано: ${sent}`,
            `❌ Помилок: ${errors}`,
            ``,
            ...userLines
        ].join('\n');

        await log(summary);

        res.status(200).send(`Sent ${users.length} forecasts`);
    } catch (error) {
        console.error(error);
        await log(`❌ <b>Cron Forecast FAILED</b> — ${startTime}\n<code>${escapeHTML(error.message)}</code>`);
        res.status(500).send('Cron Forecast Error');
    }
}


