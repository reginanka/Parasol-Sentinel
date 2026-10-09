require('dotenv').config();
const axios = require('axios');
const getBot = require('../utils/bot');
const bot = getBot();
const logToTelegram = require('../utils/logger');
const User = require('../models/User');
const City = require('../models/City');
const History = require('../models/History');
const connectDB = require('../utils/db');
const { getWeatherDesc, getWindDir, getGeomagLevel } = require('../utils/weather');
const { sleep, escapeHTML, getLocalDateStr, formatLocalDateTime } = require('../utils/helpers');
const { dayKey, getDayBaseline, daySetPaths, mergeHourlyFlat } = require('../utils/baseline');

const API_KEY = process.env.WEATHERBIT_KEY;

module.exports = async (req, res) => {
    const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
    const log = (text) => logToTelegram(bot, LOG_CHAT_ID, text);
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).send('Unauthorized');

    const startTime = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

    try {
        await connectDB();
        const users = await User.find({ notificationsEnabled: true });

        const uniqueCities = {};
        for (const user of users) {
             if (!user.lat || !user.lon) continue;
             const key = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
             if (!uniqueCities[key]) uniqueCities[key] = { lat: user.lat, lon: user.lon, name: user.city, users: [] };
             uniqueCities[key].users.push(user);
        }

        let alertsTotal = 0;
        let errorsCount = 0;
        const logLines = [];

        const alertsDict = {
            uk: {
                warmer: "вище",
                cooler: "нижче"
            },
            en: {
                warmer: "warmer",
                cooler: "cooler"
            }
        };

        /** Build Rich Message HTML for temperature forecast shift */
        const htmlForecastShift = (lang, { asOf, oldMin, oldMax, newMin, newMax, minDelta, maxDelta }) => {
            if (lang === 'uk') {
                return `<h3>📊 Прогноз температури змінився</h3>` +
                    `<table bordered striped compact>` +
                    `<tr><th></th><th>Ніч</th><th>День</th></tr>` +
                    `<tr><td>Було <i>(${asOf})</i></td><td>${oldMin}°C</td><td>${oldMax}°C</td></tr>` +
                    `<tr><td>Зараз</td><td><b>${newMin}°C</b></td><td><b>${newMax}°C</b></td></tr>` +
                    `<tr><td>Зміна</td><td>${minDelta}°C</td><td>${maxDelta}°C</td></tr>` +
                    `</table>`;
            }
            return `<h3>📊 Temperature forecast changed</h3>` +
                `<table bordered striped compact>` +
                `<tr><th></th><th>Night</th><th>Day</th></tr>` +
                `<tr><td>Was <i>(${asOf})</i></td><td>${oldMin}°C</td><td>${oldMax}°C</td></tr>` +
                `<tr><td>Now</td><td><b>${newMin}°C</b></td><td><b>${newMax}°C</b></td></tr>` +
                `<tr><td>Change</td><td>${minDelta}°C</td><td>${maxDelta}°C</td></tr>` +
                `</table>`;
        };

        /** Build Rich Message HTML for temperature anomaly (plain text) */
        const htmlTempAnomaly = (lang, { temp, asOf, expected, dir }) => {
            if (lang === 'uk') {
                return `<h3>⚠️ Аномальна температура</h3>` +
                    `<p>Зараз: <b>${temp}</b> — значно <b>${dir}</b>, ніж очікувалось на цей час.</p>` +
                    `<p>Очікували (станом на ${asOf}): <b>${expected}</b></p>`;
            }
            return `<h3>⚠️ Temperature anomaly</h3>` +
                `<p>Now: <b>${temp}</b> — significantly <b>${dir}</b> than expected for this time.</p>` +
                `<p>Expected (as of ${asOf}): <b>${expected}</b></p>`;
        };

        /** Build Rich Message HTML for precip change (table Було/Зараз) */
        const htmlPrecip = (lang, kind, { asOf, oldBlocks, oldTotal, newBlocks, newTotal }) => {
            const was = lang === 'uk' ? 'Було' : 'Was';
            const now = lang === 'uk' ? 'Зараз' : 'Now';
            const colInt = lang === 'uk' ? 'Інтервал' : 'Interval';
            const colSum = lang === 'uk' ? 'Сума' : 'Total';
            const asOfCell = asOf ? ` <i>(${asOf})</i>` : '';
            const oldInt = oldBlocks || '—';
            const newInt = newBlocks || '—';
            const oldSum = oldTotal != null ? `${Number(oldTotal).toFixed(1)} мм` : '—';
            const newSum = newTotal != null ? `${Number(newTotal).toFixed(1)} мм` : '—';

            const titles = {
                uk: {
                    canceled: '☀️ Опади скасовано',
                    amountUp: '⚠️ Більше опадів, ніж очікувалось',
                    longer: '🌤 Опади триватимуть довше',
                    appeared: "⚠️ З'явилися опади",
                    shifted: '🌤 Час опадів змістився'
                },
                en: {
                    canceled: '☀️ Precipitation canceled',
                    amountUp: '⚠️ More precipitation expected',
                    longer: '🌤 Precipitation will last longer',
                    appeared: '⚠️ Precipitation appeared',
                    shifted: '🌤 Precipitation timing shifted'
                }
            };
            const title = (titles[lang] || titles.uk)[kind] || titles.uk.shifted;

            return `<h3>${title}</h3>` +
                `<table bordered striped compact>` +
                `<tr><th></th><th>${colInt}</th><th>${colSum}</th></tr>` +
                `<tr><td>${was}${asOfCell}</td><td>${oldInt}</td><td>${oldSum}</td></tr>` +
                `<tr><td>${now}</td><td><b>${newInt}</b></td><td><b>${newSum}</b></td></tr>` +
                `</table>`;
        };

        /**
         * Build Rich Message HTML for geomagnetic alert / recovery.
         * Uses full NOAA G-scale labels from getGeomagLevel.
         * kind: 'worse' | 'better'
         * levelInfo: return value of getGeomagLevel (labelUk/En, gScale, badge, level, …)
         */
        const htmlGeomag = (lang, { kind, levelInfo }) => {
            const isUk = lang === 'uk';
            const kpStr = String(levelInfo.kpRounded);
            const label = isUk ? levelInfo.labelUk : levelInfo.labelEn;
            const g = levelInfo.gScale;

            // --- Worsening / new disturbance ---
            if (kind === 'worse') {
                // Quiet should never alert as worse
                if (levelInfo.level === 'quiet') return null;

                if (levelInfo.level === 'unsettled') {
                    if (isUk) {
                        return `<h3>🧲 ${label}</h3>` +
                            `<p>Можливе незначне погіршення самопочуття у метеочутливих людей.</p>` +
                            `<blockquote>Рекомендації: зменште фізичні навантаження, більше відпочивайте, пийте достатньо води.</blockquote>`;
                    }
                    return `<h3>🧲 ${label}</h3>` +
                        `<p>Mild discomfort possible for weather-sensitive individuals.</p>` +
                        `<blockquote>Recommendations: reduce physical activity, rest more, drink enough water.</blockquote>`;
                }

                // Storm tiers G1–G5
                const stormAdviceUk = {
                    1: 'Зменште фізичні навантаження, пийте більше води, уникайте стресу. Метеозалежним — тримайте під рукою ліки.',
                    2: 'Обмежте активність на вулиці, більше відпочивайте, контролюйте тиск. Пийте воду, уникайте кави та алкоголю.',
                    3: 'Максимально зменште навантаження. Відпочинок, гідратація, ліки під рукою. Уникайте поїздок і стресових ситуацій.',
                    4: 'Сильне збурення. Залишайтесь у спокої, обмежте будь-яку зайву активність. Слідкуйте за самопочуттям і тиском.',
                    5: 'Екстремальний рівень. Уникайте будь-яких навантажень. При погіршенні самопочуття — зверніться по медичну допомогу.'
                };
                const stormAdviceEn = {
                    1: 'Reduce physical activity, drink more water, avoid stress. Keep medication handy if weather-sensitive.',
                    2: 'Limit outdoor activity, rest more, monitor blood pressure. Stay hydrated; avoid coffee and alcohol.',
                    3: 'Minimize strain. Rest, hydrate, keep medication ready. Avoid travel and stressful situations.',
                    4: 'Severe disturbance. Stay calm, limit all extra activity. Monitor how you feel and your blood pressure.',
                    5: 'Extreme level. Avoid any physical strain. Seek medical help if you feel unwell.'
                };
                const advice = isUk
                    ? (stormAdviceUk[g] || stormAdviceUk[1])
                    : (stormAdviceEn[g] || stormAdviceEn[1]);

                if (isUk) {
                    return `<h3>🧲 Увага! ${label}</h3>` +
                        `<p>Активне збурення геомагнітного поля · рівень <b>G${g}</b>.</p>` +
                        `<blockquote>${advice}</blockquote>`;
                }
                return `<h3>🧲 Alert! ${label}</h3>` +
                    `<p>Active geomagnetic disturbance · level <b>G${g}</b>.</p>` +
                    `<blockquote>${advice}</blockquote>`;
            }

            // --- Improvement ---
            if (levelInfo.level === 'quiet') {
                if (isUk) {
                    return `<h3>🧲 Магнітне поле заспокоїлося (Kp ${kpStr})</h3>` +
                        `<p>🟢 Умови стали сприятливими.</p>`;
                }
                return `<h3>🧲 Geomagnetic field has calmed (Kp ${kpStr})</h3>` +
                    `<p>🟢 Conditions are now favorable.</p>`;
            }

            if (levelInfo.level === 'unsettled') {
                if (isUk) {
                    return `<h3>🧲 Рівень знизився: ${label}</h3>` +
                        `<p>Умови покращилися. Метеочутливим людям варто ще бути обережними.</p>`;
                }
                return `<h3>🧲 Level decreased: ${label}</h3>` +
                    `<p>Conditions improved. Weather-sensitive people should still be cautious.</p>`;
            }

            // Improved but still in a storm tier (e.g. G3 → G1)
            if (isUk) {
                return `<h3>🧲 Інтенсивність знизилась: ${label}</h3>` +
                    `<p>Буря ослабла, але поле ще збурене. Продовжуйте стежити за самопочуттям.</p>`;
            }
            return `<h3>🧲 Intensity decreased: ${label}</h3>` +
                `<p>The storm has weakened, but the field is still disturbed. Keep monitoring how you feel.</p>`;
        };

        /** Build Rich Message HTML for AQI deterioration (dynamic rows) */
        const htmlAqiWorse = (lang, { aqiVal, badge, pm25, pm10, advice }) => {
            const title = lang === 'uk'
                ? '🍃 Якість повітря погіршилась'
                : '🍃 Air quality deteriorated';
            let rows = `<tr><td>AQI</td><td><b>${aqiVal}</b> ${badge}</td></tr>`;
            if (pm25 != null) rows += `<tr><td>PM2.5</td><td>${pm25} µg/m³</td></tr>`;
            if (pm10 != null) rows += `<tr><td>PM10</td><td>${pm10} µg/m³</td></tr>`;
            const colM = lang === 'uk' ? 'Показник' : 'Metric';
            const colV = lang === 'uk' ? 'Значення' : 'Value';
            let html = `<h3>${title}</h3>` +
                `<table bordered striped compact>` +
                `<tr><th>${colM}</th><th>${colV}</th></tr>${rows}</table>`;
            if (advice) html += `<blockquote>${advice}</blockquote>`;
            return html;
        };

        /** Build Rich Message HTML for AQI recovery */
        const htmlAqiBetter = (lang, { aqiVal }) => {
            if (lang === 'uk') {
                return `<h3>🍃 Якість повітря покращилась</h3>` +
                    `<p>🟢 AQI <b>${aqiVal}</b> — повітря знову в безпечній зоні.</p>` +
                    `<p>Можна відкривати вікна та спокійно гуляти на вулиці.</p>`;
            }
            return `<h3>🍃 Air quality improved</h3>` +
                `<p>🟢 AQI <b>${aqiVal}</b> — air is back in the safe zone.</p>` +
                `<p>You can open the windows and safely go for a walk.</p>`;
        };

        for (const [key, cityInfo] of Object.entries(uniqueCities)) {
            try {
                // 1. Fetch CURRENT weather and updated DAILY forecast (7 days for dashboard snapshot)
                const [currResp, foreResp] = await Promise.all([
                    axios.get(`https://api.weatherbit.io/v2.0/current?lat=${cityInfo.lat}&lon=${cityInfo.lon}&key=${API_KEY}`),
                    axios.get(`https://api.weatherbit.io/v2.0/forecast/daily?lat=${cityInfo.lat}&lon=${cityInfo.lon}&key=${API_KEY}&days=7`)
                ]);

                const current = currResp.data.data[0];
                const dailyAll = foreResp.data.data || [];
                
                const cityDoc = await City.findOne({ externalId: key });
                const evening = cityDoc?.eveningState;

                const cityTimezone = current.timezone || cityDoc?.timezone || 'Europe/Kyiv';
                // Robust local hour (avoid toLocaleString → Date timezone pitfalls)
                const hourParts = new Intl.DateTimeFormat('en-US', {
                    timeZone: cityTimezone,
                    hour: 'numeric',
                    hour12: false
                }).formatToParts(new Date());
                const localHour = parseInt(hourParts.find(p => p.type === 'hour')?.value || '0', 10) % 24;
                const todayStr = getLocalDateStr(cityTimezone, 0);

                // Day-scoped baseline (days[today]) + legacy fallback. Match new forecast by valid_date.
                const dayBaseline = getDayBaseline(evening, todayStr, cityTimezone);
                let dayAsOf = dayBaseline?.asOf || evening?.updatedAt || null;
                const eveningToday = (dayBaseline && (dayBaseline.min_temp != null || dayBaseline.max_temp != null))
                    ? { min_temp: dayBaseline.min_temp, max_temp: dayBaseline.max_temp, valid_date: todayStr }
                    : (evening?.forecast || []).find(d => dayKey(d) === todayStr);
                const newToday = dailyAll.find(d => dayKey(d) === todayStr) || dailyAll[0];

                const alerts = [];
                let alertTriggered = false;
                let reasons = [];

                if (eveningToday && newToday) {
                    const oldMin = eveningToday.min_temp;
                    const oldMax = eveningToday.max_temp;
                    const newMin = newToday.min_temp;
                    const newMax = newToday.max_temp;

                    // Guard: only compare if both sides refer to the same calendar day
                    if (dayKey(eveningToday) === todayStr && dayKey(newToday) === todayStr) {
                        // --- LOGIC A: Forecast Shift (e.g. 25°C -> 32°C) ---
                        const maxShift = newMax - oldMax;
                        const minShift = newMin - oldMin;

                        if (Math.abs(maxShift) >= 4 || Math.abs(minShift) >= 4) {
                            reasons.push("зміна прогнозу");
                            const fmtDelta = (d) => d > 0 ? `+${d.toFixed(1)}` : d.toFixed(1);
                            for (const user of cityInfo.users) {
                                if (!user.notificationsEnabled || user.alertTriggers?.temperature === false) continue;
                                const lang = user.language || 'uk';
                                const asOf = formatLocalDateTime(dayAsOf, cityTimezone, lang);
                                const html = htmlForecastShift(lang, {
                                    asOf,
                                    oldMin: Math.round(oldMin),
                                    oldMax: Math.round(oldMax),
                                    newMin: Math.round(newMin),
                                    newMax: Math.round(newMax),
                                    minDelta: fmtDelta(minShift),
                                    maxDelta: fmtDelta(maxShift)
                                });
                                alerts.push({ userId: user.telegramId, html, lang });
                            }
                            alertTriggered = true;

                            // Значна зміна → оновлюємо baseline + timestamp,
                            // щоб наступний алерт показував «станом на» саме цей момент.
                            const updatedForecast = (evening?.forecast || []).map(d => {
                                if (dayKey(d) === todayStr) {
                                    return { ...d, min_temp: newMin, max_temp: newMax };
                                }
                                return d;
                            });
                            const shiftNow = new Date();
                            const shiftSet = {
                                "eveningState.forecast": updatedForecast,
                                "eveningState.updatedAt": shiftNow,
                                ...daySetPaths(todayStr, {
                                    asOf: shiftNow,
                                    min_temp: newMin,
                                    max_temp: newMax
                                })
                            };
                            // Keep existing hourly for this day if any
                            const prevHp = getDayBaseline(evening, todayStr, cityTimezone)?.hourlyPrecip;
                            if (prevHp && prevHp.length) {
                                shiftSet[`eveningState.days.${todayStr}.hourlyPrecip`] = prevHp;
                            }
                            await City.findOneAndUpdate(
                                { externalId: key },
                                { $set: shiftSet }
                            );
                            if (evening) {
                                evening.forecast = updatedForecast;
                                evening.updatedAt = shiftNow;
                                if (!evening.days) evening.days = {};
                                evening.days[todayStr] = {
                                    ...(evening.days[todayStr] || {}),
                                    asOf: shiftNow,
                                    min_temp: newMin,
                                    max_temp: newMax,
                                    hourlyPrecip: prevHp || evening.days[todayStr]?.hourlyPrecip || []
                                };
                            }
                            dayAsOf = shiftNow;
                        }

                        // --- LOGIC B: Current Temp Anomaly vs "Safe Zone" (±5°C threshold) ---
                        // Після можливого зсуву прогнозу порівнюємо з ОНОВЛЕНИМ baseline
                        // (evening.forecast уже оновлений вище), а не зі старими oldMin/oldMax.
                        const curTemp = current.temp;
                        const blAfter = getDayBaseline(evening, todayStr, cityTimezone);
                        const baselineMin = blAfter?.min_temp ?? oldMin;
                        const baselineMax = blAfter?.max_temp ?? oldMax;
                        let isAnomaly = false;
                        let expectedBase = 0;
                        let direction = '';

                        if (curTemp < (baselineMin - 5)) {
                            // More than 5°C colder than expected minimum → anomaly
                            isAnomaly = true;
                            expectedBase = baselineMin;
                            direction = 'cooler';
                        } else if (curTemp > (baselineMax + 5)) {
                            // More than 5°C hotter than expected maximum → anomaly
                            isAnomaly = true;
                            expectedBase = baselineMax;
                            direction = 'warmer';
                        }
                        // If temp is within min..max or within ±5°C of them → no alert needed

                        if (isAnomaly) {
                            reasons.push("аномалія темп.");
                            for (const user of cityInfo.users) {
                                if (!user.notificationsEnabled || user.alertTriggers?.temperature === false) continue;
                                const lang = user.language || 'uk';
                                const unit = user.units?.temp || 'c';
                                const fmtTemp = (c) => unit === 'f' ? `${Math.round(c * 9/5 + 32)}°F` : `${Math.round(c)}°C`;
                                const asOf = formatLocalDateTime(dayAsOf, cityTimezone, lang);

                                const html = htmlTempAnomaly(lang, {
                                    temp: fmtTemp(curTemp),
                                    asOf,
                                    expected: fmtTemp(expectedBase),
                                    dir: alertsDict[lang][direction]
                                });
                                alerts.push({ userId: user.telegramId, html, lang });
                            }
                            alertTriggered = true;
                        }
                    }
                }

                // --- SMART HISTORY UPDATE ---
                // Use $min/$max so MongoDB only updates if the current temp
                // is a new extreme for today. Values inside min..max are ignored.
                try {
                    await History.findOneAndUpdate(
                        { externalId: key, date: todayStr },
                        {
                            $min: { temp_min: current.temp },
                            $max: { temp_max: current.temp }
                        },
                        { upsert: true }
                    );
                } catch (histErr) {
                    console.error('History smart update error:', histErr.message);
                }

                // Weather code — лише для логів / lastState (не для алертів).
                // Опади проактивно покриває LOGIC D (Open-Meteo hourly).
                const newCode = current.weather.code;

                // --- LOGIC D: Smart Precipitation Check (Open-Meteo) ---
                // Rules (aligned with cron-check-light.js):
                // - COMPARE only FUTURE hours (from localHour) — ignore past-hour model updates (no spam)
                // - ALERT TEXT shows FULL calendar day schedule (0–23) when we do alert
                // - No baseline for today → set baseline silently, never treat as "was 0.0 mm"
                // - "Canceled" only if remaining (future) planned rain drops to 0
                // - Significant amount change: future total increased by ≥ 1.5 mm
                // - Significant timing change: future rain window shifted by ≥ 2 h OR duration +≥ 2 h
                // - When updating baseline, MERGE today's hours into existing array (keep other days)
                // Also stores full hourly block for dashboard snapshot
                let omHourlyForSnap = null;
                try {
                    const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${cityInfo.lat}&longitude=${cityInfo.lon}` +
                        `&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,precipitation_probability,surface_pressure,weather_code,soil_temperature_0cm,soil_temperature_6cm` +
                        `&daily=temperature_2m_mean` +
                        `&timezone=auto&forecast_days=3`;
                    const omRes = await axios.get(omUrl);
                    if (omRes.data && omRes.data.hourly) {
                        const allTimes = omRes.data.hourly.time;
                        const allPrecip = omRes.data.hourly.precipitation;
                        omHourlyForSnap = {
                            time: allTimes,
                            temperature_2m: omRes.data.hourly.temperature_2m || [],
                            wind_speed_10m: omRes.data.hourly.wind_speed_10m || [],
                            wind_gusts_10m: omRes.data.hourly.wind_gusts_10m || [],
                            precipitation: allPrecip,
                            precipitation_probability: omRes.data.hourly.precipitation_probability || [],
                            surface_pressure: omRes.data.hourly.surface_pressure || [],
                            weather_code: omRes.data.hourly.weather_code || [],
                            soil_temperature_0cm: omRes.data.hourly.soil_temperature_0cm || [],
                            soil_temperature_6cm: omRes.data.hourly.soil_temperature_6cm || []
                        };
                        // daily mean air temp for soil-frost check (stored next to hourly)
                        if (omRes.data.daily) {
                            omHourlyForSnap._dailyOm = {
                                time: omRes.data.daily.time || [],
                                temperature_2m_mean: omRes.data.daily.temperature_2m_mean || []
                            };
                        }
                        const dayBlPrecip = getDayBaseline(evening, todayStr, cityTimezone);
                        const oldPrecipArr = (dayBlPrecip?.hourlyPrecip?.length
                            ? dayBlPrecip.hourlyPrecip
                            : (evening?.hourlyPrecip || []));
                        // One asOf per calendar day (not per alert type)
                        const oldPrecipAsOf = dayBlPrecip?.asOf || dayAsOf || evening?.updatedAt || null;

                        // Parse hour from "YYYY-MM-DDTHH:MM" — avoid Date timezone bugs
                        const hourFromTime = (t) => parseInt(String(t).slice(11, 13), 10);

                        // Full-day maps (0–23). Compare uses future slice; message uses full day.
                        // Each entry: { precip: mm, prob: 0–100 }. Hour is "rainy" if precip > 0 OR prob > 15.
                        const allProb = omRes.data.hourly.precipitation_probability || [];
                        const RAIN_PROB_THRESHOLD = 15;

                        const oldByHour = {};
                        for (const o of oldPrecipArr) {
                            if (o.time && o.time.startsWith(todayStr)) {
                                const h = hourFromTime(o.time);
                                if (!Number.isNaN(h)) {
                                    oldByHour[h] = {
                                        precip: o.precip || 0,
                                        // Older baselines may lack prob — treat missing as 0 (mm-only logic)
                                        prob: (o.prob != null ? o.prob : 0)
                                    };
                                }
                            }
                        }

                        const newByHour = {};
                        for (let i = 0; i < allTimes.length; i++) {
                            if (allTimes[i].startsWith(todayStr)) {
                                const h = hourFromTime(allTimes[i]);
                                if (!Number.isNaN(h)) {
                                    newByHour[h] = {
                                        precip: allPrecip[i] || 0,
                                        prob: allProb[i] != null ? allProb[i] : 0
                                    };
                                }
                            }
                        }

                        // Helpers: total mm (actual precip only), rainy hours/blocks (mm > 0 OR prob > threshold)
                        // fromHour: 0 = full day (message), localHour = future only (compare / shouldAlert)
                        const isRainyHour = (entry) => {
                            const p = (entry && entry.precip) || 0;
                            const pr = (entry && entry.prob) || 0;
                            return p > 0 || pr > RAIN_PROB_THRESHOLD;
                        };
                        const calcStats = (byHour, fromHour = 0) => {
                            let total = 0;
                            const hours = [];
                            for (let h = fromHour; h < 24; h++) {
                                const entry = byHour[h] || { precip: 0, prob: 0 };
                                const p = entry.precip || 0;
                                if (isRainyHour(entry)) {
                                    total += p; // only real mm contribute to amount
                                    hours.push(h);
                                }
                            }
                            const blocks = [];
                            for (const h of hours) {
                                if (blocks.length && h === blocks[blocks.length - 1][1] + 1) {
                                    blocks[blocks.length - 1][1] = h;
                                } else {
                                    blocks.push([h, h]);
                                }
                            }
                            const start = hours.length ? hours[0] : null;
                            const end = hours.length ? hours[hours.length - 1] : null;
                            const duration = hours.length;
                            return { total, hours, blocks, start, end, duration };
                        };

                        const fmtBlocks = (s) => {
                            if (!s.blocks || s.blocks.length === 0) return '';
                            return s.blocks.map(([a, b]) => {
                                const from = `${String(a).padStart(2, '0')}:00`;
                                const to = `${String(b + 1).padStart(2, '0')}:00`;
                                return a === b ? from : `${from}–${to}`;
                            }).join(', ');
                        };

                        // Merge today's OM hours into existing hourlyPrecip (preserve other days)
                        // Store precip + prob so duration/blocks can use probability on next runs.
                        const mergeTodayBaseline = async () => {
                            const yesterdayStr = getLocalDateStr(cityTimezone, -1);
                            const todayHours = [];
                            for (let i = 0; i < allTimes.length; i++) {
                                if (allTimes[i].startsWith(todayStr)) {
                                    todayHours.push({
                                        time: allTimes[i],
                                        precip: allPrecip[i] || 0,
                                        prob: allProb[i] != null ? allProb[i] : 0
                                    });
                                }
                            }
                            const merged = mergeHourlyFlat(
                                evening?.hourlyPrecip || oldPrecipArr,
                                todayStr,
                                todayHours,
                                yesterdayStr
                            );
                            const mergeNow = new Date();
                            const curBl = getDayBaseline(evening, todayStr, cityTimezone);
                            const mergeSet = {
                                "eveningState.hourlyPrecip": merged,
                                "eveningState.hourlyPrecipUpdatedAt": mergeNow,
                                "eveningState.updatedAt": mergeNow,
                                ...daySetPaths(todayStr, {
                                    asOf: mergeNow,
                                    hourlyPrecip: todayHours,
                                    min_temp: curBl?.min_temp,
                                    max_temp: curBl?.max_temp
                                })
                            };
                            // daySetPaths skips undefined — ensure temps preserved if present
                            if (curBl?.min_temp != null) mergeSet[`eveningState.days.${todayStr}.min_temp`] = curBl.min_temp;
                            if (curBl?.max_temp != null) mergeSet[`eveningState.days.${todayStr}.max_temp`] = curBl.max_temp;

                            await City.findOneAndUpdate(
                                { externalId: key },
                                { $set: mergeSet }
                            );
                            if (evening) {
                                evening.hourlyPrecip = merged;
                                evening.hourlyPrecipUpdatedAt = mergeNow;
                                evening.updatedAt = mergeNow;
                                if (!evening.days) evening.days = {};
                                evening.days[todayStr] = {
                                    ...(evening.days[todayStr] || {}),
                                    asOf: mergeNow,
                                    hourlyPrecip: todayHours,
                                    min_temp: curBl?.min_temp ?? evening.days[todayStr]?.min_temp,
                                    max_temp: curBl?.max_temp ?? evening.days[todayStr]?.max_temp
                                };
                            }
                            dayAsOf = mergeNow;
                        };

                        // Future-only for shouldAlert; full-day for alert text
                        const oldS = calcStats(oldByHour, localHour);
                        const newS = calcStats(newByHour, localHour);
                        const oldSFull = calcStats(oldByHour, 0);
                        const newSFull = calcStats(newByHour, 0);

                        // No baseline for remaining (future) hours today → set silently
                        // duration > 0 covers hours with precip=0 but prob > threshold
                        const hasTodayBaseline = Object.keys(oldByHour).length > 0 && (oldS.total > 0 || oldS.duration > 0);
                        if (!hasTodayBaseline) {
                            await mergeTodayBaseline();
                        } else {
                            const amountIncrease = newS.total - oldS.total;
                            const significantAmountUp = amountIncrease >= 1.5;

                            // Canceled when previous FUTURE rainy window is gone
                            const fullyCanceled = (oldS.total > 0 || oldS.duration > 0) && newS.total === 0 && newS.duration === 0;

                            let significantShift = false;
                            let significantLonger = false;
                            if (oldS.start != null && newS.start != null) {
                                const startDelta = Math.abs(newS.start - oldS.start);
                                const endDelta = Math.abs((newS.end ?? newS.start) - (oldS.end ?? oldS.start));
                                significantShift = startDelta >= 2 || endDelta >= 2;
                                significantLonger = (newS.duration - oldS.duration) >= 2;
                            } else if (oldS.start == null && newS.start != null && (newS.total >= 0.5 || newS.duration >= 1)) {
                                significantShift = true;
                            }

                            const shouldAlert = fullyCanceled || significantAmountUp || significantShift || significantLonger;

                            if (shouldAlert) {
                                // Message uses FULL-day schedule; decision was future-only
                                let precipKind = null;
                                if (fullyCanceled) precipKind = 'canceled';
                                else if (significantAmountUp) precipKind = 'amountUp';
                                else if (significantLonger) precipKind = 'longer';
                                else if (significantShift) precipKind = (oldS.start == null) ? 'appeared' : 'shifted';

                                if (precipKind) {
                                    reasons.push("зміна опадів");
                                    for (const user of cityInfo.users) {
                                        if (!user.notificationsEnabled || user.alertTriggers?.precip === false) continue;
                                        const lang = user.language || 'uk';
                                        const asOf = formatLocalDateTime(oldPrecipAsOf, cityTimezone, lang) || '';
                                        const html = htmlPrecip(lang, precipKind, {
                                            asOf,
                                            oldBlocks: fmtBlocks(oldSFull) || '—',
                                            oldTotal: oldSFull.total,
                                            newBlocks: precipKind === 'canceled' ? '—' : (fmtBlocks(newSFull) || '—'),
                                            newTotal: precipKind === 'canceled' ? 0 : newSFull.total
                                        });
                                        alerts.push({ userId: user.telegramId, html, lang });
                                    }
                                    alertTriggered = true;
                                }

                                // Update baseline (merge) so we don't re-alert on the same change
                                await mergeTodayBaseline();
                            }
                        }
                    }
                } catch (omErr) {
                    console.error('Open-Meteo fetch error in check:', omErr.message);
                }

                // --- LOGIC E: Real-time Geomagnetic Activity (Magnetic Storms) ---
                // Rules (state machine by rank):
                // - Evening forecast does NOT write geomag state to DB
                // - Check owns lastGeomagAlert { date, maxKp, rank, level }
                // - Same rank today → silent (no re-send, no overwrite spam)
                // - Rank increased → alert worse (unsettled / storm) + recommendations
                // - Rank decreased → alert improved (to unsettled / to quiet)
                // - First observation of the day always seeds lastGeomagAlert;
                //   alert only if rank >= 1 (unsettled+) so we don't spam "calm" at midnight
                let snapGeomag = null;
                let snapWaqi = null;
                try {
                    const noaaRes = await axios.get(
                        'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
                        { timeout: 8000 }
                    );
                    if (noaaRes.data && Array.isArray(noaaRes.data) && noaaRes.data.length > 0) {
                        const now = Date.now();
                        const next12h = noaaRes.data
                            .filter(r => {
                                const t = new Date(r.time_tag).getTime();
                                return t >= now - 2 * 3600 * 1000 && t <= now + 12 * 3600 * 1000;
                            })
                            .map(r => parseFloat(r.kp))
                            .filter(v => !isNaN(v));

                        const currentMaxKp = next12h.length > 0 ? Math.max(...next12h) : null;
                        const current = getGeomagLevel(currentMaxKp);

                        if (current) {
                            snapGeomag = {
                                maxKp: current.kp,
                                badge: current.badge,
                                level: current.level,
                                rank: current.rank,
                                updatedAt: new Date()
                            };

                            const last = cityDoc?.lastGeomagAlert;
                            const lastRank = (last?.date === todayStr && last?.rank != null)
                                ? Number(last.rank)
                                : (last?.date === todayStr && last?.maxKp != null
                                    ? (getGeomagLevel(last.maxKp)?.rank ?? -1)
                                    : -1);

                            // Same rank today → silent (dashboard snap only)
                            if (last?.date === todayStr && current.rank === lastRank) {
                                // no-op
                            } else {
                                // kind: 'worse' | 'better' | null
                                // rank 0 (quiet) on first seed of day → no alert
                                let kind = null;
                                if (current.rank > lastRank && current.rank >= 1) {
                                    kind = 'worse';
                                } else if (current.rank < lastRank && lastRank >= 0) {
                                    kind = 'better';
                                }

                                let anyUserAlerted = false;
                                if (kind) {
                                    for (const user of cityInfo.users) {
                                        if (!user.notificationsEnabled || user.alertTriggers?.magneticStorm === false) continue;
                                        const lang = user.language || 'uk';
                                        const html = htmlGeomag(lang, { kind, levelInfo: current });
                                        if (!html) continue;
                                        alerts.push({ userId: user.telegramId, html, lang });
                                        anyUserAlerted = true;
                                    }
                                    if (anyUserAlerted) {
                                        if (kind === 'worse') {
                                            if (current.gScale) reasons.push(`магн. буря G${current.gScale}`);
                                            else reasons.push('збурення магн. поля');
                                        } else {
                                            reasons.push(current.rank === 0 ? 'магн. поле спокійно' : `магн. поле ↓ ${current.level}`);
                                        }
                                        alertTriggered = true;
                                    }
                                }

                                // Always persist current level so next pass can detect change
                                await City.findOneAndUpdate(
                                    { externalId: key },
                                    {
                                        $set: {
                                            lastGeomagAlert: {
                                                date: todayStr,
                                                maxKp: current.kp,
                                                rank: current.rank,
                                                level: current.level
                                            }
                                        }
                                    }
                                );
                            }
                        }
                    }
                } catch (geomagErr) {
                    console.error('Geomag check error in cron-check:', geomagErr.message);
                }

                // --- LOGIC F: Real-time AQI Transition Check (worsen OR improve to safe) ---
                // Rules:
                // - Alert only on transitions: safe → worse, or worse → safe
                // - Do NOT spam when level stays the same (safe→safe or bad→bad)
                // - When recovering to safe (tier 0), send a positive message
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
                            const pm25 = d.iaqi?.pm25?.v ?? null;
                            const pm10 = d.iaqi?.pm10?.v ?? null;

                            let currentTier = 0;
                            let badge = '🟢';
                            if (aqiVal > 150) { currentTier = 3; badge = '🔴'; }
                            else if (aqiVal > 100) { currentTier = 2; badge = '🟠'; }
                            else if (aqiVal > 50) { currentTier = 1; badge = '🟡'; }

                            snapWaqi = {
                                aqi: aqiVal,
                                aqiBadge: badge,
                                pm25,
                                pm10,
                                pm1: d.iaqi?.pm1?.v ?? null,
                                station: d.city?.name || null
                            };

                            const lastAqiTier = cityDoc?.lastAqiAlert?.tier ?? 0;

                            // Always persist current state so next check has correct baseline
                            await City.findOneAndUpdate(
                                { externalId: key },
                                { $set: { "lastAqiAlert": { date: todayStr, tier: currentTier, aqi: aqiVal } } }
                            );

                            if (currentTier > lastAqiTier) {
                                // Deterioration: safe → worse, or worse → even worse
                                reasons.push("погіршення якості повітря");

                                for (const user of cityInfo.users) {
                                    if (!user.notificationsEnabled || user.alertTriggers?.airQuality === false) continue;
                                    const lang = user.language || 'uk';
                                    const isUk = lang === 'uk';

                                    const issues = [];
                                    if (pm25 != null && pm25 > 25) issues.push(isUk ? 'PM2.5 (дрібний пил/смог)' : 'PM2.5 (fine dust/smog)');
                                    if (pm10 != null && pm10 > 50) issues.push(isUk ? 'PM10 (великий пил)' : 'PM10 (coarse dust)');

                                    let advice = '';
                                    if (aqiVal > 150) {
                                        advice = isUk
                                            ? '🔴 Небезпечний рівень забруднення! Зачиніть вікна, увімкніть очищувач повітря та утримайтесь від виходу на вулицю.'
                                            : '🔴 Dangerous air quality! Close windows, turn on air purifiers, and refrain from going outside.';
                                    } else if (aqiVal > 100) {
                                        advice = isUk
                                            ? '🟠 Шкідливо для чутливих груп! Високий рівень пилу/смогу. Рекомендуємо зачинити вікна.'
                                            : '🟠 Unhealthy for sensitive groups! High dust/smog level. We recommend closing windows.';
                                    } else if (aqiVal > 50) {
                                        advice = isUk
                                            ? '🟡 Повітря помірно забруднене. Чутливим людям варто бути обережними.'
                                            : '🟡 Moderate air pollution. Sensitive individuals should take precautions.';
                                    }
                                    if (issues.length > 0) {
                                        advice += isUk ? ` (Причина: ${issues.join(', ')})` : ` (Reason: ${issues.join(', ')})`;
                                    }

                                    const html = htmlAqiWorse(lang, { aqiVal, badge, pm25, pm10, advice });
                                    alerts.push({ userId: user.telegramId, html, lang });
                                }
                                alertTriggered = true;
                            } else if (currentTier === 0 && lastAqiTier > 0) {
                                // Recovery: was worse → now safe
                                reasons.push("покращення якості повітря");

                                for (const user of cityInfo.users) {
                                    if (!user.notificationsEnabled || user.alertTriggers?.airQuality === false) continue;
                                    const lang = user.language || 'uk';
                                    const isUk = lang === 'uk';

                                    const html = htmlAqiBetter(lang, { aqiVal });
                                    alerts.push({ userId: user.telegramId, html, lang });
                                }
                                alertTriggered = true;
                            }
                            // Same tier (safe→safe or bad→bad) → no message
                        }
                    } catch (aqiErr) {
                        console.error('AQI check error in cron-check:', aqiErr.message);
                    }
                }

                // --- SENDING ALERTS (Rich Messages) ---
                const uniqueAlerts = {}; // prevent duplicate messages to same user
                for (const a of alerts) {
                    if (!uniqueAlerts[a.userId]) uniqueAlerts[a.userId] = { parts: [], lang: a.lang || 'uk' };
                    if (a.html) uniqueAlerts[a.userId].parts.push(a.html);
                }

                for (const userId of Object.keys(uniqueAlerts)) {
                    const parts = uniqueAlerts[userId].parts;
                    if (!parts.length) continue;
                    await sleep(50);
                    const userLang = uniqueAlerts[userId].lang || 'uk';
                    const btnText = userLang === 'uk' ? '⚙️ Налаштувати сповіщення' : '⚙️ Configure alerts';
                    try {
                        await bot.api.sendRichMessage(userId, {
                            html: parts.join('<hr/>'),
                            skip_entity_detection: true
                        }, {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: btnText, callback_data: 'alert_settings' }]
                                ]
                            }
                        });
                        alertsTotal++;
                    } catch (sendErr) {
                        console.error(`sendRichMessage failed for ${userId}:`, sendErr.message);
                        // Fallback: strip tags roughly and send plain
                        const plain = parts.join('\n\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                        await bot.api.sendMessage(userId, plain, {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: btnText, callback_data: 'alert_settings' }]
                                ]
                            }
                        }).catch(() => {});
                        alertsTotal++;
                    }
                }

                // Update city and users
                if (current.timezone && !cityDoc?.timezone) {
                    await City.findOneAndUpdate({ externalId: key }, { timezone: current.timezone });
                }

                // --- Dashboard snapshot (Weatherbit layer + OM hourly if fetched) ---
                const { degToCard } = require('../utils/weather');
                const wbCurrent = {
                    ...current,
                    wind_cdir: current.wind_dir != null ? degToCard(current.wind_dir) : (current.wind_cdir || 'N'),
                    source: 'weatherbit'
                };
                const wbDaily = dailyAll.map(d => ({
                    ...d,
                    max_temp: d.max_temp,
                    min_temp: d.min_temp,
                    pop: d.pop,
                    gust: d.wind_gust_spd,
                    vis: d.vis,
                    uv: d.uv,
                    sunrise: d.sunrise_ts ? d.sunrise_ts * 1000 : d.sunrise,
                    sunset: d.sunset_ts ? d.sunset_ts * 1000 : d.sunset,
                    wind_cdir: d.wind_dir != null ? degToCard(d.wind_dir) : (d.wind_cdir || 'N')
                }));

                const snapWb = {
                    'dashboardSnapshot.updatedAtWb': new Date(),
                    'dashboardSnapshot.current': wbCurrent,
                    'dashboardSnapshot.currentSource': 'weatherbit',
                    'dashboardSnapshot.daily': wbDaily,
                    'dashboardSnapshot.dailySource': 'weatherbit',
                    'dashboardSnapshot.lat': cityInfo.lat,
                    'dashboardSnapshot.lon': cityInfo.lon,
                    'dashboardSnapshot.timezone': cityTimezone
                };
                if (omHourlyForSnap) {
                    const dailyOmFromHourly = omHourlyForSnap._dailyOm || null;
                    if (omHourlyForSnap._dailyOm) delete omHourlyForSnap._dailyOm;
                    snapWb['dashboardSnapshot.hourly'] = omHourlyForSnap;
                    snapWb['dashboardSnapshot.updatedAtOm'] = new Date();
                    if (dailyOmFromHourly) {
                        snapWb['dashboardSnapshot.dailyOm'] = dailyOmFromHourly;
                    }
                }
                if (snapGeomag) snapWb['dashboardSnapshot.geomag'] = snapGeomag;
                if (snapWaqi) snapWb['dashboardSnapshot.waqi'] = snapWaqi;
                await City.findOneAndUpdate({ externalId: key }, { $set: snapWb }, { upsert: true });

                for (const user of cityInfo.users) {
                    user.lastState = { ...user.lastState, temp: current.temp, weatherCode: newCode, updatedAt: new Date() };
                    await user.save();
                }

                const statusStr = alertTriggered ? `🚨 ${reasons.join(', ')}` : '✅ без змін';
                const weatherDesc = getWeatherDesc(newCode, 'uk');
                const windDir = getWindDir(current.wind_cdir, 'uk');
                logLines.push(`• ${cityInfo.name} | ${current.temp}°C | ${weatherDesc} | ${windDir} | ${statusStr}`);

            } catch (err) {
                errorsCount++;
                logLines.push(`• ${cityInfo.name} | ❌ помилка: ${err.message}`);
            }
        }

        const summary = [
            `📋 <b>Перевірка погоди</b> — ${startTime}`,
            `👥 Користувачів перевірено: ${users.length}`,
            `🚨 Сповіщень надіслано: ${alertsTotal}`,
            `❌ Помилок: ${errorsCount}`,
            ``,
            ...logLines
        ].join('\n');
        await log(summary);
        res.status(200).send('Processed');

    } catch (error) {
        console.error(error);
        await log(`❌ <b>Weather Check FAILED</b>\n<code>${escapeHTML(error.message)}</code>`);
        res.status(500).send('Error');
    }
}
