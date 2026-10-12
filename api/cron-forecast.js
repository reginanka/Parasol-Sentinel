require('dotenv').config();
const axios = require('axios');
const getBot = require('../utils/bot');
const bot = getBot();
const logToTelegram = require('../utils/logger');
const User = require('../models/User');
const City = require('../models/City');

const History = require('../models/History');
const connectDB = require('../utils/db');
const { getWeatherDesc, getWindDir, getSoilFrostInfo, frostWarningText, isFrostSeason, getGeomagLevel } = require('../utils/weather');
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

                    // ========== 2. Frost prefix (HTML) ==========
                    let frostHtml = '';
                    if (frostAnyDay && isFrostSeason(new Date(), cityTzForDays)) {
                        const raw = frostWarningText(lang, frostColdest) || '';
                        frostHtml = raw
                            .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
                            .replace(/\n/g, '<br>');
                    }

                    // ========== 3. Smart highlights ==========
                    const dayAccusativeUk = {
                        'понеділок': 'понеділок',
                        'вівторок': 'вівторок',
                        'середа': 'середу',
                        'четвер': 'четвер',
                        "п'ятниця": "п'ятницю",
                        'субота': 'суботу',
                        'неділя': 'неділю'
                    };
                    const getDayForPreposition = (dateObj) => {
                        if (!isUk) {
                            return dateObj.toLocaleDateString('en-US', { weekday: 'long', timeZone: cityTzForDays });
                        }
                        const nominative = dateObj.toLocaleDateString('uk-UA', { weekday: 'long', timeZone: cityTzForDays }).toLowerCase();
                        return dayAccusativeUk[nominative] || nominative;
                    };

                    const highlights = [];
                    const highPressureDays = [];
                    let highPressureStart = null;
                    let highPressureEnd = null;

                    userForecast.forEach((day) => {
                        const rawDate = day.valid_date || day.datetime || '';
                        const dateObj = new Date(rawDate.includes('T') ? rawDate : `${rawDate}T12:00:00`);
                        const dayName = getDayForPreposition(dateObj);

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

                        const gust = Number(day.wind_gust_spd || day.wind_spd) || 0;
                        if (gust >= 7) {
                            highlights.push(isUk
                                ? `у ${dayName} сильний вітер із поривами до ${Math.round(gust)} м/с`
                                : `on ${dayName} strong wind with gusts up to ${Math.round(gust)} m/s`);
                        }

                        const slp = Number(day.slp || day.pres) || 0;
                        if (slp > 1018) {
                            if (highPressureStart === null) {
                                highPressureStart = dayName;
                                highPressureEnd = dayName;
                            } else {
                                highPressureEnd = dayName;
                            }
                        } else if (highPressureStart !== null) {
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

                        const dayDate = dayKeyFn(day);
                        const kp = geomagByDate[dayDate];
                        const level = getGeomagLevel(kp);
                        if (level && kp >= 5) {
                            const label = isUk ? level.labelUk : level.labelEn;
                            let labelMid = label.charAt(0).toLowerCase() + label.slice(1);
                            // Clarify: «слабка буря» → «слабка магнітна буря»
                            if (isUk) {
                                labelMid = labelMid
                                    .replace(/\bбуря\b/, 'магнітна буря')
                                    .replace(/\bшторм\b/, 'магнітний шторм');
                            } else {
                                labelMid = labelMid.replace(/\bstorm\b/i, 'magnetic storm');
                            }
                            highlights.push(isUk
                                ? `у ${dayName} ${labelMid}`
                                : `on ${dayName} ${labelMid}`);
                        }

                        const dStrSoil = dayKeyFn(day);
                        const vals0Frost = [];
                        for (let i = 0; i < omSoilTimes.length; i++) {
                            if (String(omSoilTimes[i]).startsWith(dStrSoil) && omSoil0[i] != null) {
                                vals0Frost.push(Number(omSoil0[i]));
                            }
                        }
                        if (vals0Frost.length) {
                            const minSoil = Math.min(...vals0Frost);
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
                    });

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

                    const allHighlights = [...highlights, ...highPressureDays];
                    let highlightText = '';
                    if (allHighlights.length > 0) {
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

                    fullHtml += `<aside>${escapeHTML(highlightText)}<br>
  <cite>${citeText}</cite>
</aside>\n\n`;

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


