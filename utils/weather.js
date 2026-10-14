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
            ? `⚠️ Завтра планується заморозок по ґрунту ${tStr}`
            : '⚠️ Завтра планується заморозок по ґрунту';
    }
    return tStr
        ? `⚠️ Tomorrow soil frost expected: ${tStr}`
        : '⚠️ Tomorrow soil frost expected';
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

/**
 * Unified geomagnetic activity level from planetary Kp (0–9) / NOAA G-scale.
 * Same scale everywhere: evening forecast labels + real-time alerts.
 *
 * rank is monotonic so cron-check can detect escalate / de-escalate:
 *   0  quiet      Kp < 4
 *   1  unsettled  Kp 4–4.9
 *   2  G1         Kp 5     Слабка буря
 *   3  G2         Kp 6     Помірна буря
 *   4  G3         Kp 7     Сильна буря
 *   5  G4         Kp 8     Дуже сильна / шторм
 *   6  G5         Kp 9     Екстремальний шторм
 */
const getGeomagLevel = (kp) => {
    if (kp == null || Number.isNaN(Number(kp))) return null;
    const k = Number(kp);
    const kpRounded = Math.min(9, Math.max(0, Math.round(k)));

    // Storm tiers (Kp ≥ 5) — NOAA G1–G5
    if (k >= 5) {
        const g = Math.min(5, Math.max(1, kpRounded - 4)); // Kp5→G1 … Kp9→G5
        const stormMeta = {
            1: {
                rank: 2,
                level: 'g1',
                badge: '🟠',
                labelUk: `Слабка буря G1 (Kp ${kpRounded})`,
                labelEn: `Minor storm G1 (Kp ${kpRounded})`
            },
            2: {
                rank: 3,
                level: 'g2',
                badge: '🔴',
                labelUk: `Помірна буря G2 (Kp ${kpRounded})`,
                labelEn: `Moderate storm G2 (Kp ${kpRounded})`
            },
            3: {
                rank: 4,
                level: 'g3',
                badge: '🔴',
                labelUk: `Сильна буря G3 (Kp ${kpRounded})`,
                labelEn: `Strong storm G3 (Kp ${kpRounded})`
            },
            4: {
                rank: 5,
                level: 'g4',
                badge: '🟣',
                labelUk: `Дуже сильна буря G4 (Kp ${kpRounded})`,
                labelEn: `Severe storm G4 (Kp ${kpRounded})`
            },
            5: {
                rank: 6,
                level: 'g5',
                badge: '⚫',
                labelUk: `Екстремальний шторм G5 (Kp ${kpRounded})`,
                labelEn: `Extreme storm G5 (Kp ${kpRounded})`
            }
        };
        const m = stormMeta[g];
        return {
            level: m.level,
            rank: m.rank,
            badge: m.badge,
            kp: k,
            kpRounded,
            labelUk: m.labelUk,
            labelEn: m.labelEn,
            gScale: g,
            isStorm: true
        };
    }

    if (k >= 4) {
        return {
            level: 'unsettled',
            rank: 1,
            badge: '🟡',
            kp: k,
            kpRounded,
            labelUk: `Збурення (Kp ${kpRounded})`,
            labelEn: `Unsettled (Kp ${kpRounded})`,
            gScale: null,
            isStorm: false
        };
    }

    return {
        level: 'quiet',
        rank: 0,
        badge: '🟢',
        kp: k,
        kpRounded,
        labelUk: `Спокійно (Kp ${kpRounded})`,
        labelEn: `Calm (Kp ${kpRounded})`,
        gScale: null,
        isStorm: false
    };
};

/**
 * Ray-casting point-in-polygon.
 * polygonStr: "lat,lon lat,lon ..." (MeteoAlarm CAP style)
 */
const pointInPolygon = (lat, lon, polygonStr) => {
    if (!polygonStr || typeof polygonStr !== 'string') return false;
    const pts = [];
    for (const pair of polygonStr.trim().split(/\s+/)) {
        const [la, lo] = pair.split(',').map(Number);
        if (!Number.isNaN(la) && !Number.isNaN(lo)) pts.push([la, lo]);
    }
    if (pts.length < 3) return false;

    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [yi, xi] = pts[i]; // lat, lon
        const [yj, xj] = pts[j];
        const intersect =
            (yi > lat) !== (yj > lat) &&
            lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
};

/**
 * Fetch active weather alerts for a point from MeteoAlarm (UA Hydrometcenter via CAP).
 * Returns short human-readable lines for the "Парасоль підказує" block.
 * Source: https://feeds.meteoalarm.org/api/v1/warnings/feeds-ukraine
 */
