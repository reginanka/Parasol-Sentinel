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
const { sleep, formatUrl, generateSignature, escapeHTML, getLocalDateStr } = require('../utils/helpers');
const { getLunarPhase } = require('../utils/agro');
const { dayKey, daySetPaths, pruneDaysUnset, mergeHourlyFlat, getDayBaseline } = require('../utils/baseline');

const API_KEY = process.env.WEATHERBIT_KEY;

module.exports = async (req, res) => {
    const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
    const log = (text) => logToTelegram(bot, LOG_CHAT_ID, text);
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).send('Unauthorized');

    const startTime = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

    try {
        await connectDB();
        const users = await User.find({ notificationsEnabled: true, eveningForecastEnabled: { $ne: false } });

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
                const WAQI_TOKEN = process.env.WAQI_TOKEN;
                if (WAQI_TOKEN) {
                    try {
                        const waqiRes = await axios.get(
                            `https://api.waqi.info/feed/geo:${cityInfo.lat};${cityInfo.lon}/?token=${WAQI_TOKEN}`,
                            { timeout: 8000 }
                        );
                        if (waqiRes.data?.status === 'ok') {
                            const d = waqiRes.data.data;
                            const aqiVal = d.aqi;
                            let badge = '🟢';
                            if (aqiVal > 150) badge = '🔴';
                            else if (aqiVal > 100) badge = '🟠';
                            else if (aqiVal > 50) badge = '🟡';
                            aqiData = {
                                aqi: aqiVal,
                                badge,
                                pm25: d.iaqi?.pm25?.v ?? null,
                                pm10: d.iaqi?.pm10?.v ?? null
                            };
                        }
                    } catch (e) {
                        console.error('WAQI error:', e.message);
                    }
                }

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

                // Day-scoped baseline:
                // - TOMORROW: always refresh (daily temps + hourly precip) and set asOf = now
                // - TODAY: seed only if missing (daytime check owns today after first write)
                // - Prune days older than yesterday
                // Legacy flat hourlyPrecip / forecast / updatedAt still written for compat & messages
                const cityTz = response.data.timezone || 'Europe/Kyiv';
                const todayLocal = getLocalDateStr(cityTz, 0);
                const tomorrowStr = getLocalDateStr(cityTz, 1);
                const yesterdayStr = getLocalDateStr(cityTz, -1);
                const nowTs = new Date();

                const cityDocPre = await City.findOne({ externalId: key });
                const eveningPre = cityDocPre?.eveningState;

                let hourlyPrecip = eveningPre?.hourlyPrecip || [];
                let wroteHourlyPrecip = false;
                let tomorrowHours = [];
                let todayHoursSeed = [];

                try {
                    const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${cityInfo.lat}&longitude=${cityInfo.lon}&hourly=precipitation&timezone=auto&forecast_days=2`;
                    const omRes = await axios.get(omUrl);
                    if (omRes.data && omRes.data.hourly) {
                        const allTimes = omRes.data.hourly.time;
                        const allPrecip = omRes.data.hourly.precipitation;

                        for (let i = 0; i < allTimes.length; i++) {
                            const t = allTimes[i];
                            if (t.startsWith(tomorrowStr)) {
                                tomorrowHours.push({ time: t, precip: allPrecip[i] || 0 });
                            } else if (t.startsWith(todayLocal)) {
                                todayHoursSeed.push({ time: t, precip: allPrecip[i] || 0 });
                            }
                        }

                        const existingToday = getDayBaseline(eveningPre, todayLocal, cityTz);
                        const seedToday = !existingToday || !(existingToday.hourlyPrecip && existingToday.hourlyPrecip.length);

                        if (seedToday) {
                            hourlyPrecip = mergeHourlyFlat(
                                eveningPre?.hourlyPrecip || [],
                                todayLocal,
                                [...todayHoursSeed, ...tomorrowHours],
                                yesterdayStr
                            );
                        } else {
                            // Keep existing today hours; refresh tomorrow only
                            hourlyPrecip = mergeHourlyFlat(
                                eveningPre?.hourlyPrecip || [],
                                tomorrowStr,
                                tomorrowHours,
                                yesterdayStr
                            );
                        }
                        wroteHourlyPrecip = true;
                    }
                } catch (omErr) {
                    console.error('Open-Meteo fetch error in evening forecast:', omErr.message);
                }

                const tomorrowDaily = fullResponse.find(d => dayKey(d) === tomorrowStr) || fullResponse[1];
                const todayDaily = fullResponse.find(d => dayKey(d) === todayLocal) || todayData;

                const eveningSet = {
                    "eveningState.temp": todayData.temp,
                    "eveningState.weatherCode": todayData.weather.code,
                    "eveningState.updatedAt": nowTs,
                    "eveningState.forecast": fullResponse
                };
                if (wroteHourlyPrecip) {
                    eveningSet["eveningState.hourlyPrecip"] = hourlyPrecip;
                }

                // days[tomorrow]: always write
                if (tomorrowDaily) {
                    Object.assign(eveningSet, daySetPaths(tomorrowStr, {
                        asOf: nowTs,
                        min_temp: tomorrowDaily.min_temp,
                        max_temp: tomorrowDaily.max_temp,
                        hourlyPrecip: tomorrowHours.length
                            ? tomorrowHours
                            : (getDayBaseline(eveningPre, tomorrowStr, cityTz)?.hourlyPrecip || [])
                    }));
                }

                // days[today]: seed only if no baseline yet
                const existingTodayBl = getDayBaseline(eveningPre, todayLocal, cityTz);
                const needSeedToday = !existingTodayBl || (existingTodayBl.min_temp == null && existingTodayBl.max_temp == null);
                if (needSeedToday && todayDaily) {
                    Object.assign(eveningSet, daySetPaths(todayLocal, {
                        asOf: nowTs,
                        min_temp: todayDaily.min_temp,
                        max_temp: todayDaily.max_temp,
                        hourlyPrecip: todayHoursSeed.length
                            ? todayHoursSeed
                            : (existingTodayBl?.hourlyPrecip || [])
                    }));
                } else if (existingTodayBl && todayHoursSeed.length && !(existingTodayBl.hourlyPrecip && existingTodayBl.hourlyPrecip.length)) {
                    Object.assign(eveningSet, daySetPaths(todayLocal, {
                        asOf: existingTodayBl.asOf || nowTs,
                        hourlyPrecip: todayHoursSeed
                    }));
                }

                const unsetOld = pruneDaysUnset(eveningPre, yesterdayStr);

                await City.findOneAndUpdate(
                    { externalId: key },
                    { $set: eveningSet, ...(Object.keys(unsetOld).length ? { $unset: unsetOld } : {}) },
                    { upsert: true }
                );

                // --- FETCH NOAA Kp-index (geomagnetic forecast) ---
                let geomagInfo = null;
                let forecastedMaxKp = null;
                try {
                    const noaaRes = await axios.get(
                        'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
                        { timeout: 10000 }
                    );
                    if (noaaRes.data && Array.isArray(noaaRes.data) && noaaRes.data.length > 0) {
                        const now = Date.now();
                        const next24h = noaaRes.data
                            .filter(r => {
                                const t = new Date(r.time_tag).getTime();
                                return t >= now - 3 * 3600 * 1000 && t <= now + 24 * 3600 * 1000;
                            })
                            .map(r => parseFloat(r.kp))
                            .filter(v => !isNaN(v));

                        const kpValues = next24h.length > 0
                            ? next24h
                            : noaaRes.data.slice(0, 8).map(r => parseFloat(r.kp)).filter(v => !isNaN(v));

                        const maxKp = kpValues.length > 0 ? Math.max(...kpValues) : null;
                        if (maxKp !== null) {
                            forecastedMaxKp = maxKp;
                            let badge = '🟢';
                            let labelUk = `Спокійно (Kp ${maxKp.toFixed(0)})`;
                            let labelEn = `Calm (Kp ${maxKp.toFixed(0)})`;
                            if (maxKp >= 5) {
                                badge = '🔴';
                                labelUk = `Буря (Kp ${maxKp.toFixed(0)})`;
                                labelEn = `Storm (Kp ${maxKp.toFixed(0)})`;
                            } else if (maxKp >= 4) {
                                badge = '🟡';
                                labelUk = `Збурення (Kp ${maxKp.toFixed(0)})`;
                                labelEn = `Unsettled (Kp ${maxKp.toFixed(0)})`;
                            }
                            geomagInfo = { badge, labelUk, labelEn };
                        }
                    }
                } catch (noaaErr) {
                    console.error('NOAA Kp fetch error:', noaaErr.message);
                }

                // Persist forecasted Kp for the target day (tomorrow relative to send)
                // so cron-check can avoid repeating the same alert next day
                if (forecastedMaxKp !== null) {
                    const cityTzForKp = response.data.timezone || 'Europe/Kyiv';
                    const localForKp = new Date(new Date().toLocaleString('en-US', { timeZone: cityTzForKp }));
                    const kpTarget = new Date(localForKp);
                    kpTarget.setDate(kpTarget.getDate() + 1);
                    const kpTargetStr = getLocalDateStr(cityTzForKp, 1);

                    await City.findOneAndUpdate(
                        { externalId: key },
                        {
                            $set: {
                                'eveningState.forecastedKp': forecastedMaxKp,
                                'eveningState.forecastedKpDate': kpTargetStr
                            }
                        }
                    ).catch(e => console.error('Save forecastedKp error:', e.message));
                }

                for (const user of cityInfo.users) {
                    if (!user.notificationsEnabled || user.eveningForecastEnabled === false) continue;
                    await sleep(40);
                    const lang = user.language || 'uk';
                    const tempUnit = user.units?.temp || 'c';
                    const settings = user.forecastSettings || { daysCount: 3, enabledMetrics: ['condition', 'temp', 'precip', 'wind', 'pressure'] };
                    const metrics = settings.enabledMetrics;

                    const displayCity = (user.city && user.city !== '..') ? user.city : apiCityName;
                    
                    let aqiPrefix = '';
                    if (metrics.includes('aqi') && aqiData) {
                        const aqiLabel = lang === 'uk' ? '🍃 **Якість повітря (на момент зараз):**' : '🍃 **Air Quality (current moment):**';
                        aqiPrefix = `${aqiLabel} ${aqiData.badge} AQI ${aqiData.aqi}`;
                        if (aqiData.pm25 != null) aqiPrefix += ` | PM2.5: ${aqiData.pm25}`;
                        if (aqiData.pm10 != null) aqiPrefix += ` | PM10: ${aqiData.pm10}`;
                        
                        const isUk = lang === 'uk';
                        const issues = [];
                        if (aqiData.pm25 != null && aqiData.pm25 > 25) {
                            issues.push(isUk ? 'PM2.5 (дрібний пил/смог)' : 'PM2.5 (fine dust/smog)');
                        }
                        if (aqiData.pm10 != null && aqiData.pm10 > 50) {
                            issues.push(isUk ? 'PM10 (великий пил)' : 'PM10 (coarse dust)');
                        }

                        let advice = '';
                        if (aqiData.aqi > 150) {
                            advice = isUk 
                                ? '\n🔴 Небезпечно для всіх! Зачиніть вікна, увімкніть очищувач повітря та обмежте перебування на вулиці.' 
                                : '\n🔴 Unhealthy for everyone! Close windows, turn on air purifiers, and limit outdoor activities.';
                        } else if (aqiData.aqi > 100) {
                            advice = isUk 
                                ? '\n🟠 Шкідливо для чутливих груп. Рекомендуємо зачинити вікна на ніч.' 
                                : '\n🟠 Unhealthy for sensitive groups. Recommend closing windows for the night.';
                        } else if (aqiData.aqi > 50) {
                            advice = isUk 
                                ? '\n🟡 Повітря прийнятне, але чутливим людям варто бути обережними.' 
                                : '\n🟡 Air quality is acceptable, but sensitive groups should be cautious.';
                        } else if (issues.length > 0) {
                            advice = isUk 
                                ? '\n⚠️ Повітря чисте за AQI, але спостерігається підвищення окремих фракцій пилу.' 
                                : '\n⚠️ AQI is low, but elevated levels of specific dust particles detected.';
                        }

                        if (issues.length > 0 && advice) {
                            advice += isUk ? ` (Підвищено: ${issues.join(', ')})` : ` (Elevated: ${issues.join(', ')})`;
                        }
                        
                        aqiPrefix += advice + '\n\n';
                    }

                    let message = `${aqiPrefix}${fDict[lang].title.replace('{days}', settings.daysCount).replace('{city}', displayCity)}\n\n`;

                    // Show from TOMORROW (evening briefing). Index 0 is still stored in eveningState for daytime shift checks.
                    // Always resolve days by valid_date so labels never drift relative to stored baseline.
                    const cityTzForDays = response.data.timezone || 'Europe/Kyiv';
                    const tomorrowStr = getLocalDateStr(cityTzForDays, 1);
                    const dayKey = (d) => String(d?.valid_date || d?.datetime || '').slice(0, 10);
                    const startIdx = fullResponse.findIndex(d => dayKey(d) === tomorrowStr);
                    const fromIdx = startIdx >= 0 ? startIdx : 1;
                    const userForecast = fullResponse.slice(fromIdx, fromIdx + settings.daysCount);

                    userForecast.forEach((day, idx) => {
                        // Prefer valid_date string to avoid UTC Date parsing shifting the weekday near midnight
                        const rawDate = day.valid_date || day.datetime || '';
                        const dateObj = new Date(rawDate.includes('T') ? rawDate : `${rawDate}T12:00:00`);
                        const dayStr = dateObj.toLocaleDateString(fDict[lang].loc, { weekday: 'short', day: 'numeric', month: 'short', timeZone: cityTzForDays });
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
                        if (metrics.includes('geomag') && geomagInfo && idx === 0) {
                            const label = lang === 'uk' ? geomagInfo.labelUk : geomagInfo.labelEn;
                            const geomagLabel = lang === 'uk' ? '🧲 **Магнітні бурі:**' : '🧲 **Magnetic Storms:**';
                            message += `${geomagLabel} ${geomagInfo.badge} ${label}\n`;
                        }

                        message += '\n';
                    });

                    // Target date for hourly button = tomorrow relative to send time (in city timezone)
                    const cityTz = user.timezone || response.data.timezone || 'Europe/Kyiv';
                    const localSend = new Date(new Date().toLocaleString('en-US', { timeZone: cityTz }));
                    const targetHourly = new Date(localSend);
                    targetHourly.setDate(targetHourly.getDate() + 1);
                    const targetHourlyStr = getLocalDateStr(cityTz, 1);
                    const targetHourlyShort = targetHourly.toLocaleDateString(lang === 'uk' ? 'uk-UA' : 'en-US', {
                        day: '2-digit', month: '2-digit'
                    });

                    await bot.telegram.sendMessage(user.telegramId, message, {
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: lang === 'uk' ? `🌤 Погод.прогноз на ${targetHourlyShort}` : `🌤 Weather forecast for ${targetHourlyShort}`, callback_data: `forecast_hourly|${targetHourlyStr}` }],
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


