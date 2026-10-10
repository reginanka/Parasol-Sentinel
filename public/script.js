const API_URL = '/api/weather-data';
const DEFAULT_LAT = 50.4501;
const DEFAULT_LON = 30.5234;
const DEFAULT_CITY = 'Kyiv';

let weatherChart = null;
let currentMode = 'temp';
let weatherData = null; // Store fetched data globally for switching
let currentStatusKey = 'freeAccess';
let currentUnits = { wind: 'ms', pressure: 'mmhg', temp: 'c' }; // single source of truth (synced with bot)
let currentUserId = null;  // Telegram user ID (from URL param or WebApp)
let currentSig = null;     // HMAC signature (only present with personal link)

const i18n = {
    uk: {
        actual: "Актуально",
        sunrise: "Схід",
        sunset: "Захід",
        tabTemp: "Темп",
        tabProb: "Шанс (%)",
        tabVol: "Об'єм (мм)",
        tabWind: "Вітер",
        tabGusts: "Пориви",
        tabPress: "Тиск",
        tabGeomag: "Магнітка",
        uvIndex: "UV-індекс",
        windGusts: "Вітер",
        humidity: "Вологість",
        dewPoint: "Точка роси",
        precipChance: "Шанс опадів",
        visibility: "Видимість",
        pressure: "Тиск",
        gustsTo: "пориви до",
        airQuality: "Повітря",
        geomag: "Магнітка",
        geomagCalm: "Спокійно",
        geomagUnsettled: "Збурення",
        geomagStorm: "Буря",
        uvLevels: {
            low: "Низький",
            moderate: "Помірний",
            high: "Високий",
            veryHigh: "Дуже високий",
            extreme: "Екстремальний"
        },
        units: {
            ms: "м/с",
            kmh: "км/год",
            mmhg: "мм рт.ст.",
            hpa: "гПа",
            km: "км",
            c: "°C",
            f: "°F"
        },
        openBot: "Відкрити Parasol Bot",
        searchCity: "Пошук міста...",
        feelsLike: "Відчувається як",
        analyzing: "Аналізуємо...",
        cityNotFound: "Місто не знайдено",
        defaultCity: "Ваша Локація",
        chartNoData: "Погодинний прогноз недоступний",
        chartTemp: "Темп (°C)",
        chartWind: "Вітер (км/год)",
        chartGusts: "Пориви вітру",
        chartPrecip: "Опади (мм)",
        chartProb: "Шанс опадів (%)",
        chartPress: "Тиск (мм рт.ст.)",
        chartGeomag: "Kp-індекс",
        chartGeomagNoData: "Дані магнітного поля недоступні",
        intelMonitoring: "Інтелектуальний моніторинг",
        dataSources: "Weather data: Weatherbit, Open-Meteo · Air quality: WAQI (aqicn.org) · Geomagnetic: NOAA SWPC",
        sentinel: "Вартовий",
        dashboard: "Панель керування",
        freeAccess: "Безкоштовний доступ",
        premiumStatus: "Преміум статус",
        sentinelDashboard: "Преміум статус",
        settingsTitle: "⚙️ Налаштування",
        settingsWind: "🌬 Вітер",
        settingsPress: "🌡 Тиск",
        settingsTemp: "🌡 Температура",
        settingsNote: "Налаштування синхронізуються з ботом",
        transl: { // weather translation
            200: 'Гроза', 201: 'Гроза з дощем', 202: 'Сильна гроза', 233: 'Гроза',
            300: 'Мряка', 301: 'Мряка', 302: 'Сильна мряка',
            500: 'Невеликий дощ', 501: 'Помірний дощ', 502: 'Сильний дощ', 
            520: 'Слабкий дощ', 521: 'Злива', 522: 'Сильна злива',
            600: 'Невеликий сніг', 601: 'Сніг', 602: 'Сильний снігопад', 610: 'Сніг з дощем',
            700: 'Димка', 741: 'Туман', 751: 'Мла',
            800: 'Ясно', 801: 'Легка хмарність', 802: 'Мінлива хмарність', 803: 'Хмарно', 804: 'Похмуро'
        },
        windDirs: {
            'N': 'Північний', 'S': 'Південний', 'E': 'Східний', 'W': 'Західний',
            'NE': 'Північно-східний', 'NW': 'Північно-західний', 'SE': 'Південно-східний', 'SW': 'Південно-західний',
            'NNE': 'Пн-Пн-Сх', 'ENE': 'Сх-Пн-Сх', 'ESE': 'Сх-Пд-Сх', 'SSE': 'Пд-Пд-Сх',
            'SSW': 'Пд-Пд-Зх', 'WSW': 'Зх-Пд-Зх', 'WNW': 'Зх-Пн-Зх', 'NNW': 'Пн-Пн-Зх'
        }
    },
    en: {
        actual: "Live",
        sunrise: "Sunrise",
        sunset: "Sunset",
        tabTemp: "Temp",
        tabProb: "Prob (%)",
        tabVol: "Vol (mm)",
        tabWind: "Wind",
        tabGusts: "Gusts",
        tabPress: "Pres",
        tabGeomag: "Geomag",
        uvIndex: "UV Index",
        windGusts: "Wind",
        humidity: "Humidity",
        dewPoint: "Dew Point",
        precipChance: "Precip chance",
        visibility: "Visibility",
        pressure: "Pressure",
        gustsTo: "gusts up to",
        airQuality: "Air",
        geomag: "Geomag",
        geomagCalm: "Calm",
        geomagUnsettled: "Unsettled",
        geomagStorm: "Storm",
        uvLevels: {
            low: "Low",
            moderate: "Moderate",
            high: "High",
            veryHigh: "Very High",
            extreme: "Extreme"
        },
        units: {
            ms: "m/s",
            kmh: "km/h",
            mmhg: "mmHg",
            hpa: "hPa",
            km: "km",
            c: "°C",
            f: "°F"
        },
        openBot: "Open Parasol Bot",
        searchCity: "Search city...",
        feelsLike: "Feels like",
        analyzing: "Analyzing...",
        cityNotFound: "City not found",
        defaultCity: "Your Location",
        chartNoData: "Hourly forecast unavailable",
        chartTemp: "Temp (°C)",
        chartWind: "Wind (km/h)",
        chartGusts: "Wind Gusts",
        chartPrecip: "Precip (mm)",
        chartProb: "Precip Chance (%)",
        chartPress: "Pressure (mb)",
        chartGeomag: "Kp Index",
        chartGeomagNoData: "Geomagnetic data unavailable",
        intelMonitoring: "Intelligence Monitoring",
        dataSources: "Weather data: Weatherbit, Open-Meteo · Air quality: WAQI (aqicn.org) · Geomagnetic: NOAA SWPC",
        sentinel: "Sentinel",
        dashboard: "Dashboard",
        freeAccess: "Free Access",
        premiumStatus: "Premium Status",
        sentinelDashboard: "Sentinel Dashboard",
        settingsTitle: "⚙️ Settings",
        settingsWind: "🌬 Wind",
        settingsPress: "🌡 Pressure",
        settingsTemp: "🌡 Temperature",
        settingsNote: "Settings sync with the bot",
        transl: {
            200: 'Thunderstorm', 201: 'Thunderstorm with rain', 202: 'Heavy thunderstorm', 233: 'Thunderstorm',
            300: 'Drizzle', 301: 'Drizzle', 302: 'Heavy drizzle',
            500: 'Light rain', 501: 'Moderate rain', 502: 'Heavy rain', 
            520: 'Light shower', 521: 'Shower', 522: 'Heavy shower',
            600: 'Light snow', 601: 'Snow', 602: 'Heavy snow', 610: 'Sleet',
            700: 'Mist', 741: 'Fog', 751: 'Haze',
            800: 'Clear', 801: 'Few clouds', 802: 'Partly cloudy', 803: 'Cloudy', 804: 'Overcast'
        },
        windDirs: {
            'N': 'North', 'S': 'South', 'E': 'East', 'W': 'West',
            'NE': 'Northeast', 'NW': 'Northwest', 'SE': 'Southeast', 'SW': 'Southwest',
            'NNE': 'NNE', 'ENE': 'ENE', 'ESE': 'ESE', 'SSE': 'SSE',
            'SSW': 'SSW', 'WSW': 'WSW', 'WNW': 'WNW', 'NNW': 'NNW'
        }
    }
};

