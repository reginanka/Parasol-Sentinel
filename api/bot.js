const getBot = require('../utils/bot');
const bot = getBot();
const axios = require('axios');
require('dotenv').config();

const User = require('../models/User');
const City = require('../models/City');
const connectDB = require('../utils/db');
const { formatUrl, generateSignature } = require('../utils/helpers');

const dict = {
    uk: {
        welcome: "👋 Вітаю! Мене звати **Парасоль**.\n\nЯ буду стежити за погодою у вашому місті та надсилатиму сповіщення про різкі зміни.\n\nБудь ласка, напишіть назву вашого міста (українською або англійською):",
        select: "🔎 Оберіть правильний варіант зі списку:",
        notFound: "❌ Не вдалося знайти це місто. Спробуйте уточнити назву (наприклад, додайте область).",
        citySet: "Місто {city} встановлено!",
        citySetFull: "✅ **Місто встановлено:** {city}\n🌐 Координати: {lat}, {lon}\n🌡️ Поточна температура: {temp}°C",
        dashboard: "📊 Мій Дашборд",
        settingsBtn: "⚙️ Налаштування",
        helpBtn: "❓ Допомога",
        helpSelect: "🔎 Оберіть тему, яка вас цікавить:",
        help_uv: "☀️ Що таке УФ-індекс?",
        help_wind: "🌬️ Напрямки вітру",
        help_press: "🌡️ Тиск та здоров'я",
        help_hum: "💧 Вологість та видимість",
        help_precip: "☔ Ймовірність опадів",
        help_dew: "💧 Точка роси",
        help_feels: "🌡️ Відчувається як",
        help_cloud: "☁️ Хмарність",
        help_bot: "ℹ️ Як працює бот",
        help_uv_desc: "☀️ **УФ-індекс** показує рівень сонячного випромінювання:\n\n  0-2: Низький (безпечно)\n  3-5: Помірний (потрібен захист, крем SPF)\n  6-7: Високий (небезпечно, будьте в тіні)\n  8+: Дуже високий (уникайте перебування на сонці)",
        help_wind_desc: "🌬️ **Напрямки вітру** використовують 16-румбову систему:\n\n  **Основні**: Пн, Пд, Сх, Зх.\n  **Проміжні**: Пн-Сх, Пд-Зх тощо.\n  **Детальні**: Наприклад, **Пд-Пд-Зх** означає, що вітер дме з точки між Півднем та Південним Заходом. Це дає максимальну точність.\n\nПівнічні вітри зазвичай несуть холод, південні - тепло. Західні часто приносять вологу та дощі.",
        help_press_desc: "🌡️ **Атмосферний тиск**:\n\nНормою вважається **760 мм рт.ст.** (1013 гПа). \n  **Тиск падає**: зазвичай до хмарності, опадів або шторму. \n  **Тиск росте**: до ясної та сухої погоди. \nРізкі зміни можуть викликати головний біль у метеозалежних людей.",
        help_hum_desc: "💧 **Вологість та видимість**:\n\n  **Вологість**: комфортна норма - 40-60%. Висока вологість посилює відчуття спеки влітку та холоду взимку.\n  **Видимість**: показує дальність огляду в км. Менше 1 км - це густий туман, будьте обережні на дорогах.",
        help_precip_desc: "☔ **Ймовірність опадів**:\n\nЦе ймовірність того, що дощ або сніг випаде десь у вашому районі. \n**Чому 30%, але дощу немає?** Це означає, що при таких умовах дощ йшов у 3 з 10 випадків. Опади можуть бути дуже локальними або пройти зовсім поруч.",
        help_dew_desc: "🌡️ **Точка роси** - це температура, до якої треба охолодити повітря, щоб утворився конденсат (роса).\n\n  **Комфортно**: до 10-12°C - повітря свіже та приємне.\n  **Волого**: 15-18°C - відчувається вологість.\n  **Задушливо**: вище 20°C - повітря дуже важке, важко дихати через надмір вологи.",
        help_feels_desc: "🌡️ **Відчувається як (Feels Like)**:\n\nПояснює, як саме вологість та вітер змінюють наше сприйняття температури. \n\nЧому при +25°C з високою вологістю набагато важче, ніж при сухих +30°C: висока вологість перешкоджає випаровуванню поту, через що тіло гірше охолоджується. А вітер, навпаки, посилює віддачу тепла, тому при +5°C з вітром здається холодніше, ніж у штиль.",
        help_cloud_desc: "☁️ **Хмарність**:\n\nРозшифровка термінів у % покриття неба:\n\n  • **Ясно**: 0-10% (небо майже чисте).\n  • **Мінлива хмарність**: 30-60% (сонце часто з'являється).\n  • **Суцільна хмарність**: 90-100% (небо повністю затягнуте хмарами).",
        help_bot_desc: "ℹ️ **Інструкція: Як працює бот**:\n\n  1. **Налаштування сповіщень**: Натисніть кнопку '⚙️ Налаштування'. Тут можна обрати одиниці виміру вітру та тиску.\n  2. **Дашборд**: Натисніть кнопку зліва від поля вводу (або '📊 Мій Дашборд'), щоб відкрити веб-інтерфейс з графіками.\n  3. **Змінити місто**: Просто напишіть нову назву міста боту, і він запропонує варіанти для вибору.",
        saveError: "❌ Не вдалося зберегти. Перевірте конфігурацію сервера.",
        settings: "⚙️ *Налаштування*",
        settingsWind: "🌬️ Вітер:",
        settingsPress: "🌡️ Тиск:",
        settingsCity: "📍 Змінити місто",
        settingsSaved: "✅ Налаштування збережено!",
        unitMs: "м/с",
        unitKmh: "км/год",
        unitMmhg: "мм рт.ст.",
        unitHpa: "гПа",
        unitC: "°C",
        unitF: "°F",
        settingsTemp: "🌡️ Темп:"
    },
    en: {
        welcome: "👋 Hello! My name is **Parasol**.\n\nI will monitor the weather in your city and send alerts about sudden changes.\n\nPlease type the name of your city:",
        select: "🔎 Choose the correct option from the list:",
        notFound: "❌ Cannot find this city. Please try to be more specific (e.g. add region/state).",
        errorSearch: "❌ Search error occurred. Please try again later.",
        citySet: "City {city} is set!",
        citySetFull: "✅ **City set:** {city}\n🌐 Coordinates: {lat}, {lon}\n🌡️ Current temperature: {temp}°C\n💧 Dew Point: {dewpt}°C",
        dashboard: "📊 My Dashboard",
        settingsBtn: "⚙️ Settings",
        helpBtn: "❓ Help",
        helpSelect: "🔎 Choose a topic you are interested in:",
        help_uv: "☀️ What is UV index?",
        help_wind: "🌬️ Wind directions",
        help_press: "🌡️ Pressure & Health",
        help_hum: "💧 Humidity & Visibility",
        help_precip: "☔ Precipitation chance",
        help_dew: "💧 Dew Point",
        help_feels: "🌡️ Feels Like",
        help_cloud: "☁️ Cloudiness",
        help_bot: "ℹ️ How it works",
        help_uv_desc: "☀️ **UV index** shows the level of solar radiation:\n\n  0-2: Low (safe)\n  3-5: Moderate (protection needed, SPF cream)\n  6-7: High (dangerous, stay in shade)\n  8+: Very high (avoid going outside)",
        help_wind_desc: "🌬️ **Wind directions** use a 16-point compass:\n\n  **Main**: N, S, E, W.\n  **Intermediate**: NE, SW, etc.\n  **Detailed**: E.g., **SSW** (South-South-West) means the wind is coming from between South and South-West. This provides maximum precision.\n\nNorth winds usually bring cold, while south winds bring warmth. West winds often bring moisture and rain.",
        help_press_desc: "🌡️ **Atmospheric Pressure**:\n\nThe standard norm is **760 mmHg** (1013 hPa). \n  **Falling pressure**: usually predicts clouds, rain, or storms. \n  **Rising pressure**: leads to clear and dry weather. \nSudden changes can cause headaches in weather-sensitive people.",
        help_hum_desc: "💧 **Humidity & Visibility**:\n\n  **Humidity**: Comfortable range is 40-60%. High humidity intensifies the feeling of heat in summer and cold in winter.\n  **Visibility**: Shows the range of sight in km. Less than 1 km is considered dense fog, be careful on the roads.",
        help_precip_desc: "☔ **Precipitation Chance**:\n\nThis is the probability that rain or snow will fall somewhere in your area. \n**Why is it 30% but no rain?** It means under these conditions, it rained in 3 out of 10 cases. Precipitation can be very localized or pass right next to you.",
        help_dew_desc: "🌡️ **Dew Point** is the temperature to which air must be cooled to produce condensation (dew).\n\n  **Comfort**: up to 10-12°C - air feels fresh and pleasant.\n  **Humid**: 15-18°C - noticeable humidity.\n  **Muggy**: above 20°C - air feels very heavy, hard to breathe due to excess moisture.",
        help_feels_desc: "🌡️ **Feels Like**:\n\nExplains how humidity and wind change our perception of temperature.\n\nHigh humidity at +25°C can feel harder than dry +30°C because humidity prevents sweat from evaporating, making it harder for the body to cool down. Wind, on the other hand, increases heat loss, making +5°C feel much colder than it is in calm weather.",
        help_cloud_desc: "☁️ **Cloudiness**:\n\nDecoding terms in % of sky coverage:\n\n  • **Clear**: 0-10% coverage.\n  • **Partly Cloudy**: 30-60% coverage.\n  • **Overcast**: 90-100% coverage.",
        help_bot_desc: "ℹ️ **Guide: How the bot works**:\n\n  1. **Notifications**: Click '⚙️ Settings' to choose units for wind and pressure.\n  2. **Dashboard**: Use the button to the left of the input field (or '📊 My Dashboard') to open the web interface with charts.\n  3. **Change City**: Simply send the name of a new city, and the bot will provide options to choose from.",
        saveError: "❌ Failed to save. Please check server configuration.",
        settings: "⚙️ *Settings*",
        settingsWind: "🌬️ Wind:",
        settingsPress: "🌡️ Pressure:",
        settingsCity: "📍 Change city",
        settingsSaved: "✅ Settings saved!",
        unitMs: "m/s",
        unitKmh: "km/h",
        unitMmhg: "mmHg",
        unitHpa: "hPa",
        unitC: "°C",
        unitF: "°F",
        settingsTemp: "🌡️ Temp:"
    }
};

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

