require('dotenv').config();
const axios = require('axios');
const getBot = require('../utils/bot');
const bot = getBot();
const logToTelegram = require('../utils/logger');
const User = require('../models/User');
const connectDB = require('../utils/db');
const { getWeatherDesc, getWindDir, getSoilFrostInfo, frostWarningText, getGeomagLevel } = require('../utils/weather');
const { sleep, escapeHTML } = require('../utils/helpers');
const { getLunarPhase } = require('../utils/agro');

const API_KEY = process.env.WEATHERBIT_KEY;

/**
 * Build { 'YYYY-MM-DD': maxKp } from NOAA 3-hourly forecast + 27-day outlook.
 * 3-hourly values take priority; outlook fills missing days.
 */
const fetchGeomagByDate = async () => {
    const byDate = {};

    // 1) Detailed 3-hourly Kp (~2–3 days)
    try {
        const noaaRes = await axios.get(
            'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
            { timeout: 10000 }
        );
        if (Array.isArray(noaaRes.data)) {
            for (const r of noaaRes.data) {
                const kp = parseFloat(r.kp);
                if (isNaN(kp)) continue;
                const dateStr = String(r.time_tag || '').slice(0, 10);
                if (!dateStr || dateStr.length < 10) continue;
                if (byDate[dateStr] == null || kp > byDate[dateStr]) {
                    byDate[dateStr] = kp;
                }
            }
        }
    } catch (e) {
        console.error('NOAA Kp forecast error:', e.message);
    }

    // 2) 27-day outlook — daily max Kp (fills days beyond ~3)
    try {
        const outlookRes = await axios.get(
            'https://services.swpc.noaa.gov/text/27-day-outlook.txt',
            { timeout: 10000 }
        );
        const months = {
            Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
            Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12
        };
        const lines = String(outlookRes.data || '').split('\n');
        for (const line of lines) {
            // e.g. "2026 Oct 11      90          10          3"
            const m = line.match(/^(\d{4})\s+(\w{3})\s+(\d{1,2})\s+\d+\s+\d+\s+(\d+)/);
            if (!m) continue;
            const [, year, mon, day, kpStr] = m;
            const month = months[mon];
            if (!month) continue;
            const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const kp = parseFloat(kpStr);
            if (isNaN(kp)) continue;
            // do not overwrite more precise 3-hourly max
            if (byDate[dateStr] == null) {
                byDate[dateStr] = kp;
            }
        }
    } catch (e) {
        console.error('NOAA 27-day outlook error:', e.message);
    }

    return byDate;
};

