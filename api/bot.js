const getBot = require('../utils/bot');
const bot = getBot();
const axios = require('axios');
require('dotenv').config();

const User = require('../models/User');
const City = require('../models/City');
const connectDB = require('../utils/db');
const { formatUrl, generateSignature } = require('../utils/helpers');

/**
 * Parasol Sentinel Bot - Core logic handler.
 * Design Choice: Using a hybrid approach (Serverless Webhook + Polling for Local Dev).
 */

const dict = {
    uk: {
        welcome: "👋 Вітаю! Мене звати **Parasol**.\n\nЯ буду стежити за погодою у вашому місті та надсилати сповіщення про різкі зміни.\n\nБудь ласка, введіть назву вашого міста (українською або англійською):",
        select: "🔍 Оберіть правильний варіант зі списку:",
        notFound: "❌ Не вдалося знайти це місто. Спробуйте уточнити запит (наприклад, додайте область).",
        errorSearch: "❌ Сталася помилка пошуку. Спробуйте пізніше.",
        citySet: "Місто {city} успішно встановлено!",
        citySetFull: "✅ **Місто встановлено:** {city}\n🌐 Координати: {lat}, {lon}\n🌡️ Поточна температура: {temp}°C\n💧 Точка роси: {dewpt}°C",
        dashboard: "📊 Мій Дашборд",
        settingsBtn: "⚙️ Налаштування",
        helpBtn: "❓ Допомога",
        helpSelect: "🔍 Оберіть тему, яка вас цікавить:",
        help_uv: "☀️ Що таке УФ-індекс?",
        help_wind: "🌬️ Напрямки вітру",
        help_press: "🌡️ Тиск та здоров'я",
        help_hum: "💧 Вологість та видимість",
        help_precip: "🌧️ Шанс опадів",
        help_dew: "💧 Точка роси",
        help_feels: "🌡️ Відчувається як",
        help_cloud: "☁️ Хмарність",
        help_how: "ℹ️ Як це працює",
        help_uv_desc: "☀️ **УФ-індекс** показує рівень сонячного випромінювання:\n\n• 0-2: Низький (безпечно)\n• 3-5: Помірний (потрібен захист, SPF крем)\n• 6-7: Високий (небезпечно, перебувайте в тіні)\n• 8+: Дуже високий (уникайте сонця)",
        help_wind_desc: "🌬️ **Напрямки вітру** використовують 16-румбову систему:\n\n• **Основні**: Пн (N), Пд (S), Сх (E), Зх (W).\n• **Проміжні**: Пн-Сх (NE), Пд-Зх (SW) тощо.\n• **Детальні**: Наприклад, **Пд-Пд-Зх** (SSW) означає, що вітер дме з напрямку між Півднем та Південним Заходом. Це забезпечує максимальну точність.\n\nПівнічні вітри зазвичай несуть холод, південні — тепло. Західні вітри часто приносять вологу та опади.",
        help_press_desc: "🌡️ **Атмосферний тиск**:\n\nНормою вважається **760 мм рт.ст.** (1013 гПа). \n• **Падіння тиску**: зазвичай віщує хмари, дощ або шторм. \n• **Ріст тиску**: до ясної та сухої погоди. \nРізкі зміни можуть викликати головний біль у метеозалежних людей.",
        help_hum_desc: "💧 **Вологість та Видимість**:\n\n• **Вологість**: Комфортна норма — 40-60%. Висока вологість підсилює відчуття спеки влітку та холоду взимку.\n• **Видимість**: Показує дальність огляду в км. Менше 1 км — це густий туман, будьте обережні на дорогах.",
        help_precip_desc: "🌧️ **Шанс опадів**:\n\nЦе ймовірність того, що хоча б десь у вашому районі випаде дощ чи сніг. \n**Чому пише 30%, а дощу немає?** Це означає, що за таких умов дощ випадав у 3 з 10 випадків. Опади можуть бути дуже локальними або пройти зовсім поруч із вами.",
        help_dew_desc: "💧 **Точка роси** — це температура, до якої повинно охолодитися повітря, щоб випав конденсат (роса).\n\n• **Комфортно**: до 10-12°C — повітря свіже.\n• **Волого**: 15-18°C — відчутна вологість.\n• **Душно**: понад 20°C — повітря дуже важке.",
        help_feels_desc: "🌡️ **Відчувається як (Apparent Temperature)**:\n\nЦе температура, яку насправді відчуває людина. Вона розраховується на основі реальної температури, вологості та швидкості вітру.\n\n• Влітку висока вологість робить спеку нестерпною.\n• Взимку сильний вітер змушує мороз відчуватися набагато сильнішим.",
        help_cloud_desc: "☁️ **Хмарність** показує відсоток неба, закритий хмарами:\n\n• **0-10%**: Ясно\n• **11-30%**: Майже ясно\n• **31-70%**: Мінлива хмарність\n• **71-100%**: Похмуро",
        help_how_desc: "ℹ️ **Як це працює**:\n\n1. Напишіть назву свого міста.\n2. Бот запам'ятає ваші координати.\n3. Щогодини бот перевіряє погоду. Якщо температура різко впаде або підніметься (більше ніж на 2-3 градуси), ви отримаєте сповіщення.\n4. Ви також можете налаштувати одиниці вимірювання в меню 'Налаштування'.",
        saveError: "❌ Не вдалося зберегти вибір. Перевірте конфігурацію сервера.",
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
        select: "🔍 Choose the correct option from the list:",
        notFound: "❌ Cannot find this city. Please try to be more specific (e.g. add region/state).",
        errorSearch: "❌ Search error occurred. Please try again later.",
        citySet: "City {city} is set!",
        citySetFull: "✅ **City set:** {city}\n🌐 Coordinates: {lat}, {lon}\n🌡️ Current temperature: {temp}°C\n💧 Dew Point: {dewpt}°C",
        dashboard: "📊 My Dashboard",
        settingsBtn: "⚙️ Settings",
        helpBtn: "❓ Help",
        helpSelect: "🔍 Choose a topic you are interested in:",
        help_uv: "☀️ What is UV index?",
        help_wind: "🌬️ Wind directions",
        help_press: "🌡️ Pressure & Health",
        help_hum: "💧 Humidity & Visibility",
        help_precip: "🌧️ Precipitation chance",
        help_dew: "💧 Dew Point",
        help_feels: "🌡️ Feels Like",
        help_cloud: "☁️ Cloudiness",
        help_how: "ℹ️ How it works",
        help_uv_desc: "☀️ **UV index** shows the level of solar radiation:\n\n• 0-2: Low (safe)\n• 3-5: Moderate (protection needed, SPF cream)\n• 6-7: High (dangerous, stay in shade)\n• 8+: Very high (avoid going outside)",
        help_wind_desc: "🌬️ **Wind directions** use a 16-point compass:\n\n• **Main**: N, S, E, W.\n• **Intermediate**: NE, SW, etc.\n• **Detailed**: E.g., **SSW** (South-South-West) means the wind is coming from between South and South-West. This provides maximum precision.\n\nNorth winds usually bring cold, while south winds bring warmth. West winds often bring moisture and rain.",
        help_press_desc: "🌡️ **Atmospheric Pressure**:\n\nThe standard norm is **760 mmHg** (1013 hPa). \n• **Falling pressure**: usually predicts clouds, rain, or storms. \n• **Rising pressure**: leads to clear and dry weather. \nSudden changes can cause headaches in weather-sensitive people.",
        help_hum_desc: "💧 **Humidity & Visibility**:\n\n• **Humidity**: Comfortable range is 40-60%. High humidity intensifies the feeling of heat in summer and cold in winter.\n• **Visibility**: Shows the range of sight in km. Less than 1 km is considered dense fog, be careful on the roads.",
        help_precip_desc: "🌧️ **Precipitation Chance**:\n\nThis is the probability that rain or snow will fall somewhere in your area. \n**Why is it 30% but no rain?** It means under these conditions, it rained in 3 out of 10 cases. Precipitation can be very localized or pass right next to you.",
        help_dew_desc: "💧 **Dew Point** is the temperature to which air must be cooled to produce condensation (dew).\n\n• **Comfort**: up to 10-12°C — air feels fresh and pleasant.\n• **Humid**: 15-18°C — noticeable humidity.\n• **Muggy**: above 20°C — air feels very heavy, hard to breathe due to excess moisture.",
        help_feels_desc: "🌡️ **Feels Like (Apparent Temperature)**:\n\nThis is the temperature that humans actually perceive. It is calculated based on air temperature, relative humidity, and wind speed.\n\n• In summer, high humidity makes the heat feel more intense.\n• In winter, strong winds make the cold feel much sharper.",
        help_cloud_desc: "☁️ **Cloudiness** shows the percentage of the sky covered by clouds:\n\n• **0-10%**: Clear\n• **11-30%**: Mostly clear\n• **31-70%**: Partly cloudy\n• **71-100%**: Overcast",
        help_how_desc: "ℹ️ **How it works**:\n\n1. Type your city name.\n2. The bot remembers your coordinates.\n3. Every hour, the bot checks the weather. If the temperature drops or rises significantly (more than 2-3 degrees), you get an alert.\n4. You can also customize units in the 'Settings' menu.",
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
                { text: `${d.settingsTemp} ${units.temp === 'f' ? '' : '✅'} ${d.unitC}`, callback_data: 'unit|temp|c' },
                { text: `${units.temp === 'f' ? '✅' : ''} ${d.unitF}`, callback_data: 'unit|temp|f' }
            ],
            [
                { text: d.settingsCity, callback_data: 'change_city' }
            ]
        ]
    };
}

