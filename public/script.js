const API_URL = '/api/weather-data';
const DEFAULT_LAT = 50.4501;
const DEFAULT_LON = 30.5234;
const DEFAULT_CITY = 'Kyiv';

let weatherChart = null;
let currentMode = 'temp';
let weatherData = null; // Store fetched data globally for switching
let currentStatusKey = 'freeAccess';
let currentUnits = { wind: 'ms', pressure: 'mmhg' }; // single source of truth (synced with bot)
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
        tabPress: "Тиск",
        uvIndex: "UV-індекс",
        windGusts: "Вітер",
        humidity: "Вологість",
        precipChance: "Шанс опадів",
        visibility: "Видимість",
        pressure: "Тиск",
        gustsTo: "пориви до",
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
            km: "км"
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
        chartPrecip: "Опади (мм)",
        chartProb: "Шанс опадів (%)",
        chartPress: "Тиск (мм рт.ст.)",
        intelMonitoring: "Інтелектуальний моніторинг",
        sentinel: "Вартовий",
        dashboard: "Панель керування",
        freeAccess: "Безкоштовний доступ",
        premiumStatus: "Преміум статус",
        sentinelDashboard: "Преміум статус",
        transl: { // weather translation
            200: 'Гроза', 201: 'Гроза з дощем', 202: 'Сильна гроза', 233: 'Гроза',
            300: 'Мряка', 301: 'Мряка', 302: 'Сильна мряка',
            500: 'Невеликий дощ', 501: 'Помірний дощ', 502: 'Сильний дощ', 
            520: 'Слабкий дощ', 521: 'Злива', 522: 'Сильна злива',
            600: 'Невеликий сніг', 601: 'Сніг', 602: 'Сильний снігопад', 610: 'Сніг з дощем',
            700: 'Димка', 741: 'Туман', 751: 'Мла',
            800: 'Ясно', 801: 'Легка хмарність', 802: 'Мінлива хмарність', 803: 'Хмарно', 804: 'Похмуро'
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
        tabPress: "Pres",
        uvIndex: "UV Index",
        windGusts: "Wind",
        humidity: "Humidity",
        precipChance: "Precip chance",
        visibility: "Visibility",
        pressure: "Pressure",
        gustsTo: "gusts up to",
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
            km: "km"
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
        chartPrecip: "Precip (mm)",
        chartProb: "Precip Chance (%)",
        chartPress: "Pressure (mb)",
        intelMonitoring: "Intelligence Monitoring",
        sentinel: "Sentinel",
        dashboard: "Dashboard",
        freeAccess: "Free Access",
        premiumStatus: "Premium Status",
        sentinelDashboard: "Sentinel Dashboard",
        transl: {
            200: 'Thunderstorm', 201: 'Thunderstorm with rain', 202: 'Heavy thunderstorm', 233: 'Thunderstorm',
            300: 'Drizzle', 301: 'Drizzle', 302: 'Heavy drizzle',
            500: 'Light rain', 501: 'Moderate rain', 502: 'Heavy rain', 
            520: 'Light shower', 521: 'Shower', 522: 'Heavy shower',
            600: 'Light snow', 601: 'Snow', 602: 'Heavy snow', 610: 'Sleet',
            700: 'Mist', 741: 'Fog', 751: 'Haze',
            800: 'Clear', 801: 'Few clouds', 802: 'Partly cloudy', 803: 'Cloudy', 804: 'Overcast'
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
            const response = await fetch(`${API_URL}?user=${userId}${sigPart}${refreshPart}`);
            if (!response.ok) throw new Error('Internal API failed');
            const data = await response.json();

            if (data.cached && data.lastState && data.lastState.fullData) {
                weatherData = data.lastState.fullData;
                currentCity.textContent = data.user.city;
                currentStatusKey = 'sentinelDashboard';
            } else {
                weatherData = data;
                currentCity.textContent = data.current?.city_name || i18n[currentLang].defaultCity;
                currentStatusKey = 'premiumStatus';
            }
            // Apply unit preferences from the API (single source of truth)
            if (data.units) {
                currentUnits = data.units;
                localStorage.setItem('units', JSON.stringify(currentUnits));
            }
            accessType.textContent = i18n[currentLang][currentStatusKey];
            updateUI(0); // Show today by default
            const lat = data.user?.lat || data.lat || DEFAULT_LAT;
            const lon = data.user?.lon || data.lon || DEFAULT_LON;
            updateWindyWidget(lat, lon);
            updateUpdateTime();
        }
    } catch (error) {
        console.warn('Load error:', error);
        updateTime.textContent = 'API Error';
    } finally {
        setTimeout(() => document.body.classList.remove('loading'), 500);
    }
}

