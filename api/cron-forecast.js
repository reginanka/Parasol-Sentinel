require('dotenv').config();
const axios = require('axios');
const getBot = require('../utils/bot');
const bot = getBot();
const logToTelegram = require('../utils/logger');
const User = require('../models/User');
const { incrementUsage } = require('../utils/admin');
const City = require('../models/City');

const History = require('../models/History');
const connectDB = require('../utils/db');
const { getWeatherDesc, getWindDir, getSoilFrostInfo, frostWarningText, isFrostSeason, getGeomagLevel, fetchMeteoAlarmAlerts } = require('../utils/weather');
const { sleep, formatUrl, generateSignature, escapeHTML, getLocalDateStr } = require('../utils/helpers');
const { getLunarPhase } = require('../utils/agro');
const { dayKey, daySetPaths, pruneDaysUnset, mergeHourlyFlat, getDayBaseline } = require('../utils/baseline');

const API_KEY = process.env.WEATHERBIT_KEY;

module.exports = async (req, res) => {
    const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
    const log = (text) => logToTelegram(bot, LOG_CHAT_ID, text);
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).send('Unauthorized');

    const startTime = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

    // Optional: single-user mode via ?userId=TELEGRAM_ID (admin «вечірній крон обраним»)
    const singleUserId = req.query?.userId ? Number(req.query.userId) : null;

    try {
        await connectDB();
        let users;
        if (singleUserId && !isNaN(singleUserId)) {
            const u = await User.findOne({ telegramId: singleUserId });
            if (!u) {
                return res.status(404).send(`User ${singleUserId} not found`);
            }
            if (!u.lat || !u.lon) {
                return res.status(400).send('User has no coordinates');
            }
            users = [u];
        } else {
            users = await User.find({ notificationsEnabled: true, eveningForecastEnabled: { $ne: false }, accessLevel: { $ne: "none" } });
        }

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

        for (const [key, cityInfo] of Object.entries(uniqueCities)) {
            try {
                // Fetch daily forecast (includes most metrics)
                const response = await axios.get(`https://api.weatherbit.io/v2.0/forecast/daily?lat=${cityInfo.lat}&lon=${cityInfo.lon}&key=${API_KEY}&days=7`);
                const fullResponse = response.data.data;
                const apiCityName = response.data.city_name || cityInfo.name;
                const todayData = fullResponse[0];

                // --- AQI «зараз»: WAQI ≤ 10 км, інакше Open-Meteo current ---
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
                    return '🟢';
                };
                {
                    const WAQI_TOKEN = process.env.WAQI_TOKEN;
                    if (WAQI_TOKEN) {
                        try {
                            const waqiRes = await axios.get(
                                `https://api.waqi.info/feed/geo:${cityInfo.lat};${cityInfo.lon}/?token=${WAQI_TOKEN}`,
                                { timeout: 8000 }
                            );
                            if (waqiRes.data?.status === 'ok') {
                                const d = waqiRes.data.data;
                                const geo = Array.isArray(d.city?.geo) ? d.city.geo : null;
                                let distKm = null;
                                if (geo && geo.length >= 2) {
                                    distKm = haversineKm(cityInfo.lat, cityInfo.lon, Number(geo[0]), Number(geo[1]));
                                }
                                if (distKm != null && distKm <= WAQI_MAX_KM) {
                                    aqiData = {
                                        provider: 'waqi',
                                        aqi: d.aqi,
                                        aqiLabel: 'AQI',
                                        badge: badgeFromUsAqi(d.aqi),
                                        pm25: d.iaqi?.pm25?.v ?? null,
                                        pm10: d.iaqi?.pm10?.v ?? null,
                                        station: d.city?.name || null,
                                        stationUrl: d.city?.url || null,
                                        stationGeo: geo,
                                        source: d.attributions?.[0]?.name || null,
                                        dominant: d.dominentpol || null,
                                        distKm: Math.round(distKm * 10) / 10
                                    };
                                }
                            }
                        } catch (e) {
                            console.error('WAQI error:', e.message);
                        }
                    }
                    if (!aqiData) {
                        try {
                            const omCurUrl =
                                `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${cityInfo.lat}&longitude=${cityInfo.lon}` +
                                `&current=european_aqi,us_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,sulphur_dioxide,dust&timezone=auto`;
                            const omCurRes = await axios.get(omCurUrl, { timeout: 10000 });
                            const cur = omCurRes.data?.current || {};
                            const eaqi = cur.european_aqi != null ? Number(cur.european_aqi) : null;
                            const usAqi = cur.us_aqi != null ? Number(cur.us_aqi) : null;
                            aqiData = {
                                provider: 'open-meteo',
                                aqi: eaqi != null ? eaqi : usAqi,
                                aqiLabel: eaqi != null ? 'EAQI' : 'US AQI',
                                badge: eaqi != null ? badgeFromEaqi(eaqi) : badgeFromUsAqi(usAqi),
                                pm25: cur.pm2_5 != null ? Number(cur.pm2_5) : null,
                                pm10: cur.pm10 != null ? Number(cur.pm10) : null,
                                station: null,
                                stationUrl: null,
                                stationGeo: [cityInfo.lat, cityInfo.lon],
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

                // --- Open-Meteo Air Quality forecast (daily max for tips + table) ---
                let omAqByDate = {};
                try {
                    const aqUrl =
                        `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${cityInfo.lat}&longitude=${cityInfo.lon}` +
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
                    console.error('Open-Meteo AQ forecast error:', e.message);
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
                // Soil frost data from Open-Meteo (hourly soil + daily mean)
                let omSoil0 = [];
                let omSoil6 = [];
                let omSoilTimes = [];
                let omDailyMeanTimes = [];
                let omDailyMeanVals = [];

                try {
                    const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${cityInfo.lat}&longitude=${cityInfo.lon}` +
                        `&hourly=precipitation,soil_temperature_0cm,soil_temperature_6cm` +
                        `&daily=temperature_2m_mean` +
                        `&timezone=auto&forecast_days=7`;
                    const omRes = await axios.get(omUrl);
                    if (omRes.data && omRes.data.hourly) {
                        const allTimes = omRes.data.hourly.time;
                        const allPrecip = omRes.data.hourly.precipitation;
                        omSoilTimes = allTimes;
                        omSoil0 = omRes.data.hourly.soil_temperature_0cm || [];
                        omSoil6 = omRes.data.hourly.soil_temperature_6cm || [];
                        if (omRes.data.daily) {
                            omDailyMeanTimes = omRes.data.daily.time || [];
                            omDailyMeanVals = omRes.data.daily.temperature_2m_mean || [];
                        }

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

                        // Persist daily mean for frost checks. Soil stays aligned with light/full hourly.time.
                        try {
                            await City.findOneAndUpdate(
                                { externalId: key },
                                {
                                    $set: {
                                        'dashboardSnapshot.dailyOm': {
                                            time: omDailyMeanTimes,
                                            temperature_2m_mean: omDailyMeanVals
                                        }
                                    }
                                }
                            );
                        } catch (snapErr) {
                            console.error('Evening dailyOm snapshot update error:', snapErr.message);
                        }
                    }
                } catch (omErr) {
                    console.error('Open-Meteo fetch error in evening forecast:', omErr.message);
                }

                // Official weather alerts (UA Hydrometcenter via MeteoAlarm) — once per city
                let cityMeteoAlerts = [];
                try {
                    cityMeteoAlerts = await fetchMeteoAlarmAlerts(cityInfo.lat, cityInfo.lon, 'uk');
                } catch (e) {
                    console.error('MeteoAlarm evening fetch error:', e.message);
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

                // --- FETCH NOAA Kp per day (display only) ---
                // Does NOT write forecastedKp / lastGeomagAlert to DB.
                // Real-time state & alerts are owned exclusively by cron-check (LOGIC E).
                // geomagByDate: { 'YYYY-MM-DD': maxKp }
                // 3-hourly JSON covers ~2–3 days; 27-day outlook fills the rest.
                const geomagByDate = {};
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
                            if (geomagByDate[dateStr] == null || kp > geomagByDate[dateStr]) {
                                geomagByDate[dateStr] = kp;
                            }
                        }
                    }
                } catch (noaaErr) {
                    console.error('NOAA Kp forecast error:', noaaErr.message);
                }
                try {
                    const outlookRes = await axios.get(
                        'https://services.swpc.noaa.gov/text/27-day-outlook.txt',
                        { timeout: 10000 }
                    );
                    const months = {
                        Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
                        Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12
                    };
                    for (const line of String(outlookRes.data || '').split('\n')) {
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
                        if (geomagByDate[dateStr] == null) {
                            geomagByDate[dateStr] = kp;
                        }
                    }
                } catch (outlookErr) {
                    console.error('NOAA 27-day outlook error:', outlookErr.message);
                }

                // --- Persist eveningGeomag plan (today seed / tomorrow always) ---
                // Quiet-mode daytime alerts use eveningGeomag[todayStr].maxRank as planRank.
                // Does NOT touch lastGeomagAlert (owned by cron-check).
                try {
                    const egPre = cityDocPre?.eveningGeomag || {};
                    const egSet = {};
                    const asOfEg = new Date();
                    const buildPlan = (dateStr) => {
                        const kp = geomagByDate[dateStr];
                        if (kp == null || isNaN(Number(kp))) return null;
                        const lvl = getGeomagLevel(Math.round(Number(kp)));
                        if (!lvl) return null;
                        return { maxRank: lvl.rank, maxKp: Number(kp), asOf: asOfEg };
                    };
                    const planTomorrow = buildPlan(tomorrowStr);
                    if (planTomorrow) {
                        egSet[`eveningGeomag.${tomorrowStr}`] = planTomorrow;
                    }
                    // today: seed only if missing
                    if (!egPre[todayLocal]) {
                        const planToday = buildPlan(todayLocal);
                        if (planToday) {
                            egSet[`eveningGeomag.${todayLocal}`] = planToday;
                        }
                    }
                    // prune keys older than yesterday
                    if (egPre && typeof egPre === 'object') {
                        for (const d of Object.keys(egPre)) {
                            if (d < yesterdayStr) {
                                egSet[`eveningGeomag.${d}`] = undefined; // handled via $unset below
                            }
                        }
                    }
                    const egUnset = {};
                    if (egPre && typeof egPre === 'object') {
                        for (const d of Object.keys(egPre)) {
                            if (d < yesterdayStr) egUnset[`eveningGeomag.${d}`] = 1;
                        }
                    }
                    // remove undefined keys from $set
                    Object.keys(egSet).forEach(k => { if (egSet[k] === undefined) delete egSet[k]; });
                    if (Object.keys(egSet).length || Object.keys(egUnset).length) {
                        await City.findOneAndUpdate(
                            { externalId: key },
                            {
                                ...(Object.keys(egSet).length ? { $set: egSet } : {}),
                                ...(Object.keys(egUnset).length ? { $unset: egUnset } : {})
                            },
                            { upsert: true }
                        );
                    }
                } catch (egWriteErr) {
                    console.error('eveningGeomag write error:', egWriteErr.message);
                }


                // --- Planned soil frost (save once per city for frost-cron cross-check) ---
                // Store the coldest frost day in the next 6 days (from tomorrow). frost-cron reads this from Mongo.
                // Only in frost season (Mar–Jun, Aug–Nov).
                let plannedFrost = null;
                try {
                    const pfTz0 = response.data.timezone || 'Europe/Kyiv';
                    if (!isFrostSeason(new Date(), pfTz0)) {
                        await City.findOneAndUpdate(
                            { externalId: key },
                            { $unset: { 'eveningState.plannedFrost': 1 } }
                        ).catch(() => {});
                        throw new Error('SKIP_SEASON');
                    }
                    const pfTz = response.data.timezone || 'Europe/Kyiv';
                    const pfFrom = getLocalDateStr(pfTz, 1);
                    let pfColdest = null;
                    let pfDate = null;
                    let pfHour = null;
                    for (let dayOffset = 1; dayOffset <= 6; dayOffset++) {
                        const dStr = getLocalDateStr(pfTz, dayOffset);
                        let dayMin = null;
                        let dayMinHour = null;
                        for (let i = 0; i < omSoilTimes.length; i++) {
                            const raw = String(omSoilTimes[i] || '');
                            if (!raw.startsWith(dStr) || omSoil0[i] == null) continue;
                            const v = Number(omSoil0[i]);
                            if (Number.isNaN(v)) continue;
                            const h = parseInt(raw.slice(11, 13), 10);
                            if (dayMin == null || v < dayMin) {
                                dayMin = v;
                                dayMinHour = Number.isNaN(h) ? null : h;
                            }
                        }
                        let mean = null;
                        const mIdx = omDailyMeanTimes.findIndex(t => String(t).startsWith(dStr));
                        if (mIdx >= 0) mean = omDailyMeanVals[mIdx];
                        const info = getSoilFrostInfo(dayMin != null ? [dayMin] : [], mean);
                        if (info.frost && info.minSoil != null) {
                            if (pfColdest == null || info.minSoil < pfColdest) {
                                pfColdest = info.minSoil;
                                pfDate = dStr;
                                pfHour = dayMinHour;
                            }
                        }
                    }
                    if (pfColdest != null && pfDate) {
                        plannedFrost = {
                            date: pfDate,
                            minSoil: Math.round(pfColdest * 10) / 10,
                            hour: pfHour,
                            warnedAt: nowTs
                        };
                        await City.findOneAndUpdate(
                            { externalId: key },
                            { $set: { 'eveningState.plannedFrost': plannedFrost } }
                        ).catch(e => console.error('Save plannedFrost error:', e.message));
                    }
                } catch (pfErr) {
                    if (pfErr.message !== 'SKIP_SEASON') {
                        console.error('plannedFrost compute error:', pfErr.message);
                    }
                }

                for (const user of cityInfo.users) {
                    if (!user.notificationsEnabled || user.eveningForecastEnabled === false) continue;
                    await sleep(40);
                    const lang = user.language || 'uk';
                    const tempUnit = user.units?.temp || 'c';
                    const settings = user.forecastSettings || { daysCount: 3, enabledMetrics: ['condition', 'temp', 'precip', 'wind', 'pressure'] };
                    const metrics = settings.enabledMetrics;
                    const hasAqiNow  = metrics.includes('aqi_now')  || metrics.includes('aqi');
                    const hasAqiMain = metrics.includes('aqi_main') || metrics.includes('aqi');
                    const hasAqiExt  = metrics.includes('aqi_ext')  || metrics.includes('aqi');

                    const displayCity = (user.city && user.city !== '..') ? user.city : apiCityName;
                    const isUk = lang === 'uk';

                    // Frost risk — ONLY tomorrow (evening alert is for the next night)
                    const cityTzForDays = response.data.timezone || 'Europe/Kyiv';
                    const tomorrowStrForMsg = getLocalDateStr(cityTzForDays, 1);
                    const dayKeyFn = (d) => String(d?.valid_date || d?.datetime || '').slice(0, 10);
                    const startIdxPre = fullResponse.findIndex(d => dayKeyFn(d) === tomorrowStrForMsg);
                    const fromIdxPre = startIdxPre >= 0 ? startIdxPre : 1;
                    const previewDays = fullResponse.slice(fromIdxPre, fromIdxPre + settings.daysCount);
                    const userForecast = previewDays;

                    let frostAnyDay = false;
                    let frostColdest = null;
                    const soilForTomorrow = [];
                    for (let i = 0; i < omSoilTimes.length; i++) {
                        if (String(omSoilTimes[i]).startsWith(tomorrowStrForMsg) && omSoil0[i] != null) {
                            soilForTomorrow.push(omSoil0[i]);
                        }
                    }
                    let meanTomorrow = null;
                    const mIdxT = omDailyMeanTimes.findIndex(t => String(t).startsWith(tomorrowStrForMsg));
                    if (mIdxT >= 0) meanTomorrow = omDailyMeanVals[mIdxT];
                    const frostInfo = getSoilFrostInfo(soilForTomorrow, meanTomorrow);
                    if (frostInfo.frost) {
                        frostAnyDay = true;
                        frostColdest = frostInfo.minSoil;
                    }

                    // ========== 1. AQI (HTML) ==========
                    let aqiHtml = '';
                    if (hasAqiNow && aqiData) {
                        const idxName = aqiData.aqiLabel || 'AQI';
                        const aqiShow = aqiData.aqi != null
                            ? (Number.isInteger(aqiData.aqi) ? aqiData.aqi : Number(aqiData.aqi).toFixed(0))
                            : '—';
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
                        const isWaqi = aqiData.provider === 'waqi';
                        const bad = isWaqi
                            ? (aqiData.aqi > 150 ? 3 : aqiData.aqi > 100 ? 2 : aqiData.aqi > 50 ? 1 : 0)
                            : (aqiData.aqi > 80 ? 3 : aqiData.aqi > 60 ? 2 : aqiData.aqi > 40 ? 1 : 0);
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
                        } else if (aqiData.provider === 'open-meteo') {
                            detailParts.push(isUk
                                ? `📡 <b>Джерело:</b> Open-Meteo · CAMS (атмосферна модель)`
                                : `📡 <b>Source:</b> Open-Meteo · CAMS (atmospheric model)`);
                            detailParts.push(isUk
                                ? `ℹ️ Немає станції WAQI ближче 10 км — показано модельну оцінку для ваших координат`
                                : `ℹ️ No WAQI station within 10 km — showing model estimate for your coordinates`);
                            if (aqiData.eaqi != null) detailParts.push(`EAQI: ${Math.round(aqiData.eaqi)}`);
                            if (aqiData.usAqi != null) detailParts.push(`US AQI: ${Math.round(aqiData.usAqi)}`);
                        }
                        if (advice) detailParts.push(advice);

                        if (detailParts.length) {
                            aqiHtml = `<details><summary>${summaryLine}</summary><p>${detailParts.join('<br>')}</p></details>`;
                        } else {
                            aqiHtml = summaryLine;
                        }
                    }

                    // ========== 2. Frost prefix (HTML) ==========
                    let frostHtml = '';
                    if (frostAnyDay && isFrostSeason(new Date(), cityTzForDays)) {
                        const raw = frostWarningText(lang, frostColdest) || '';
                        frostHtml = raw
                            .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
                            .replace(/\n/g, '<br>');
                    }

                    // ========== 3. Smart highlights (структуровані підказки) ==========
                    const dayAccusativeByIndex = [
                        'неділю', 'понеділок', 'вівторок', 'середу', 'четвер', "п'ятницю", 'суботу'
                    ];
                    const getDayForPreposition = (dateObj) => {
                        if (!isUk) {
                            return dateObj.toLocaleDateString('en-US', { weekday: 'long', timeZone: cityTzForDays });
                        }
                        const parts = new Intl.DateTimeFormat('en-US', {
                            timeZone: cityTzForDays,
                            weekday: 'short'
                        }).formatToParts(dateObj);
                        const wd = (parts.find((p) => p.type === 'weekday') || {}).value || '';
                        const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
                        const idx = map[wd] != null ? map[wd] : dateObj.getDay();
                        return dayAccusativeByIndex[idx] || dateObj.toLocaleDateString('uk-UA', { weekday: 'long', timeZone: cityTzForDays }).toLowerCase();
                    };

                    const dayEvents = [];
                    userForecast.forEach((day) => {
                        const rawDate = day.valid_date || day.datetime || '';
                        const dateObj = new Date(rawDate.includes('T') ? rawDate : `${String(rawDate).slice(0, 10)}T12:00:00`);
                        const dayName = getDayForPreposition(dateObj);
                        const dayDate = String(day.valid_date || day.datetime || '').slice(0, 10);
                        const ev = {
                            dayName, dateObj, dayDate,
                            precip: 0, precipHeavy: false, gust: 0, highPress: false,
                            uvLabel: null, frostLabel: null, geomagLabel: null,
                            aqIssues: [], eaqi: null, eaqiBadge: null,
                            skyCode: day.weather?.code,
                            skyDesc: (getWeatherDesc(day.weather?.code, lang) || '').replace(/\*\*/g, '')
                        };

                        const precip = Number(day.precip) || 0;
                        const pop = Number(day.pop) || 0;
                        if (precip >= 5) { ev.precip = precip; ev.precipHeavy = true; }
                        else if (precip >= 0.3 || pop >= 40) { ev.precip = precip; }

                        const gust = Number(day.wind_gust_spd || day.wind_spd) || 0;
                        if (gust >= 7) ev.gust = gust;

                        const slp = Number(day.slp || day.pres) || 0;
                        if (slp > 1018) ev.highPress = true;

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

                        const vals0 = [];
                        for (let i = 0; i < omSoilTimes.length; i++) {
                            if (String(omSoilTimes[i]).startsWith(dayDate) && omSoil0[i] != null) {
                                vals0.push(Number(omSoil0[i]));
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

                        // AQ tips — завжди (не залежить від опцій таблиці)
                        const aq = omAqByDate[dayDate];
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
                                    ? `NO₂ до ${aq.no2Max.toFixed(0)} µg/m³`
                                    : `NO₂ up to ${aq.no2Max.toFixed(0)} µg/m³`);
                            }
                            if (aq.o3Max != null && aq.o3Max >= 100) {
                                ev.aqIssues.push(isUk
                                    ? `озон O₃ до ${aq.o3Max.toFixed(0)} µg/m³`
                                    : `ozone O₃ up to ${aq.o3Max.toFixed(0)} µg/m³`);
                            }
                            if (aq.so2Max != null && aq.so2Max >= 30) {
                                ev.aqIssues.push(isUk
                                    ? `SO₂ до ${aq.so2Max.toFixed(0)} µg/m³`
                                    : `SO₂ up to ${aq.so2Max.toFixed(0)} µg/m³`);
                            }
                            if (aq.eaqiMax != null && aq.eaqiMax >= 40) {
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

                    const nearEvents = dayEvents.slice(0, 3);
                    const farEvents = dayEvents.slice(3);

                    const isClearSky = (code) => {
                        const c = Number(code);
                        return c === 800 || c === 801 || c === 802;
                    };
                    const hasHazard = (ev) =>
                        ev.precip > 0 || ev.gust >= 7 || ev.highPress || ev.uvLabel || ev.frostLabel ||
                        ev.geomagLabel || ev.eaqi != null || (ev.aqIssues && ev.aqIssues.length);

                    const fmtShort = (d) => d.toLocaleDateString(isUk ? 'uk-UA' : 'en-GB', {
                        day: '2-digit', month: '2-digit', timeZone: cityTzForDays
                    });

                    const nearLines = [];
                    nearEvents.forEach((ev, idx) => {
                        const shortDate = fmtShort(ev.dateObj);
                        let labelDay;
                        if (idx === 0) labelDay = isUk ? `Завтра (${shortDate})` : `Tomorrow (${shortDate})`;
                        else if (idx === 1) labelDay = isUk ? `Післязавтра (${shortDate})` : `Day after tomorrow (${shortDate})`;
                        else labelDay = `${ev.dayName.charAt(0).toUpperCase() + ev.dayName.slice(1)} (${shortDate})`;

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
                                const detail = ev.aqIssues.length ? `: ${ev.aqIssues[0]}` : '';
                                bits.push(isUk
                                    ? `якість повітря EAQI ${ev.eaqi} ${ev.eaqiBadge}${detail}`
                                    : `air quality EAQI ${ev.eaqi} ${ev.eaqiBadge}${detail}`);
                            } else if (ev.aqIssues.length) {
                                bits.push(ev.aqIssues[0]);
                            }
                            nearLines.push(`${labelDay} — ${bits.join(', ')}`);
                        }
                    });

                    const groupPrecip = [], groupWind = [], groupPress = [];
                    const groupAq = [], groupUv = [], groupFrost = [], groupGeomag = [];
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
                        } else flushPress();
                        if (ev.eaqi != null || ev.aqIssues.length) groupAq.push(dayLabel);
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
                        farLines.push(isUk
                            ? `Якість повітря — можливий дрібний пил/смог PM2.5: ${groupAq.join(', ')}.`
                            : `Air quality — possible fine dust/smog PM2.5: ${groupAq.join(', ')}.`);
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

                    const parts = [];
                    if (cityMeteoAlerts.length > 0) {
                        const alertHeader = isUk
                            ? '⚠️ Офіційне попередження Укргідрометцентру:'
                            : '⚠️ Official Hydrometcenter warning:';
                        const alertLines = cityMeteoAlerts.slice(0, 4).map((a) => a.line).join('\n');
                        parts.push(`${alertHeader}\n${alertLines}`);
                    }
                    if (nearLines.length) parts.push(nearLines.join('\n'));
                    else parts.push(isUk ? 'Найближчі дні — без особливих загроз.' : 'Next days — no major hazards.');

                    let farPlain = '';
                    if (farLines.length) farPlain = farLines.join('\n');
                    else if (farEvents.length) {
                        farPlain = isUk
                            ? 'У подальші дні особливих небезпек не передбачається.'
                            : 'No significant hazards expected in the following days.';
                    }

                    const highlightText = parts.join('\n\n');
                    const farHighlightText = farPlain;

                    const citeText = isUk
                        ? 'Парасоль☔️ підказує, на що звернути увагу. Гортай вбік таблицю, щоб переглянути прогноз на всі дні'
                        : 'Parasol☔️ highlights what to watch. Swipe the table to see the full forecast';

                    // ========== 4. Таблиця ==========
                    const dayHeaders = userForecast.map((day) => {
                        const rawDate = day.valid_date || day.datetime || '';
                        const dateObj = new Date(rawDate.includes('T') ? rawDate : `${rawDate}T12:00:00`);
                        const weekday = dateObj.toLocaleDateString(fDict[lang].loc, { weekday: 'short', timeZone: cityTzForDays });
                        const dayNum = dateObj.toLocaleDateString(fDict[lang].loc, { day: 'numeric', month: 'short', timeZone: cityTzForDays });
                        const capWeek = weekday.charAt(0).toUpperCase() + weekday.slice(1);
                        return `<th width="90" align="center" valign="middle">📅 ${capWeek}<br>${dayNum}</th>`;
                    }).join('');

                    const rows = [];

                    if (metrics.includes('condition')) {
                        const cells = userForecast.map((day) => {
                            const desc = (getWeatherDesc(day.weather.code, lang) || '').replace(/\*\*/g, '');
                            const parts = desc.split(/\s+/);
                            const cell = parts.length > 2
                                ? `${parts[0]} ${parts[1]}<br>${parts.slice(2).join(' ')}`
                                : desc;
                            return `<td align="center" valign="middle">${cell}</td>`;
                        }).join('');
                        rows.push(`<tr><td align="left" valign="middle"><b>${isUk ? 'Стан<br>неба' : 'Sky'}</b></td>${cells}</tr>`);
                    }

                    if (metrics.includes('temp')) {
                        const cells = userForecast.map((day) => {
                            return `<td align="center" valign="middle">${formatTemp(day.min_temp, tempUnit)} ...<br>${formatTemp(day.max_temp, tempUnit)}</td>`;
                        }).join('');
                        rows.push(`<tr><td align="left" valign="middle"><b>🌡 ${isUk ? 'Темп' : 'Temp'}</b></td>${cells}</tr>`);
                    }

                    if (metrics.includes('soil0')) {
                        const cells = userForecast.map((day) => {
                            const dStrSoil = dayKeyFn(day);
                            const vals = [];
                            for (let i = 0; i < omSoilTimes.length; i++) {
                                if (String(omSoilTimes[i]).startsWith(dStrSoil) && omSoil0[i] != null && !Number.isNaN(Number(omSoil0[i]))) {
                                    vals.push(Number(omSoil0[i]));
                                }
                            }
                            if (!vals.length) return `<td align="center" valign="middle">—</td>`;
                            const mn = Math.min(...vals), mx = Math.max(...vals);
                            const fmt = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}°C`;
                            return `<td align="center" valign="middle">${fmt(mn)} ...<br>${fmt(mx)}</td>`;
                        }).join('');
                        rows.push(`<tr><td align="left" valign="middle"><b>🌱 ${isUk ? 'Ґрунт<br>0 см' : 'Soil<br>0 cm'}</b></td>${cells}</tr>`);
                    }

                    if (metrics.includes('soil6')) {
                        const cells = userForecast.map((day) => {
                            const dStrSoil = dayKeyFn(day);
                            const vals = [];
                            for (let i = 0; i < omSoilTimes.length; i++) {
                                if (String(omSoilTimes[i]).startsWith(dStrSoil) && omSoil6[i] != null && !Number.isNaN(Number(omSoil6[i]))) {
                                    vals.push(Number(omSoil6[i]));
                                }
                            }
                            if (!vals.length) return `<td align="center" valign="middle">—</td>`;
                            const mn = Math.min(...vals), mx = Math.max(...vals);
                            const fmt = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}°C`;
                            return `<td align="center" valign="middle">${fmt(mn)} ...<br>${fmt(mx)}</td>`;
                        }).join('');
                        rows.push(`<tr><td align="left" valign="middle"><b>🌱 ${isUk ? 'Ґрунт<br>6 см' : 'Soil<br>6 cm'}</b></td>${cells}</tr>`);
                    }

                    if (metrics.includes('precip')) {
                        const cells = userForecast.map((day) => {
                            const precip = (Number(day.precip) || 0).toFixed(1);
                            return `<td align="center" valign="middle">${day.pop}%<br><small>(${precip} мм)</small></td>`;
                        }).join('');
                        rows.push(`<tr><td align="left" valign="middle"><b>💧 ${isUk ? 'Вірог.<br>опадів' : 'Precip'}</b></td>${cells}</tr>`);
                    }

                    if (metrics.includes('wind')) {
                        const cells = userForecast.map((day) => {
                            const windStr = formatWind(day.wind_spd, day.wind_gust_spd, day.wind_cdir, user.units?.wind || 'ms', lang);
                            return `<td align="center" valign="middle">${windStr}</td>`;
                        }).join('');
                        rows.push(`<tr><td align="left" valign="middle"><b>💨 ${isUk ? 'Вітер' : 'Wind'}</b></td>${cells}</tr>`);
                    }

                    if (metrics.includes('pressure')) {
                        const cells = userForecast.map((day) => {
                            const pressStr = formatPress(day.pres, day.slp || day.pres, user.units?.pressure || 'mmhg', lang);
                            return `<td align="center" valign="middle">${pressStr}</td>`;
                        }).join('');
                        rows.push(`<tr><td align="left" valign="middle"><b>🧭 ${isUk ? 'Тиск' : 'Pressure'}</b></td>${cells}</tr>`);
                    }

                    if (metrics.includes('dew')) {
                        const cells = userForecast.map((day) => {
                            return `<td align="center" valign="middle">${formatTemp(day.dewpt, tempUnit)}</td>`;
                        }).join('');
                        rows.push(`<tr><td align="left" valign="middle"><b>🌡 ${isUk ? 'Точка<br>роси' : 'Dew<br>Point'}</b></td>${cells}</tr>`);
                    }

                    if (metrics.includes('uv')) {
                        const cells = userForecast.map((day) => {
                            return `<td align="center" valign="middle">${formatUV(day.uv)}</td>`;
                        }).join('');
                        rows.push(`<tr><td align="left" valign="middle"><b>☀️ ${isUk ? 'УФ-<br>індекс' : 'UV<br>Index'}</b></td>${cells}</tr>`);
                    }

                    if (metrics.includes('visibility')) {
                        const cells = userForecast.map((day) => {
                            return `<td align="center" valign="middle">${Math.round(day.vis)} км</td>`;
                        }).join('');
                        rows.push(`<tr><td align="left" valign="middle"><b>👁 ${isUk ? 'Видимість' : 'Visibility'}</b></td>${cells}</tr>`);
                    }

                    if (metrics.includes('moon')) {
                        const cells = userForecast.map((day) => {
                            const dObj = new Date(day.valid_date || day.datetime);
                            const moon = formatMoon(dObj, lang);
                            const m = moon.match(/^(\S+)\s+(.+)$/);
                            if (m) {
                                return `<td align="center" valign="middle">${m[1]}<br>${m[2]}</td>`;
                            }
                            return `<td align="center" valign="middle">${moon}</td>`;
                        }).join('');
                        rows.push(`<tr><td align="left" valign="middle"><b>${isUk ? 'Місяць' : 'Moon'}</b></td>${cells}</tr>`);
                    }

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

                    if (metrics.includes('geomag')) {
                        const cells = userForecast.map((day) => {
                            const dayDate = dayKeyFn(day);
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

                    // --- Open-Meteo AQ table rows (за опціями aqi_main / aqi_ext) ---
                    if (hasAqiMain || hasAqiExt) {
                        const aqBadgeFor = (key, v) => {
                            if (v == null || Number.isNaN(Number(v))) return '';
                            const n = Number(v);
                            const bands = {
                                eaqiMax:  [20, 40, 60, 80],
                                usAqiMax: [50, 100, 150, 200],
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
                        const aqRowsMain = [
                            ['eaqiMax', 'EAQI<br><small>OM max</small>', 0],
                            ['usAqiMax', 'US AQI<br><small>OM max</small>', 0],
                            ['pm25Max', 'PM2.5<br><small>µg/m³</small>', 1],
                            ['pm10Max', 'PM10<br><small>µg/m³</small>', 1]
                        ];
                        const aqRowsExt = [
                            ['no2Max', 'NO₂<br><small>µg/m³</small>', 1],
                            ['o3Max', 'O₃<br><small>µg/m³</small>', 1],
                            ['so2Max', 'SO₂<br><small>µg/m³</small>', 1],
                            ['coMax', 'CO<br><small>µg/m³</small>', 0],
                            ['dustMax', isUk ? 'Пил<br><small>dust</small>' : 'Dust<br><small>µg/m³</small>', 1]
                        ];
                        const aqRows = [
                            ...(hasAqiMain ? aqRowsMain : []),
                            ...(hasAqiExt ? aqRowsExt : [])
                        ];
                        for (const [key, label, dec] of aqRows) {
                            const cells = userForecast.map((day) => aqCell(day, key, dec)).join('');
                            rows.push(`<tr><td align="left" valign="middle"><b>🍃 ${label}</b></td>${cells}</tr>`);
                        }
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

                    // ========== 5. Збірка HTML ==========
                    let fullHtml = '';
                    if (aqiHtml) fullHtml += aqiHtml + '\n\n';
                    if (frostHtml) fullHtml += frostHtml + '\n\n';

                    const titleText = isUk
                        ? `Прогноз на ${settings.daysCount} дн. для ${escapeHTML(displayCity)}`
                        : `${settings.daysCount}-day forecast for ${escapeHTML(displayCity)}`;
                    fullHtml += `<h1>🌆 ${titleText}</h1>\n\n`;

                    {
                        const nearHtml = escapeHTML(highlightText).replace(/\n/g, '<br>');
                        fullHtml += `<aside>${nearHtml}<br>
  <cite>${citeText}</cite>
</aside>\n\n`;
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

                    // Target date for hourly button
                    const cityTz = user.timezone || response.data.timezone || 'Europe/Kyiv';
                    const localSend = new Date(new Date().toLocaleString('en-US', { timeZone: cityTz }));
                    const targetHourly = new Date(localSend);
                    targetHourly.setDate(targetHourly.getDate() + 1);
                    const targetHourlyStr = getLocalDateStr(cityTz, 1);
                    const targetHourlyShort = targetHourly.toLocaleDateString(lang === 'uk' ? 'uk-UA' : 'en-US', {
                        day: '2-digit', month: '2-digit'
                    });

                    // Compact 2+2+1 layout; callbacks send NEW messages (do not overwrite forecast)
                    const replyMarkup = {
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
                    };

                    // ========== 6. Відправка Rich Message ==========
                    try {
                        await bot.api.sendRichMessage(user.telegramId, {
                            html: fullHtml,
                            skip_entity_detection: true
                        }, {
                            reply_markup: replyMarkup
                        });
                    } catch (sendErr) {
                        console.error(`sendRichMessage failed for ${user.telegramId}:`, sendErr.message);
                        const plain = fullHtml
                            .replace(/<[^>]+>/g, ' ')
                            .replace(/\s+/g, ' ')
                            .trim();
                        await bot.api.sendMessage(user.telegramId, plain, {
                            reply_markup: replyMarkup
                        }).catch(() => {});
                    }
                    sent++;
                        await incrementUsage(user.telegramId, 'evening').catch(() => {});
                }
                logLines.push(`• ${cityInfo.name} | ${cityInfo.users.length} ос. | ✅`);
            } catch (err) {
                errors++;
                logLines.push(`• ${cityInfo.name} | ❌ error: ${err.message}`);
                console.error(`Forecast error for ${cityInfo.name}:`, err.message);
            }
        }

        const modeNote = singleUserId ? `\n🎯 <i>Режим: один користувач <code>${singleUserId}</code></i>` : '';
        const summary =
            `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
            `┃  🌆 <b>Вечірній прогноз</b>\n` +
            `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
            `🕐 ${escapeHTML(startTime)}${modeNote}\n` +
            `\n` +
            `👥 Користувачів: <b>${users.length}</b>\n` +
            `📨 Надіслано: <b>${sent}</b>\n` +
            `❌ Помилок: <b>${errors}</b>\n` +
            (logLines.length
                ? `\n┌ <b>Міста</b>\n` + logLines.map((l) => `│ ${l}`).join('\n') + `\n└`
                : '');
        await log(summary);
        res.status(200).send(`Sent ${sent} forecasts` + (singleUserId ? ` (user ${singleUserId})` : ''));
    } catch (error) {
        console.error(error);
        await log(
            `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
                `┃  ❌ <b>Cron Forecast FAILED</b>\n` +
                `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
                `🕐 ${escapeHTML(startTime)}\n` +
                `<code>${escapeHTML(error.message)}</code>`
        );
        res.status(500).send('Cron Forecast Error');
    }
}


