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

        // --- FETCH WEATHER ONCE PER UNIQUE CITY COORDINATES ---
        const uniqueCities = {};
        for (const user of users) {
             if (!user.lat || !user.lon) continue;
             const key = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
             if (!uniqueCities[key]) uniqueCities[key] = { lat: user.lat, lon: user.lon, name: user.city, users: [] };
             uniqueCities[key].users.push(user);
        }

        let sent = 0;
        let errors = 0;
        const logLines = [];

        const fDict = {
            uk: {
                title: "🌆 **Прогноз на 3 дні для {city}**",
                temp: "🌡 **Темп:**",
                precip: "💧 **Вірог. опадів:**",
                wind: "💨 **Вітер:**",
                press: "🧭 **Тиск:**",
                details: "🔗 Детальний прогноз",
                unitMs: "м/с",
                unitKmh: "км/год",
                unitMmhg: "мм рт.ст.",
                unitHpa: "гПа",
                loc: 'uk-UA'
            },
            en: {
                title: "🌆 **3-day forecast for {city}**",
                temp: "🌡 **Temp:**",
                precip: "💧 **Precip:**",
                wind: "💨 **Wind:**",
                press: "🧭 **Pressure:**",
                details: "🔗 Detailed forecast",
                unitMs: "m/s",
                unitKmh: "km/h",
                unitMmhg: "mmHg",
                unitHpa: "hPa",
                loc: 'en-US'
            }
        };

        const formatTemp = (c, unit) => {
            if (unit === 'f') return `${Math.round(c * 9/5 + 32)}°F`;
            return `${Math.round(c)}°C`;
        };

        const formatWind = (ms, unit, lang) => {
            if (unit === 'kmh') return `${Math.round(ms * 3.6)} ${fDict[lang].unitKmh}`;
            return `${Math.round(ms)} ${fDict[lang].unitMs}`;
        };

        const formatPress = (mb, unit, lang) => {
            if (unit === 'mmhg') return `${Math.round(mb * 0.75006)} ${fDict[lang].unitMmhg}`;
            return `${Math.round(mb)} ${fDict[lang].unitHpa}`;
        };

        for (const [key, cityInfo] of Object.entries(uniqueCities)) {
            try {
                // Fetch forecast data once for this unique location
                const response = await axios.get(`https://api.weatherbit.io/v2.0/forecast/daily?lat=${cityInfo.lat}&lon=${cityInfo.lon}&key=${API_KEY}&days=4`);
                const fullResponse = response.data.data;
                const forecastData = fullResponse.slice(1, 4); // tom, day after tom, +1

                // --- SAVE EVENING SNAPSHOT to City collection for the morning check ---
                await City.findOneAndUpdate(
                    { externalId: key },
                    {
                        eveningState: {
                            temp: fullResponse[0].temp,
                            weatherCode: fullResponse[0].weather.code,
                            updatedAt: new Date(),
                            forecast: fullResponse // full 4 days for reference
                        }
                    },
                    { upsert: true }
                );

                for (const user of cityInfo.users) {
                    await sleep(40);
                    const lang = user.language || 'uk';
                    const tempUnit = user.units?.temp || 'c';

                    let message = `${fDict[lang].title.replace('{city}', user.city)}\n\n`;

                    forecastData.forEach(day => {
                        const dateObj = new Date(day.valid_date || day.datetime);
                        const dayStr = dateObj.toLocaleDateString(fDict[lang].loc, { weekday: 'short', day: 'numeric', month: 'short' });
                        const capDay = dayStr.charAt(0).toUpperCase() + dayStr.slice(1);
                        const desc = getWeatherDesc(day.weather.code, lang);

                        message += `📅 **${capDay}**\n` +
                            `☁️ ${desc}\n` +
                            `${fDict[lang].temp} ${formatTemp(day.min_temp, tempUnit)} ... ${formatTemp(day.max_temp, tempUnit)}\n` +
                            `${fDict[lang].precip} ${day.pop}% (${day.precip.toFixed(1)} мм)\n` +
                            `${fDict[lang].wind} ${formatWind(day.wind_spd, user.units?.wind || 'ms', lang)}\n` +
                            `${fDict[lang].press} ${formatPress(day.pres, user.units?.pressure || 'mmhg', lang)}\n\n`;
                    });

                    const sig = generateSignature(user.telegramId, process.env.CRON_SECRET);
                    await bot.telegram.sendMessage(user.telegramId, message, {
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true,
                        reply_markup: {
                            inline_keyboard: [[
                                { text: fDict[lang].details, url: formatUrl(process.env.DOMAIN, `/?user=${user.telegramId}&sig=${sig}`) }
                            ]]
                        }
                    });
                    sent++;
                }
                logLines.push(`• ${cityInfo.name} | ${cityInfo.users.length} ос. | ✅`);
            } catch (err) {
                errors++;
                logLines.push(`• ${cityInfo.name} | ❌ error: ${err.message}`);
                console.error(`Forecast error for ${cityInfo.name}:`, err.message);
            }
        }

        const summary = [`<b>Вечірній прогноз</b> — ${startTime}`, `👥 Користувачів: ${users.length}`, `📨 Надіслано: ${sent}`, `❌ Помилок: ${errors}`, ``, ...logLines].join('\n');
        await log(summary);
        res.status(200).send(`Sent ${sent} forecasts`);
    } catch (error) {
        console.error(error);
        await log(`❌ <b>Cron Forecast FAILED</b> — ${startTime}\n<code>${escapeHTML(error.message)}</code>`);
        res.status(500).send('Cron Forecast Error');
    }
}


