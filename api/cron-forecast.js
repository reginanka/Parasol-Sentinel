require('dotenv').config();
const axios = require('axios');
const getBot = require('../utils/bot');
const bot = getBot();
const logToTelegram = require('../utils/logger');
const User = require('../models/User');
const City = require('../models/City');

const History = require('../models/History');
const connectDB = require('../utils/db');
const { getWeatherDesc, getWindDir } = require('../utils/weather');
const { sleep, formatUrl, generateSignature, escapeHTML } = require('../utils/helpers');
const { getLunarPhase } = require('../utils/agro');

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
                title: "🌆 **Прогноз на {days} дн. для {city}**",
                temp: "🌡 **Темп:**",
                precip: "💧 **Вірог. опадів:**",
                dew: "🌡 **Точка роси:**",
                wind: "💨 **Вітер:**",
                press: "🧭 **Тиск:**",
                uv: "☀️ **УФ-індекс:**",
                vis: "👁 **Видимість:**",
                moon: "**Місяць:**",
                sun: "🌅 **Сонце:**",
                pressLow: "низький",
                pressNorm: "норма",
                pressHigh: "високий",
                details: "🔗 Детальний прогноз",
                gustsTo: "пориви до",
                unitMs: "м/с",
                unitKmh: "км/год",
                unitMmhg: "мм рт.ст.",
                unitHpa: "гПа",
                loc: 'uk-UA'
            },
            en: {
                title: "🌆 **{days}-day forecast for {city}**",
                temp: "🌡 **Temp:**",
                precip: "💧 **Precip:**",
                dew: "🌡 **Dew Point:**",
                wind: "💨 **Wind:**",
                press: "🧭 **Pressure:**",
                uv: "☀️ **UV Index:**",
                vis: "👁 **Visibility:**",
                moon: "**Moon:**",
                sun: "🌅 **Sun:**",
                pressLow: "low",
                pressNorm: "normal",
                pressHigh: "high",
                details: "🔗 Detailed forecast",
                gustsTo: "gusts up to",
                unitMs: "m/s",
                unitKmh: "km/h",
                unitMmhg: "mmHg",
                unitHpa: "hPa",
                loc: 'en-US'
            }
        };

        const formatTemp = (c, unit) => {
            if (unit === 'f') return `${Math.round(c * 9 / 5 + 32)}°F`;
            return `${Math.round(c)}°C`;
        };

        const formatWind = (ms, gust_ms, cdir, unit, lang) => {
            let spdVal = ms;
            let gustVal = gust_ms || ms;
            let unitStr = fDict[lang].unitMs;
            let dirStr = getWindDir(cdir, lang);

            if (unit === 'kmh') {
                spdVal = spdVal * 3.6;
                gustVal = gustVal * 3.6;
                unitStr = fDict[lang].unitKmh;
            }

            const baseWind = `${dirStr}, ${Math.round(spdVal)} ${unitStr}`;
            if (Math.round(gustVal) > Math.round(spdVal)) {
                return `${baseWind} (${fDict[lang].gustsTo} ${Math.round(gustVal)})`;
            }
            return baseWind;
        };

        const formatPress = (pres_mb, slp_mb, unit, lang) => {
            const convert = (mb) => unit === 'mmhg' ? Math.round(mb * 0.75006) : Math.round(mb);
            const unitStr = unit === 'mmhg' ? fDict[lang].unitMmhg : fDict[lang].unitHpa;
            const presVal = convert(pres_mb);
            const slpVal = convert(slp_mb);

            let indicator;
            if (slp_mb < 1007) indicator = `🟢(${fDict[lang].pressLow})`;
            else if (slp_mb <= 1018) indicator = `🟡(${fDict[lang].pressNorm})`;
            else indicator = `🔴(${fDict[lang].pressHigh})`;

            return `${presVal} (slp: ${slpVal}) ${unitStr} ${indicator}`;
        };

        const formatUV = (uv) => {
            let desc = '';
            if (uv <= 2) desc = '🟢';
            else if (uv <= 5) desc = '🟡';
            else if (uv <= 7) desc = '🟠';
            else if (uv <= 10) desc = '🔴';
            else desc = '🟣';
            return `${Math.round(uv)} ${desc}`;
        };

        const formatMoon = (dateObj, lang) => {
            const moonInfo = getLunarPhase(dateObj);
            const isUk = lang === 'uk';
            let name = '';
            let icon = '';

            switch (moonInfo.index) {
                case 0: name = isUk ? 'Новий місяць' : 'New Moon'; icon = '🌑'; break;
                case 1: name = isUk ? 'Молодик' : 'Waxing Crescent'; icon = '🌒'; break;
                case 2: name = isUk ? 'Перша чверть' : 'First Quarter'; icon = '🌓'; break;
                case 3: name = isUk ? 'Зростаючий' : 'Waxing Gibbous'; icon = '🌔'; break;
                case 4: name = isUk ? 'Повня' : 'Full Moon'; icon = '🌕'; break;
                case 5: name = isUk ? 'Спадний' : 'Waning Gibbous'; icon = '🌖'; break;
                case 6: name = isUk ? 'Остання чверть' : 'Last Quarter'; icon = '🌗'; break;
                case 7: name = isUk ? 'Старий місяць' : 'Waning Crescent'; icon = '🌘'; break;
            }

            return `${icon} ${name}`;
        };

        for (const [key, cityInfo] of Object.entries(uniqueCities)) {
            try {
                // Fetch daily forecast (includes most metrics)
                const response = await axios.get(`https://api.weatherbit.io/v2.0/forecast/daily?lat=${cityInfo.lat}&lon=${cityInfo.lon}&key=${API_KEY}&days=7`);
                const fullResponse = response.data.data;
                const apiCityName = response.data.city_name || cityInfo.name;
                const todayData = fullResponse[0];

                let aqiData = null;

                // --- SYNC HISTORY ---
                await History.findOneAndUpdate(
                    { externalId: key, date: todayData.valid_date },
                    {
                        $min: { temp_min: todayData.min_temp },
                        $max: { temp_max: todayData.max_temp },
                        $set: {
                            temp_avg: todayData.temp,
                            precip: todayData.precip,
                            uv_max: todayData.uv,
                            rh_avg: todayData.rh,
                            clouds_avg: todayData.clouds,
                            wind_spd_max: todayData.wind_gust_spd || todayData.wind_spd
                        }
                    },
                    { upsert: true }
                ).catch(e => console.error('History sync error:', e.message));

                await City.findOneAndUpdate(
                    { externalId: key },
                    {
                        eveningState: {
                            temp: todayData.temp,
                            weatherCode: todayData.weather.code,
                            updatedAt: new Date(),
                            forecast: fullResponse
                        }
                    },
                    { upsert: true }
                );

                for (const user of cityInfo.users) {
                    await sleep(40);
                    const lang = user.language || 'uk';
                    const tempUnit = user.units?.temp || 'c';
                    const settings = user.forecastSettings || { daysCount: 3, enabledMetrics: ['condition', 'temp', 'precip', 'wind', 'pressure'] };
                    const metrics = settings.enabledMetrics;

                    const displayCity = (user.city && user.city !== '..') ? user.city : apiCityName;
                    let message = `${fDict[lang].title.replace('{days}', settings.daysCount).replace('{city}', displayCity)}\n\n`;

                    const userForecast = fullResponse.slice(1, 1 + settings.daysCount);

                    userForecast.forEach((day, idx) => {
                        const dateObj = new Date(day.valid_date || day.datetime);
                        const dayStr = dateObj.toLocaleDateString(fDict[lang].loc, { weekday: 'short', day: 'numeric', month: 'short' });
                        const capDay = dayStr.charAt(0).toUpperCase() + dayStr.slice(1);

                        message += `📅 **${capDay}**\n`;

                        if (metrics.includes('condition')) {
                            message += `${getWeatherDesc(day.weather.code, lang)}\n`;
                        }
                        if (metrics.includes('temp')) {
                            message += `${fDict[lang].temp} ${formatTemp(day.min_temp, tempUnit)} ... ${formatTemp(day.max_temp, tempUnit)}\n`;
                        }
                        if (metrics.includes('precip')) {
                            message += `${fDict[lang].precip} ${day.pop}% (${(day.precip || 0).toFixed(1)} мм)\n`;
                        }
                        if (metrics.includes('wind')) {
                            message += `${fDict[lang].wind} ${formatWind(day.wind_spd, day.wind_gust_spd, day.wind_cdir, user.units?.wind || 'ms', lang)}\n`;
                        }
                        if (metrics.includes('pressure')) {
                            message += `${fDict[lang].press} ${formatPress(day.pres, day.slp || day.pres, user.units?.pressure || 'mmhg', lang)}\n`;
                        }
                        if (metrics.includes('dew')) {
                            message += `${fDict[lang].dew} ${formatTemp(day.dewpt, tempUnit)}\n`;
                        }
                        if (metrics.includes('uv')) {
                            message += `${fDict[lang].uv} ${formatUV(day.uv)}\n`;
                        }
                        if (metrics.includes('visibility')) {
                            message += `${fDict[lang].vis} ${Math.round(day.vis)} км\n`;
                        }
                        if (metrics.includes('moon')) {
                            const dObj = new Date(day.valid_date || day.datetime);
                            message += `${fDict[lang].moon} ${formatMoon(dObj, lang)}\n`;
                        }
                        if (metrics.includes('sun')) {
                            const sunrise = new Date(day.sunrise_ts * 1000).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: user.timezone || 'Europe/Kyiv' });
                            const sunset = new Date(day.sunset_ts * 1000).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: user.timezone || 'Europe/Kyiv' });
                            message += `${fDict[lang].sun} ${sunrise} | ${sunset}\n`;
                        }

                        message += '\n';
                    });

                    await bot.telegram.sendMessage(user.telegramId, message, {
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: lang === 'uk' ? '🌱 Рекомендації на завтра' : '🌱 Agro-recommendations for tomorrow', callback_data: 'agro_tomorrow' }],
                                [{ text: lang === 'uk' ? '⚙️ Налаштувати прогноз' : '⚙️ Configure forecast', callback_data: 'forecast_menu' }]
                            ]
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

        const summary = [
            `📋 <b>Вечірній прогноз</b> — ${startTime}`,
            `👥 Користувачів перевірено: ${users.length}`,
            `📨 Прогнозів надіслано: ${sent}`,
            `❌ Помилок: ${errors}`,
            ``,
            ...logLines
        ].join('\n');
        await log(summary);
        res.status(200).send(`Sent ${sent} forecasts`);
    } catch (error) {
        console.error(error);
        await log(`❌ <b>Cron Forecast FAILED</b> — ${startTime}\n<code>${escapeHTML(error.message)}</code>`);
        res.status(500).send('Cron Forecast Error');
    }
}


