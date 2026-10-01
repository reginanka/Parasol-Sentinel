/**
 * Evening soil-frost cross-check (~21:00 local per city).
 *
 * Data source: **Tomorrow.io** hourly forecast (timelines API).
 * We take the **coldest hour** in the overnight window (local 21:00 today → 08:00
 * tomorrow), then estimate morning soil surface:
 *   T_soil ≈ T − k · (T − T_dew)
 * with T, dewPoint, cloudCover, windSpeed from that same forecast hour.
 *
 * Primary frost signal (user rule):
 *   air temp ≤ +3.0 °C  AND  dew point ≤ +2.0 °C
 *
 * Formula (radiation frost model) is always computed and reported.
 *
 * Message tiers:
 *   full     — thresholds + formula frost  → high danger / full combo
 *   risk     — thresholds only, formula still warm → confirmed risk, may not materialize
 *   formula  — formula frost only (no thresholds)
 *   deny     — Open-Meteo said frost, but neither thresholds nor formula confirm
 *   silent   — nothing
 *
 * Compared with Open-Meteo soil frost (snapshot or live).
 *
 * Env:
 *   TOMORROW_IO_KEY  — required
 */
require('dotenv').config();
const axios = require('axios');
const getBot = require('../utils/bot');
const bot = getBot();
const logToTelegram = require('../utils/logger');
const User = require('../models/User');
const City = require('../models/City');
const connectDB = require('../utils/db');
const { sleep, escapeHTML, getLocalDateStr } = require('../utils/helpers');
const {
    estimateSoilTemp0,
    formatSoilTemp,
    isFrostSeason
} = require('../utils/weather');

const TIO_KEY = process.env.TOMORROW_IO_KEY;
const SOIL_FROST_THRESHOLD = 0.5; // °C — same as OM rule / formula frost
const AIR_FROST_THRESHOLD = 3.0;  // °C — air temp ≤ this
const DEW_FROST_THRESHOLD = 2.0;  // °C — dew point ≤ this

/** Overnight hours local: from 21 today through 08 tomorrow (inclusive). */
function isOvernightHour(dateStr, hour, todayStr, tomorrowStr) {
    if (dateStr === todayStr && hour >= 21) return true;
    if (dateStr === tomorrowStr && hour <= 8) return true;
    return false;
}

/**
 * Parse one Tomorrow.io hourly interval.
 * Response shape: { startTime: "2026-10-01T05:00:00Z", values: { temperature, dewPoint, ... } }
 * or weather/forecast style: { time: "...", values: { ... } }
 */
function parseHourFields(interval, timezone) {
    const raw = String(interval.startTime || interval.time || '');
    if (!raw) return null;

    // Convert to local date/hour via Intl (timezone from city)
    let dateStr;
    let hour;
    try {
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) return null;
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            hour12: false
        }).formatToParts(d);
        const y = parts.find(p => p.type === 'year')?.value;
        const m = parts.find(p => p.type === 'month')?.value;
        const day = parts.find(p => p.type === 'day')?.value;
        const h = parts.find(p => p.type === 'hour')?.value;
        if (!y || !m || !day || h == null) return null;
        dateStr = `${y}-${m}-${day}`;
        hour = parseInt(h, 10) % 24;
    } catch {
        // Fallback: assume ISO local-ish
        dateStr = raw.slice(0, 10);
        hour = parseInt(raw.slice(11, 13), 10);
    }

    const v = interval.values || interval;
    const t = v.temperature != null ? Number(v.temperature) : null;
    if (t == null || Number.isNaN(t) || Number.isNaN(hour) || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return null;
    }

    const dew = v.dewPoint != null ? Number(v.dewPoint) : null;
    let clouds = 50;
    if (v.cloudCover != null) clouds = Number(v.cloudCover);
    let windMs = 2;
    if (v.windSpeed != null) windMs = Number(v.windSpeed);

    return {
        temperature: t,
        dew_point: (dew != null && !Number.isNaN(dew)) ? dew : null,
        clouds: Number.isNaN(clouds) ? 50 : clouds,
        windMs: Number.isNaN(windMs) ? 2 : windMs,
        date: dateStr,
        hour
    };
}