const getLang = (ctx) => (ctx.from?.language_code === 'uk' || ctx.from?.language_code === 'ru') ? 'uk' : 'en';

// Global command registration (runs once on startup/import)
if (process.env.TG_TOKEN) {
    bot.telegram.setMyCommands([
        { command: 'start', description: 'Запустити бота / Start' },
        { command: 'settings', description: 'Налаштування / Settings' },
        { command: 'help', description: 'Допомога / Help' }
    ]).catch(err => console.error('Error setting global commands:', err.message));
}

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
            [{ text: dict[lang].settingsBtn }, { text: dict[lang].helpBtn }]
        ],
        resize_keyboard: true,
        is_persistent: true
    };

    if (user) {
        const sig = generateSignature(ctx.from.id, process.env.CRON_SECRET);
        const dashboardUrl = formatUrl(process.env.DOMAIN || 'localhost', `/?user=${ctx.from.id}&sig=${sig}`);
        await ctx.replyWithMarkdown(dict[lang].welcome, {
            reply_markup: {
                ...keyboard,
                //inline_keyboard: [
                //[{ text: dict[lang].dashboard, url: dashboardUrl }]
                //]
            }
        });
    } else {
        await ctx.replyWithMarkdown(dict[lang].welcome, {
            reply_markup: keyboard
        });
    }

    // Register commands for the user
    try {
        await ctx.setMyCommands([
            { command: 'start', description: lang === 'uk' ? 'Запустити бота' : 'Start the bot' },
            { command: 'settings', description: lang === 'uk' ? 'Налаштування' : 'Settings' },
            { command: 'help', description: lang === 'uk' ? 'Допомога' : 'Help' }
        ]);

        // Set WebApp menu button (this will be on the left of the input field)
        await ctx.setChatMenuButton({
            type: 'web_app',
            text: dict[lang].dashboard,
            web_app: { url: formatUrl(process.env.DOMAIN || 'localhost') }
        });
    } catch (e) {
        console.error('Error setting commands/menu:', e.message);
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

// Help menu logic
const sendHelpMenu = async (ctx) => {
    const lang = getLang(ctx);
    const d = dict[lang];
    await ctx.reply(d.helpSelect, {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: d.help_uv, callback_data: 'help|uv' },
                    { text: d.help_wind, callback_data: 'help|wind' }
                ],
                [
                    { text: d.help_press, callback_data: 'help|press' },
                    { text: d.help_hum, callback_data: 'help|hum' }
                ],
                [
                    { text: d.help_precip, callback_data: 'help|precip' },
                    { text: d.help_dew, callback_data: 'help|dew' }
                ],
                [
                    { text: d.help_feels, callback_data: 'help|feels' },
                    { text: d.help_cloud, callback_data: 'help|cloud' }
                ],
                [
                    { text: d.help_how, callback_data: 'help|how' }
                ]
            ]
        }
    });
};