let currentLang = localStorage.getItem('lang');
if (!currentLang) {
    const isUkOrRu = (navigator.language && (navigator.language.startsWith('uk') || navigator.language.startsWith('ru')));
    currentLang = isUkOrRu ? 'uk' : 'en';
    // If we want to default to UK for Ukrainian users even if browser is EN
    if (window.location.hostname.includes('.ua')) currentLang = 'uk';
}
let currentDailyIndex = 0;

// Returns the index of today's date in weatherData.daily,
// falling back to 0 if not found (e.g. data is fresh and starts today).
function findTodayIndex() {
    if (!weatherData || !weatherData.daily) return 0;
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const idx = weatherData.daily.findIndex(d => (d.valid_date || '').substring(0, 10) === todayStr);
    return idx !== -1 ? idx : 0;
}

// Removes past days from weatherData.daily so stale cache never shows old cards.
function prunePastDays() {
    if (!weatherData || !weatherData.daily) return;
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    weatherData.daily = weatherData.daily.filter(d => (d.valid_date || '').substring(0, 10) >= todayStr);
}

function updateTexts() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (key.startsWith('placeholder:')) {
            el.placeholder = i18n[currentLang][key.split(':')[1]];
        } else {
            el.textContent = i18n[currentLang][key];
        }
    });
    
    document.querySelectorAll('.lang-toggle-btn').forEach(btn => {
        btn.textContent = currentLang === 'uk' ? 'EN' : 'UK';
    });

    if (accessType) accessType.textContent = i18n[currentLang][currentStatusKey];
}

// DOM Elements
const currentTemp = document.getElementById('current-temp');
const weatherCondition = document.getElementById('weather-condition');
const weatherFeels = document.getElementById('weather-feels');
const currentCity = document.getElementById('current-city');
const currentDate = document.getElementById('current-date');
const updateTime = document.getElementById('update-time');
const weatherIcon = document.getElementById('weather-icon');
const dailyForecastContainer = document.getElementById('daily-forecast');
const accessType = document.getElementById('access-type');

async function init() {
    const urlParams = new URLSearchParams(window.location.search);

    // Detect how the page was opened:
    // 1. Via Telegram WebApp button → TG passes user data automatically
    // 2. Via personal link → ?user=ID&sig=SIG in URL
    const tgWebApp = window.Telegram?.WebApp;
    const tgUser = tgWebApp?.initDataUnsafe?.user;

    if (tgWebApp?.initData) {
        tgWebApp.ready();  // Signal to Telegram that the app is loaded
        tgWebApp.expand(); // Expand to full height
    }

    currentUserId = tgUser?.id?.toString() || urlParams.get('user');
    currentSig    = urlParams.get('sig'); // null when opened from WebApp button without params

    // Load units from localStorage as fallback (until API responds)
    try {
        const saved = localStorage.getItem('units');
        if (saved) currentUnits = JSON.parse(saved);
    } catch(e) {}

    updateCurrentDate();
    updateCopyrightYear();
    await loadWeatherData(currentUserId, currentSig);

    // Search Binding
    document.getElementById('search-btn').addEventListener('click', () => searchCity());
    document.getElementById('city-search').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') searchCity();
    });

    // Chart Tabs Binding
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentMode = btn.dataset.mode;
            renderChart(currentDailyIndex);
        });
    });

    document.querySelectorAll('.lang-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            currentLang = currentLang === 'uk' ? 'en' : 'uk';
            localStorage.setItem('lang', currentLang);
            updateTexts();
            updateCurrentDate();
            updateUpdateTime();
            if (weatherData) updateUI(currentDailyIndex);
        });
    });

    // Settings panel bindings
    const settingsBtn   = document.getElementById('settings-btn');
    const settingsPanel = document.getElementById('settings-panel');
    const settingsClose = document.getElementById('settings-close');
    if (settingsBtn)  settingsBtn.addEventListener('click', openSettingsPanel);
    if (settingsClose) settingsClose.addEventListener('click', () => { settingsPanel.style.display = 'none'; });
    settingsPanel?.addEventListener('click', (e) => { if (e.target === settingsPanel) settingsPanel.style.display = 'none'; });
    document.querySelectorAll('.unit-btn').forEach(btn => {
        btn.addEventListener('click', () => saveUnitSetting(btn.dataset.type, btn.dataset.val));
    });

    updateTexts();
}

