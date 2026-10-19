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
        // Якість повітря: три окремі опції (+ legacy 'aqi' = усі три)
        const hasAqiNow  = metrics.includes('aqi_now')  || metrics.includes('aqi');
        const hasAqiMain = metrics.includes('aqi_main') || metrics.includes('aqi');
        const hasAqiExt  = metrics.includes('aqi_ext')  || metrics.includes('aqi');
        // OM AQ завжди тягнемо для підказок «Парасоль»; таблиця — лише за опціями
        const needOmAq   = true;

        // --- Weatherbit ---
        const response = await axios.get(
            `https://api.weatherbit.io/v2.0/forecast/daily?lat=${user.lat}&lon=${user.lon}&key=${API_KEY}&days=7`
        );
        const fullResponse = response.data.data;
        const apiCityName = response.data.city_name || user.city;

        // --- AQI «зараз»: WAQI якщо станція ≤ 10 км, інакше Open-Meteo current ---
        let aqiData = null;
        const WAQI_MAX_KM = 10;
        const haversineKm = (lat1, lon1, lat2, lon2) => {
            const toRad = (x) => x * Math.PI / 180;
            const R = 6371;
            const dLat = toRad(lat2 - lat1);
            const dLon = toRad(lon2 - lon1);
            const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        };
        const badgeFromUsAqi = (v) => {
            if (v == null || Number.isNaN(Number(v))) return '🟢';
            const n = Number(v);
            if (n > 150) return '🔴';
            if (n > 100) return '🟠';
            if (n > 50) return '🟡';
            return '🟢';
        };
        const badgeFromEaqi = (v) => {
            if (v == null || Number.isNaN(Number(v))) return '🟢';
            const n = Number(v);
            if (n > 80) return '🔴';
            if (n > 60) return '🟠';
            if (n > 40) return '🟡';
            if (n > 20) return '🟢';
            return '🟢';
        };

        if (hasAqiNow) {
            const WAQI_TOKEN = process.env.WAQI_TOKEN;
            // 1) Спробувати WAQI, прийняти лише близьку станцію
            if (WAQI_TOKEN) {
                try {
                    const waqiRes = await axios.get(
                        `https://api.waqi.info/feed/geo:${user.lat};${user.lon}/?token=${WAQI_TOKEN}`,
                        { timeout: 8000 }
                    );
                    if (waqiRes.data?.status === 'ok') {
                        const d = waqiRes.data.data;
                        const geo = Array.isArray(d.city?.geo) ? d.city.geo : null;
                        let distKm = null;
                        if (geo && geo.length >= 2) {
                            distKm = haversineKm(user.lat, user.lon, Number(geo[0]), Number(geo[1]));
                        }
                        if (distKm != null && distKm <= WAQI_MAX_KM) {
                            const aqiVal = d.aqi;
                            aqiData = {
                                provider: 'waqi',
                                aqi: aqiVal,
                                aqiLabel: 'AQI',
                                badge: badgeFromUsAqi(aqiVal),
                                pm25: d.iaqi?.pm25?.v ?? null,
                                pm10: d.iaqi?.pm10?.v ?? null,
                                station: d.city?.name || null,
                                stationUrl: d.city?.url || null,
                                stationGeo: geo,
                                stationId: d.idx ?? null,
                                source: d.attributions?.[0]?.name || null,
                                dominant: d.dominentpol || null,
                                distKm: Math.round(distKm * 10) / 10
                            };
                        } else {
                            console.log(`WAQI station too far (${distKm != null ? distKm.toFixed(1) : '?'} km), fallback to Open-Meteo`);
                        }
                    }
                } catch (e) {
                    console.error('WAQI error:', e.message);
                }
            }

            // 2) Fallback — Open-Meteo current (модель CAMS по координатах)
            if (!aqiData) {
                try {
                    const omCurUrl =
                        `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${user.lat}&longitude=${user.lon}` +
                        `&current=european_aqi,us_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,sulphur_dioxide,dust` +
                        `&timezone=auto`;
                    const omCurRes = await axios.get(omCurUrl, { timeout: 10000 });
                    const cur = omCurRes.data?.current || {};
                    const eaqi = cur.european_aqi != null ? Number(cur.european_aqi) : null;
                    const usAqi = cur.us_aqi != null ? Number(cur.us_aqi) : null;
                    const aqiVal = usAqi != null ? usAqi : eaqi;
                    const aqiLabel = usAqi != null ? 'US AQI' : 'EAQI';
                    aqiData = {
                        provider: 'open-meteo',
                        aqi: aqiVal,
                        aqiLabel,
                        badge: usAqi != null ? badgeFromUsAqi(usAqi) : badgeFromEaqi(eaqi),
                        pm25: cur.pm2_5 != null ? Number(cur.pm2_5) : null,
                        pm10: cur.pm10 != null ? Number(cur.pm10) : null,
                        station: null,
                        stationUrl: null,
                        stationGeo: [user.lat, user.lon],
                        stationId: null,
                        source: 'Open-Meteo · CAMS (модель)',
                        dominant: null,
                        distKm: 0,
                        eaqi,
                        usAqi
                    };
                } catch (e) {
                    console.error('Open-Meteo current AQ error:', e.message);
                }
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

        // --- Open-Meteo Air Quality (лише якщо aqi_main / aqi_ext) ---
        // Hourly CAMS → daily max per calendar day
        let omAqByDate = {}; // { 'YYYY-MM-DD': { eaqiMax, usAqiMax, pm25Max, pm10Max, no2Max, o3Max, so2Max, coMax, dustMax } }
        if (needOmAq) {
        try {
            const aqUrl =
                `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${user.lat}&longitude=${user.lon}` +
                `&hourly=european_aqi,us_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,sulphur_dioxide,carbon_monoxide,dust,` +
                `ammonia,aerosol_optical_depth,methane,` +
                `alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen,` +
                `pm10_wildfires,total_elementary_carbon` +
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
                        no2Max: null, o3Max: null, so2Max: null, coMax: null, dustMax: null,
                        nh3Max: null, aodMax: null, ch4Max: null,
                        alderMax: null, birchMax: null, grassMax: null, mugwortMax: null, oliveMax: null, ragweedMax: null,
                        wildfireMax: null, ecTotalMax: null
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
                bump('nh3Max', pickMax(h.ammonia, i));
                bump('aodMax', pickMax(h.aerosol_optical_depth, i));
                bump('ch4Max', pickMax(h.methane, i));
                bump('alderMax', pickMax(h.alder_pollen, i));
                bump('birchMax', pickMax(h.birch_pollen, i));
                bump('grassMax', pickMax(h.grass_pollen, i));
                bump('mugwortMax', pickMax(h.mugwort_pollen, i));
                bump('oliveMax', pickMax(h.olive_pollen, i));
                bump('ragweedMax', pickMax(h.ragweed_pollen, i));
                bump('wildfireMax', pickMax(h.pm10_wildfires, i));
                bump('ecTotalMax', pickMax(h.total_elementary_carbon, i));
            }
        } catch (e) {
            console.error('Test forecast Open-Meteo AQ error:', e.message);
        }
        } // end if (needOmAq)

        // --- Формування повідомлення (Rich Message) ---
        const displayCity = (user.city && user.city !== '..') ? user.city : apiCityName;
        const isUk = lang === 'uk';
        const userForecast = fullResponse.slice(1, 1 + settings.daysCount);

        // ========== 1. AQI prefix ==========
        let aqiHtml = '';
        if (hasAqiNow && aqiData) {
            const idxName = aqiData.aqiLabel || 'AQI';
            const aqiShow = aqiData.aqi != null ? (Number.isInteger(aqiData.aqi) ? aqiData.aqi : Number(aqiData.aqi).toFixed(0)) : '—';
            let summaryLine = isUk
                ? `🍃 <b>Якість повітря (на момент зараз):</b> ${aqiData.badge} ${idxName} ${aqiShow}`
                : `🍃 <b>Air Quality (current moment):</b> ${aqiData.badge} ${idxName} ${aqiShow}`;
            if (aqiData.pm25 != null) summaryLine += ` | PM2.5: ${Number(aqiData.pm25).toFixed(1)}`;
            if (aqiData.pm10 != null) summaryLine += ` | PM10: ${Number(aqiData.pm10).toFixed(1)}`;

            const issues = [];
            if (aqiData.pm25 != null && aqiData.pm25 > 25) {
                issues.push(isUk ? 'PM2.5 (дрібний пил/смог)' : 'PM2.5 (fine dust/smog)');
            }
            if (aqiData.pm10 != null && aqiData.pm10 > 50) {
                issues.push(isUk ? 'PM10 (великий пил)' : 'PM10 (coarse dust)');
            }

            let advice = '';
            // Always US AQI thresholds (50/100/150)
            const bad = aqiData.aqi > 150 ? 3 : aqiData.aqi > 100 ? 2 : aqiData.aqi > 50 ? 1 : 0;
            if (bad === 3) {
                advice = isUk
                    ? '🔴 Небезпечно для всіх! Зачиніть вікна, увімкніть очищувач повітря та обмежте перебування на вулиці.'
                    : '🔴 Unhealthy for everyone! Close windows, turn on air purifiers, and limit outdoor activities.';
            } else if (bad === 2) {
                advice = isUk
                    ? '🟠 Шкідливо для чутливих груп. Рекомендуємо зачинити вікна на ніч.'
                    : '🟠 Unhealthy for sensitive groups. Recommend closing windows for the night.';
            } else if (bad === 1) {
                advice = isUk
                    ? '🟡 Повітря прийнятне, але чутливим людям варто бути обережними.'
                    : '🟡 Air quality is acceptable, but sensitive groups should be cautious.';
            } else if (issues.length > 0) {
                advice = isUk
                    ? '⚠️ Повітря чисте за індексом, але спостерігається підвищення окремих фракцій пилу.'
                    : '⚠️ Index is low, but elevated levels of specific dust particles detected.';
            }
            if (issues.length > 0 && advice) {
                advice += isUk ? ` (Підвищено: ${issues.join(', ')})` : ` (Elevated: ${issues.join(', ')})`;
            }

            // Деталі джерела (згортаються)
            const detailParts = [];
            if (aqiData.provider === 'waqi') {
                if (aqiData.station) {
                    detailParts.push(isUk
                        ? `📍 <b>Станція:</b> ${escapeHTML(String(aqiData.station))}`
                        : `📍 <b>Station:</b> ${escapeHTML(String(aqiData.station))}`);
                }
                if (aqiData.distKm != null) {
                    detailParts.push(isUk
                        ? `📏 <b>Відстань:</b> ${aqiData.distKm} км`
                        : `📏 <b>Distance:</b> ${aqiData.distKm} km`);
                }
                if (aqiData.stationGeo && aqiData.stationGeo.length >= 2) {
                    const [slat, slon] = aqiData.stationGeo;
                    detailParts.push(isUk
                        ? `🗺 <b>Координати станції:</b> ${Number(slat).toFixed(4)}, ${Number(slon).toFixed(4)}`
                        : `🗺 <b>Station coordinates:</b> ${Number(slat).toFixed(4)}, ${Number(slon).toFixed(4)}`);
                }
                if (aqiData.source) {
                    detailParts.push(isUk
                        ? `📡 <b>Джерело:</b> ${escapeHTML(String(aqiData.source))}`
                        : `📡 <b>Source:</b> ${escapeHTML(String(aqiData.source))}`);
                }
                if (aqiData.dominant) {
                    detailParts.push(isUk
                        ? `🧪 <b>Домінуючий забрудник:</b> ${escapeHTML(String(aqiData.dominant).toUpperCase())}`
                        : `🧪 <b>Dominant pollutant:</b> ${escapeHTML(String(aqiData.dominant).toUpperCase())}`);
                }
                if (aqiData.stationUrl) {
                    const url = String(aqiData.stationUrl).startsWith('http')
                        ? aqiData.stationUrl
                        : `https://aqicn.org${aqiData.stationUrl}`;
                    detailParts.push(isUk
                        ? `🔗 <a href="${escapeHTML(url)}">Сторінка станції</a>`
                        : `🔗 <a href="${escapeHTML(url)}">Station page</a>`);
                }
            } else {
                detailParts.push(isUk
                    ? `📡 <b>Джерело:</b> Open-Meteo · CAMS (атмосферна модель)`
                    : `📡 <b>Source:</b> Open-Meteo · CAMS (atmospheric model)`);
                detailParts.push(isUk
                    ? `ℹ️ Немає станції WAQI ближче ${WAQI_MAX_KM} км — показано модельну оцінку для ваших координат`
                    : `ℹ️ No WAQI station within ${WAQI_MAX_KM} km — showing model estimate for your coordinates`);
                if (aqiData.eaqi != null) {
                    detailParts.push(`EAQI: ${Math.round(aqiData.eaqi)}`);
                }
                if (aqiData.usAqi != null) {
                    detailParts.push(`US AQI: ${Math.round(aqiData.usAqi)}`);
                }
            }
            if (advice) detailParts.push(advice);

            if (detailParts.length) {
                aqiHtml = `<details><summary>${summaryLine}</summary><p>${detailParts.join('<br>')}</p></details>`;
            } else {
                aqiHtml = summaryLine;
            }
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

        // ========== 3. Smart highlights (структуровані підказки) ==========
        // Збираємо події по днях, потім ділимо: завтра+післязавтра | решта днів
        const dayEvents = []; // { dayName, dateObj, precip, precipHeavy, gust, highPress, uvLabel, frostLabel, geomagLabel, aqIssues, eaqi, eaqiBadge, skyCode, skyDesc }

        userForecast.forEach((day) => {
            const rawDate = day.valid_date || day.datetime || '';
            const dateObj = new Date(rawDate.includes('T') ? rawDate : `${String(rawDate).slice(0, 10)}T12:00:00`);
            const dayName = getDayForPreposition(dateObj);
            const ev = {
                dayName,
                dateObj,
                precip: 0,
                precipHeavy: false,
                gust: 0,
                highPress: false,
                uvLabel: null,
                frostLabel: null,
                geomagLabel: null,
                aqIssues: [],
                eaqi: null,
                eaqiBadge: null,
                skyCode: day.weather?.code,
                skyDesc: (getWeatherDesc(day.weather?.code, lang) || '').replace(/\*\*/g, '')
            };

            const precip = Number(day.precip) || 0;
            const pop = Number(day.pop) || 0;
            if (precip >= 5) {
                ev.precip = precip;
                ev.precipHeavy = true;
            } else if (precip >= 0.3 || pop >= 40) {
                ev.precip = precip;
                ev.precipHeavy = false;
            }

            const gust = Number(day.wind_gust_spd || day.wind_spd) || 0;
            if (gust >= 7) ev.gust = gust;

            const slp = Number(day.slp || day.pres) || 0;
            if (slp > 1018) ev.highPress = true;

            const dayDate = String(day.valid_date || day.datetime || '').slice(0, 10);
            const kp = geomagByDate[dayDate];
            const level = getGeomagLevel(kp);
            if (level && kp >= 5) {
                let labelMid = (isUk ? level.labelUk : level.labelEn);
                labelMid = labelMid.charAt(0).toLowerCase() + labelMid.slice(1);
                if (isUk && !labelMid.includes('магніт')) {
                    labelMid = labelMid.replace('буря', 'магнітна буря').replace('шторм', 'магнітний шторм');
                } else if (!isUk && !/magnetic/i.test(labelMid)) {
                    labelMid = labelMid.replace(/\bstorm\b/i, 'magnetic storm');
                }
                ev.geomagLabel = labelMid;
            }

            const dStrSoil = dayDate;
            const vals0 = [];
            for (let i = 0; i < soilTimes.length; i++) {
                if (String(soilTimes[i]).startsWith(dStrSoil) && soil0[i] != null) {
                    vals0.push(Number(soil0[i]));
                }
            }
            if (vals0.length) {
                const minSoil = Math.min(...vals0);
                if (minSoil <= 0) {
                    ev.frostLabel = isUk
                        ? `заморозки на ґрунті (до ${minSoil.toFixed(1)}°C)`
                        : `soil frost (down to ${minSoil.toFixed(1)}°C)`;
                }
            }

            const uv = Number(day.uv);
            if (!Number.isNaN(uv) && uv >= 6) {
                const uvR = Math.round(uv);
                if (uv > 10) ev.uvLabel = isUk ? `екстремальний УФ (${uvR}) 🟣` : `extreme UV (${uvR}) 🟣`;
                else if (uv >= 8) ev.uvLabel = isUk ? `дуже високий УФ (${uvR}) 🔴` : `very high UV (${uvR}) 🔴`;
                else ev.uvLabel = isUk ? `високий УФ (${uvR}) 🟠` : `high UV (${uvR}) 🟠`;
            }

            // AQ tips — ЗАВЖДИ (не залежить від налаштувань таблиці)
            const aq = omAqByDate[dStrSoil];
            if (aq) {
                if (aq.pm25Max != null && aq.pm25Max >= 12) {
                    ev.aqIssues.push(isUk
                        ? `дрібний пил/смог PM2.5 до ${aq.pm25Max.toFixed(0)} µg/m³`
                        : `fine dust/smog PM2.5 up to ${aq.pm25Max.toFixed(0)} µg/m³`);
                }
                if (aq.pm10Max != null && aq.pm10Max >= 25) {
                    ev.aqIssues.push(isUk
                        ? `великий пил PM10 до ${aq.pm10Max.toFixed(0)} µg/m³`
                        : `coarse dust PM10 up to ${aq.pm10Max.toFixed(0)} µg/m³`);
                }
                if (aq.dustMax != null && aq.dustMax >= 15) {
                    ev.aqIssues.push(isUk
                        ? `пилова хмара (dust) до ${aq.dustMax.toFixed(0)} µg/m³`
                        : `dust plume up to ${aq.dustMax.toFixed(0)} µg/m³`);
                }
                if (aq.no2Max != null && aq.no2Max >= 40) {
                    ev.aqIssues.push(isUk
                        ? `NO₂ (трафік/опалення) до ${aq.no2Max.toFixed(0)} µg/m³`
                        : `NO₂ (traffic/heating) up to ${aq.no2Max.toFixed(0)} µg/m³`);
                }
                if (aq.o3Max != null && aq.o3Max >= 100) {
                    ev.aqIssues.push(isUk
                        ? `озон O₃ до ${aq.o3Max.toFixed(0)} µg/m³ — краще без інтенсивних тренувань удень`
                        : `ozone O₃ up to ${aq.o3Max.toFixed(0)} µg/m³ — avoid hard midday workouts`);
                }
                if (aq.so2Max != null && aq.so2Max >= 30) {
                    ev.aqIssues.push(isUk
                        ? `SO₂ до ${aq.so2Max.toFixed(0)} µg/m³`
                        : `SO₂ up to ${aq.so2Max.toFixed(0)} µg/m³`);
                }
                if (aq.wildfireMax != null && aq.wildfireMax >= 15) {
                    ev.aqIssues.push(isUk
                        ? `можливий дим пожеж (PM) до ${aq.wildfireMax.toFixed(0)} µg/m³ — вікна, FFP2`
                        : `possible wildfire smoke (PM) up to ${aq.wildfireMax.toFixed(0)} µg/m³ — windows, FFP2`);
                }
                if (aq.ecTotalMax != null && aq.ecTotalMax >= 1.5) {
                    ev.aqIssues.push(isUk
                        ? `сажа (black carbon) до ${aq.ecTotalMax.toFixed(1)} µg/m³ — дизель/опалення/пожежі`
                        : `black carbon up to ${aq.ecTotalMax.toFixed(1)} µg/m³ — diesel/heating/fires`);
                }
                if (aq.nh3Max != null && aq.nh3Max >= 10) {
                    ev.aqIssues.push(isUk
                        ? `аміак NH₃ до ${aq.nh3Max.toFixed(0)} µg/m³ (агро)`
                        : `ammonia NH₃ up to ${aq.nh3Max.toFixed(0)} µg/m³ (agriculture)`);
                }
                if (aq.aodMax != null && aq.aodMax >= 0.25) {
                    ev.aqIssues.push(isUk
                        ? `каламутність AOD ${aq.aodMax.toFixed(2)} — імла/дим`
                        : `haze AOD ${aq.aodMax.toFixed(2)} — smoke/dust`);
                }
                // Пилок по видах (Європа, сезон)
                const pollenTips = [
                    ['birchMax', 30, isUk ? 'пилок берези' : 'birch pollen'],
                    ['alderMax', 30, isUk ? 'пилок вільхи' : 'alder pollen'],
                    ['grassMax', 30, isUk ? 'пилок трав' : 'grass pollen'],
                    ['mugwortMax', 20, isUk ? 'пилок полину' : 'mugwort pollen'],
                    ['oliveMax', 30, isUk ? 'пилок оливки' : 'olive pollen'],
                    ['ragweedMax', 20, isUk ? 'пилок амброзії' : 'ragweed pollen']
                ];
                for (const [key, thr, label] of pollenTips) {
                    const v = aq[key];
                    if (v != null && v >= thr) {
                        ev.aqIssues.push(isUk
                            ? `${label} до ${Math.round(v)} зерн/м³ — алергікам обережно`
                            : `${label} up to ${Math.round(v)} grains/m³ — caution if allergic`);
                    }
                }
                if (aq.usAqiMax != null && aq.usAqiMax >= 50) {
                    ev.eaqi = Math.round(aq.usAqiMax);
                    ev.eaqiBadge = aq.usAqiMax > 150 ? '🔴' : aq.usAqiMax > 100 ? '🟠' : '🟡';
                    if (!ev.aqIssues.length && aq.pm25Max != null) {
                        ev.aqIssues.push(isUk
                            ? `дрібний пил/смог PM2.5 до ${aq.pm25Max.toFixed(0)} µg/m³`
                            : `fine dust/smog PM2.5 up to ${aq.pm25Max.toFixed(0)} µg/m³`);
                    }
                } else if (aq.eaqiMax != null && aq.eaqiMax >= 40) {
                    ev.eaqi = Math.round(aq.eaqiMax);
                    ev.eaqiBadge = aq.eaqiMax > 80 ? '🔴' : aq.eaqiMax > 60 ? '🟠' : '🟡';
                    if (!ev.aqIssues.length && aq.pm25Max != null) {
                        ev.aqIssues.push(isUk
                            ? `дрібний пил/смог PM2.5 до ${aq.pm25Max.toFixed(0)} µg/m³`
                            : `fine dust/smog PM2.5 up to ${aq.pm25Max.toFixed(0)} µg/m³`);
                    }
                }
            }

            dayEvents.push(ev);
        });

        // Перші 3 дні — у aside; з 4-го — у згортаємий «далеке майбутнє» (лише якщо daysCount > 3)
        const nearEvents = dayEvents.slice(0, 3);
        const farEvents = dayEvents.slice(3);

        const isClearSky = (code) => {
            const c = Number(code);
            return c === 800 || c === 801 || c === 802;
        };
        const hasHazard = (ev) =>
            ev.precip > 0 || ev.gust >= 7 || ev.highPress || ev.uvLabel || ev.frostLabel ||
            ev.geomagLabel || ev.eaqi != null || (ev.aqIssues && ev.aqIssues.length);

        // --- Текст «близьких» днів ---
        const fmtShort = (d) => d.toLocaleDateString(isUk ? 'uk-UA' : 'en-GB', {
            day: '2-digit', month: '2-digit'
        });
        const nearLines = [];
        nearEvents.forEach((ev, idx) => {
            const shortDate = fmtShort(ev.dateObj);
            let labelDay;
            if (idx === 0) {
                labelDay = isUk ? `Завтра (${shortDate})` : `Tomorrow (${shortDate})`;
            } else if (idx === 1) {
                labelDay = isUk ? `Післязавтра (${shortDate})` : `Day after tomorrow (${shortDate})`;
            } else {
                // 3-й день: назва дня + дата
                labelDay = isUk
                    ? `${ev.dayName.charAt(0).toUpperCase() + ev.dayName.slice(1)} (${shortDate})`
                    : `${ev.dayName.charAt(0).toUpperCase() + ev.dayName.slice(1)} (${shortDate})`;
            }
            if (!hasHazard(ev) && isClearSky(ev.skyCode)) {
                nearLines.push(isUk
                    ? `${labelDay} — чудовий ясний день ☀️`
                    : `${labelDay} — a lovely clear day ☀️`);
            } else if (!hasHazard(ev)) {
                const sky = ev.skyDesc || (isUk ? 'без особливих загроз' : 'no major hazards');
                nearLines.push(isUk
                    ? `${labelDay} — спокійно (${sky})`
                    : `${labelDay} — quiet (${sky})`);
            } else {
                const bits = [];
                if (ev.precip > 0) {
                    bits.push(isUk
                        ? (ev.precipHeavy ? `сильний дощ ${ev.precip.toFixed(1)} мм` : `слабкий дощ ${ev.precip.toFixed(1)} мм`)
                        : (ev.precipHeavy ? `heavy rain ${ev.precip.toFixed(1)} mm` : `light rain ${ev.precip.toFixed(1)} mm`));
                }
                if (ev.gust >= 7) {
                    bits.push(isUk
                        ? `вітер із поривами до ${Math.round(ev.gust)} м/с`
                        : `wind gusts up to ${Math.round(ev.gust)} m/s`);
                }
                if (ev.frostLabel) bits.push(ev.frostLabel);
                if (ev.uvLabel) bits.push(ev.uvLabel);
                if (ev.geomagLabel) bits.push(ev.geomagLabel);
                if (ev.highPress) bits.push(isUk ? 'високий тиск 🔴' : 'high pressure 🔴');
                if (ev.eaqi != null) {
                    const detail = ev.aqIssues.length ? `: ${ev.aqIssues.slice(0, 3).join('; ')}` : '';
                    bits.push(isUk
                        ? `якість повітря AQI ${ev.eaqi} ${ev.eaqiBadge}${detail}`
                        : `air quality AQI ${ev.eaqi} ${ev.eaqiBadge}${detail}`);
                } else if (ev.aqIssues.length) {
                    bits.push(ev.aqIssues.slice(0, 3).join('; '));
                }
                nearLines.push(`${labelDay} — ${bits.join(', ')}`);
            }
        });

        // --- Згруповані «далекі» дні ---
        const groupPrecip = [];
        const groupWind = [];
        const groupPress = []; // consecutive ranges by dayName
        const groupAq = [];
        const groupUv = [];
        const groupFrost = [];
        const groupGeomag = [];

        let pressStart = null, pressEnd = null;
        const flushPress = () => {
            if (pressStart == null) return;
            if (pressStart === pressEnd) groupPress.push(pressStart);
            else groupPress.push(`${pressStart}–${pressEnd}`);
            pressStart = pressEnd = null;
        };

        farEvents.forEach((ev) => {
            const d = fmtShort(ev.dateObj);
            const dayLabel = `${ev.dayName} ${d}`;
            if (ev.precip > 0) {
                groupPrecip.push(isUk
                    ? `${dayLabel} (${ev.precip.toFixed(1)} мм)`
                    : `${dayLabel} (${ev.precip.toFixed(1)} mm)`);
            }
            if (ev.gust >= 7) {
                groupWind.push(isUk
                    ? `${dayLabel} до ${Math.round(ev.gust)} м/с`
                    : `${dayLabel} up to ${Math.round(ev.gust)} m/s`);
            }
            if (ev.highPress) {
                if (pressStart == null) { pressStart = pressEnd = dayLabel; }
                else pressEnd = dayLabel;
            } else {
                flushPress();
            }
            if (ev.eaqi != null || ev.aqIssues.length) {
                if (ev.aqIssues.some(x => x.includes('PM2.5') || x.includes('пил') || x.includes('dust') || x.includes('smog'))) {
                    groupAq.push(dayLabel);
                } else {
                    groupAq.push(dayLabel);
                }
            }
            if (ev.uvLabel) groupUv.push(`${dayLabel} (${ev.uvLabel})`);
            if (ev.frostLabel) groupFrost.push(dayLabel);
            if (ev.geomagLabel) groupGeomag.push(`${dayLabel}: ${ev.geomagLabel}`);
        });
        flushPress();

        const farLines = [];
        if (groupPrecip.length) {
            farLines.push(isUk
                ? `Можливий дощ: ${groupPrecip.join(', ')}.`
                : `Possible rain: ${groupPrecip.join(', ')}.`);
        }
        if (groupWind.length) {
            farLines.push(isUk
                ? `Сильний вітер із поривами: ${groupWind.join(', ')}.`
                : `Strong wind with gusts: ${groupWind.join(', ')}.`);
        }
        if (groupPress.length) {
            farLines.push(isUk
                ? `Високий тиск 🔴: ${groupPress.join(', ')}.`
                : `High pressure 🔴: ${groupPress.join(', ')}.`);
        }
        if (groupAq.length) {
            // Зібрати типи проблем з далеких днів для точнішого формулювання
            const farAqKinds = new Set();
            farEvents.forEach((ev) => {
                for (const s of (ev.aqIssues || [])) {
                    const x = String(s).toLowerCase();
                    if (x.includes('pm2.5') || x.includes('смог') || x.includes('smog')) farAqKinds.add('PM2.5');
                    else if (x.includes('pm10') || x.includes('пил') || x.includes('dust')) farAqKinds.add(isUk ? 'пил' : 'dust');
                    else if (x.includes('o₃') || x.includes('o3') || x.includes('озон') || x.includes('ozone')) farAqKinds.add('O₃');
                    else if (x.includes('no₂') || x.includes('no2')) farAqKinds.add('NO₂');
                    else if (x.includes('пожеж') || x.includes('wildfire') || x.includes('дим')) farAqKinds.add(isUk ? 'дим пожеж' : 'wildfire smoke');
                    else if (x.includes('сажа') || x.includes('black carbon') || x.includes('soot')) farAqKinds.add(isUk ? 'сажа' : 'soot');
                    else if (x.includes('пилк') || x.includes('pollen')) farAqKinds.add(isUk ? 'пилок' : 'pollen');
                    else if (x.includes('nh₃') || x.includes('nh3') || x.includes('аміак') || x.includes('ammonia')) farAqKinds.add('NH₃');
                }
            });
            const kindsStr = farAqKinds.size
                ? [...farAqKinds].join(', ')
                : (isUk ? 'погіршення якості повітря' : 'air quality decline');
            farLines.push(isUk
                ? `Якість повітря (${kindsStr}): ${groupAq.join(', ')}.`
                : `Air quality (${kindsStr}): ${groupAq.join(', ')}.`);
        }
        if (groupFrost.length) {
            farLines.push(isUk
                ? `Заморозки на ґрунті: ${groupFrost.join(', ')}.`
                : `Soil frost: ${groupFrost.join(', ')}.`);
        }
        if (groupUv.length) {
            farLines.push(isUk
                ? `Високий УФ: ${groupUv.join(', ')}.`
                : `High UV: ${groupUv.join(', ')}.`);
        }
        if (groupGeomag.length) {
            farLines.push(isUk
                ? `Магнітні бурі: ${groupGeomag.join(', ')}.`
                : `Magnetic storms: ${groupGeomag.join(', ')}.`);
        }

        // --- Збірка highlightText ---
        const parts = [];

        // 1) Hydromet
        if (meteoAlerts.length > 0) {
            const alertHeader = isUk
                ? '⚠️ Офіційне попередження Укргідрометцентру:'
                : '⚠️ Official Hydrometcenter warning:';
            const alertLines = meteoAlerts.slice(0, 4).map((a) => a.line).join('\n');
            parts.push(`${alertHeader}\n${alertLines}`);
        }

        // 2) Near days
        if (nearLines.length) {
            parts.push(nearLines.join('\n'));
        } else {
            parts.push(isUk ? 'Найближчі дні — без особливих загроз.' : 'Next days — no major hazards.');
        }

        // 3) Far days (collapsed via <details> in HTML later — keep plain text marker)
        let farPlain = '';
        if (farLines.length) {
            farPlain = farLines.join('\n');
        } else if (farEvents.length) {
            farPlain = isUk
                ? 'У подальші дні особливих небезпек не передбачається.'
                : 'No significant hazards expected in the following days.';
        }

        let highlightText = parts.join('\n\n');
        // far section stored separately for HTML collapse
        const farHighlightText = farPlain;

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

        // --- Open-Meteo Air Quality rows (за опціями aqi_main / aqi_ext) ---
        // Пороги орієнтовні (WHO/EEA daily): 🟢 добре → 🟡 помірно → 🟠 погано → 🔴 небезпечно
        if (hasAqiMain || hasAqiExt) {
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
                dustMax:  [15, 40, 80, 150],
                nh3Max:   [10, 20, 50, 100],
                aodMax:   [0.2, 0.5, 1.0, 2.0],
                ch4Max:   [1200, 2000, 3000, 5000],
                grassMax:   [30, 50, 100, 200],
                birchMax:   [30, 50, 100, 200],
                alderMax:   [30, 50, 100, 200],
                mugwortMax: [20, 40, 80, 150],
                oliveMax:   [30, 50, 100, 200],
                ragweedMax: [20, 40, 80, 150],
                wildfireMax: [15, 40, 80, 150],
                ecTotalMax:  [1, 3, 6, 10],
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

        // Основне: індекси + PM
        const aqRowsMain = [
            ['eaqiMax', isUk ? 'EAQI<br><small>OM max</small>' : 'EAQI<br><small>OM max</small>', 0],
            ['usAqiMax', isUk ? 'US AQI<br><small>OM max</small>' : 'US AQI<br><small>OM max</small>', 0],
            ['pm25Max', 'PM2.5<br><small>µg/m³</small>', 1],
            ['pm10Max', 'PM10<br><small>µg/m³</small>', 1]
        ];
        // Розширене: гази, аерозолі, пилок (Європа), UV CAMS
        const aqRowsExt = [
            ['no2Max', 'NO₂<br><small>µg/m³</small>', 1],
            ['o3Max', 'O₃<br><small>µg/m³</small>', 1],
            ['so2Max', 'SO₂<br><small>µg/m³</small>', 1],
            ['coMax', 'CO<br><small>µg/m³</small>', 0],
            ['dustMax', isUk ? 'Пил<br><small>dust</small>' : 'Dust<br><small>µg/m³</small>', 1],
            ['nh3Max', 'NH₃<br><small>µg/m³</small>', 1],
            ['aodMax', 'AOD<br><small>550 nm</small>', 3],
            ['ch4Max', isUk ? 'CH₄<br><small>метан</small>' : 'CH₄<br><small>methane</small>', 0],
            ['grassMax', isUk ? 'Пилок<br><small>трави</small>' : 'Pollen<br><small>grass</small>', 0],
            ['birchMax', isUk ? 'Пилок<br><small>береза</small>' : 'Pollen<br><small>birch</small>', 0],
            ['alderMax', isUk ? 'Пилок<br><small>вільха</small>' : 'Pollen<br><small>alder</small>', 0],
            ['mugwortMax', isUk ? 'Пилок<br><small>полин</small>' : 'Pollen<br><small>mugwort</small>', 0],
            ['oliveMax', isUk ? 'Пилок<br><small>оливка</small>' : 'Pollen<br><small>olive</small>', 0],
            ['ragweedMax', isUk ? 'Пилок<br><small>амброзія</small>' : 'Pollen<br><small>ragweed</small>', 0],
            ['wildfireMax', isUk ? 'Пил пожеж<br><small>PM10</small>' : 'Wildfire<br><small>PM10</small>', 1],
            ['ecTotalMax', isUk ? 'Сажа<br><small>EC total</small>' : 'Black carbon<br><small>EC total</small>', 2],
        ];
        const aqRows = [
            ...(hasAqiMain ? aqRowsMain : []),
            ...(hasAqiExt ? aqRowsExt : [])
        ];
        for (const [key, label, dec] of aqRows) {
            const cells = userForecast.map((day) => aqCell(day, key, dec)).join('');
            rows.push(`<tr><td align="left" valign="middle"><b>🍃 ${label}</b></td>${cells}</tr>`);
        }
        } // end hasAqiMain || hasAqiExt

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

        {
            // Блок 1: перші 3 дні (+ гідромет) — завжди видно
            const nearHtml = escapeHTML(highlightText).replace(/\n/g, '<br>');
            const citeNear = isUk
                ? 'Парасоль☔️ підказує, на що звернути увагу. Гортай вбік таблицю, щоб переглянути прогноз на всі дні'
                : 'Parasol☔️ highlights what to watch. Swipe the table to see the full forecast';
            fullHtml += `<aside>${nearHtml}<br>
  <cite>${citeNear}</cite>
</aside>\n\n`;

            // Блок 2: з 4-го дня — лише якщо користувач обрав 4+ дні
            if (farHighlightText) {
                const farHtml = escapeHTML(farHighlightText).replace(/\n/g, '<br>');
                const farSummary = isUk
                    ? '<b>4–6 день · може змінитись</b>'
                    : '<b>Days 4–6 · may change</b>';
                fullHtml += `<blockquote><details><summary>${farSummary}</summary>
<p>${farHtml}</p>
</details></blockquote>\n\n`;
            }
        }

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
                            { text: isUk ? '🍃 Повітря' : '🍃 Air', callback_data: 'air_fc' },
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
                            { text: isUk ? '🍃 Повітря' : '🍃 Air', callback_data: 'air_fc' },
                            { text: isUk ? '⚙️ Налаштувати прогноз' : '⚙️ Configure forecast', callback_data: 'forecast_menu' }
                        ]
                    ]
                }
            }).catch(() => {});
        }

        const cityName = user.city || '—';
        await log(`
<h1>🧪 Вечірній тест</h1>
<p>🕐 ${escapeHTML(startTime)}</p>
<table bordered striped>
  <thead>
    <tr>
      <th align="left">Показник</th>
      <th align="center">Значення</th>
    </tr>
  </thead>
  <tbody>
    <tr><td align="left">👤 User ID</td><td align="center"><code>${TEST_USER_ID}</code></td></tr>
    <tr><td align="left">📍 Місто</td><td align="center">${escapeHTML(cityName)}</td></tr>
    <tr><td align="left">Статус</td><td align="center"><b>✅ Надіслано</b></td></tr>
  </tbody>
</table>
`.trim());
        res.status(200).send(`Test forecast (Rich Message) sent to ${TEST_USER_ID}`);
    } catch (error) {
        console.error(error);
        await log(
            `<h1>❌ Test forecast FAILED</h1>` +
                `<p><code>${escapeHTML(error.message)}</code></p>`
        );
        res.status(500).send('Test forecast error');
    }
};
