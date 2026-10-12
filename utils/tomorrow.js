/**
 * Tomorrow.io helpers — shared by frost cron, check cron, and bot hourly "Перевірити".
 *
 * Env: TOMORROW_IO_KEY
 * API: GET https://api.tomorrow.io/v4/timelines
 */
const axios = require('axios');

const TIO_BASE = 'https://api.tomorrow.io/v4/timelines';

/** Weather code → emoji (Tomorrow.io weather codes) */
const TIO_WEATHER_EMOJI = {
    0: '❓',
    1000: '☀️',
    1100: '🌤',
    1101: '⛅',
    1102: '🌥',
    1001: '☁️',
    2000: '🌫',
    2100: '🌫',
    4000: '🌦',
    4001: '🌧',
    4200: '🌧',
    4201: '🌧',
    5000: '❄️',
    5001: '🌨',
    5100: '🌨',
    5101: '❄️',
    6000: '🌧',
    6001: '🌧',
    6200: '🌧',
    6201: '🌧',
    7000: '🧊',
    7101: '🧊',
    7102: '🧊',
    8000: '⛈'
};

const tioWeatherEmoji = (code) => TIO_WEATHER_EMOJI[Number(code)] || '🌤';

/**
 * Parse one Tomorrow.io hourly interval into local date/hour + values.
 * @returns {{ temperature, precip, precipProb, windMs, weatherCode, date, hour, timeLocal }|null}
 */
function parseHourlyInterval(interval, timezone) {
    const raw = String(interval.startTime || interval.time || '');
    if (!raw) return null;

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
        dateStr = raw.slice(0, 10);
        hour = parseInt(raw.slice(11, 13), 10);
    }

    if (Number.isNaN(hour) || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;

    const v = interval.values || interval;
    const temperature = v.temperature != null ? Number(v.temperature) : null;
    // precipitationIntensity is mm/h ≈ mm for 1h step; precipitationProbability 0–100
    let precip = 0;
    if (v.precipitationIntensity != null) precip = Number(v.precipitationIntensity) || 0;
    else if (v.rainIntensity != null) precip = Number(v.rainIntensity) || 0;
    else if (v.precipitation != null) precip = Number(v.precipitation) || 0;

    let precipProb = null;
    if (v.precipitationProbability != null) precipProb = Number(v.precipitationProbability);
    else if (v.rainProbability != null) precipProb = Number(v.rainProbability);

    let windMs = null;
    if (v.windSpeed != null) windMs = Number(v.windSpeed);

    let weatherCode = v.weatherCode != null ? Number(v.weatherCode) : null;

    return {
        temperature: (temperature != null && !Number.isNaN(temperature)) ? temperature : null,
        precip: Number.isNaN(precip) ? 0 : precip,
        precipProb: (precipProb != null && !Number.isNaN(precipProb)) ? precipProb : null,
        windMs: (windMs != null && !Number.isNaN(windMs)) ? windMs : null,
        weatherCode,
        date: dateStr,
        hour,
        timeLocal: `${dateStr}T${String(hour).padStart(2, '0')}:00`
    };
}

/**
 * Fetch hourly timeline from Tomorrow.io for lat/lon.
 * @param {number} lat
 * @param {number} lon
 * @param {string} timezone IANA tz
 * @param {object} [opts]
 * @param {string} [opts.endTime='nowPlus48h']
 * @param {string} [opts.apiKey]
 * @returns {Promise<{ hours: Array, fetchedAt: Date }>}
 */
async function fetchTomorrowHourly(lat, lon, timezone = 'Europe/Kyiv', opts = {}) {
    const apiKey = opts.apiKey || process.env.TOMORROW_IO_KEY;
    if (!apiKey) {
        throw new Error('TOMORROW_IO_KEY is not set');
    }

    const fields = [
        'temperature',
        'weatherCode',
        'precipitationIntensity',
        'precipitationProbability',
        'windSpeed'
    ].join(',');

    const endTime = opts.endTime || 'nowPlus48h';
    const url =
        `${TIO_BASE}` +
        `?location=${lat},${lon}` +
        `&fields=${fields}` +
        `&timesteps=1h` +
        `&units=metric` +
        `&timezone=${encodeURIComponent(timezone)}` +
        `&startTime=now` +
        `&endTime=${encodeURIComponent(endTime)}` +
        `&apikey=${encodeURIComponent(apiKey)}`;

    const res = await axios.get(url, { timeout: opts.timeout || 15000 });
    const timelines = res.data?.data?.timelines || [];
    const hourlyTimeline = timelines.find(t => t.timestep === '1h') || timelines[0];
    const intervals = hourlyTimeline?.intervals || [];

    const hours = [];
    for (const iv of intervals) {
        const row = parseHourlyInterval(iv, timezone);
        if (row) hours.push(row);
    }

    return { hours, fetchedAt: new Date(), rawCount: intervals.length };
}

/**
 * Filter parsed hours to a single calendar day YYYY-MM-DD.
 */
function filterHoursByDate(hours, dateStr) {
    return (hours || []).filter(h => h.date === dateStr);
}

module.exports = {
    TIO_WEATHER_EMOJI,
    tioWeatherEmoji,
    parseHourlyInterval,
    fetchTomorrowHourly,
    filterHoursByDate
};