async function fetchOpenMeteo(lat, lon, name) {
    try {
        const omResponse = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&hourly=temperature_2m,wind_speed_10m,precipitation,precipitation_probability,surface_pressure&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,visibility_max&timezone=auto`);
        if (!omResponse.ok) return;
        const omData = await omResponse.json();

        weatherData = normalizeOpenMeteo(omData, name);
        currentCity.textContent = name;
        currentStatusKey = 'freeAccess';
        updateUI(0);
        updateWindyWidget(lat, lon);
        updateUpdateTime();
    } catch (error) {
        console.error('Open-Meteo Error:', error);
        showToast(i18n[currentLang].chartNoData);
    }
}

function updateUpdateTime() {
    const now = new Date();
    const loc = currentLang === 'uk' ? 'uk-UA' : 'en-US';
    updateTime.textContent = now.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
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
            uv: om.daily.uv_index_max[0],
            weather: wmoMap[om.current.weather_code] || wmoMap[0]
        },
        hourly: om.hourly,
        daily: om.daily.time.map((t, i) => {
            const wmo = wmoMap[om.daily.weather_code[i]] || wmoMap[0];
            return {
                valid_date: t,
                max_temp: om.daily.temperature_2m_max[i],
                min_temp: om.daily.temperature_2m_min[i],
                pop: om.daily.precipitation_probability_max[i],
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
                weather: wmo
            };
        })
    };
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

    currentTemp.textContent = `${Math.round(mainTemp)}°C`;
    weatherCondition.textContent = translateWeather(day.weather?.code, day.weather?.description || day.weather?.desc || i18n[currentLang].analyzing);
    weatherFeels.textContent = `${i18n[currentLang].feelsLike} ${Math.round(apparentTemp)}°C`;

    // Premium Icon Upgrade
    weatherIcon.src = getPremiumIcon(day.weather.icon);

    // Compact Pills
    document.getElementById('sunrise-val').textContent = formatFullTime(details.sunrise);
    document.getElementById('sunset-val').textContent = formatFullTime(details.sunset);
    document.getElementById('uv-val').innerHTML = formatUV(details.uv);
    
    // Wind combined (spd + gusts)
    const spdStr = formatWind(day.wind_spd || 0);
    const gustVal = Math.round((details.gust || 0) * (currentUnits.wind === 'kmh' ? 3.6 : 1));
    const fullWindStr = `${spdStr} (${i18n[currentLang].gustsTo} ${gustVal})`;
    document.getElementById('wind-gust').textContent = fullWindStr;

    document.getElementById('humidity-val').textContent = `${day.rh}%`;
    document.getElementById('precip-prob').textContent = `${details.pop}%`;
    document.getElementById('vis-val').textContent = `${Math.round(details.vis)} ${i18n[currentLang].units.km}`;
    // Pressure: use hourly data from OM (index 0 for now) if today, or fallback.
    const hPress = weatherData.hourly?.surface_pressure?.[isToday ? 0 : dayIndex * 24];
    document.getElementById('press-val').textContent = hPress ? formatPressure(hPress) : '---';

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
    const base = 'https://basmilius.github.io/weather-icons/production/fill/all/';

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

    const start = dayOffset * 24;
    let dataSlice = weatherData.hourly;

    // Backward compatibility: If hourly is an array (old format), we normalize it on the fly
    if (Array.isArray(dataSlice)) {
        dataSlice = {
            time: dataSlice.map(h => h.timestamp_local || h.time),
            temperature_2m: dataSlice.map(h => h.temp || h.temperature_2m),
            wind_speed_10m: dataSlice.map(h => h.wind_spd || h.wind_speed_10m),
            precipitation: dataSlice.map(h => h.precip || h.precipitation),
            precipitation_probability: dataSlice.map(h => h.pop || h.precipitation_probability),
            surface_pressure: dataSlice.map(h => h.pres || h.surface_pressure)
        };
    }

    // Handle missing or empty hourly data
    if (!dataSlice || !dataSlice.time || dataSlice.time.length === 0) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
        ctx.textAlign = "center";
        ctx.font = "14px Inter";
        ctx.fillText(i18n[currentLang].chartNoData, ctx.canvas.width / 2, ctx.canvas.height / 2);
        return;
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
                            if (currentMode === 'temp') return ` ${y} °C`;
                            if (currentMode === 'wind') return ` ${y} ${currentUnits.wind === 'ms' ? 'м/с' : 'км/год'}`;
                            if (currentMode === 'precip') return ` ${y} мм`;
                            if (currentMode === 'precip_prob') return ` ${y} %`;
                            return ` ${y} ${currentUnits.pressure === 'mmhg' ? 'мм рт.ст.' : 'гПа'}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    min: currentMode === 'precip' ? 0 : undefined,
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

            let tempsStr = `<strong>${Math.round(day.temp || day.max_temp || 0)}°</strong>`;
            if (day.max_temp !== undefined && day.min_temp !== undefined) {
                tempsStr = `<strong>${Math.round(day.max_temp)}°</strong> <span style="font-size: 0.85em; opacity: 0.6;">${Math.round(day.min_temp)}°</span>`;
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

        let tempsStr = `<strong>${Math.round(day.temp || day.max_temp || 0)}°</strong>`;
        if (day.max_temp !== undefined && day.min_temp !== undefined) {
            tempsStr = `<strong>${Math.round(day.max_temp)}°</strong> <span style="font-size: 0.85em; opacity: 0.6;">${Math.round(day.min_temp)}°</span>`;
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

    // Sync to DB (only if user has a valid personal link with sig)
    if (currentUserId && currentSig) {
        try {
            await fetch(`/api/settings?user=${currentUserId}&sig=${currentSig}`, {
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
