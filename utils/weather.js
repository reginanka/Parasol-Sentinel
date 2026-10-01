const WEATHER_CODES = {
    200: { uk: '⛈ Гроза', en: '⛈ Thunderstorm' },
    201: { uk: '⛈ Гроза з дощем', en: '⛈ Thunderstorm with rain' },
    202: { uk: '⛈ Сильна гроза', en: '⛈ Heavy thunderstorm' },
    233: { uk: '⛈ Гроза', en: '⛈ Thunderstorm' },
    300: { uk: '🌦 Мряка', en: '🌦 Drizzle' },
    301: { uk: '🌦 Мряка', en: '🌦 Drizzle' },
    302: { uk: '🌦 Сильна мряка', en: '🌦 Heavy drizzle' },
    500: { uk: '🌧 Невеликий дощ', en: '🌧 Light rain' },
    501: { uk: '🌧 Помірний дощ', en: '🌧 Moderate rain' },
    502: { uk: '🌧 Сильний дощ', en: '🌧 Heavy rain' },
    520: { uk: '🌧 Слабкий дощ', en: '🌧 Light shower' },
    521: { uk: '🌧 Злива', en: '🌧 Shower' },
    522: { uk: '🌧 Сильна злива', en: '🌧 Heavy shower' },
    15: { uk: '🌨 Невеликий сніг', en: '🌨 Light snow' },
    600: { uk: '🌨 Невеликий сніг', en: '🌨 Light snow' },
    601: { uk: '❄️ Сніг', en: '❄️ Snow' },
    602: { uk: '❄️ Сильний снігопад', en: '❄️ Heavy snow' },
    610: { uk: '🌨 Сніг з дощем', en: '🌨 Sleet' },
    19: { uk: '🌫 Димка', en: '🌫 Mist' },
    700: { uk: '🌫 Димка', en: '🌫 Mist' },
    741: { uk: '🌫 Туман', en: '🌫 Fog' },
    751: { uk: '🌫 Мла', en: '🌫 Haze' },
    800: { uk: '☀️ Ясно', en: '☀️ Clear' },
    801: { uk: '🌤 Легка хмарність', en: '🌤 Few clouds' },
    802: { uk: '⛅ Мінлива хмарність', en: '⛅ Partly cloudy' },
    803: { uk: '🌥 Хмарно', en: '🌥 Cloudy' },
    804: { uk: '☁️ Похмуро', en: '☁️ Overcast' }
};

const WIND_DIRECTIONS = {
    'N': { uk: 'Північний', en: 'North' },
    'S': { uk: 'Південний', en: 'South' },
    'E': { uk: 'Східний', en: 'East' },
    'W': { uk: 'Західний', en: 'West' },
    'NE': { uk: 'Північно-східний', en: 'Northeast' },
    'NW': { uk: 'Північно-західний', en: 'Northwest' },
    'SE': { uk: 'Південно-східний', en: 'Southeast' },
    'SW': { uk: 'Південно-західний', en: 'Southwest' },
    'NNE': { uk: 'Пн-Пн-Сх', en: 'NNE' },
    'ENE': { uk: 'Сх-Пн-Сх', en: 'ENE' },
    'ESE': { uk: 'Сх-Пд-Сх', en: 'ESE' },
    'SSE': { uk: 'Пд-Пд-Сх', en: 'SSE' },
    'SSW': { uk: 'Пд-Пд-Зх', en: 'SSW' },
    'WSW': { uk: 'Зх-Пд-Зх', en: 'WSW' },
    'WNW': { uk: 'Зх-Пн-Зх', en: 'WNW' },
    'NNW': { uk: 'Пн-Пн-Зх', en: 'NNW' }
};

const getWeatherDesc = (code, lang = 'uk') => {
    return WEATHER_CODES[code]?.[lang] || (lang === 'uk' ? `код ${code}` : `code ${code}`);
};

const getWindDir = (cdir, lang = 'uk') => {
    return WIND_DIRECTIONS[cdir]?.[lang] || cdir;
};

const degToCard = (deg) => {
    const cardinal = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    const index = Math.round(deg / 22.5) % 16;
    return cardinal[index];
};

const getIconMapping = (code) => {
    // Map Weatherbit icons to high-quality Meteocons
    const mapping = {
        'c01d': 'clear-day', 'c01n': 'clear-night',
        'c02d': 'partly-cloudy-day', 'c02n': 'partly-cloudy-night',
        'c03d': 'cloudy', 'c03n': 'cloudy',
        'c04d': 'overcast-day', 'c04n': 'overcast-night',
        'a01d': 'mist', 'a05d': 'fog',
        'r01d': 'rain', 'r02d': 'heavy-rain', 'r03d': 'heavy-rain',
        'd01d': 'drizzle', 'd02d': 'drizzle', 'd03d': 'drizzle',
        's01d': 'snow', 's02d': 'heavy-snow', 's04d': 'sleet',
        't01d': 'thunderstorms-day', 't02d': 'thunderstorms-day', 't04d': 'thunderstorms-rain'
    };
    return mapping[code] || (code.startsWith('r') ? 'rain' : code.startsWith('s') ? 'snow' : code.startsWith('t') ? 'thunderstorms' : 'not-available');
};

/**
 * Soil frost risk (radiation frost):
 * soil_temperature_0cm ≤ 0.5 °C AND daily mean air temp (temperature_2m_mean) is positive.
 * Returns { frost: boolean, minSoil: number|null }.
 */
