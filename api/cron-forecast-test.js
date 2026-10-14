require('dotenv').config();
const axios = require('axios');
const getBot = require('../utils/bot');
const bot = getBot();
const logToTelegram = require('../utils/logger');
const User = require('../models/User');
const connectDB = require('../utils/db');
const { getWeatherDesc, getWindDir, getSoilFrostInfo, frostWarningText, getGeomagLevel, fetchMeteoAlarmAlerts } = require('../utils/weather');
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

            // Multi-line for table cells: dir / speed / gusts
            let html = `${dirStr},<br>${Math.round(spdVal)} ${unitStr}`;
            if (Math.round(gustVal) > Math.round(spdVal)) {
                html += `<br>(${fDict[lang].gustsTo} ${Math.round(gustVal)})`;
            }
            return html;
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

            // Multi-line for table cells: value / slp / unit / indicator
            return `${presVal}<br>(slp: ${slpVal})<br>${unitStr}<br>${indicator}`;
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

        // --- Official weather alerts (UA Hydrometcenter via MeteoAlarm CAP) ---
        let meteoAlerts = [];
        try {
            meteoAlerts = await fetchMeteoAlarmAlerts(user.lat, user.lon, lang);
        } catch (e) {
            console.error('Test forecast MeteoAlarm error:', e.message);
        }

        // --- Open-Meteo Air Quality (test: full set of metrics for table) ---
        // Hourly CAMS → daily max/mean per calendar day
        let omAqByDate = {}; // { 'YYYY-MM-DD': { eaqlMax, usAqiMax, pm25Max, pm10Max, no2Max, o3Max, so2Max, coMax, dustMax } }
        try {
            const aqUrl =
                `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${user.lat}&longitude=${user.lon}` +
                `&hourly=european_aqi,us_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,sulphur_dioxide,carbon_monoxide,dust` +
                `&timezone=auto&forecast_days=7`;
            const aqRes = await axios.get(aqUrl, { timeout: 12000 });
            const h = aqRes.data?.hourly || {};
            const times = h.time || [];
            const pickMax = (arr, i) => {
                const v = arr?.[i];
                return v == null || Number.isNaN(Number(v)) ? null : Number(v);
            };
            for (let i = 0; i < times.length; i++) {
                const dStr = String(times[i]).slice(0, 10);
                if (!omAqByDate[dStr]) {
                    omAqByDate[dStr] = {
                        eaqiMax: null, usAqiMax: null,
                        pm25Max: null, pm10Max: null,
                        no2Max: null, o3Max: null, so2Max: null, coMax: null, dustMax: null
                    };
                }
                const row = omAqByDate[dStr];
                const bump = (key, val) => {
                    if (val == null) return;
                    if (row[key] == null || val > row[key]) row[key] = val;
                };
                bump('eaqiMax', pickMax(h.european_aqi, i));
                bump('usAqiMax', pickMax(h.us_aqi, i));
                bump('pm25Max', pickMax(h.pm2_5, i));
                bump('pm10Max', pickMax(h.pm10, i));
                bump('no2Max', pickMax(h.nitrogen_dioxide, i));
                bump('o3Max', pickMax(h.ozone, i));
                bump('so2Max', pickMax(h.sulphur_dioxide, i));
                bump('coMax', pickMax(h.carbon_monoxide, i));
                bump('dustMax', pickMax(h.dust, i));
            }
        } catch (e) {
            console.error('Test forecast Open-Meteo AQ error:', e.message);
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
        // Українські дні у знахідному відмінку після прийменника «у»
        // Надійніше через getDay() — locale інколи віддає різний апостроф у «п'ятниця»
        const dayAccusativeByIndex = [
            'неділю',    // 0 Sunday
            'понеділок', // 1
            'вівторок',  // 2
            'середу',    // 3
            'четвер',    // 4
            "п'ятницю",  // 5
            'суботу'     // 6
        ];

        const getDayForPreposition = (dateObj) => {
            if (!isUk) {
                return dateObj.toLocaleDateString('en-US', { weekday: 'long' });
            }
            const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
            const idx = d.getDay();
            return dayAccusativeByIndex[idx] || dateObj.toLocaleDateString('uk-UA', { weekday: 'long' }).toLowerCase();
        };

        const highlights = [];
        const highPressureDays = [];
        let highPressureStart = null; // accusative form
        let highPressureEnd = null;

        userForecast.forEach((day) => {
            const rawDate = day.valid_date || day.datetime || '';
            // Полудень UTC-safe, щоб weekday не з’їжджав через TZ
            const dateObj = new Date(rawDate.includes('T') ? rawDate : `${String(rawDate).slice(0, 10)}T12:00:00`);
            const dayName = getDayForPreposition(dateObj); // уже у потрібному відмінку

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
                // label часто з великої («Слабка буря…») — маленька + «магнітна» для ясності
                let labelMid = label.charAt(0).toLowerCase() + label.slice(1);
                if (isUk) {
                    // No \b — JS word boundaries ignore Cyrillic
                    if (!labelMid.includes('магніт')) {
                        labelMid = labelMid
                            .replace('буря', 'магнітна буря')
                            .replace('шторм', 'магнітний шторм');
                    }
                } else if (!/magnetic/i.test(labelMid)) {
                    labelMid = labelMid.replace(/\bstorm\b/i, 'magnetic storm');
                }
                highlights.push(isUk
                    ? `у ${dayName} ${labelMid}`
                    : `on ${dayName} ${labelMid}`);
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

            // УФ-індекс (≥6 високий, ≥8 дуже високий, >10 екстремальний)
            const uv = Number(day.uv);
            if (!Number.isNaN(uv) && uv >= 6) {
                const uvR = Math.round(uv);
                if (uv > 10) {
                    highlights.push(isUk
                        ? `у ${dayName} екстремальний УФ-індекс (${uvR}) 🟣`
                        : `on ${dayName} extreme UV index (${uvR}) 🟣`);
                } else if (uv >= 8) {
                    highlights.push(isUk
                        ? `у ${dayName} дуже високий УФ-індекс (${uvR}) 🔴`
                        : `on ${dayName} very high UV index (${uvR}) 🔴`);
                } else {
                    highlights.push(isUk
                        ? `у ${dayName} високий УФ-індекс (${uvR}) 🟠`
                        : `on ${dayName} high UV index (${uvR}) 🟠`);
                }
            }

            // --- Open-Meteo Air Quality tips (модель CAMS, денний max) ---
            const dStrAq = String(day.valid_date || day.datetime || '').slice(0, 10);
            const aq = omAqByDate[dStrAq];
            if (aq) {
                const issues = [];
                // М’якші пороги для підказки (коли вже є підвищений EAQI)
                if (aq.pm25Max != null && aq.pm25Max >= 12) {
                    issues.push(isUk
                        ? `дрібний пил/смог PM2.5 до ${aq.pm25Max.toFixed(0)} µg/m³`
                        : `fine dust/smog PM2.5 up to ${aq.pm25Max.toFixed(0)} µg/m³`);
                }
                if (aq.pm10Max != null && aq.pm10Max >= 25) {
                    issues.push(isUk
                        ? `великий пил PM10 до ${aq.pm10Max.toFixed(0)} µg/m³`
                        : `coarse dust PM10 up to ${aq.pm10Max.toFixed(0)} µg/m³`);
                }
                if (aq.dustMax != null && aq.dustMax >= 15) {
                    issues.push(isUk
                        ? `пилова хмара (dust) до ${aq.dustMax.toFixed(0)} µg/m³`
                        : `dust plume up to ${aq.dustMax.toFixed(0)} µg/m³`);
                }
                if (aq.no2Max != null && aq.no2Max >= 40) {
                    issues.push(isUk
                        ? `викиди NO₂ до ${aq.no2Max.toFixed(0)} µg/m³`
                        : `NO₂ emissions up to ${aq.no2Max.toFixed(0)} µg/m³`);
                }
                if (aq.o3Max != null && aq.o3Max >= 100) {
                    issues.push(isUk
                        ? `підвищений озон O₃ до ${aq.o3Max.toFixed(0)} µg/m³`
                        : `elevated ozone O₃ up to ${aq.o3Max.toFixed(0)} µg/m³`);
                }
                if (aq.so2Max != null && aq.so2Max >= 30) {
                    issues.push(isUk
                        ? `SO₂ до ${aq.so2Max.toFixed(0)} µg/m³`
                        : `SO₂ up to ${aq.so2Max.toFixed(0)} µg/m³`);
                }

                // EAQI як загальний рівень
                if (aq.eaqiMax != null && aq.eaqiMax >= 40) {
                    const badge = aq.eaqiMax > 80 ? '🔴' : aq.eaqiMax > 60 ? '🟠' : '🟡';
                    // Якщо issues порожній — все одно показуємо головний вкладник (PM2.5)
                    let detail = '';
                    if (issues.length) {
                        detail = ': ' + issues.join(', ');
                    } else if (aq.pm25Max != null) {
                        detail = isUk
                            ? `: дрібний пил/смог PM2.5 до ${aq.pm25Max.toFixed(0)} µg/m³`
                            : `: fine dust/smog PM2.5 up to ${aq.pm25Max.toFixed(0)} µg/m³`;
                    }
                    highlights.push(isUk
                        ? `у ${dayName} погана якість повітря (EAQI ${Math.round(aq.eaqiMax)}) ${badge}${detail}`
                        : `on ${dayName} poor air quality (EAQI ${Math.round(aq.eaqiMax)}) ${badge}${detail}`);
                } else if (issues.length) {
                    highlights.push(isUk
                        ? `у ${dayName} ${issues.join(', ')}`
                        : `on ${dayName} ${issues.join(', ')}`);
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

        // Official UA Hydrometcenter alerts (MeteoAlarm) — prepend to tips block
        if (meteoAlerts.length > 0) {
            const alertHeader = isUk
                ? '⚠️ Офіційне попередження Укргідрометцентру:'
                : '⚠️ Official Hydrometcenter warning:';
            const alertLines = meteoAlerts.slice(0, 4).map((a) => a.line).join('\n');
            // Порожній рядок після алертів — відділяє від самарі «Парасоль»
            highlightText = `${alertHeader}\n${alertLines}\n\n${highlightText}`;
        }

        const citeText = isUk
            ? 'Парасоль☔️ підказує, на що звернути увагу. Гортай вбік, щоб переглянути прогноз на всі дні'
            : 'Parasol☔️ highlights what to watch. Swipe sideways to see the full forecast';

        // ========== 4. Таблиця ==========
        // Заголовки днів — коротший формат + <br>, щоб стовпці були вужчі
        const dayHeaders = userForecast.map((day) => {
            const dateObj = new Date(day.valid_date || day.datetime);
            const weekday = dateObj.toLocaleDateString(fDict[lang].loc, { weekday: 'short' });
            const dayNum = dateObj.toLocaleDateString(fDict[lang].loc, { day: 'numeric', month: 'short' });
            const capWeek = weekday.charAt(0).toUpperCase() + weekday.slice(1);
            return `<th width="90" align="center" valign="middle">📅 ${capWeek}<br>${dayNum}</th>`;
        }).join('');

        // Рядки таблиці за метриками (з <br> у довгих написах і значеннях)
        const rows = [];

        // Стан неба — розбиваємо довгі описи по пробілу/дефісу якщо дуже довгі
        if (metrics.includes('condition')) {
            const cells = userForecast.map((day) => {
                const desc = getWeatherDesc(day.weather.code, lang) || '';
                const clean = desc.replace(/\*\*/g, '');
                // Якщо є пробіл — ставимо <br> після першого слова (іконка + коротке слово)
                const parts = clean.split(/\s+/);
                const cell = parts.length > 2
                    ? `${parts[0]} ${parts[1]}<br>${parts.slice(2).join(' ')}`
                    : clean;
                return `<td align="center" valign="middle">${cell}</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>${isUk ? 'Стан<br>неба' : 'Sky'}</b></td>${cells}</tr>`);
        }

        // Температура
        if (metrics.includes('temp')) {
            const cells = userForecast.map((day) => {
                return `<td align="center" valign="middle">${formatTemp(day.min_temp, tempUnit)} ...<br>${formatTemp(day.max_temp, tempUnit)}</td>`;
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
            rows.push(`<tr><td align="left" valign="middle"><b>🌱 ${isUk ? 'Ґрунт<br>0 см' : 'Soil<br>0 cm'}</b></td>${cells}</tr>`);
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
            rows.push(`<tr><td align="left" valign="middle"><b>🌱 ${isUk ? 'Ґрунт<br>6 см' : 'Soil<br>6 cm'}</b></td>${cells}</tr>`);
        }

        // Вірогідність опадів
        if (metrics.includes('precip')) {
            const cells = userForecast.map((day) => {
                const precip = (Number(day.precip) || 0).toFixed(1);
                return `<td align="center" valign="middle">${day.pop}%<br><small>(${precip} мм)</small></td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>💧 ${isUk ? 'Вірог.<br>опадів' : 'Precip'}</b></td>${cells}</tr>`);
        }

        // Вітер — напрямок / швидкість / пориви (formatWind already has <br>)
        if (metrics.includes('wind')) {
            const cells = userForecast.map((day) => {
                const windStr = formatWind(day.wind_spd, day.wind_gust_spd, day.wind_cdir, user.units?.wind || 'ms', lang);
                return `<td align="center" valign="middle">${windStr}</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>💨 ${isUk ? 'Вітер' : 'Wind'}</b></td>${cells}</tr>`);
        }

                // Тиск — значення / slp / одиниця / індикатор (formatPress already has <br>)
        if (metrics.includes('pressure')) {
            const cells = userForecast.map((day) => {
                const pressStr = formatPress(day.pres, day.slp || day.pres, user.units?.pressure || 'mmhg', lang);
                return `<td align="center" valign="middle">${pressStr}</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>🧭 ${isUk ? 'Тиск' : 'Pressure'}</b></td>${cells}</tr>`);
        }

        // Точка роси
        if (metrics.includes('dew')) {
            const cells = userForecast.map((day) => {
                return `<td align="center" valign="middle">${formatTemp(day.dewpt, tempUnit)}</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>🌡 ${isUk ? 'Точка<br>роси' : 'Dew<br>Point'}</b></td>${cells}</tr>`);
        }

        // УФ
        if (metrics.includes('uv')) {
            const cells = userForecast.map((day) => {
                return `<td align="center" valign="middle">${formatUV(day.uv)}</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>☀️ ${isUk ? 'УФ-<br>індекс' : 'UV<br>Index'}</b></td>${cells}</tr>`);
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
                const moon = formatMoon(dObj, lang);
                // "🌑 Новий місяць" → іконка + <br> + назва
                const m = moon.match(/^(\S+)\s+(.+)$/);
                if (m) {
                    return `<td align="center" valign="middle">${m[1]}<br>${m[2]}</td>`;
                }
                return `<td align="center" valign="middle">${moon}</td>`;
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
                    // 🟠<br>Слабка буря G1<br>(Kp 5)
                    const m = String(label).match(/^(.+?)\s*(\(Kp\s*\d+\))\s*$/i);
                    const body = m
                        ? `${m[1]}<br>${m[2]}`
                        : label;
                    return `<td align="center" valign="middle">${level.badge}<br>${body}</td>`;
                }
                return `<td align="center" valign="middle">—</td>`;
            }).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>🧲 ${isUk ? 'Магн.<br>бурі' : 'Geomag'}</b></td>${cells}</tr>`);
        }

        // --- Open-Meteo Air Quality rows (TEST only — always shown) ---
        // Пороги орієнтовні (WHO/EEA daily): 🟢 добре → 🟡 помірно → 🟠 погано → 🔴 небезпечно
        const aqBadgeFor = (key, v) => {
            if (v == null || Number.isNaN(Number(v))) return '';
            const n = Number(v);
            const bands = {
                eaqiMax:  [20, 40, 60, 80],   // European AQI
                usAqiMax: [50, 100, 150, 200], // US AQI
                pm25Max:  [12, 25, 50, 75],
                pm10Max:  [30, 50, 90, 150],
                no2Max:   [40, 70, 120, 200],
                o3Max:    [80, 120, 160, 200],
                so2Max:   [20, 40, 100, 200],
                coMax:    [2000, 4000, 10000, 20000],
                dustMax:  [15, 40, 80, 150]
            };
            const b = bands[key] || [25, 50, 100, 200];
            if (n <= b[0]) return '🟢';
            if (n <= b[1]) return '🟡';
            if (n <= b[2]) return '🟠';
            if (n <= b[3]) return '🔴';
            return '🟣';
        };
        const aqCell = (day, key, decimals = 0) => {
            const dStr = String(day.valid_date || day.datetime || '').slice(0, 10);
            const v = omAqByDate[dStr]?.[key];
            if (v == null) return `<td align="center" valign="middle">—</td>`;
            const n = decimals > 0 ? Number(v).toFixed(decimals) : String(Math.round(Number(v)));
            const badge = aqBadgeFor(key, v);
            return `<td align="center" valign="middle">${badge}<br>${n}</td>`;
        };

        const aqRows = [
            ['eaqiMax', isUk ? 'EAQI<br><small>OM max</small>' : 'EAQI<br><small>OM max</small>', 0],
            ['usAqiMax', isUk ? 'US AQI<br><small>OM max</small>' : 'US AQI<br><small>OM max</small>', 0],
            ['pm25Max', 'PM2.5<br><small>µg/m³</small>', 1],
            ['pm10Max', 'PM10<br><small>µg/m³</small>', 1],
            ['no2Max', 'NO₂<br><small>µg/m³</small>', 1],
            ['o3Max', 'O₃<br><small>µg/m³</small>', 1],
            ['so2Max', 'SO₂<br><small>µg/m³</small>', 1],
            ['coMax', 'CO<br><small>µg/m³</small>', 0],
            ['dustMax', isUk ? 'Пил<br><small>dust</small>' : 'Dust<br><small>µg/m³</small>', 1]
        ];
        for (const [key, label, dec] of aqRows) {
            const cells = userForecast.map((day) => aqCell(day, key, dec)).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>🍃 ${label}</b></td>${cells}</tr>`);
        }

        const tableHtml = `
<table bordered striped>
  <thead>
    <tr>
      <th width="80" align="left" valign="middle">${isUk ? 'Показник' : 'Metric'}</th>
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

        fullHtml += `<aside>${escapeHTML(highlightText).replace(/\n/g, '<br>')}<br>
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
                        [
                            { text: isUk ? '🌤 Погод. прогноз' : '🌤 Weather', callback_data: `forecast_hourly|${targetHourlyStr}` },
                            { text: isUk ? 'Прогноз Tomorrow.io' : 'Tomorrow.io', callback_data: `forecast_verify|${targetHourlyStr}` }
                        ],
                        [
                            { text: isUk ? '🧲 Магнітні бурі' : '🧲 Magnetic storms', callback_data: 'geomag_fc' },
                            { text: isUk ? '🌱 Рекомендації' : '🌱 Tips', callback_data: 'agro_tomorrow' }
                        ],
                        [
                            { text: isUk ? '⚙️ Налаштувати прогноз' : '⚙️ Configure forecast', callback_data: 'forecast_menu' }
                        ]
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
                        [
                            { text: isUk ? '🌤 Погод. прогноз' : '🌤 Weather', callback_data: `forecast_hourly|${targetHourlyStr}` },
                            { text: isUk ? 'Прогноз Tomorrow.io' : 'Tomorrow.io', callback_data: `forecast_verify|${targetHourlyStr}` }
                        ],
                        [
                            { text: isUk ? '🧲 Магнітні бурі' : '🧲 Magnetic storms', callback_data: 'geomag_fc' },
                            { text: isUk ? '🌱 Рекомендації' : '🌱 Tips', callback_data: 'agro_tomorrow' }
                        ],
                        [
                            { text: isUk ? '⚙️ Налаштувати прогноз' : '⚙️ Configure forecast', callback_data: 'forecast_menu' }
                        ]
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