function getLang(ctx) {
    return ctx.from?.language_code === 'uk' ? 'uk' : 'en';
}

const sendHelpMenu = async (ctx) => {
    const lang = getLang(ctx);
    const d = dict[lang];
    await ctx.reply(d.helpSelect, {
        reply_markup: {
            inline_keyboard: [
                [{ text: d.help_uv, callback_data: 'help|uv' }, { text: d.help_wind, callback_data: 'help|wind' }],
                [{ text: d.help_press, callback_data: 'help|press' }, { text: d.help_hum, callback_data: 'help|hum' }],
                [{ text: d.help_precip, callback_data: 'help|precip' }, { text: d.help_dew, callback_data: 'help|dew' }],
                [{ text: d.help_feels, callback_data: 'help|feels' }, { text: d.help_cloud, callback_data: 'help|cloud' }],
                [{ text: d.help_bot, callback_data: 'help|bot' }]
            ]
        }
    });
};

bot.command('start', async (ctx) => {
    const lang = getLang(ctx);
    const d = dict[lang];
    
    await connectDB();
    const user = await User.findOne({ telegramId: ctx.from.id });
    
    const keyboard = {
        keyboard: [
            [{ text: d.settingsBtn }, { text: d.helpBtn }]
        ],
        resize_keyboard: true
    };

    if (user) {
        await ctx.reply(d.helpSelect, { reply_markup: keyboard });
        return sendHelpMenu(ctx);
    } else {
        await ctx.replyWithMarkdown(d.welcome, { reply_markup: keyboard });
    }
    try {
        await ctx.setMyCommands([
            { command: 'start', description: lang === 'uk' ? 'Запустити бота' : 'Start the bot' },
            { command: 'settings', description: lang === 'uk' ? 'Налаштування' : 'Settings' },
            { command: 'help', description: lang === 'uk' ? 'Допомога' : 'Help' }
        ]);
        await ctx.setChatMenuButton({
            type: 'web_app',
            text: dict[lang].dashboard,
            web_app: { url: formatUrl(process.env.DOMAIN || 'localhost') }
        });
    } catch (e) { console.error(e); }
});