// /help command
bot.command('help', sendHelpMenu);

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

    if (query === dict.uk.helpBtn || query === dict.en.helpBtn) {
        return sendHelpMenu(ctx);
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

            // --- City Deduplication Logic ---
            const cityKey = `${parseFloat(lat).toFixed(2)},${parseFloat(lon).toFixed(2)}`;
            await City.findOneAndUpdate(
                { externalId: cityKey },
                {
                    name: weather.city_name,
                    lat: parseFloat(lat),
                    lon: parseFloat(lon),
                    externalId: cityKey
                },
                { upsert: true }
            );
            // ---------------------------------

            const sig = generateSignature(ctx.from.id, process.env.CRON_SECRET);
            const dashboardUrl = formatUrl(process.env.DOMAIN || 'localhost', `/?user=${ctx.from.id}&sig=${sig}`);

            await ctx.answerCbQuery(dict[lang].citySet.replace('{city}', weather.city_name));

            const messageText = dict[lang].citySetFull
                .replace('{city}', weather.city_name)
                .replace('{lat}', lat)
                .replace('{lon}', lon)
                .replace('{temp}', Math.round(weather.temp))
                .replace('{dewpt}', Math.round(weather.dewpt));

            await ctx.editMessageText(messageText, {
                parse_mode: 'Markdown',
                //reply_markup: {
                //inline_keyboard: [
                //  [{ text: dict[lang].dashboard, url: dashboardUrl }]
                // ]
                //}
            });

            // Set WebApp menu button after successful city selection
            await ctx.setChatMenuButton({
                type: 'web_app',
                text: dict[lang].dashboard,
                web_app: { url: formatUrl(process.env.DOMAIN || 'localhost') }
            }).catch(e => console.error('Menu button error:', e.message));

        } catch (error) {
            await ctx.replyWithMarkdown(dict[lang].saveError);
        }
    }

    // --- Help topic callback ---
    else if (data[0] === 'help') {
        const topic = data[1];
        await ctx.answerCbQuery();
        await ctx.replyWithMarkdown(dict[lang][`help_${topic}_desc`]);
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
            console.log('🚀 Launching Parasol Sentinel in POLLING mode (Local Dev)...');
            await connectDB();
            await bot.launch();
            console.log('✅ Bot is active and polling.');
        } catch (e) {
            console.error('❌ Failed to launch bot locally:', e.message);
        }
    })();
}