async function searchCity() {
    const query = document.getElementById('city-search').value;
    if (!query) return;

    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`);
        const data = await response.json();
        if (data.length > 0) {
            const { lat, lon, display_name } = data[0];
            const name = display_name.split(',')[0];
            await fetchOpenMeteo(lat, lon, name);
        } else {
            showToast(i18n[currentLang].cityNotFound);
        }
    } catch (e) {
        console.error('Search error:', e);
    }
}

async function loadWeatherData(userId, sig = '', forceRefresh = false) {
    try {
        if (!userId) {
            await fetchOpenMeteo(DEFAULT_LAT, DEFAULT_LON, DEFAULT_CITY);
        } else {
            const refreshPart = forceRefresh ? '&refresh=true' : '';
            const sigPart = sig ? `&sig=${sig}` : '';
            const tgWebApp = window.Telegram?.WebApp;
            
            let url = `${API_URL}?user=${userId}${sigPart}${refreshPart}`;
            if (tgWebApp?.initData) {
                url += `&initData=${encodeURIComponent(tgWebApp.initData)}`;
            }
            const response = await fetch(url);
            
            if (!response.ok) {
                // FALLBACK: if not authorized (missing/invalid sig), show free version instead of error
                if (response.status === 401) {
                    console.info('Unauthorized or missing signature: Falling back to Open-Meteo free engine.');
                    return await fetchOpenMeteo(DEFAULT_LAT, DEFAULT_LON, DEFAULT_CITY);
                }
                throw new Error('Internal API failed');
            }
            const data = await response.json();

            if (data.cached && data.lastState && data.lastState.fullData) {
                // Legacy user-cache shape
                weatherData = data.lastState.fullData;
                currentCity.textContent = data.user?.city || data.current?.city_name || i18n[currentLang].defaultCity;
                currentStatusKey = 'sentinelDashboard';
            } else {
                // Snapshot or live response (same shape: current/hourly/daily)
                weatherData = data;
                currentCity.textContent = data.user?.city || data.current?.city_name || i18n[currentLang].defaultCity;
                currentStatusKey = data.fromSnapshot ? 'sentinelDashboard' : 'premiumStatus';
            }
            // Apply unit preferences from the API (single source of truth)
            if (data.units) {
                currentUnits = data.units;
                localStorage.setItem('units', JSON.stringify(currentUnits));
            }
            accessType.textContent = i18n[currentLang][currentStatusKey];
            // Ensure full Kp time series for the Mag tab (API may only send maxKp)
            await ensureGeomagSeries();
            // Always recompute pill from current 3h slot (snapshot may still hold old max-window Kp)
            syncGeomagBadgeFromSeries();
            prunePastDays();
            updateUI(findTodayIndex());
            const lat = data.user?.lat || data.lat || DEFAULT_LAT;
            const lon = data.user?.lon || data.lon || DEFAULT_LON;
            updateWindyWidget(lat, lon);

            // Honest update time from DB/API — never invent "now" if we have a server timestamp
            const rawTs =
                data.meta?.updatedAt ||
                data.meta?.updatedAtWb ||
                data.meta?.updatedAtOm ||
                data.lastState?.updatedAt ||
                data.dashboardSnapshot?.updatedAtWb ||
                data.dashboardSnapshot?.updatedAtOm ||
                null;
            const dbUpdateTime = rawTs ? new Date(rawTs) : null;
            updateUpdateTime(dbUpdateTime);
        }
    } catch (error) {
        console.warn('Load error:', error);
        const errMsg = error.message.includes('Unauthorized') ? 'Sign Error' : 'API Error';
        updateTime.textContent = errMsg;
        showToast(error.message || 'Failed to connect to server');
    } finally {
        setTimeout(() => document.body.classList.remove('loading'), 500);
    }
}

/** Load full NOAA Kp series (observed + forecast) for the Mag chart if missing. */
/** NOAA time_tag is UTC but often lacks "Z" — force UTC parse. */
function parseNoaaTime(timeTag) {
    if (!timeTag) return NaN;
    const s = String(timeTag).trim();
    if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s).getTime();
    const normalized = s.includes('T') ? s : s.replace(' ', 'T');
    return new Date(normalized.endsWith('Z') ? normalized : normalized + 'Z').getTime();
}

function geomagBadgeFromKp(kp) {
    if (kp == null || isNaN(kp)) return null;
    let badge = '🟢';
    if (kp >= 5) badge = '🔴';
    else if (kp >= 4) badge = '🟡';
    return badge;
}

/**
 * Expand official 3h Kp slots into hourly points via linear interpolation.
 * NOAA value is placed at the START of each 3h bin; between starts we lerp.
 * This is an estimate for UX only — not an official sub-hourly Kp product.
 */
function buildHourlyGeomagSeries(series3h) {
    if (!Array.isArray(series3h) || series3h.length < 1) return [];
    const sorted = series3h
        .map(r => ({
            t: parseNoaaTime(r.time),
            kp: Number(r.kp),
            observed: r.observed || null,
            scale: r.scale || null
        }))
        .filter(r => !isNaN(r.t) && !isNaN(r.kp))
        .sort((a, b) => a.t - b.t);
    if (!sorted.length) return [];

    const hourly = [];
    const hourMs = 3600 * 1000;

    for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i];
        const b = sorted[i + 1] || null;
        // Hours covered: from a.t inclusive up to (b ? b.t : a.t + 3h) exclusive
        const end = b ? b.t : a.t + 3 * hourMs;
        for (let t = a.t; t < end; t += hourMs) {
            let kp;
            let observed;
            if (!b || t === a.t) {
                kp = a.kp;
                observed = a.observed;
            } else {
                const frac = (t - a.t) / (b.t - a.t);
                kp = a.kp + (b.kp - a.kp) * frac;
                // Status: inherit from the bin we're in; future bins stay forecast
                if (a.observed === 'predicted' || (b && b.observed === 'predicted' && t >= b.t)) {
                    observed = 'predicted';
                } else if (a.observed === 'observed' && (!b || b.observed === 'observed')) {
                    observed = 'observed';
                } else {
                    observed = a.observed === 'estimated' || (b && b.observed === 'estimated')
                        ? 'estimated'
                        : (a.observed || 'estimated');
                }
            }
            hourly.push({
                time: new Date(t).toISOString(),
                t,
                kp: Math.round(kp * 100) / 100,
                observed,
                interpolated: t !== a.t,
                scale: a.scale
            });
        }
    }
    // Include the final official slot start if loop didn't (when no next bin)
    const last = sorted[sorted.length - 1];
    if (!hourly.length || hourly[hourly.length - 1].t < last.t) {
        hourly.push({
            time: new Date(last.t).toISOString(),
            t: last.t,
            kp: last.kp,
            observed: last.observed,
            interpolated: false,
            scale: last.scale
        });
    }
    return hourly;
}

/** Interpolated Kp at an arbitrary moment (default: now). */
function interpolateKpAt(series3h, atMs = Date.now()) {
    if (!Array.isArray(series3h) || !series3h.length) return null;
    const sorted = series3h
        .map(r => ({
            t: parseNoaaTime(r.time),
            kp: Number(r.kp),
            observed: r.observed || null
        }))
        .filter(r => !isNaN(r.t) && !isNaN(r.kp))
        .sort((a, b) => a.t - b.t);
    if (!sorted.length) return null;

    // Before first / after last
    if (atMs <= sorted[0].t) {
        return { kp: sorted[0].kp, observed: sorted[0].observed, t: atMs, interpolated: false };
    }
    const last = sorted[sorted.length - 1];
    if (atMs >= last.t + 3 * 3600 * 1000) {
        return { kp: last.kp, observed: last.observed, t: atMs, interpolated: false };
    }

    for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i];
        const b = sorted[i + 1];
        const binEnd = b ? b.t : a.t + 3 * 3600 * 1000;
        if (atMs >= a.t && atMs < binEnd) {
            if (!b) {
                return { kp: a.kp, observed: a.observed, t: atMs, interpolated: false };
            }
            const frac = (atMs - a.t) / (b.t - a.t);
            const kp = a.kp + (b.kp - a.kp) * frac;
            let observed = a.observed;
            if (a.observed === 'predicted' || b.observed === 'predicted') observed = 'predicted';
            else if (a.observed === 'estimated' || b.observed === 'estimated') observed = 'estimated';
            return {
                kp: Math.round(kp * 100) / 100,
                observed,
                t: atMs,
                interpolated: frac > 0.01 && frac < 0.99
            };
        }
    }
    return { kp: last.kp, observed: last.observed, t: atMs, interpolated: false };
}

/** Current official 3h Kp point (for reference; alerts stay on this). */
function pickCurrentGeomagPoint(series) {
    if (!Array.isArray(series) || !series.length) return null;
    const nowMs = Date.now();
    const isForecastOnly = (o) => o === 'predicted' || o === 'outlook';
    let currentPt = series.find(r => {
        const t = parseNoaaTime(r.time);
        return t <= nowMs && nowMs < t + 3 * 3600 * 1000 && !isForecastOnly(r.observed);
    });
    if (!currentPt || isForecastOnly(currentPt.observed)) {
        const past = series
            .filter(r => {
                const t = parseNoaaTime(r.time);
                return t <= nowMs && !isForecastOnly(r.observed);
            })
            .sort((a, b) => parseNoaaTime(b.time) - parseNoaaTime(a.time));
        currentPt = past[0] || null;
    }
    if (currentPt && isForecastOnly(currentPt.observed)) return null;
    return currentPt || null;
}

/** Status for hourly/interpolated chart points. */
function geomagPointStatus(pt) {
    if (!pt) return 'forecast';
    const t = pt.t != null ? pt.t : parseNoaaTime(pt.time);
    const nowMs = Date.now();
    // "now" = closest hour mark within ±45 min, or exact current interpolate marker
    if (pt.isNow) return 'now';
    const isNearNow = Math.abs(t - nowMs) < 45 * 60 * 1000;
    // 27-day outlook & predicted 3h slots are always "forecast"
    if (pt.observed === 'predicted' || pt.observed === 'outlook') return 'forecast';
    if (isNearNow) return 'now';
    if (pt.observed === 'observed' && t < nowMs) return 'observed';
    if (t < nowMs) return pt.observed === 'estimated' ? 'estimated' : 'observed';
    return 'forecast';
}

/** Pill = interpolated Kp at this moment (more responsive than flat 3h bin). */
function syncGeomagBadgeFromSeries() {
    if (!weatherData?.geomagSeries?.length) return;
    const at = interpolateKpAt(weatherData.geomagSeries, Date.now());
    if (at && at.observed !== 'predicted' && at.observed !== 'outlook') {
        weatherData.geomag = {
            maxKp: at.kp,
            badge: geomagBadgeFromKp(at.kp)
        };
    } else {
        const currentPt = pickCurrentGeomagPoint(weatherData.geomagSeries);
        if (currentPt) {
            weatherData.geomag = {
                maxKp: currentPt.kp,
                badge: geomagBadgeFromKp(currentPt.kp)
            };
        }
    }
}

/**
 * Merge NOAA 27-day outlook (daily max Kp) into geomagSeries for dates
 * not already covered by the 3-hourly product. Same logic as cron-forecast.js.
 */
async function extendGeomagWith27DayOutlook(series) {
    const out = Array.isArray(series) ? [...series] : [];
    const datesCovered = new Set();
    for (const r of out) {
        const ds = String(r.time || '').slice(0, 10);
        if (ds.length >= 10) datesCovered.add(ds);
    }
    try {
        const outlookRes = await fetch('https://services.swpc.noaa.gov/text/27-day-outlook.txt');
        if (!outlookRes.ok) return out;
        const text = await outlookRes.text();
        const months = {
            Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
            Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12
        };
        for (const line of text.split('\n')) {
            // e.g. "2026 Oct 11      90          10          3"
            const m = line.match(/^(\d{4})\s+(\w{3})\s+(\d{1,2})\s+\d+\s+\d+\s+(\d+)/);
            if (!m) continue;
            const [, year, mon, day, kpStr] = m;
            const month = months[mon];
            if (!month) continue;
            const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const kp = parseFloat(kpStr);
            if (isNaN(kp)) continue;
            if (datesCovered.has(dateStr)) continue;
            for (let h = 0; h < 24; h += 3) {
                out.push({
                    time: `${dateStr}T${String(h).padStart(2, '0')}:00:00Z`,
                    kp,
                    observed: 'outlook',
                    scale: null
                });
            }
            datesCovered.add(dateStr);
        }
    } catch (e) {
        console.warn('27-day outlook extend failed:', e.message);
    }
    out.sort((a, b) => parseNoaaTime(a.time) - parseNoaaTime(b.time));
    return out;
}

async function ensureGeomagSeries() {
    if (!weatherData) return;
    try {
        let series = Array.isArray(weatherData.geomagSeries) ? weatherData.geomagSeries : [];
        if (!series.length) {
            const noaaRes = await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json');
            if (noaaRes.ok) {
                const noaaData = await noaaRes.json();
                if (Array.isArray(noaaData) && noaaData.length > 0) {
                    series = noaaData
                        .map(r => ({
                            time: r.time_tag,
                            kp: parseFloat(r.kp != null ? r.kp : r.Kp),
                            observed: r.observed || null,
                            scale: r.noaa_scale || null
                        }))
                        .filter(r => !isNaN(r.kp));
                }
            }
        }
        // Always try to extend with 27-day outlook (skip if already merged)
        const hasOutlook = series.some(r => r.observed === 'outlook');
        if (!hasOutlook) {
            series = await extendGeomagWith27DayOutlook(series);
        }
        if (series.length) {
            weatherData.geomagSeries = series;
            syncGeomagBadgeFromSeries();
        }
    } catch (e) {
        console.warn('ensureGeomagSeries failed:', e.message);
    }
}

async function fetchOpenMeteo(lat, lon, name) {
    try {
        const omResponse = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,precipitation_probability,surface_pressure&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,visibility_max,wind_direction_10m_dominant&timezone=auto`);
        if (!omResponse.ok) return;
        const omData = await omResponse.json();

        weatherData = normalizeOpenMeteo(omData, name);

        // Free path extras: AQI (Open-Meteo) + geomag (NOAA) — both public, no key
        try {
            const [aqiRes, noaaRes] = await Promise.all([
                fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=us_aqi&timezone=auto`),
                fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json')
            ]);
            if (aqiRes.ok) {
                const aqiData = await aqiRes.json();
                weatherData.aqi = aqiData.hourly || null;
            }
            if (noaaRes.ok) {
                const noaaData = await noaaRes.json();
                if (Array.isArray(noaaData) && noaaData.length > 0) {
                    let series = noaaData
                        .map(r => ({
                            time: r.time_tag,
                            kp: parseFloat(r.kp != null ? r.kp : r.Kp),
                            observed: r.observed || null,
                            scale: r.noaa_scale || null
                        }))
                        .filter(r => !isNaN(r.kp));
                    series = await extendGeomagWith27DayOutlook(series);
                    weatherData.geomagSeries = series;
                    syncGeomagBadgeFromSeries();
                }
            }
        } catch (extraErr) {
            console.warn('Free extras (AQI/geomag) failed:', extraErr.message);
        }

        currentCity.textContent = name;
        currentStatusKey = 'freeAccess';
        prunePastDays();
        updateUI(findTodayIndex());
        updateWindyWidget(lat, lon);
        updateUpdateTime();
    } catch (error) {
        console.error('Open-Meteo Error:', error);
        showToast(i18n[currentLang].chartNoData);
    }
}

function updateUpdateTime(date) {
    // Prefer timestamp from DB/API snapshot; only fall back to "now" for free live fetches
    const timeToDisplay = (date instanceof Date && !isNaN(date.getTime())) ? date : new Date();
    const loc = currentLang === 'uk' ? 'uk-UA' : 'en-US';
    const now = new Date();
    const sameDay = timeToDisplay.toDateString() === now.toDateString();
    if (sameDay) {
        updateTime.textContent = timeToDisplay.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
    } else {
        updateTime.textContent = timeToDisplay.toLocaleString(loc, {
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
        });
    }
    // Expose raw ISO on the element for debugging / future use
    if (updateTime) updateTime.dataset.updatedAt = timeToDisplay.toISOString();
}

function normalizeOpenMeteo(om, name) {
    const wmoMap = {
        0: { desc: 'Ясно', icon: 'c01d', code: 800 },
        1: { desc: 'Переважно ясно', icon: 'c02d', code: 801 },
        2: { desc: 'Хмарно', icon: 'c03d', code: 802 },
        3: { desc: 'Похмуро', icon: 'c04d', code: 804 },
        45: { desc: 'Туман', icon: 'a05d', code: 741 },
        51: { desc: 'Мряка', icon: 'd01d', code: 300 },
        61: { desc: 'Дощ', icon: 'r01d', code: 500 },
        63: { desc: 'Дощ', icon: 'r02d', code: 501 },
        71: { desc: 'Сніг', icon: 's01d', code: 600 },
        95: { desc: 'Гроза', icon: 't01d', code: 200 }
    };

    return {
        current: {
            temp: om.current.temperature_2m,
            app_temp: om.current.apparent_temperature,
            rh: om.current.relative_humidity_2m,
            wind_spd: om.current.wind_speed_10m / 3.6,
            wind_cdir: degToCard(om.current.wind_direction_10m || 0),
            uv: om.daily.uv_index_max[0],
            weather: wmoMap[om.current.weather_code] || wmoMap[0]
        },
        hourly: { ...om.hourly, wind_gusts_10m: om.hourly.wind_gusts_10m || [] },
        daily: om.daily.time.map((t, i) => {
            const wmo = wmoMap[om.daily.weather_code[i]] || wmoMap[0];
            return {
                valid_date: t,
                max_temp: om.daily.temperature_2m_max[i],
                min_temp: om.daily.temperature_2m_min[i],
                pop: om.daily.precipitation_probability_max[i],
                precip: om.daily.precipitation_sum ? om.daily.precipitation_sum[i] : 0,
                sunrise: om.daily.sunrise[i],
                sunset: om.daily.sunset[i],
                uv: om.daily.uv_index_max[i],
                gust: om.daily.wind_gusts_10m_max[i] / 3.6,
                vis: om.daily.visibility_max[i] / 1000,
                // These are for the main widget when selected
                temp: om.daily.temperature_2m_max[i],
                app_temp: om.daily.temperature_2m_max[i] - 2,
                rh: 60, // Placeholder
                wind_spd: (om.daily.wind_speed_10m_max[i] || om.daily.wind_gusts_10m_max[i] / 1.5) / 3.6,
                wind_cdir: degToCard(om.daily.wind_direction_10m_dominant?.[i] || 0),
                weather: wmo
            };
        })
    };
}

function degToCard(deg) {
    const cardinal = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    const index = Math.round(deg / 22.5) % 16;
    return cardinal[index];
}

/** AQI + geomagnetic pills — only for the current moment (today). */
function updateNowExtras(isToday) {
    const wrap = document.getElementById('now-extras');
    const aqiPill = document.getElementById('aqi-pill');
    const geoPill = document.getElementById('geomag-pill');
    if (!wrap || !aqiPill || !geoPill) return;

    if (!isToday) {
        wrap.style.display = 'none';
        return;
    }

    let showAny = false;
    const setLvl = (el, lvl) => {
        el.classList.remove('lvl-good', 'lvl-mod', 'lvl-warn', 'lvl-bad');
        if (lvl) el.classList.add(lvl);
    };
    const aqiLevel = (v) => (v > 150 ? 'lvl-bad' : v > 100 ? 'lvl-warn' : v > 50 ? 'lvl-mod' : 'lvl-good');

    // --- Air quality ---
    // Premium: WAQI (ground stations). Free: Open-Meteo US AQI (model).
    const waqi = weatherData.waqi;
    if (waqi && waqi.aqi != null && !isNaN(Number(waqi.aqi))) {
        const aqiVal = Number(waqi.aqi);
        document.getElementById('aqi-val').textContent = `AQI ${aqiVal}`;
        setLvl(aqiPill, aqiLevel(aqiVal));
        aqiPill.style.display = 'inline-flex';
        aqiPill.title = waqi.station
            ? `WAQI · ${waqi.station}`
            : 'Якість повітря (станція WAQI)';
        showAny = true;
    } else if (weatherData.aqi?.us_aqi?.length) {
        const arr = weatherData.aqi.us_aqi;
        const times = weatherData.aqi.time || [];
        let val = null;
        if (times.length === arr.length && times.length > 0) {
            const now = Date.now();
            let bestIdx = -1;
            let bestDiff = Infinity;
            for (let i = 0; i < times.length; i++) {
                if (arr[i] == null) continue;
                const t = new Date(times[i]).getTime();
                const diff = Math.abs(t - now);
                if (diff < bestDiff) {
                    bestDiff = diff;
                    bestIdx = i;
                }
            }
            if (bestIdx >= 0) val = arr[bestIdx];
        }
        if (val == null) val = arr.find(v => v != null);
        if (val != null) {
            const aqiVal = Number(val);
            document.getElementById('aqi-val').textContent = `AQI ${Math.round(aqiVal)}`;
            setLvl(aqiPill, aqiLevel(aqiVal));
            aqiPill.style.display = 'inline-flex';
            aqiPill.title = 'Open-Meteo US AQI (модель)';
            showAny = true;
        } else {
            aqiPill.style.display = 'none';
        }
    } else {
        aqiPill.style.display = 'none';
    }

    // --- Geomagnetic activity (interpolated "now" from 3h slots) ---
    const geo = weatherData.geomag;
    if (geo && geo.maxKp != null) {
        const kp = Number(geo.maxKp);
        const t = i18n[currentLang];
        let label = t.geomagCalm;
        let lvl = 'lvl-good';
        if (kp >= 5) { label = t.geomagStorm; lvl = 'lvl-bad'; }
        else if (kp >= 4) { label = t.geomagUnsettled; lvl = 'lvl-mod'; }
        // One decimal when fractional (hourly interpolate); integer when whole
        const kpStr = Math.abs(kp - Math.round(kp)) < 0.05 ? String(Math.round(kp)) : kp.toFixed(1);
        document.getElementById('geomag-val').textContent = `Kp ${kpStr} · ${label}`;
        setLvl(geoPill, lvl);
        geoPill.style.display = 'inline-flex';
        showAny = true;
    } else {
        geoPill.style.display = 'none';
    }

    wrap.style.display = showAny ? 'flex' : 'none';
}

function updateUI(dayIndex) {
    if (!weatherData) return;
    currentDailyIndex = dayIndex;
    const isToday = dayIndex === 0;
    const day = isToday ? weatherData.current : weatherData.daily[dayIndex];
    const details = weatherData.daily[dayIndex];

    // Main Card
    const mainTemp = day.temp !== undefined ? day.temp : day.max_temp;
    const apparentTemp = day.app_temp !== undefined ? day.app_temp : (day.app_max_temp !== undefined ? day.app_max_temp : mainTemp);

    const translateWeather = (code, defaultText) => {
        return i18n[currentLang].transl[code] || defaultText;
    };

    currentTemp.textContent = formatTemp(mainTemp);
    weatherCondition.textContent = translateWeather(day.weather?.code, day.weather?.description || day.weather?.desc || i18n[currentLang].analyzing);
    weatherFeels.textContent = `${i18n[currentLang].feelsLike} ${formatTemp(apparentTemp)}`;

    // AQI + geomag — only meaningful for "now" (today card)
    updateNowExtras(isToday);

    // Premium Icon Upgrade
    weatherIcon.src = getPremiumIcon(day.weather.icon);

    // Compact Pills Icons (Dynamic)
    const iconBase = 'https://cdn.jsdelivr.net/npm/@meteocons/svg/fill/';
    
    // UV Icon dynamic
    const uvVal = Math.round(details.uv || 0);
    const uvIconName = uvVal > 0 ? `uv-index-${Math.min(uvVal, 11)}` : 'uv-index';
    document.getElementById('uv-icon').src = `${iconBase}${uvIconName}.svg`;

    // Wind Icon dynamic (Beaufort-ish or Alert)
    const windMs = details.gust || day.wind_spd || 0;
    let windIconName = 'wind';
    if (windMs > 15) windIconName = 'wind-alert';
    else if (windMs > 10) windIconName = 'windsock';
    document.getElementById('wind-icon').src = `${iconBase}${windIconName}.svg`;

    // Humidity
    document.getElementById('humidity-icon').src = `${iconBase}humidity.svg`;
    document.getElementById('dew-icon').src = `${iconBase}thermometer-mercury.svg`;

    // Precip Icon dynamic
    const precipProb = details.pop || 0;
    const precipIconName = precipProb > 60 ? 'raindrops' : (precipProb > 20 ? 'raindrop' : 'raindrop');
    document.getElementById('precip-icon').src = `${iconBase}${precipIconName}.svg`;

    // Visibility dynamic
    const visKm = details.vis || 10;
    let visIconName = 'mist'; // Base icon (neutral lines)
    if (visKm < 1) visIconName = 'fog';
    else if (visKm < 4) visIconName = 'haze';
    document.getElementById('vis-icon').src = `${iconBase}${visIconName}.svg`;

    // Pressure dynamic
    const hPress = weatherData.hourly?.surface_pressure?.[isToday ? 0 : dayIndex * 24] || 1013;
    let pressIconName = 'barometer'; // Base instrument icon
    if (hPress > 1022) pressIconName = 'barometer-high';
    else if (hPress < 1005) pressIconName = 'barometer-low';
    document.getElementById('press-icon').src = `${iconBase}${pressIconName}.svg`;

    // Compact Pills Values
    document.getElementById('sunrise-val').textContent = formatFullTime(details.sunrise);
    document.getElementById('sunset-val').textContent = formatFullTime(details.sunset);
    document.getElementById('uv-val').innerHTML = formatUV(details.uv);
    
    const spdStr = formatWind(day.wind_spd || 0);
    const gustVal = Math.round((details.gust || 0) * (currentUnits.wind === 'kmh' ? 3.6 : 1));
    const windDirKey = day.wind_cdir || 'N';
    const windDirStr = (i18n[currentLang].windDirs && i18n[currentLang].windDirs[windDirKey]) ? i18n[currentLang].windDirs[windDirKey] : windDirKey;
    const fullWindStr = `${windDirStr}, ${spdStr} (${i18n[currentLang].gustsTo} ${gustVal})`;
    document.getElementById('wind-gust').textContent = fullWindStr;

    document.getElementById('humidity-val').textContent = `${day.rh}%`;
    document.getElementById('dew-val').textContent = formatTemp(day.dewpt || (day.temp - ((100 - day.rh) / 5))); // Simple fallback if dewpt is missing
    const precipVal = details.precip !== undefined ? details.precip.toFixed(1) : 0;
    document.getElementById('precip-prob').textContent = `${details.pop}% (${precipVal} мм)`;
    document.getElementById('vis-val').textContent = `${Math.round(details.vis)} ${i18n[currentLang].units.km}`;
    document.getElementById('press-val').textContent = formatPressure(hPress);

    // Theme
    const code = day.weather.code;
    document.body.classList.remove('clear', 'rainy', 'cloudy', 'stormy', 'snowy');
    if (code >= 200 && code < 300) document.body.classList.add('stormy');
    else if (code >= 300 && code < 700) document.body.classList.add('rainy');
    else if (code >= 800 && code < 803) document.body.classList.add('clear');
    else if (code >= 803) document.body.classList.add('cloudy');

    renderChart(dayIndex);
    renderDaily(dayIndex);
}

function getPremiumIcon(code) {
    // Map Weatherbit icons [c01d, etc] to high-quality Meteocons
    const base = 'https://cdn.jsdelivr.net/npm/@meteocons/svg/fill/';

    const mapping = {
        'c01d': 'clear-day', 'c01n': 'clear-night',
        'c02d': 'partly-cloudy-day', 'c02n': 'partly-cloudy-night',
        'c03d': 'cloudy', 'c03n': 'cloudy',
        'c04d': 'overcast-day', 'c04n': 'overcast-night',
        'a01d': 'mist', 'a05d': 'fog',
        'r01d': 'rain', 'r02d': 'rain', 'r03d': 'rain',
        'd01d': 'drizzle', 'd02d': 'drizzle', 'd03d': 'drizzle',
        's01d': 'snow', 's02d': 'snow', 's04d': 'sleet',
        't01d': 'thunderstorms-day', 't02d': 'thunderstorms-day', 't04d': 'thunderstorms-rain'
    };

    // Extract base code (without 'd' or 'n' sometimes if generic)
    const iconName = mapping[code] || 
        (code.startsWith('r') ? 'rain' : 
         code.startsWith('s') ? 'snow' : 
         code.startsWith('t') ? 'thunderstorms' : 
         code.startsWith('c') ? 'cloudy' : 
         code.startsWith('a') ? 'fog' : 'cloudy');
    return `${base}${iconName}.svg`;
}

function renderChart(dayOffset = 0) {
    const ctx = document.getElementById('weatherChart').getContext('2d');
    if (weatherChart) weatherChart.destroy();

    // ── Geomagnetic Kp chart — hourly interpolation from official 3h slots ──
    if (currentMode === 'geomag') {
        const series = weatherData?.geomagSeries;
        if (!series || !series.length) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
            ctx.textAlign = 'center';
            ctx.font = "14px 'Oswald', system-ui, sans-serif";
            ctx.fillText(
                i18n[currentLang].chartGeomagNoData || 'Geomagnetic data unavailable',
                ctx.canvas.width / 2, ctx.canvas.height / 2
            );
            return;
        }

        // Resolve the selected day's calendar date (same approach as hourly charts)
        const targetDay = weatherData.daily?.[dayOffset];
        let targetDateStr = '';
        if (dayOffset === 0) {
            const now = new Date();
            targetDateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        } else if (targetDay) {
            targetDateStr = (targetDay.valid_date || '').substring(0, 10);
        }

        // Expand 3h → hourly, then filter by local calendar day
        const hourlyAll = buildHourlyGeomagSeries(series);
        let points = hourlyAll.filter(r => {
            const d = new Date(r.t);
            const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            return localDate === targetDateStr;
        });

        if (!points.length && targetDateStr) {
            points = hourlyAll.filter(r => {
                const d = new Date(r.t);
                const utcDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
                return utcDate === targetDateStr;
            });
        }

        // Mark the hour closest to "now" on today's chart
        if (dayOffset === 0 && points.length) {
            const nowMs = Date.now();
            let bestIdx = -1;
            let bestDiff = Infinity;
            points.forEach((p, i) => {
                const diff = Math.abs(p.t - nowMs);
                if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
            });
            if (bestIdx >= 0 && bestDiff < 90 * 60 * 1000) {
                // Snap "now" marker to interpolated value at exact now (smoother pill match)
                const at = interpolateKpAt(series, nowMs);
                if (at) {
                    points[bestIdx] = {
                        ...points[bestIdx],
                        kp: at.kp,
                        observed: at.observed,
                        interpolated: at.interpolated,
                        isNow: true
                    };
                } else {
                    points[bestIdx] = { ...points[bestIdx], isNow: true };
                }
            }
        }

        if (!points.length) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
            ctx.textAlign = 'center';
            ctx.font = "14px 'Oswald', system-ui, sans-serif";
            ctx.fillText(
                i18n[currentLang].chartGeomagNoData || 'Geomagnetic data unavailable',
                ctx.canvas.width / 2, ctx.canvas.height / 2
            );
            return;
        }

        const loc = currentLang === 'uk' ? 'uk-UA' : 'en-US';
        const labels = points.map(r => {
            const d = new Date(r.t);
            return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
        });
        const datasetData = points.map(r => r.kp);
        // Color by peak intensity for the selected day
        const peak = Math.max(...datasetData);
        let color = '#00F260'; // calm
        if (peak >= 5) color = '#ef4444';
        else if (peak >= 4) color = '#fbbf24';
        else if (peak >= 3) color = '#a3e635';

        weatherChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: i18n[currentLang].chartGeomag,
                    data: datasetData,
                    borderColor: color,
                    backgroundColor: `${color}1A`,
                    borderWidth: 3,
                    tension: 0.35,
                    fill: true,
                    pointRadius: points.map(pt => geomagPointStatus(pt) === 'now' ? 6 : 4),
                    pointHitRadius: 16,
                    pointHoverRadius: 7,
                    pointBackgroundColor: datasetData.map((kp, i) => {
                        const st = geomagPointStatus(points[i]);
                        // Forecast points stay muted; fact/now use intensity color
                        if (st === 'forecast') return 'rgba(255,255,255,0.35)';
                        if (kp >= 5) return '#ef4444';
                        if (kp >= 4) return '#fbbf24';
                        return '#00F260';
                    }),
                    pointBorderColor: points.map(pt => {
                        const st = geomagPointStatus(pt);
                        if (st === 'now') return '#fff';
                        if (st === 'observed') return 'rgba(255,255,255,0.9)';
                        return 'rgba(255,255,255,0.4)';
                    }),
                    pointBorderWidth: points.map(pt => geomagPointStatus(pt) === 'now' ? 2 : 1)
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        enabled: true,
                        backgroundColor: 'rgba(15, 32, 39, 0.95)',
                        titleColor: '#fff',
                        bodyColor: color,
                        bodyFont: { size: 14, weight: 'bold' },
                        padding: 12,
                        displayColors: false,
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1,
                        cornerRadius: 10,
                        callbacks: {
                            label: (context) => {
                                const y = context.parsed.y;
                                const pt = points[context.dataIndex];
                                let tag = '';
                                if (y >= 5) tag = ` · G${Math.min(5, Math.round(y) - 4)}`;
                                else if (y >= 4) tag = currentLang === 'uk' ? ' · Збурення' : ' · Unsettled';
                                const st = geomagPointStatus(pt);
                                let obs;
                                if (st === 'observed') {
                                    obs = currentLang === 'uk' ? ' (факт)' : ' (obs)';
                                } else if (st === 'now') {
                                    obs = currentLang === 'uk' ? ' (зараз)' : ' (now)';
                                } else if (st === 'estimated') {
                                    obs = currentLang === 'uk' ? ' (оцінка)' : ' (est)';
                                } else {
                                    obs = currentLang === 'uk' ? ' (прогноз)' : ' (fcst)';
                                }
                                // Interpolated hours between official 3h slots
                                if (pt?.interpolated && st !== 'now') {
                                    obs += currentLang === 'uk' ? ' ≈' : ' ≈';
                                }
                                return ` Kp ${y.toFixed(2)}${tag}${obs}`;
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        min: 0,
                        max: 9,
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: {
                            color: 'rgba(255, 255, 255, 0.4)',
                            font: { size: 10 },
                            stepSize: 1
                        }
                    },
                    x: {
                        grid: { display: false },
                        ticks: {
                            color: 'rgba(255, 255, 255, 0.4)',
                            font: { size: 10 },
                            // Same style as temp/wind/pressure (diagonal hour labels)
                            maxRotation: 45,
                            minRotation: 45,
                            autoSkip: true,
                            maxTicksLimit: 12
                        }
                    }
                }
            }
        });
        return;
    }

    let dataSlice = weatherData.hourly;

    // Find the correct hourly start index based on the actual date of the selected day,
    // not just dayOffset*24 — this fixes stale cache where data starts from a previous day.
    let start = dayOffset * 24; // safe fallback

    // Backward compatibility: If hourly is an array (old format), we normalize it on the fly
    if (Array.isArray(dataSlice)) {
        dataSlice = {
            time: dataSlice.map(h => h.timestamp_local || h.time),
            temperature_2m: dataSlice.map(h => h.temp || h.temperature_2m),
            wind_speed_10m: dataSlice.map(h => h.wind_spd || h.wind_speed_10m),
            wind_gusts_10m: dataSlice.map(h => h.gust || h.wind_gusts_10m || 0),
            precipitation: dataSlice.map(h => h.precip || h.precipitation),
            precipitation_probability: dataSlice.map(h => h.pop || h.precipitation_probability),
            surface_pressure: dataSlice.map(h => h.pres || h.surface_pressure)
        };
    }

    // Handle missing or empty hourly data
    if (!dataSlice || !dataSlice.time || dataSlice.time.length === 0) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
        ctx.textAlign = "center";
        ctx.font = "14px 'Oswald', system-ui, sans-serif";
        ctx.fillText(i18n[currentLang].chartNoData, ctx.canvas.width / 2, ctx.canvas.height / 2);
        return;
    }

    // Smart start: find the index of the selected day's date in the time array.
    // For "today" (dayOffset=0), always use the actual current local date
    // so stale cache never shows a previous day's hours.
    const targetDay = weatherData.daily[dayOffset];
    let targetDateStr = '';
    if (dayOffset === 0) {
        const now = new Date();
        targetDateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    } else if (targetDay) {
        targetDateStr = (targetDay.valid_date || '').substring(0, 10);
    }
    if (targetDateStr && dataSlice.time) {
        const idx = dataSlice.time.findIndex(t => t.substring(0, 10) === targetDateStr);
        if (idx !== -1) start = idx;
    }

    const loc = currentLang === 'uk' ? 'uk-UA' : 'en-US';
    const labels = dataSlice.time.slice(start, start + 24).map(t => new Date(t).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' }));

    let datasetLabel = '';
    let datasetData = [];
    let color = '#00F260';

    if (currentMode === 'temp') {
        datasetLabel = i18n[currentLang].chartTemp;
        datasetData = dataSlice.temperature_2m.slice(start, start + 24);
    } else if (currentMode === 'wind') {
        // Open-Meteo hourly wind is in km/h; convert to m/s if needed
        const rawWind = dataSlice.wind_speed_10m.slice(start, start + 24);
        if (currentUnits.wind === 'ms') {
            datasetData = rawWind.map(v => +(v / 3.6).toFixed(1));
            datasetLabel = currentLang === 'uk' ? 'Вітер (м/с)' : 'Wind (m/s)';
        } else {
            datasetData = rawWind;
            datasetLabel = i18n[currentLang].chartWind;
        }
        color = '#38bdf8';
    } else if (currentMode === 'gusts') {
        // Wind gusts: Open-Meteo hourly wind_gusts_10m is in km/h
        const rawGusts = (dataSlice.wind_gusts_10m || []).slice(start, start + 24);
        if (!rawGusts.length || rawGusts.every(v => !v)) {
            // Data missing — show a text message instead of blank chart
            ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
            ctx.textAlign = 'center';
            ctx.font = "14px Oswald, system-ui, sans-serif";
            ctx.fillText(
                currentLang === 'uk' ? 'Дані поривів недоступні' : 'Gusts data unavailable',
                ctx.canvas.width / 2, ctx.canvas.height / 2
            );
            return;
        }
        if (currentUnits.wind === 'ms') {
            datasetData = rawGusts.map(v => +(v / 3.6).toFixed(1));
            datasetLabel = currentLang === 'uk' ? 'Пориви (м/с)' : 'Gusts (m/s)';
        } else {
            datasetData = rawGusts;
            datasetLabel = currentLang === 'uk' ? 'Пориви (км/год)' : 'Gusts (km/h)';
        }
        color = '#f97316'; // orange
    } else if (currentMode === 'precip') {
        datasetLabel = i18n[currentLang].chartPrecip;
        datasetData = dataSlice.precipitation.slice(start, start + 24);
        color = '#38bdf8';
    } else if (currentMode === 'precip_prob') {
        datasetLabel = i18n[currentLang].chartProb;
        datasetData = dataSlice.precipitation_probability.slice(start, start + 24);
        color = '#00F260';
    } else {
        // Pressure: Open-Meteo gives hPa
        const rawPress = dataSlice.surface_pressure.slice(start, start + 24);
        if (currentUnits.pressure === 'mmhg') {
            datasetData = rawPress.map(v => +(v * 0.75006).toFixed(0));
            datasetLabel = currentLang === 'uk' ? 'Тиск (мм рт.ст.)' : 'Pressure (mmHg)';
        } else {
            datasetData = rawPress;
            datasetLabel = currentLang === 'uk' ? 'Тиск (гПа)' : 'Pressure (hPa)';
        }
        color = '#fbbf24';
    }

    weatherChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: datasetLabel,
                data: datasetData,
                borderColor: color,
                backgroundColor: `${color}1A`,
                borderWidth: 3,
                tension: 0.4,
                fill: true,
                pointRadius: 0,
                pointHitRadius: 20, // Wider area to catch the mouse
                pointHoverRadius: 6,
                pointHoverBackgroundColor: color,
                pointHoverBorderColor: '#fff',
                pointHoverBorderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false, // Essential: triggers even if not exactly on the point
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: true,
                    backgroundColor: 'rgba(15, 32, 39, 0.95)',
                    titleColor: '#fff',
                    bodyColor: color,
                    bodyFont: { size: 14, weight: 'bold' },
                    padding: 12,
                    displayColors: false,
                    borderColor: 'rgba(255, 255, 255, 0.1)',
                    borderWidth: 1,
                    cornerRadius: 10,
                    callbacks: {
                        label: (context) => {
                            const y = context.parsed.y;
                            if (currentMode === 'temp') return ` ${formatTemp(y)}`;
                            if (currentMode === 'wind') return ` ${y} ${currentUnits.wind === 'ms' ? 'м/с' : 'км/год'}`;
                            if (currentMode === 'gusts') return ` ${y} ${currentUnits.wind === 'ms' ? 'м/с' : 'км/год'}`;
                            if (currentMode === 'precip') return ` ${y} мм`;
                            if (currentMode === 'precip_prob') return ` ${y} %`;
                            return ` ${y} ${currentUnits.pressure === 'mmhg' ? 'мм рт.ст.' : 'гПа'}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    min: (currentMode === 'precip' || currentMode === 'gusts') ? 0 : undefined,
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: 'rgba(255, 255, 255, 0.4)', font: { size: 10 } }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: 'rgba(255, 255, 255, 0.4)', font: { size: 10 } }
                }
            }
        }
    });
}

