const getBot = require('../utils/bot');
const bot = getBot();
const axios = require('axios');
require('dotenv').config();

const User = require('../models/User');
const connectDB = require('../utils/db');
const { formatUrl, generateSignature } = require('../utils/helpers');

/**
 * Parasol Sentinel Bot - Core logic handler.
 * Design Choice: Using a hybrid approach (Serverless Webhook + Polling for Local Dev).
 */

const dict = {
    uk: {
        welcome: "👋 Вітаю! Мене звати **Парасоль**.\n\nЯ буду моніторити погоду у твоєму місті та надсилатиму сповіщення про різкі зміни.\n\nНапиши назву свого міста (англійською або кирилицею):",
        select: "🔎 Оберіть правильний варіант з переліку:",
        notFound: "❌ Не можу знайти таке місто. Спробуйте уточнити (наприклад, додайте область).",
        errorSearch: "❌ Сталася помилка при пошуку. Спробуйте пізніше.",
        citySet: "Місто {city} встановлено!",
        citySetFull: "✅ **Місто встановлено:** {city}\n🌐 Координати: {lat}, {lon}\n🌡️ Поточна температура: {temp}°C",
        dashboard: "📊 Мій Дашборд",
        settingsBtn: "⚙️ Налаштування",
        saveError: "❌ Не вдалося зберегти вибір. Перевірте конфігурацію сервера.",
        settings: "⚙️ *Налаштування*",
        settingsWind: "🌬 Вітер:",
        settingsPress: "🌡 Тиск:",
        settingsCity: "📍 Змінити місто",
        settingsSaved: "✅ Налаштування збережено!",
        unitMs: "м/с",
        unitKmh: "км/год",
        unitMmhg: "мм рт.ст.",
        unitHpa: "гПа"
    },
    en: {
        welcome: "👋 Hello! My name is **Parasol**.\n\nI will monitor the weather in your city and send alerts about sudden changes.\n\nPlease type the name of your city:",
        select: "🔎 Choose the correct option from the list:",
        notFound: "❌ Cannot find this city. Please try to be more specific (e.g. add region/state).",
        errorSearch: "❌ Search error occurred. Please try again later.",
        citySet: "City {city} is set!",
        citySetFull: "✅ **City set:** {city}\n🌐 Coordinates: {lat}, {lon}\n🌡️ Current temperature: {temp}°C",
        dashboard: "📊 My Dashboard",
        settingsBtn: "⚙️ Settings",
        saveError: "❌ Failed to save. Please check server configuration.",
        settings: "⚙️ *Settings*",
        settingsWind: "🌬 Wind:",
        settingsPress: "🌡 Pressure:",
        settingsCity: "📍 Change city",
        settingsSaved: "✅ Settings saved!",
        unitMs: "m/s",
        unitKmh: "km/h",
        unitMmhg: "mmHg",
        unitHpa: "hPa"
    }
};

// Build settings keyboard based on current user preferences
function buildSettingsKeyboard(lang, units = {}) {
    const d = dict[lang];
    const wind = units.wind || 'ms';
    const pressure = units.pressure || 'mmhg';
    return {
        inline_keyboard: [
            [
                { text: `${d.settingsWind} ${wind === 'ms' ? '✅' : ''} ${d.unitMs}`, callback_data: 'unit|wind|ms' },
                { text: `${wind === 'kmh' ? '✅' : ''} ${d.unitKmh}`, callback_data: 'unit|wind|kmh' }
            ],
            [
                { text: `${d.settingsPress} ${pressure === 'mmhg' ? '✅' : ''} ${d.unitMmhg}`, callback_data: 'unit|pressure|mmhg' },
                { text: `${pressure === 'hpa' ? '✅' : ''} ${d.unitHpa}`, callback_data: 'unit|pressure|hpa' }
            ],
            [
                { text: d.settingsCity, callback_data: 'change_city' }
            ]
        ]
    };
}

const getLang = (ctx) => (ctx.from?.language_code === 'uk' || ctx.from?.language_code === 'ru') ? 'uk' : 'en';

// Bot Logic (Webhook handler)
module.exports = async (req, res) => {
    try {
        if (!process.env.TG_TOKEN) {
            return res.status(500).send('TG_TOKEN is missing');
        }

        await connectDB();

        // Handle Webhook request
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            res.status(200).send('OK');
        } else {
            res.status(200).send('Parasol Sentinel Bot is active.');
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
    const lang = getLang(ctx);
    await connectDB();
    const user = await User.findOne({ telegramId: ctx.from.id });
    
    const keyboard = {
        keyboard: [
            [{ text: dict[lang].settingsBtn }]
        ],
        resize_keyboard: true
    };

    if (user) {
        const sig = generateSignature(ctx.from.id, process.env.CRON_SECRET);
        const dashboardUrl = formatUrl(process.env.DOMAIN || 'localhost', `/?user=${ctx.from.id}&sig=${sig}`);
        await ctx.replyWithMarkdown(dict[lang].welcome, {
            reply_markup: {
                ...keyboard,
                inline_keyboard: [
                    [{ text: dict[lang].dashboard, url: dashboardUrl }]
                ]
            }
        });
    } else {
        await ctx.replyWithMarkdown(dict[lang].welcome, {
            reply_markup: keyboard
        });
    }
});

// /settings command
bot.command('settings', async (ctx) => {
    const lang = getLang(ctx);
    await connectDB();
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user) {
        return ctx.replyWithMarkdown(lang === 'uk'
            ? '❌ Спочатку встановіть місто, надіславши його назву.'
            : '❌ Please set your city first by sending its name.');
    }
    await ctx.replyWithMarkdown(
        dict[lang].settings,
        { reply_markup: buildSettingsKeyboard(lang, user.units) }
    );
});