const fetchMeteoAlarmAlerts = async (lat, lon, lang = 'uk') => {
    const preferUk = lang === 'uk';
    const out = [];
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        const res = await fetch(
            'https://feeds.meteoalarm.org/api/v1/warnings/feeds-ukraine',
            { signal: controller.signal }
        );
        clearTimeout(timer);
        if (!res.ok) throw new Error(`MeteoAlarm HTTP ${res.status}`);
        const data = await res.json();
        const warnings = data?.warnings || [];
        const now = Date.now();

        for (const w of warnings) {
            const alert = w.alert || w;
            const infos = alert.info || [];
            if (!infos.length) continue;

            // Prefer Ukrainian info block, else first
            let info = infos.find((i) => {
                const l = String(i.language || '').toLowerCase();
                return preferUk
                    ? l.startsWith('uk') || l.startsWith('ua')
                    : l.startsWith('en');
            });
            if (!info) info = infos[0];

            // Skip expired
            if (info.expires) {
                const exp = Date.parse(info.expires);
                if (!Number.isNaN(exp) && exp < now) continue;
            }

            // Match location: any area polygon contains the point
            const areas = info.area || [];
            let matches = false;
            let areaDesc = '';
            for (const a of areas) {
                areaDesc = a.areaDesc || areaDesc;
                const polys = a.polygon || [];
                for (const p of polys) {
                    if (pointInPolygon(lat, lon, p)) {
                        matches = true;
                        break;
                    }
                }
                if (matches) break;
            }
            // If no polygon matched but area is very broad / national — still skip
            // (only show alerts whose geometry covers the user)
            if (!matches) continue;

            const severity = String(info.severity || '').toLowerCase();
            let badge = '🟡';
            if (severity === 'extreme') badge = '🔴';
            else if (severity === 'severe') badge = '🟠';
            else if (severity === 'moderate') badge = '🟡';
            else if (severity === 'minor') badge = '🟢';

            // awareness_level from parameters if present
            const params = info.parameter || [];
            for (const p of params) {
                if (String(p.valueName || '').toLowerCase() === 'awareness_level') {
                    const v = String(p.value || '').toLowerCase();
                    if (v.includes('red') || v.includes('3;')) badge = '🔴';
                    else if (v.includes('orange') || v.includes('2;')) badge = '🟠';
                    else if (v.includes('yellow') || v.includes('1;')) badge = '🟡';
                }
            }

            const event = (info.event || '').trim();
            const desc = (info.description || '').trim().replace(/\s+/g, ' ');
            // Short line
            let line = `${badge} ${event}`;
            if (desc && desc.length < 120) line += ` — ${desc}`;
            else if (desc) line += ` — ${desc.slice(0, 100)}…`;

            // Дати дії попередження (onset / expires) — безпечне форматування
            const fmtAlertDate = (iso) => {
                if (!iso) return null;
                try {
                    const d = new Date(iso);
                    if (Number.isNaN(d.getTime())) return null;
                    // Europe/Kyiv offset: manual pad to avoid locale issues on serverless
                    const parts = new Intl.DateTimeFormat('en-GB', {
                        timeZone: 'Europe/Kyiv',
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false
                    }).formatToParts(d);
                    const get = (t) => parts.find((p) => p.type === t)?.value || '';
                    return `${get('day')}.${get('month')} ${get('hour')}:${get('minute')}`;
                } catch {
                    return null;
                }
            };
            try {
                const from = fmtAlertDate(info.onset);
                const to = fmtAlertDate(info.expires);
                if (from && to) {
                    line += preferUk ? ` (діє ${from} – ${to})` : ` (valid ${from} – ${to})`;
                } else if (to) {
                    line += preferUk ? ` (до ${to})` : ` (until ${to})`;
                } else if (from) {
                    line += preferUk ? ` (з ${from})` : ` (from ${from})`;
                }
            } catch (_) {
                // дати не критичні — не ламаємо весь алерт
            }

            out.push({
                event,
                severity,
                badge,
                description: desc,
                areaDesc,
                onset: info.onset || null,
                expires: info.expires || null,
                line
            });
        }
    } catch (e) {
        console.error('MeteoAlarm fetch error:', e.message);
    }
    // Deduplicate by event+onset
    const seen = new Set();
    return out.filter((a) => {
        const key = `${a.event}|${a.onset}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
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
    isFrostSeason,
    getGeomagLevel,
    pointInPolygon,
    fetchMeteoAlarmAlerts
};