function renderDaily(selectedIndex = 0) {

    if (dailyForecastContainer.children.length === weatherData.daily.length) {
        weatherData.daily.forEach((day, index) => {
            const card = dailyForecastContainer.children[index];
            const dateObj = new Date(day.valid_date);
            const loc = currentLang === 'uk' ? 'uk-UA' : 'en-US';
            const dayOfWeek = dateObj.toLocaleDateString(loc, { weekday: 'short' });
            const dateStr = dateObj.toLocaleDateString(loc, { day: 'numeric', month: 'short' });

            let tempsStr = `<strong>${formatTemp(day.temp || day.max_temp || 0)}</strong>`;
            if (day.max_temp !== undefined && day.min_temp !== undefined) {
                tempsStr = `<strong>${formatTemp(day.max_temp)}</strong> <span style="font-size: 0.85em; opacity: 0.6;">${formatTemp(day.min_temp)}</span>`;
            }

            const pWeek = card.querySelector('.day-week');
            const pDate = card.querySelector('.day-date');
            const imgIcon = card.querySelector('img');
            const pTemps = card.querySelector('.day-temps');

            if (pWeek) pWeek.textContent = dayOfWeek;
            if (pDate) pDate.textContent = dateStr;
            if (imgIcon && imgIcon.src !== getPremiumIcon(day.weather.icon)) {
                imgIcon.src = getPremiumIcon(day.weather.icon);
            }
            if (pTemps) pTemps.innerHTML = tempsStr;

            if (index === selectedIndex) {
                card.classList.add('active');
            } else {
                card.classList.remove('active');
            }
        });
        return;
    }

    dailyForecastContainer.innerHTML = '';
    weatherData.daily.forEach((day, index) => {
        const dateObj = new Date(day.valid_date);
        const loc = currentLang === 'uk' ? 'uk-UA' : 'en-US';
        const dayOfWeek = dateObj.toLocaleDateString(loc, { weekday: 'short' });
        const dateStr = dateObj.toLocaleDateString(loc, { day: 'numeric', month: 'short' });

        const card = document.createElement('div');
        card.className = `forecast-card ${index === selectedIndex ? 'active' : ''} fade-in-up`;
        card.style.animationDelay = `${0.3 + (index * 0.05)}s`;

        let tempsStr = `<strong>${formatTemp(day.temp || day.max_temp || 0)}</strong>`;
        if (day.max_temp !== undefined && day.min_temp !== undefined) {
            tempsStr = `<strong>${formatTemp(day.max_temp)}</strong> <span style="font-size: 0.85em; opacity: 0.6;">${formatTemp(day.min_temp)}</span>`;
        }

        card.innerHTML = `
            <p class="day-week" style="text-transform: uppercase;">${dayOfWeek}</p>
            <p class="day-date" style="font-size: 0.75rem; opacity: 0.7; margin-bottom: 5px;">${dateStr}</p>
            <img src="${getPremiumIcon(day.weather.icon)}" alt="icon">
            <p class="day-temps">${tempsStr}</p>
        `;
        card.addEventListener('click', () => updateUI(index));
        dailyForecastContainer.appendChild(card);
    });
}