const getSoilFrostInfo = (soil0cmValues, tempMean) => {
    if (tempMean == null || Number.isNaN(Number(tempMean)) || Number(tempMean) <= 0) {
        return { frost: false, minSoil: null };
    }
    if (!Array.isArray(soil0cmValues) || soil0cmValues.length === 0) {
        return { frost: false, minSoil: null };
    }
    const nums = soil0cmValues
        .map(v => (v == null ? null : Number(v)))
        .filter(v => v != null && !Number.isNaN(v));
    if (nums.length === 0) return { frost: false, minSoil: null };
    const minSoil = Math.min(...nums);
    return { frost: minSoil <= 0.5, minSoil };
};

const hasSoilFrost = (soil0cmValues, tempMean) => getSoilFrostInfo(soil0cmValues, tempMean).frost;

/**
 * Warning text for frost. minSoil — min soil_temperature_0cm for the day (°C).
 * UK: «⚠️ Планується заморозок по ґрунту -5.0°C»
 * EN: «⚠️ Soil frost expected: -5.0°C»
 */
const frostWarningText = (lang = 'uk', minSoil = null) => {
    const tStr = (minSoil != null && !Number.isNaN(Number(minSoil)))
        ? `${Number(minSoil) > 0 ? '+' : ''}${Number(minSoil).toFixed(1)}°C`
        : null;
    if (lang === 'uk') {
        return tStr
            ? `⚠️ Планується заморозок по ґрунту ${tStr}`
            : '⚠️ Планується заморозок по ґрунту';
    }
    return tStr
        ? `⚠️ Soil frost expected: ${tStr}`
        : '⚠️ Soil frost expected';
};

/**
 * Past-tense frost text when the planned frost hours have already passed.
 * UK: «⚠️ Запланований заморозок по ґрунту -0.3°C відбувся в 07:00»
 * EN: «⚠️ Planned soil frost -0.3°C occurred at 07:00»
 */
const frostOccurredText = (lang = 'uk', minSoil = null, hour = null) => {
    const tStr = (minSoil != null && !Number.isNaN(Number(minSoil)))
        ? `${Number(minSoil) > 0 ? '+' : ''}${Number(minSoil).toFixed(1)}°C`
        : null;
    const hStr = (hour != null && !Number.isNaN(Number(hour)))
        ? `${String(Number(hour)).padStart(2, '0')}:00`
        : null;
    if (lang === 'uk') {
        if (tStr && hStr) return `⚠️ Запланований заморозок по ґрунту ${tStr} відбувся в ${hStr}`;
        if (tStr) return `⚠️ Запланований заморозок по ґрунту ${tStr} уже відбувся`;
        return '⚠️ Запланований заморозок по ґрунту уже відбувся';
    }
    if (tStr && hStr) return `⚠️ Planned soil frost ${tStr} occurred at ${hStr}`;
    if (tStr) return `⚠️ Planned soil frost ${tStr} has already occurred`;
    return '⚠️ Planned soil frost has already occurred';
};

/**
 * Estimate soil surface temperature (0 cm) from air temp, dew point, clouds and wind.
 * Radiation-frost model: T_soil ≈ T_air − k · (T_air − T_dew)
 *
 * k is higher under clear skies and light wind (stronger nocturnal cooling).
 * @param {number} tempAir - air temperature °C (2 m)
 * @param {number} dewPoint - dew point °C
 * @param {number} [clouds=50] - cloud cover 0–100 %
 * @param {number} [windMs=2] - wind speed m/s
 * @returns {{ soilEst: number, k: number } | null}
 */
const estimateSoilTemp0 = (tempAir, dewPoint, clouds = 50, windMs = 2) => {
    const T = Number(tempAir);
    const Td = Number(dewPoint);
    if (Number.isNaN(T) || Number.isNaN(Td)) return null;

    const cloudFrac = Math.min(1, Math.max(0, Number(clouds) / 100));
    // Wind mixing: calm ~0, strong (≥8 m/s) ~1
    const windFrac = Math.min(1, Math.max(0, Number(windMs) / 8));

    // Clear + calm → k ≈ 0.95; overcast or windy → much lower
    const k = 0.95 * (1 - 0.72 * cloudFrac) * (1 - 0.55 * windFrac);
    const soilEst = T - k * (T - Td);
    return { soilEst, k: Math.round(k * 100) / 100 };
};

/** Format soil temp for messages: -0.3°C / +1.2°C */
const formatSoilTemp = (v) => {
    if (v == null || Number.isNaN(Number(v))) return '—';
    const n = Number(v);
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(1)}°C`;
};

/**
 * Radiation-frost alert season (Ukraine agro):
 * March–June and August–November (inclusive).
 * Outside this window evening/frost-cron stay silent to avoid winter spam.
 */
const isFrostSeason = (date = new Date(), timezone = 'Europe/Kyiv') => {
    try {
        const d = date instanceof Date ? date : new Date(date);
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            month: 'numeric'
        }).formatToParts(d);
        const month = parseInt(parts.find(p => p.type === 'month')?.value || '0', 10);
        return (month >= 3 && month <= 6) || (month >= 8 && month <= 11);
    } catch {
        return false;
    }
};

module.exports = {
    WEATHER_CODES,
    WIND_DIRECTIONS,
    getWeatherDesc,
    getWindDir,
    degToCard,
    getIconMapping,
    getSoilFrostInfo,
    hasSoilFrost,
    frostWarningText,
    frostOccurredText,
    estimateSoilTemp0,
    formatSoilTemp,
    isFrostSeason
};