bot.command('settings', async (ctx) => {
    const lang = getLang(ctx);
    await connectDB();
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user) return ctx.replyWithMarkdown(lang === 'uk' ? '❌ Спочатку встановіть місто.' : '❌ Please set your city first.');
    await ctx.replyWithMarkdown(dict[lang].settings, { reply_markup: buildSettingsKeyboard(lang, user.units) });
});

bot.command('help', sendHelpMenu);

bot.on('text', async (ctx) => {
    const query = ctx.message.text.trim();
    const lang = getLang(ctx);
    if (query === dict.uk.settingsBtn || query === dict.en.settingsBtn) {
        await connectDB();
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (!user) return ctx.reply(lang === 'uk' ? '❌ Спочатку встановіть місто.' : '❌ Please set a city first.');
        return ctx.replyWithMarkdown(dict[lang].settings, { reply_markup: buildSettingsKeyboard(lang, user.units) });
    }
    if (query === dict.uk.helpBtn || query === dict.en.helpBtn) return sendHelpMenu(ctx);
    if (query.startsWith('/')) return;
    try {
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1&accept-language=${lang}`;
        const res = await axios.get(nominatimUrl, { headers: { 'User-Agent': 'ParasolSentinelBot/1.1' } });
        if (res.data?.length > 0) {
            const buttons = res.data.map(item => {
                const name = item.display_name.split(',').slice(0, 3).join(',').trim();
                const callbackData = `set|${parseFloat(item.lat).toFixed(3)}|${parseFloat(item.lon).toFixed(3)}|${(item.address?.city || item.address?.town || query).slice(0, 30)}`;
                return [{ text: name, callback_data: callbackData }];
            });
            await ctx.reply(dict[lang].select, { reply_markup: { inline_keyboard: buttons } });
        } else {
            await ctx.replyWithMarkdown(dict[lang].notFound);
        }
    } catch (e) { console.error(e); }
});

bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data.split('|');
    const lang = getLang(ctx);
    if (data[0] === 'set') {
        const [_, lat, lon, cityName] = data;
        try {
            await connectDB();
            const weatherRes = await axios.get(`https://api.weatherbit.io/v2.0/current?lat=${lat}&lon=${lon}&key=${process.env.WEATHERBIT_KEY}`);
            const weather = weatherRes.data.data[0];
            await User.findOneAndUpdate({ telegramId: ctx.from.id }, {
                username: ctx.from.username, city: weather.city_name, lat: parseFloat(lat), lon: parseFloat(lon),
                timezone: weather.timezone, language: lang,
                lastState: { temp: weather.temp, weatherCode: weather.weather.code, updatedAt: new Date() }
            }, { upsert: true });
            const sig = generateSignature(ctx.from.id, process.env.CRON_SECRET);
            await ctx.answerCbQuery(dict[lang].citySet.replace('{city}', weather.city_name));
            await ctx.editMessageText(dict[lang].citySetFull.replace('{city}', weather.city_name).replace('{lat}', lat).replace('{lon}', lon).replace('{temp}', Math.round(weather.temp)), { parse_mode: 'Markdown' });

            // Send main keyboard
            await ctx.reply(dict[lang].helpSelect, {
                reply_markup: {
                    keyboard: [[{ text: dict[lang].settingsBtn }, { text: dict[lang].helpBtn }]],
                    resize_keyboard: true
                }
            });

            await ctx.setChatMenuButton({ type: 'web_app', text: dict[lang].dashboard, web_app: { url: formatUrl(process.env.DOMAIN || 'localhost') } });
        } catch (e) { await ctx.replyWithMarkdown(dict[lang].saveError); }
    } else if (data[0] === 'help') {
        await ctx.answerCbQuery();
        await ctx.replyWithMarkdown(dict[lang][`help_${data[1]}_desc`]);
    } else if (data[0] === 'open_settings') {
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (!user) return ctx.answerCbQuery('Error');
        await ctx.answerCbQuery();
        await ctx.replyWithMarkdown(dict[lang].settings, { reply_markup: buildSettingsKeyboard(lang, user.units) });
    } else if (data[0] === 'unit') {
        try {
            await connectDB();
            const user = await User.findOneAndUpdate({ telegramId: ctx.from.id }, { $set: { [`units.${data[1]}`]: data[2] } }, { new: true });
            await ctx.answerCbQuery(dict[lang].settingsSaved);
            await ctx.editMessageReplyMarkup(buildSettingsKeyboard(lang, user?.units));
        } catch (e) { await ctx.answerCbQuery('Error'); }
    } else if (data[0] === 'change_city') {
        await ctx.answerCbQuery();
        await ctx.reply(lang === 'uk' ? '🔎 Надішліть назву нового міста:' : '🔎 Send the name of the new city:');
    }
});

// --- Webhook Handler (for Vercel) ---
// Using Telegraf's built-in webhookCallback for better compatibility
const webhookHandler = bot.webhookCallback('/');

module.exports = async (req, res) => {
    try {
        console.log(`Incoming request: ${req.method} ${req.url}`);
        
        // Ensure DB connection for every request
        await connectDB();
        
        if (req.method === 'POST') {
            return await webhookHandler(req, res);
        } else {
            res.status(200).send('Parasol Sentinel Bot is alive and waiting for webhooks! 🤖');
        }
    } catch (err) {
        console.error('Bot Error:', err.message);
        // Don't leak errors to the response in production
        if (!res.headersSent) {
            res.status(500).send('Internal Server Error');
        }
    }
};

// --- Local Development Support (Polling Mode) ---
if (require.main === module) {
    (async () => {
        try {
            console.log('🚀 Launching Parasol Sentinel in POLLING mode (Local Dev)...');
            await connectDB();
            await bot.launch();
            console.log('✅ Bot is active and polling.');
        } catch (e) {
            console.error('❌ Failed to launch bot locally:', e.message);
        }
    })();
}
