const axios = require('axios');
const mongoose = require('mongoose');
const { Telegraf } = require('telegraf');
const User = require('../models/User');

const bot = new Telegraf(process.env.TG_TOKEN);
const API_KEY = process.env.WEATHERBIT_KEY;

const connectDB = require('../utils/db');

module.exports = async (req, res) => {
    // Basic auth/token check for Vercel Cron
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).send('Unauthorized');

    try {
        await connectDB();
        const users = await User.find({ notificationsEnabled: true });

        for (const user of users) {
            try {
                const response = await axios.get(`https://api.weatherbit.io/v2.0/forecast/daily?city=${encodeURIComponent(user.city)}&key=${API_KEY}&days=4&lang=uk`);
                const forecastData = response.data.data.slice(1, 4); // index 1, 2, 3 (завтра, післязавтра, і ще один день)

                let message = `🌆 **Прогноз на 3 дні для ${user.city}**\n\n`;

                const translateWeather = (code, defaultText) => {
                    const map = {
                        200: 'Гроза', 201: 'Гроза з дощем', 202: 'Сильна гроза', 233: 'Гроза',
                        300: 'Мряка', 301: 'Мряка', 302: 'Сильна мряка',
                        500: 'Невеликий дощ', 501: 'Помірний дощ', 502: 'Сильний дощ',
                        520: 'Слабкий дощ', 521: 'Злива', 522: 'Сильна злива',
                        600: 'Невеликий сніг', 601: 'Сніг', 602: 'Сильний снігопад', 610: 'Сніг з дощем',
                        700: 'Димка', 741: 'Туман', 751: 'Мла',
                        800: 'Ясно', 801: 'Легка хмарність', 802: 'Мінлива хмарність', 803: 'Хмарно', 804: 'Пасмурно'
                    };
                    return map[code] || defaultText;
                };

                forecastData.forEach(day => {
                    const dateObj = new Date(day.valid_date || day.datetime);
                    // Короткий день тижня та дата
                    const dayStr = dateObj.toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'short' });
                    const capDay = dayStr.charAt(0).toUpperCase() + dayStr.slice(1);

                    const desc = translateWeather(day.weather.code, day.weather.description);

                    message += `📅 **${capDay}**\n` +
                        `☁️ ${desc}\n` +
                        `🌡 **Темп:** ${Math.round(day.min_temp)}°C ... ${Math.round(day.max_temp)}°C\n` +
                        `💧 **Вірог. опадів:** ${day.pop}% (${day.precip.toFixed(1)} мм)\n` +
                        `💨 **Вітер:** ${Math.round(day.wind_spd)} м/с (до ${Math.round(day.wind_gust_spd)} м/с)\n` +
                        `🧭 **Тиск:** ${Math.round(day.pres)} мб\n\n`;
                });

                await bot.telegram.sendMessage(user.telegramId, message, { 
                    parse_mode: 'Markdown', 
                    disable_web_page_preview: true,
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "🔗 Детальний прогноз", url: `https://parasol-sentinel.vercel.app/?user=${user.telegramId}` }
                        ]]
                    }
                });

            } catch (err) {
                console.error(`Error processing forecast for user ${user.telegramId}:`, err.message);
            }
        }
        res.status(200).send(`Sent ${users.length} forecasts`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Cron Forecast Error');
    }
}
