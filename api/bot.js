const { Telegraf } = require('telegraf');
const axios = require('axios');
const mongoose = require('mongoose');
require('dotenv').config();

const User = require('../models/User');

const connectDB = require('../utils/db');

if (!process.env.TG_TOKEN) {
    console.error('CRITICAL ERROR: TG_TOKEN is missing in environment variables!');
}

const bot = new Telegraf(process.env.TG_TOKEN || 'dummy-token');

// Bot Logic (Webhook handler)
module.exports = async (req, res) => {
    try {
        if (!process.env.TG_TOKEN) {
            return res.status(500).send('TG_TOKEN is missing');
        }

        await connectDB();

        // Handle Webhook request
        if (req.method === 'POST') {
            console.log('--- Incoming Telegram Update ---');
            console.log(JSON.stringify(req.body, null, 2));
            await bot.handleUpdate(req.body);
            res.status(200).send('OK');
        } else {
            console.log('GET request received on bot API');
            res.status(200).send('Bot is running...');
        }
    } catch (e) {
        console.error('Handler Error:', e.message);
        console.error(e.stack);
        res.status(500).send(`Error: ${e.message}`);
    }
}

// /start command
bot.start(async (ctx) => {
    console.log('Start command from:', ctx.from.id);
    const welcome = `👋 Вітаю! Мене звати **Парасоль**.\n\nЯ буду моніторити погоду у твоєму місті та надсилатиму сповіщення про різкі зміни.\n\nНапиши назву свого міста (англійською або кирилицею):`;
    await ctx.replyWithMarkdown(welcome);
});

// Handle text messages (City search)
bot.on('text', async (ctx) => {
    const query = ctx.message.text.trim();
    if (query.startsWith('/')) return;

    try {
        console.log(`Searching for: ${query}`);
        // Using Nominatim for better search with multiple results
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1&accept-language=uk`;
        const response = await axios.get(nominatimUrl, {
            headers: { 'User-Agent': 'WeatherSentinelBot/1.0' }
        });

        if (response.data && response.data.length > 0) {
            const buttons = response.data.map(item => {
                const name = item.display_name.split(',').slice(0, 3).join(',');
                // Store coordinates and city name in callback data (limited to 64 chars)
                // We'll use a short format: lat|lon|city_name
                const callbackData = `set|${item.lat}|${item.lon}|${item.address.city || item.address.town || item.address.village || query.slice(0, 15)}`;
                return [{ text: name, callback_data: callbackData.slice(0, 64) }];
            });

            await ctx.reply('🔎 Оберіть правильний варіант з переліку:', {
                reply_markup: { inline_keyboard: buttons }
            });
        } else {
            await ctx.reply('❌ Не можу знайти таке місто. Спробуйте уточнити (наприклад, додайте область).');
        }
    } catch (error) {
        console.error('Search Error:', error.message);
        await ctx.reply('❌ Сталася помилка при пошуку. Спробуйте пізніше.');
    }
});

// Handle button clicks
bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data.split('|');
    if (data[0] === 'set') {
        const [_, lat, lon, cityName] = data;

        try {
            await connectDB();
            
            // Validate and get initial weather from Weatherbit using coordinates
            const weatherbitUrl = `https://api.weatherbit.io/v2.0/current?lat=${lat}&lon=${lon}&key=${process.env.WEATHERBIT_KEY}`;
            const weatherRes = await axios.get(weatherbitUrl);
            const weather = weatherRes.data.data[0];

            await User.findOneAndUpdate(
                { telegramId: ctx.from.id },
                {
                    username: ctx.from.username,
                    city: weather.city_name,
                    lat: parseFloat(lat),
                    lon: parseFloat(lon),
                    timezone: weather.timezone,
                    lastState: {
                        temp: weather.temp,
                        weatherCode: weather.weather.code,
                        updatedAt: new Date()
                    }
                },
                { upsert: true, new: true }
            );

            const domain = process.env.DOMAIN || 'localhost';
            const dashboardUrl = `${domain.startsWith('http') ? '' : 'https://'}${domain}/?user=${ctx.from.id}`;
            
            await ctx.answerCbQuery(`Місто ${weather.city_name} встановлено!`);
            await ctx.editMessageText(`✅ **Місто встановлено:** ${weather.city_name}\n🌐 Координати: ${lat}, ${lon}\n🌡️ Поточна температура: ${weather.temp}°C`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "📊 Мій Дашборд", url: dashboardUrl }]
                    ]
                }
            });
        } catch (error) {
            console.error('Save Error:', error.message);
            await ctx.reply('❌ Не вдалося зберегти вибір. Перевірте конфігурацію сервера.');
        }
    }
});