module.exports = async (req, res) => {
    const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
    const log = (text) => logToTelegram(bot, LOG_CHAT_ID, text);

    // Захист тим самим секретом
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).send('Unauthorized');
    }

    const TEST_USER_ID = process.env.TEST_USER_ID ? Number(process.env.TEST_USER_ID) : null;
    if (!TEST_USER_ID) {
        return res.status(400).send('TEST_USER_ID is not set in secrets');
    }

    const startTime = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

    try {
        await connectDB();

        const user = await User.findOne({ telegramId: TEST_USER_ID });
        if (!user) {
            return res.status(404).send(`User ${TEST_USER_ID} not found`);
        }
        if (!user.lat || !user.lon) {
            return res.status(400).send('User has no coordinates');
        }

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
                return `${baseWind} <small>(${fDict[lang].gustsTo} ${Math.round(gustVal)})</small>`;
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

        const lang = user.language || 'uk';
        const tempUnit = user.units?.temp || 'c';
        const settings = user.forecastSettings || {
            daysCount: 3,
            enabledMetrics: ['condition', 'temp', 'precip', 'wind', 'pressure', 'aqi', 'geomag']
        };
        const metrics = settings.enabledMetrics || [];

        // --- Weatherbit ---
        const response = await axios.get(
            `https://api.weatherbit.io/v2.0/forecast/daily?lat=${user.lat}&lon=${user.lon}&key=${API_KEY}&days=7`
        );
        const fullResponse = response.data.data;
        const apiCityName = response.data.city_name || user.city;

        // --- WAQI (AQI) ---
        let aqiData = null;
        const WAQI_TOKEN = process.env.WAQI_TOKEN;
        if (WAQI_TOKEN) {
            try {
                const waqiRes = await axios.get(
                    `https://api.waqi.info/feed/geo:${user.lat};${user.lon}/?token=${WAQI_TOKEN}`,
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

        // Target date for hourly button only (TEST does NOT write eveningState —
        // real baseline is owned exclusively by the production evening cron)
        const cityTz = user.timezone || response.data.timezone || 'Europe/Kyiv';
        const localSend = new Date(new Date().toLocaleString('en-US', { timeZone: cityTz }));
        const targetHourly = new Date(localSend);
        targetHourly.setDate(targetHourly.getDate() + 1);
        const targetHourlyStr = targetHourly.toLocaleDateString('en-CA', { timeZone: cityTz });
        const targetHourlyShort = targetHourly.toLocaleDateString(lang === 'uk' ? 'uk-UA' : 'en-US', {
            day: '2-digit', month: '2-digit'
        });

        // --- NOAA Kp per day (display only, no DB write) ---
        // geomagByDate: { 'YYYY-MM-DD': maxKp }
        const geomagByDate = await fetchGeomagByDate();

        // --- Open-Meteo soil frost (display only, no DB write) ---
        let frostAnyDay = false;
        let frostColdest = null;
        let soilTimes = [];
        let soil0 = [];
        let soil6 = [];
        try {
            const omFrostUrl =
                `https://api.open-meteo.com/v1/forecast?latitude=${user.lat}&longitude=${user.lon}` +
                `&hourly=soil_temperature_0cm,soil_temperature_6cm` +
                `&daily=temperature_2m_mean` +
                `&timezone=auto&forecast_days=7`;
            const omFrostRes = await axios.get(omFrostUrl, { timeout: 12000 });
            soilTimes = omFrostRes.data?.hourly?.time || [];
            soil0 = omFrostRes.data?.hourly?.soil_temperature_0cm || [];
            soil6 = omFrostRes.data?.hourly?.soil_temperature_6cm || [];
            const meanTimes = omFrostRes.data?.daily?.time || [];
            const meanVals = omFrostRes.data?.daily?.temperature_2m_mean || [];
            // Frost alert — ONLY tomorrow (first day after today in Weatherbit list)
            const tomorrowDay = fullResponse[1];
            if (tomorrowDay) {
                const dStr = String(tomorrowDay.valid_date || tomorrowDay.datetime || '').slice(0, 10);
                if (dStr) {
                    const soilForDay = [];
                    for (let i = 0; i < soilTimes.length; i++) {
                        if (String(soilTimes[i]).startsWith(dStr) && soil0[i] != null) {
                            soilForDay.push(soil0[i]);
                        }
                    }
                    let mean = null;
                    const mIdx = meanTimes.findIndex(t => String(t).startsWith(dStr));
                    if (mIdx >= 0) mean = meanVals[mIdx];
                    const info = getSoilFrostInfo(soilForDay, mean);
                    if (info.frost) {
                        frostAnyDay = true;
                        frostColdest = info.minSoil;
                    }
                }
            }
        } catch (e) {
            console.error('Test forecast frost check error:', e.message);
        }

        // --- Формування повідомлення (Rich Message) ---
        const displayCity = (user.city && user.city !== '..') ? user.city : apiCityName;
        const isUk = lang === 'uk';
        const userForecast = fullResponse.slice(1, 1 + settings.daysCount);

        // ========== 1. AQI prefix ==========
        let aqiHtml = '';
        if (metrics.includes('aqi') && aqiData) {
            const aqiLabel = isUk ? '🍃 <b>Якість повітря (на момент зараз):</b>' : '🍃 <b>Air Quality (current moment):</b>';
            aqiHtml = `${aqiLabel} ${aqiData.badge} AQI ${aqiData.aqi}`;
            if (aqiData.pm25 != null) aqiHtml += ` | PM2.5: ${aqiData.pm25}`;
            if (aqiData.pm10 != null) aqiHtml += ` | PM10: ${aqiData.pm10}`;

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
                    ? '<br>🔴 Небезпечно для всіх! Зачиніть вікна, увімкніть очищувач повітря та обмежте перебування на вулиці.'
                    : '<br>🔴 Unhealthy for everyone! Close windows, turn on air purifiers, and limit outdoor activities.';
            } else if (aqiData.aqi > 100) {
                advice = isUk
                    ? '<br>🟠 Шкідливо для чутливих груп. Рекомендуємо зачинити вікна на ніч.'
                    : '<br>🟠 Unhealthy for sensitive groups. Recommend closing windows for the night.';
            } else if (aqiData.aqi > 50) {
                advice = isUk
                    ? '<br>🟡 Повітря прийнятне, але чутливим людям варто бути обережними.'
                    : '<br>🟡 Air quality is acceptable, but sensitive groups should be cautious.';
            } else if (issues.length > 0) {
                advice = isUk
                    ? '<br>⚠️ Повітря чисте за AQI, але спостерігається підвищення окремих фракцій пилу.'
                    : '<br>⚠️ AQI is low, but elevated levels of specific dust particles detected.';
            }

            if (issues.length > 0 && advice) {
                advice += isUk ? ` (Підвищено: ${issues.join(', ')})` : ` (Elevated: ${issues.join(', ')})`;
            }

            aqiHtml += advice;
        }

        // ========== 2. Frost prefix ==========
        let frostHtml = '';
        if (frostAnyDay) {
            // frostWarningText returns Markdown-style text; convert basic ** to <b>
            const raw = frostWarningText(lang, frostColdest) || '';
            frostHtml = raw
                .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
                .replace(/\n/g, '<br>');
        }

        // ========== 3. Smart highlights (на що звернути увагу) ==========
        const highlights = [];
        const highPressureDays = [];
        let highPressureStart = null;
        let highPressureEnd = null;

        userForecast.forEach((day, idx) => {
            const dateObj = new Date(day.valid_date || day.datetime);
            const dayName = dateObj.toLocaleDateString(isUk ? 'uk-UA' : 'en-US', { weekday: 'long' });
            const dayNameShort = dateObj.toLocaleDateString(isUk ? 'uk-UA' : 'en-US', { weekday: 'short' });

            // Дощ
            const precip = Number(day.precip) || 0;
            const pop = Number(day.pop) || 0;
            if (precip >= 5) {
                highlights.push(isUk
                    ? `у ${dayName} сильний дощ (${precip.toFixed(1)} мм)`
                    : `on ${dayName} heavy rain (${precip.toFixed(1)} mm)`);
            } else if (precip >= 0.3 || pop >= 40) {
                highlights.push(isUk
                    ? `у ${dayName} слабкий дощ (${precip.toFixed(1)} мм)`
                    : `on ${dayName} light rain (${precip.toFixed(1)} mm)`);
            }

            // Пориви вітру (поріг 7 м/с)
            const gust = Number(day.wind_gust_spd || day.wind_spd) || 0;
            if (gust >= 7) {
                highlights.push(isUk
                    ? `у ${dayName} сильний вітер із поривами до ${Math.round(gust)} м/с`
                    : `on ${dayName} strong wind with gusts up to ${Math.round(gust)} m/s`);
            }

            // Високий тиск — збираємо послідовні дні
            const slp = Number(day.slp || day.pres) || 0;
            if (slp > 1018) {
                if (highPressureStart === null) {
                    highPressureStart = dayName;
                    highPressureEnd = dayName;
                } else {
                    highPressureEnd = dayName;
                }
            } else {
                if (highPressureStart !== null) {
                    if (highPressureStart === highPressureEnd) {
                        highPressureDays.push(isUk
                            ? `у ${highPressureStart} високий тиск 🔴`
                            : `on ${highPressureStart} high pressure 🔴`);
                    } else {
                        highPressureDays.push(isUk
                            ? `у ${highPressureStart}–${highPressureEnd} високий тиск 🔴`
                            : `on ${highPressureStart}–${highPressureEnd} high pressure 🔴`);
                    }
                    highPressureStart = null;
                    highPressureEnd = null;
                }
            }

            // Магнітна буря (Kp ≥ 5)
            const dayDate = String(day.valid_date || day.datetime || '').slice(0, 10);
            const kp = geomagByDate[dayDate];
            const level = getGeomagLevel(kp);
            if (level && kp >= 5) {
                const label = isUk ? level.labelUk : level.labelEn;
                highlights.push(isUk
                    ? `у ${dayName} ${label}`
                    : `on ${dayName} ${label}`);
            }

            // Заморозки по ґрунту (для кожного дня)
            const dStrSoil = String(day.valid_date || day.datetime || '').slice(0, 10);
            const vals0 = [];
            for (let i = 0; i < soilTimes.length; i++) {
                if (String(soilTimes[i]).startsWith(dStrSoil) && soil0[i] != null) {
                    vals0.push(Number(soil0[i]));
                }
            }
            if (vals0.length) {
                const minSoil = Math.min(...vals0);
                if (minSoil <= 0) {
                    highlights.push(isUk
                        ? `у ${dayName} заморозки на ґрунті (до ${minSoil.toFixed(1)}°C)`
                        : `on ${dayName} soil frost (down to ${minSoil.toFixed(1)}°C)`);
                }
            }
        });

        // Закрити останній діапазон високого тиску
        if (highPressureStart !== null) {
            if (highPressureStart === highPressureEnd) {
                highPressureDays.push(isUk
                    ? `у ${highPressureStart} високий тиск 🔴`
                    : `on ${highPressureStart} high pressure 🔴`);
            } else {
                highPressureDays.push(isUk
                    ? `у ${highPressureStart}–${highPressureEnd} високий тиск 🔴`
                    : `on ${highPressureStart}–${highPressureEnd} high pressure 🔴`);
            }
        }

        // Об'єднати highlights + high pressure
        const allHighlights = [...highlights, ...highPressureDays];

        let highlightText = '';
        if (allHighlights.length > 0) {
            // Перша літера велика, решта через кому
            const joined = allHighlights.map((h, i) => i === 0 ? h.charAt(0).toUpperCase() + h.slice(1) : h).join(', ');
            highlightText = joined + '.';
        } else {
            highlightText = isUk
                ? 'Особливих небезпек не передбачається.'
                : 'No significant hazards expected.';
        }

        const citeText = isUk
            ? 'Парасоль☔️ підказує, на що звернути увагу. Гортай вбік, щоб переглянути прогноз на всі дні'
            : 'Parasol☔️ highlights what to watch. Swipe sideways to see the full forecast';

        // ========== 4. Таблиця ==========
        // Заголовки днів
        const dayHeaders = userForecast.map((day) => {
            const dateObj = new Date(day.valid_date || day.datetime);
            const dayStr = dateObj.toLocaleDateString(fDict[lang].loc, {
                weekday: 'short', day: 'numeric', month: 'short'
            });
            const capDay = dayStr.charAt(0).toUpperCase() + dayStr.slice(1);
            return `<th width="125" align="center" valign="middle">📅 ${capDay}</th>`;
        }).join('');

        // Рядки таблиці за метриками
        const rows = [];

        // Стан неба
        if (metrics.includes('condition')) {
            const cells = userForecast.map((day) => {
                const desc = getWeatherDesc(day.weather.code, lang) || '';
                // Прибираємо markdown ** якщо є
                const clean = desc.replace(/\*\*/g, '');
                return `<td align="center" valign="middle">${clean}</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>${isUk ? 'Стан неба' : 'Sky'}</b></td>${cells}</tr>`);
        }

        // Температура
        if (metrics.includes('temp')) {
            const cells = userForecast.map((day) => {
                return `<td align="center" valign="middle">${formatTemp(day.min_temp, tempUnit)} ... ${formatTemp(day.max_temp, tempUnit)}</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>🌡 ${isUk ? 'Темп' : 'Temp'}</b></td>${cells}</tr>`);
        }

        // Ґрунт 0 см
        if (metrics.includes('soil0')) {
            const cells = userForecast.map((day) => {
                const dStrSoil = String(day.valid_date || day.datetime || '').slice(0, 10);
                const vals = [];
                for (let i = 0; i < soilTimes.length; i++) {
                    if (String(soilTimes[i]).startsWith(dStrSoil) && soil0[i] != null && !Number.isNaN(Number(soil0[i]))) {
                        vals.push(Number(soil0[i]));
                    }
                }
                if (!vals.length) return `<td align="center" valign="middle">—</td>`;
                const mn = Math.min(...vals);
                const mx = Math.max(...vals);
                const fmt = (v) => {
                    const s = v > 0 ? '+' : '';
                    return `${s}${v.toFixed(1)}°C`;
                };
                return `<td align="center" valign="middle">${fmt(mn)} ...<br>${fmt(mx)}</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>🌱 ${isUk ? 'Ґрунт 0 см' : 'Soil 0 cm'}</b></td>${cells}</tr>`);
        }

        // Ґрунт 6 см
        if (metrics.includes('soil6')) {
            const cells = userForecast.map((day) => {
                const dStrSoil = String(day.valid_date || day.datetime || '').slice(0, 10);
                const vals = [];
                for (let i = 0; i < soilTimes.length; i++) {
                    if (String(soilTimes[i]).startsWith(dStrSoil) && soil6[i] != null && !Number.isNaN(Number(soil6[i]))) {
                        vals.push(Number(soil6[i]));
                    }
                }
                if (!vals.length) return `<td align="center" valign="middle">—</td>`;
                const mn = Math.min(...vals);
                const mx = Math.max(...vals);
                const fmt = (v) => {
                    const s = v > 0 ? '+' : '';
                    return `${s}${v.toFixed(1)}°C`;
                };
                return `<td align="center" valign="middle">${fmt(mn)} ...<br>${fmt(mx)}</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>🌱 ${isUk ? 'Ґрунт 6 см' : 'Soil 6 cm'}</b></td>${cells}</tr>`);
        }

        // Вірогідність опадів
        if (metrics.includes('precip')) {
            const cells = userForecast.map((day) => {
                const precip = (Number(day.precip) || 0).toFixed(1);
                return `<td align="center" valign="middle">${day.pop}%<br><small>(${precip} мм)</small></td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>💧 ${isUk ? 'Вірог. опадів' : 'Precip'}</b></td>${cells}</tr>`);
        }

        // Вітер
        if (metrics.includes('wind')) {
            const cells = userForecast.map((day) => {
                return `<td align="center" valign="middle">${formatWind(day.wind_spd, day.wind_gust_spd, day.wind_cdir, user.units?.wind || 'ms', lang)}</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>💨 ${isUk ? 'Вітер' : 'Wind'}</b></td>${cells}</tr>`);
        }

        // Тиск
        if (metrics.includes('pressure')) {
            const cells = userForecast.map((day) => {
                return `<td align="center" valign="middle">${formatPress(day.pres, day.slp || day.pres, user.units?.pressure || 'mmhg', lang)}</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>🧭 ${isUk ? 'Тиск' : 'Pressure'}</b></td>${cells}</tr>`);
        }

        // Точка роси
        if (metrics.includes('dew')) {
            const cells = userForecast.map((day) => {
                return `<td align="center" valign="middle">${formatTemp(day.dewpt, tempUnit)}</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>🌡 ${isUk ? 'Точка роси' : 'Dew Point'}</b></td>${cells}</tr>`);
        }

        // УФ
        if (metrics.includes('uv')) {
            const cells = userForecast.map((day) => {
                return `<td align="center" valign="middle">${formatUV(day.uv)}</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>☀️ ${isUk ? 'УФ-індекс' : 'UV Index'}</b></td>${cells}</tr>`);
        }

        // Видимість
        if (metrics.includes('visibility')) {
            const cells = userForecast.map((day) => {
                return `<td align="center" valign="middle">${Math.round(day.vis)} км</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>👁 ${isUk ? 'Видимість' : 'Visibility'}</b></td>${cells}</tr>`);
        }

        // Місяць
        if (metrics.includes('moon')) {
            const cells = userForecast.map((day) => {
                const dObj = new Date(day.valid_date || day.datetime);
                return `<td align="center" valign="middle">${formatMoon(dObj, lang)}</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>${isUk ? 'Місяць' : 'Moon'}</b></td>${cells}</tr>`);
        }

        // Сонце
        if (metrics.includes('sun')) {
            const cells = userForecast.map((day) => {
                const sunrise = new Date(day.sunrise_ts * 1000).toLocaleTimeString('uk-UA', {
                    hour: '2-digit', minute: '2-digit', timeZone: user.timezone || 'Europe/Kyiv'
                });
                const sunset = new Date(day.sunset_ts * 1000).toLocaleTimeString('uk-UA', {
                    hour: '2-digit', minute: '2-digit', timeZone: user.timezone || 'Europe/Kyiv'
                });
                return `<td align="center" valign="middle">${sunrise}<br>${sunset}</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>🌅 ${isUk ? 'Сонце' : 'Sun'}</b></td>${cells}</tr>`);
        }

        // Магнітні бурі
        if (metrics.includes('geomag')) {
            const cells = userForecast.map((day) => {
                const dayDate = String(day.valid_date || day.datetime || '').slice(0, 10);
                const kp = geomagByDate[dayDate];
                const level = getGeomagLevel(kp);
                if (level) {
                    const label = isUk ? level.labelUk : level.labelEn;
                    return `<td align="center" valign="middle">${level.badge} ${label}</td>`;
                }
                return `<td align="center" valign="middle">—</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>🧲 ${isUk ? 'Магн. бурі' : 'Geomag'}</b></td>${cells}</tr>`);
        }

        const tableHtml = `
<table bordered striped>
  <thead>
    <tr>
      <th width="110" align="left" valign="middle">${isUk ? 'Показник' : 'Metric'}</th>
      ${dayHeaders}
    </tr>
  </thead>
  <tbody>
    ${rows.join('\n    ')}
  </tbody>
</table>`.trim();

        // ========== 5. Збірка повного HTML ==========
        let fullHtml = '';

        if (aqiHtml) {
            fullHtml += aqiHtml + '\n\n';
        }
        if (frostHtml) {
            fullHtml += frostHtml + '\n\n';
        }

        fullHtml += `<h1>🧪 ${isUk ? 'ТЕСТОВИЙ прогноз' : 'TEST forecast'} на ${settings.daysCount} дн. для ${escapeHTML(displayCity)}</h1>\n\n`;

        fullHtml += `<aside>${escapeHTML(highlightText)}<br>
  <cite>${citeText}</cite>
</aside>\n\n`;

        fullHtml += tableHtml;

        // ========== 6. Відправка Rich Message ==========
        try {
            await bot.api.sendRichMessage(user.telegramId, {
                html: fullHtml,
                skip_entity_detection: true
            }, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: isUk ? `🌤 Погод.прогноз на ${targetHourlyShort}` : `🌤 Weather forecast for ${targetHourlyShort}`, callback_data: `forecast_hourly|${targetHourlyStr}` }],
                        [{ text: isUk ? '🧲 Прогноз магнітних бур' : '🧲 Geomagnetic storm forecast', callback_data: 'geomag_fc' }],
                        [{ text: isUk ? '🌱 Рекомендації на завтра' : '🌱 Agro-recommendations for tomorrow', callback_data: 'agro_tomorrow' }],
                        [{ text: isUk ? '⚙️ Налаштувати прогноз' : '⚙️ Configure forecast', callback_data: 'forecast_menu' }]
                    ]
                }
            });
        } catch (sendErr) {
            console.error('sendRichMessage failed, fallback to plain:', sendErr.message);
            // Fallback: plain text version
            const plain = fullHtml
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            await bot.api.sendMessage(user.telegramId, plain, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: isUk ? `🌤 Погод.прогноз на ${targetHourlyShort}` : `🌤 Weather forecast for ${targetHourlyShort}`, callback_data: `forecast_hourly|${targetHourlyStr}` }],
                        [{ text: isUk ? '🧲 Прогноз магнітних бур' : '🧲 Geomagnetic storm forecast', callback_data: 'geomag_fc' }],
                        [{ text: isUk ? '🌱 Рекомендації на завтра' : '🌱 Agro-recommendations for tomorrow', callback_data: 'agro_tomorrow' }],
                        [{ text: isUk ? '⚙️ Налаштувати прогноз' : '⚙️ Configure forecast', callback_data: 'forecast_menu' }]
                    ]
                }
            }).catch(() => {});
        }

        await log(`🧪 <b>Тестовий прогноз (Rich)</b> — ${startTime}\nНадіслано тільки user ${TEST_USER_ID}`);
        res.status(200).send(`Test forecast (Rich Message) sent to ${TEST_USER_ID}`);
    } catch (error) {
        console.error(error);
        await log(`❌ <b>Test forecast FAILED</b>\n<code>${escapeHTML(error.message)}</code>`);
        res.status(500).send('Test forecast error');
    }
};