// Handle text messages (City search or Menu buttons)
bot.on('text', async (ctx) => {
    const query = ctx.message.text.trim();
    const lang = getLang(ctx);

    // Handle Menu Buttons
    if (query === dict.uk.settingsBtn || query === dict.en.settingsBtn) {
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (!user) {
            return ctx.reply(lang === 'uk' ? '📍 Спочатку встановіть місто.' : '📍 Please set a city first.');
        }
        return ctx.replyWithMarkdown(dict[lang].settings, {
            reply_markup: buildSettingsKeyboard(lang, user.units)
        });
    }

    if (query.startsWith('/')) return;

    try {
        console.log(`Searching for: ${query}`);
        // Using Nominatim for better search with multiple results
        // Added User-Agent (required by Nominatim) and explicit language
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1&accept-language=${lang}`;
        const response = await axios.get(nominatimUrl, {
            headers: { 'User-Agent': 'ParasolSentinelBot/1.1' }
        });

        if (response.data?.length > 0) {
            const buttons = response.data.map(item => {
                // Shorten name for the button text
                const name = item.display_name.split(',').slice(0, 3).join(',').trim();
                
                // Telegram callback_data limit is 64 bytes.
                // Format: set|lat|lon|city_name
                const lat = parseFloat(item.lat).toFixed(3);
                const lon = parseFloat(item.lon).toFixed(3);
                
                // Prioritize city name from address object
                const cityNameRaw = item.address?.city || item.address?.town || item.address?.village || query;
                const cityName = cityNameRaw.slice(0, 30);
                const callbackData = `set|${lat}|${lon}|${cityName}`;

                return [{ text: name, callback_data: callbackData }];
            });

            await ctx.reply(dict[lang].select, {
                reply_markup: { inline_keyboard: buttons }
            });
        } else {
            await ctx.replyWithMarkdown(dict[lang].notFound);
        }
    } catch (error) {
        console.error('Search Error:', error.message);
        await ctx.replyWithMarkdown(dict[lang].errorSearch);
    }
});

// Handle button clicks
bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data.split('|');
    const lang = getLang(ctx);

    // --- City selection callback ---
    if (data[0] === 'set') {
        const [_, lat, lon, cityName] = data;

        try {
            await connectDB();

            const weatherbitUrl = `https://api.weatherbit.io/v2.0/current?lat=${lat}&lon=${lon}&key=${process.env.WEATHERBIT_KEY}`;
            const weatherRes = await axios.get(weatherbitUrl);
            
            if (!weatherRes.data?.data?.[0]) throw new Error('No weather data received');
            const weather = weatherRes.data.data[0];

            await User.findOneAndUpdate(
                { telegramId: ctx.from.id },
                {
                    username: ctx.from.username,
                    city: weather.city_name,
                    lat: parseFloat(lat),
                    lon: parseFloat(lon),
                    timezone: weather.timezone,
                    language: lang,
                    lastState: {
                        temp: weather.temp,
                        weatherCode: weather.weather.code,
                        updatedAt: new Date()
                    }
                },
                { upsert: true, new: true }
            );

            const sig = generateSignature(ctx.from.id, process.env.CRON_SECRET);
            const dashboardUrl = formatUrl(process.env.DOMAIN || 'localhost', `/?user=${ctx.from.id}&sig=${sig}`);

            await ctx.answerCbQuery(dict[lang].citySet.replace('{city}', weather.city_name));
            
            const messageText = dict[lang].citySetFull
                .replace('{city}', weather.city_name)
                .replace('{lat}', lat)
                .replace('{lon}', lon)
                .replace('{temp}', Math.round(weather.temp));

            await ctx.editMessageText(messageText, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: dict[lang].dashboard, url: dashboardUrl }]
                    ]
                }
            });
        } catch (error) {
            await ctx.replyWithMarkdown(dict[lang].saveError);
        }
    }

    // --- Open Settings manual callback ---
    else if (data[0] === 'open_settings') {
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (!user) return ctx.answerCbQuery('❌ Error');
        await ctx.answerCbQuery();
        await ctx.replyWithMarkdown(
            dict[lang].settings,
            { reply_markup: buildSettingsKeyboard(lang, user.units) }
        );
    }

    // --- Units change callback (wind or pressure) ---
    else if (data[0] === 'unit') {
        const [_, type, value] = data; // e.g. unit|wind|kmh
        try {
            await connectDB();
            const updateField = `units.${type}`;
            const user = await User.findOneAndUpdate(
                { telegramId: ctx.from.id },
                { $set: { [updateField]: value } },
                { new: true }
            );
            await ctx.answerCbQuery(dict[lang].settingsSaved);
            // Refresh the settings keyboard to show the new checkmark
            await ctx.editMessageReplyMarkup(
                buildSettingsKeyboard(lang, user?.units)
            );
        } catch (error) {
            await ctx.answerCbQuery('❌ Error saving');
        }
    }

    // --- Change city callback ---
    else if (data[0] === 'change_city') {
        await ctx.answerCbQuery();
        await ctx.reply(lang === 'uk'
            ? '📍 Надішліть назву нового міста:'
            : '📍 Send the name of the new city:');
    }
});

// --- Local Development Support (Polling Mode) ---
// If the script is run directly (not via a serverless require), launch in polling mode.
if (require.main === module) {
    (async () => {
        try {
            console.log('🔄 Launching Parasol Sentinel in POLLING mode (Local Dev)...');
            await connectDB();
            await bot.launch();
            console.log('🚀 Bot is active and polling.');
        } catch (e) {
            console.error('❌ Failed to launch bot locally:', e.message);
        }
    })();
}