/**
 * Pick the coldest overnight hour from Tomorrow.io intervals.
 * Prefer hours that have dew_point; among those pick coldest air temp.
 */
function pickMorningHour(intervals, todayStr, tomorrowStr, timezone) {
    if (!Array.isArray(intervals) || intervals.length === 0) return null;

    const overnight = [];
    const all = [];
    for (const h of intervals) {
        const parsed = parseHourFields(h, timezone);
        if (!parsed) continue;
        all.push(parsed);
        if (isOvernightHour(parsed.date, parsed.hour, todayStr, tomorrowStr)) {
            overnight.push(parsed);
        }
    }

    const pool = overnight.length > 0 ? overnight : all;
    if (pool.length === 0) return null;

    const withDew = pool.filter(p => p.dew_point != null);
    const candidates = withDew.length > 0 ? withDew : pool;
    let best = candidates[0];
    for (const p of candidates) {
        if (p.temperature < best.temperature) best = p;
    }
    return best;
}

module.exports = async (req, res) => {
    const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
    const log = (text) => logToTelegram(bot, LOG_CHAT_ID, text);

    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).send('Unauthorized');
    }
    if (!TIO_KEY) {
        return res.status(500).send('TOMORROW_IO_KEY is not set');
    }

    const startTime = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

    try {
        await connectDB();
        const users = await User.find({ notificationsEnabled: true });

        const uniqueCities = {};
        for (const user of users) {
            if (!user.lat || !user.lon) continue;
            const key = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
            if (!uniqueCities[key]) {
                uniqueCities[key] = {
                    lat: user.lat,
                    lon: user.lon,
                    name: user.city,
                    users: []
                };
            }
            uniqueCities[key].users.push(user);
        }

        let alertsTotal = 0;
        let errorsCount = 0;
        const logLines = [];

        /**
         * Message templates.
         * Placeholders: {soil} {omSoil} {k} {t} {td} {hour}
         */
        const msgDict = {
            uk: {
                full:
                    '🔴 **Високий рівень небезпеки — повне комбо**\n' +
                    'Під ранок (~{hour}:00) приморозок підтверджено:\n' +
                    '• **Tomorrow.io:** повітря **{t}°C** (≤ +3.0°C), точка роси **{td}°C** (≤ +2.0°C)\n' +
                    '• **Формула:** ґрунт ≈ **{soil}** (k={k})\n' +
                    '• **Open-Meteo:** мін. ґрунт {omSoil} — теж бачив ризик\n' +
                    'Рекомендовано захист рослин (укриття, полив, димлення).',
                risk:
                    '⚠️ **Підтверджений ризик, але за формулою t ґрунту ще завелика**\n' +
                    'Під ранок (~{hour}:00):\n' +
                    '• **Tomorrow.io:** повітря **{t}°C**, точка роси **{td}°C** — умови для приморозку є\n' +
                    '• **Формула:** ґрунт ≈ **{soil}** (k={k}) — вище порогу 0.5°C\n' +
                    '• **Open-Meteo:** мін. ґрунт {omSoil}\n' +
                    'Ризик є, проте приморозок може і не реалізуватися.',
                formula:
                    '⚠️ **Формула бачить ризик заморозку по ґрунту**\n' +
                    'Під ранок (~{hour}:00):\n' +
                    '• **Формула:** ґрунт ≈ **{soil}** (k={k})\n' +
                    '• **Tomorrow.io:** повітря {t}°C, точка роси {td}°C — пороги T≤+3 / Td≤+2 не виконані\n' +
                    '• **Open-Meteo:** мін. ґрунт {omSoil}',
                deny:
                    'ℹ️ **Не підтверджено**\n' +
                    '• **Open-Meteo:** показував заморозок (мін. ґрунт {omSoil})\n' +
                    '• **Tomorrow.io + формула:** не підтверджують — на ~{hour}:00 ґрунт **{soil}** (повітря {t}°C, Td {td}°C, k={k})'
            },
            en: {
                full:
                    '🔴 **High danger — full combo**\n' +
                    'Morning frost confirmed (~{hour}:00):\n' +
                    '• **Tomorrow.io:** air **{t}°C** (≤ +3.0°C), dew point **{td}°C** (≤ +2.0°C)\n' +
                    '• **Formula:** soil ≈ **{soil}** (k={k})\n' +
                    '• **Open-Meteo:** min soil {omSoil} — also saw risk\n' +
                    'Protect plants (cover, watering, smoke).',
                risk:
                    '⚠️ **Confirmed risk, but formula soil temp is still too high**\n' +
                    'Morning (~{hour}:00):\n' +
                    '• **Tomorrow.io:** air **{t}°C**, dew point **{td}°C** — frost conditions present\n' +
                    '• **Formula:** soil ≈ **{soil}** (k={k}) — above 0.5°C threshold\n' +
                    '• **Open-Meteo:** min soil {omSoil}\n' +
                    'Risk exists, yet frost may not fully materialize.',
                formula:
                    '⚠️ **Formula sees soil frost risk**\n' +
                    'Morning (~{hour}:00):\n' +
                    '• **Formula:** soil ≈ **{soil}** (k={k})\n' +
                    '• **Tomorrow.io:** air {t}°C, dew point {td}°C — T≤+3 / Td≤+2 not met\n' +
                    '• **Open-Meteo:** min soil {omSoil}',
                deny:
                    'ℹ️ **Not confirmed**\n' +
                    '• **Open-Meteo:** indicated frost (min soil {omSoil})\n' +
                    '• **Tomorrow.io + formula:** do not confirm — at ~{hour}:00 soil **{soil}** (air {t}°C, Td {td}°C, k={k})'
            }
        };

        for (const [key, cityInfo] of Object.entries(uniqueCities)) {
            try {
                const cityDoc = await City.findOne({ externalId: key }).lean();
                const timezone = cityDoc?.timezone
                    || cityDoc?.dashboardSnapshot?.timezone
                    || 'Europe/Kyiv';

                const todayStr = getLocalDateStr(timezone, 0);
                const tomorrowStr = getLocalDateStr(timezone, 1);

                if (cityDoc?.lastFrostWbAlert?.date === todayStr) {
                    logLines.push(`• ${cityInfo.name} | ⏭ вже було сповіщення сьогодні`);
                    continue;
                }

                // Season gate: Mar–Jun, Aug–Nov only (no winter spam)
                if (!isFrostSeason(new Date(), timezone)) {
                    logLines.push(`• ${cityInfo.name} | ⏭ поза сезоном приморозків (бер–чер / сер–лист)`);
                    continue;
                }

                // --- Tomorrow.io hourly (metric: °C, wind m/s) ---
                // GET /v4/timelines — fields include dewPoint natively
                const fields = ['temperature', 'dewPoint', 'cloudCover', 'windSpeed'].join(',');
                const tioUrl =
                    `https://api.tomorrow.io/v4/timelines` +
                    `?location=${cityInfo.lat},${cityInfo.lon}` +
                    `&fields=${fields}` +
                    `&timesteps=1h` +
                    `&units=metric` +
                    `&timezone=${encodeURIComponent(timezone)}` +
                    `&startTime=now` +
                    `&endTime=nowPlus18h` +
                    `&apikey=${encodeURIComponent(TIO_KEY)}`;

                const tioRes = await axios.get(tioUrl, { timeout: 15000 });
                const timelines = tioRes.data?.data?.timelines || [];
                const hourlyTimeline = timelines.find(t => t.timestep === '1h') || timelines[0];
                const intervals = hourlyTimeline?.intervals || [];

                if (intervals.length === 0) {
                    const keys = tioRes.data ? Object.keys(tioRes.data).join(',') : 'null';
                    throw new Error(`Tomorrow.io: empty hourly intervals (response keys: ${keys})`);
                }

                const morning = pickMorningHour(intervals, todayStr, tomorrowStr, timezone);
                if (!morning) {
                    throw new Error(`Tomorrow.io: no usable overnight hour (n=${intervals.length})`);
                }

                const tAir = morning.temperature;
                let dewpt = morning.dew_point;

                if (dewpt == null || Number.isNaN(Number(dewpt))) {
                    throw new Error('Tomorrow.io: dewPoint missing for coldest hour');
                }

                // Avoid formula warming when Td > T at that hour
                const tdEff = Math.min(dewpt, tAir);

                const est = estimateSoilTemp0(tAir, tdEff, morning.clouds, morning.windMs);
                if (!est) {
                    throw new Error('Cannot estimate soil from Tomorrow.io hour');
                }

                const soilEst = est.soilEst;

                // --- Daily mean > 0 required (radiation frost only; skip winter spam) ---
                // Prefer Open-Meteo daily mean from snapshot; fallback Weatherbit day temp from evening forecast
                let meanDay = null;
                const dailyOm = cityDoc?.dashboardSnapshot?.dailyOm;
                if (dailyOm?.time && dailyOm?.temperature_2m_mean) {
                    const iTmr = dailyOm.time.findIndex(t => String(t).startsWith(tomorrowStr));
                    const iTod = dailyOm.time.findIndex(t => String(t).startsWith(todayStr));
                    if (iTmr >= 0 && dailyOm.temperature_2m_mean[iTmr] != null) {
                        meanDay = Number(dailyOm.temperature_2m_mean[iTmr]);
                    } else if (iTod >= 0 && dailyOm.temperature_2m_mean[iTod] != null) {
                        meanDay = Number(dailyOm.temperature_2m_mean[iTod]);
                    }
                }
                if ((meanDay == null || Number.isNaN(meanDay)) && Array.isArray(cityDoc?.eveningState?.forecast)) {
                    const wb = cityDoc.eveningState.forecast;
                    const dayKey = (d) => String(d?.valid_date || d?.datetime || '').slice(0, 10);
                    const row = wb.find(d => dayKey(d) === tomorrowStr) || wb.find(d => dayKey(d) === todayStr);
                    if (row) {
                        if (row.temp != null) meanDay = Number(row.temp);
                        else if (row.min_temp != null && row.max_temp != null) {
                            meanDay = (Number(row.min_temp) + Number(row.max_temp)) / 2;
                        }
                    }
                }
                const meanPositive = meanDay != null && !Number.isNaN(meanDay) && meanDay > 0;

                // Without positive daily mean — silent (winter / deep cold, not radiation frost season)
                if (!meanPositive) {
                    logLines.push(
                        `• ${cityInfo.name} | ~${String(morning.hour).padStart(2, '0')}:00 T=${tAir.toFixed(1)}° Td=${Number(dewpt).toFixed(1)}° soil≈${soilEst.toFixed(1)}° | ⏭ mean=${meanDay == null ? '?' : meanDay.toFixed(1)}° ≤0 — без радіаційного приморозку`
                    );
                    await sleep(1100);
                    continue;
                }

                const formulaFrost = soilEst <= SOIL_FROST_THRESHOLD;
                const thresholdRisk = (tAir <= AIR_FROST_THRESHOLD) && (dewpt <= DEW_FROST_THRESHOLD);

                // --- OM frost from Mongo (saved by evening forecast) — do NOT re-fetch Open-Meteo ---
                // eveningState.plannedFrost = { date, minSoil, hour, warnedAt }
                // date = calendar day of the frost (usually "tomorrow" from evening run)
                const planned = cityDoc?.eveningState?.plannedFrost || null;
                let omFrost = false;
                let omMinSoil = null;
                if (planned && planned.minSoil != null && !Number.isNaN(Number(planned.minSoil))) {
                    // Match overnight target: frost for tomorrow morning, or today if still in window
                    if (planned.date === tomorrowStr || planned.date === todayStr) {
                        omMinSoil = Number(planned.minSoil);
                        omFrost = omMinSoil <= SOIL_FROST_THRESHOLD;
                    }
                }

                // --- Decide alert type ---
                let alertType = null;
                if (thresholdRisk && formulaFrost) {
                    alertType = 'full';       // high danger / full combo
                } else if (thresholdRisk && !formulaFrost) {
                    alertType = 'risk';       // thresholds yes, formula still warm
                } else if (formulaFrost && !thresholdRisk) {
                    alertType = 'formula';    // formula only
                } else if (omFrost && !thresholdRisk && !formulaFrost) {
                    alertType = 'deny';       // OM said yes, we say no
                }

                if (!alertType) {
                    logLines.push(
                        `• ${cityInfo.name} | ~${String(morning.hour).padStart(2, '0')}:00 T=${tAir.toFixed(1)}° Td=${Number(dewpt).toFixed(1)}° soil≈${soilEst.toFixed(1)}° k=${est.k} mean=${meanDay.toFixed(1)}° | ✅ без ризику`
                    );
                    await sleep(1100);
                    continue;
                }

                const soilStr = formatSoilTemp(soilEst);
                const omSoilStr = formatSoilTemp(omMinSoil);
                const kStr = String(est.k);
                const tStr = Number(tAir).toFixed(1);
                const tdStr = Number(dewpt).toFixed(1);
                const hourStr = String(morning.hour).padStart(2, '0');

                for (const user of cityInfo.users) {
                    const lang = user.language || 'uk';
                    const tpl = msgDict[lang]?.[alertType] || msgDict.uk[alertType];
                    const text = tpl
                        .replace(/\{soil\}/g, soilStr)
                        .replace(/\{omSoil\}/g, omSoilStr)
                        .replace(/\{k\}/g, kStr)
                        .replace(/\{t\}/g, tStr)
                        .replace(/\{td\}/g, tdStr)
                        .replace(/\{hour\}/g, hourStr);

                    try {
                        await bot.telegram.sendMessage(user.telegramId, text, { parse_mode: 'Markdown' });
                        alertsTotal++;
                    } catch (sendErr) {
                        console.error(`Frost TIO send to ${user.telegramId}:`, sendErr.message);
                    }
                    await sleep(50);
                }

                await City.findOneAndUpdate(
                    { externalId: key },
                    {
                        $set: {
                            lastFrostWbAlert: {
                                date: todayStr,
                                type: alertType,
                                soilEst: Math.round(soilEst * 10) / 10,
                                tAir: Math.round(tAir * 10) / 10,
                                dewpt: Math.round(dewpt * 10) / 10,
                                source: 'tomorrow.io',
                                hour: morning.hour
                            }
                        }
                    },
                    { upsert: true }
                );

                const typeIcon = alertType === 'full' ? '🔴'
                    : alertType === 'risk' ? '⚠️'
                    : alertType === 'formula' ? '⚠️'
                    : 'ℹ️';
                logLines.push(
                    `• ${cityInfo.name} | ${typeIcon} ${alertType} | ~${hourStr}:00 T=${tStr}° Td=${tdStr}° soil≈${soilEst.toFixed(1)}° | OM ${omFrost ? omSoilStr : 'ні'}`
                );

                await sleep(1100);
            } catch (err) {
                errorsCount++;
                logLines.push(`• ${cityInfo.name} | ❌ ${err.message}`);
                console.error('cron-frost-wb city error:', err.message);
            }
        }

        const summary = [
            `📋 <b>Перевірка заморозку під ранок (Tomorrow.io)</b> — ${startTime}`,
            `👥 Міст: ${Object.keys(uniqueCities).length}`,
            `🚨 Сповіщень: ${alertsTotal}`,
            `❌ Помилок: ${errorsCount}`,
            ``,
            ...logLines
        ].join('\n');
        await log(summary);
        res.status(200).send('Processed (frost-tio)');
    } catch (error) {
        console.error(error);
        await log(`❌ <b>Frost TIO Check FAILED</b>\n<code>${escapeHTML(error.message)}</code>`);
        res.status(500).send('Error');
    }
};