function updateWindyWidget(lat, lon) {
    const iframe = document.getElementById('windy-iframe');
    if (iframe) {
        iframe.src = `https://embed.windy.com/embed2.html?lat=${lat}&lon=${lon}&zoom=7&level=surface&overlay=radar&menu=&message=true`;
    }
}

function formatFullTime(t) {
    if (!t) return '--:--';
    const loc = currentLang === 'uk' ? 'uk-UA' : 'en-US';
    return new Date(t).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
}

function updateCurrentDate() {
    const options = { weekday: 'long', day: 'numeric', month: 'long' };
    const loc = currentLang === 'uk' ? 'uk-UA' : 'en-US';
    currentDate.textContent = new Date().toLocaleDateString(loc, options);
}

function showToast(message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<span>⚠️</span> ${message}`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.5s ease-out';
        setTimeout(() => toast.remove(), 500);
    }, 3000);
}

function updateCopyrightYear() {
    const yearEl = document.getElementById('copyright-year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();
}

// ─── UV Index label with contextual color ───────────────────────────────────
function formatUV(uv) {
    const val = Math.round(uv || 0);
    const lvls = i18n[currentLang].uvLevels;
    let label, color;
    if (val <= 2)      { label = lvls.low;       color = '#4ade80'; }
    else if (val <= 5) { label = lvls.moderate;  color = '#facc15'; }
    else if (val <= 7) { label = lvls.high;      color = '#fb923c'; }
    else if (val <= 10){ label = lvls.veryHigh;  color = '#f87171'; }
    else               { label = lvls.extreme;   color = '#c084fc'; }
    return `${val} <span style="color:${color};font-size:0.78em;font-weight:600;margin-left:3px;">${label}</span>`;
}

// ─── Wind formatting (m/s or km/h based on user settings) ───────────────────
function formatWind(ms) {
    const units = i18n[currentLang].units;
    if (currentUnits.wind === 'kmh') {
        return `${Math.round(ms * 3.6)} ${units.kmh}`;
    }
    return `${Math.round(ms)} ${units.ms}`;
}

// ─── Pressure formatting (mmHg or hPa based on user settings) ───────────────
function formatPressure(hpa) {
    const units = i18n[currentLang].units;
    if (currentUnits.pressure === 'mmhg') {
        return `${Math.round(hpa * 0.75006)} ${units.mmhg}`;
    }
    return `${Math.round(hpa)} ${units.hpa}`;
}

// ─── Temperature formatting (C or F based on user settings) ───────────────
function formatTemp(c) {
    if (currentUnits.temp === 'f') {
        const f = (c * 9/5) + 32;
        return `${Math.round(f)}°F`;
    }
    return `${Math.round(c)}°C`;
}

// ─── Open settings panel and highlight active unit buttons ──────────────────
function openSettingsPanel() {
    const panel = document.getElementById('settings-panel');
    if (!panel) return;
    document.querySelectorAll('.unit-btn').forEach(btn => {
        const isActive = currentUnits[btn.dataset.type] === btn.dataset.val;
        btn.style.background    = isActive ? 'rgba(0,242,96,0.2)'      : 'rgba(255,255,255,0.08)';
        btn.style.borderColor   = isActive ? 'rgba(0,242,96,0.6)'      : 'rgba(255,255,255,0.2)';
        btn.style.fontWeight    = isActive ? '700'                      : '400';
    });
    panel.style.display = 'flex';
}

// ─── Save a unit preference (locally + to DB if user has sig) ───────────────
async function saveUnitSetting(type, val) {
    currentUnits[type] = val;
    localStorage.setItem('units', JSON.stringify(currentUnits));
    openSettingsPanel(); // refresh highlights
    if (weatherData) updateUI(currentDailyIndex); // re-render with new units

    // Sync to DB (if user has sig OR is in WebApp)
    const tgWebApp = window.Telegram?.WebApp;
    if (currentUserId && (currentSig || tgWebApp?.initData)) {
        try {
            let url = `/api/settings?user=${currentUserId}`;
            if (currentSig) url += `&sig=${currentSig}`;
            if (tgWebApp?.initData) url += `&initData=${encodeURIComponent(tgWebApp.initData)}`;

            await fetch(url, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [type]: val })
            });
        } catch (e) {
            console.warn('Settings sync to DB failed:', e);
        }
    }
    showToast(currentLang === 'uk' ? '✅ Збережено!' : '✅ Saved!');
}

init();
