const API_URL = '/api/weather-data';
let weatherChart = null;
let currentMode = 'temp';
let weatherData = null; // Store fetched data globally for switching

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
    const userId = urlParams.get('user');

    updateCurrentDate();
    updateCopyrightYear();
    await loadWeatherData(userId);

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
            renderChart();
        });
    });
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
            alert('Місто не знайдено');
        }
    } catch (e) {
        console.error('Search error:', e);
    }
}

async function loadWeatherData(userId, forceRefresh = false) {
    try {
        if (!userId) {
            await fetchOpenMeteo(50.4501, 30.5234, 'Київ');
        } else {
            const refreshPart = forceRefresh ? '&refresh=true' : '';
            const response = await fetch(`${API_URL}?user=${userId}${refreshPart}`);
            if (!response.ok) throw new Error('Internal API failed');
            const data = await response.json();

            if (data.cached && data.lastState && data.lastState.fullData) {
                weatherData = data.lastState.fullData;
                currentCity.textContent = data.user.city;
                accessType.textContent = 'Sentinel Dashboard';
            } else {
                weatherData = data;
                // Weatherbit puts city name inside 'current'
                currentCity.textContent = data.current?.city_name || 'Ваша Локація';
                accessType.textContent = 'Premium Status';
            }
            updateUI(0); // Show today by default
            updateWindyWidget(data.lat || 50.45, data.lon || 30.52);
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
    const omResponse = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&hourly=temperature_2m,wind_speed_10m,precipitation,precipitation_probability,surface_pressure&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max,wind_gusts_10m_max,visibility_max&timezone=auto`);
    if (!omResponse.ok) return;
    const omData = await omResponse.json();

    weatherData = normalizeOpenMeteo(omData, name);
    currentCity.textContent = name;
    updateUI(0);
    updateWindyWidget(lat, lon);
    accessType.textContent = 'Free Access';
    updateUpdateTime();
}

function updateUpdateTime() {
    const now = new Date();
    updateTime.textContent = now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

function normalizeOpenMeteo(om, name) {
    const wmoMap = {
        0: { desc: 'Ясно', icon: 'c01d', code: 800 },
        1: { desc: 'Переважно ясно', icon: 'c02d', code: 801 },
        2: { desc: 'Хмарно', icon: 'c03d', code: 802 },
        3: { desc: 'Пасмурно', icon: 'c04d', code: 804 },
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
                rh: 60,
                wind_spd: om.daily.wind_gusts_10m_max[i] / 4,
                weather: wmo
            };
        })
    };
}

function updateUI(dayIndex) {
    if (!weatherData) return;
    const isToday = dayIndex === 0;
    const day = isToday ? weatherData.current : weatherData.daily[dayIndex];
    const details = weatherData.daily[dayIndex];

    // Main Card
    const mainTemp = day.temp !== undefined ? day.temp : day.max_temp;
    const apparentTemp = day.app_temp !== undefined ? day.app_temp : (day.app_max_temp !== undefined ? day.app_max_temp : mainTemp);

    const translateWeather = (code, defaultText) => {
        const map = {
            200: 'Гроза', 201: 'Гроза з дощем', 202: 'Сильна гроза', 233: 'Гроза',
            300: 'Мряка', 301: 'Мряка', 302: 'Сильна мряка',
            500: 'Невеликий дощ', 501: 'Помірний дощ', 502: 'Сильний дощ', 
            520: 'Слабкий дощ', 521: 'Злива', 522: 'Сильна злива',
            600: 'Невеликий сніг', 601: 'Сніг', 602: 'Сильний снігопад', 610: 'Сніг з дощем',
            700: 'Димка', 741: 'Туман', 751: 'Мла',
            800: 'Ясно', 801: 'Легка хмарність', 802: 'Мінлива хмарність', 803: 'Хмарно', 804: 'Пасмурно'
        };
        return map[code] || defaultText;
    };

    currentTemp.textContent = `${Math.round(mainTemp)}°C`;
    weatherCondition.textContent = translateWeather(day.weather?.code, day.weather?.description || day.weather?.desc || 'Аналізуємо...');
    weatherFeels.textContent = `Відчувається як ${Math.round(apparentTemp)}°C`;

    // Premium Icon Upgrade
    weatherIcon.src = getPremiumIcon(day.weather.icon);

    // Compact Pills
    document.getElementById('sunrise-val').textContent = formatFullTime(details.sunrise);
    document.getElementById('sunset-val').textContent = formatFullTime(details.sunset);
    document.getElementById('uv-val').textContent = Math.round(details.uv);
    document.getElementById('wind-gust').textContent = `${Math.round(details.gust || 0)} м/с`;
    document.getElementById('humidity-val').textContent = `${day.rh}%`;
    document.getElementById('precip-prob').textContent = `${details.pop}%`;
    document.getElementById('vis-val').textContent = `${Math.round(details.vis)} км`;
    document.getElementById('press-val').textContent = isToday ? `${Math.round(weatherData.hourly.surface_pressure[0] || 1013)} mb` : '1013 mb';

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
        'r01d': 'rain', 'r02d': 'heavy-rain', 'r03d': 'heavy-rain',
        'd01d': 'drizzle', 'd02d': 'drizzle', 'd03d': 'drizzle',
        's01d': 'snow', 's02d': 'heavy-snow', 's04d': 'sleet',
        't01d': 'thunderstorms-day', 't02d': 'thunderstorms-day', 't04d': 'thunderstorms-rain'
    };

    // Extract base code (without 'd' or 'n' sometimes if generic)
    const iconName = mapping[code] || (code.startsWith('r') ? 'rain' : code.startsWith('s') ? 'snow' : code.startsWith('t') ? 'thunderstorms' : 'not-available');
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
        ctx.fillText("Погодинний прогноз недоступний", ctx.canvas.width / 2, ctx.canvas.height / 2);
        return;
    }

    const labels = dataSlice.time.slice(start, start + 24).map(t => new Date(t).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }));

    let datasetLabel = '';
    let datasetData = [];
    let color = '#00F260';

    if (currentMode === 'temp') {
        datasetLabel = 'Темп (°C)';
        datasetData = dataSlice.temperature_2m.slice(start, start + 24);
    } else if (currentMode === 'wind') {
        datasetLabel = 'Вітер (км/год)';
        datasetData = dataSlice.wind_speed_10m.slice(start, start + 24);
        color = '#38bdf8';
    } else if (currentMode === 'precip') {
        datasetLabel = 'Опади (мм)';
        datasetData = dataSlice.precipitation.slice(start, start + 24);
        color = '#38bdf8';
    } else if (currentMode === 'precip_prob') {
        datasetLabel = 'Шанс опадів (%)';
        datasetData = dataSlice.precipitation_probability.slice(start, start + 24);
        color = '#00F260';
    } else {
        datasetLabel = 'Тиск (mb)';
        datasetData = dataSlice.surface_pressure.slice(start, start + 24);
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
                        label: (context) => ` ${context.parsed.y} ${currentMode === 'temp' ? '°C' : currentMode === 'wind' ? 'км/год' : currentMode === 'precip' ? 'мм' : currentMode === 'precip_prob' ? '%' : 'mb'}`
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
            const dayOfWeek = dateObj.toLocaleDateString('uk-UA', { weekday: 'short' });
            const dateStr = dateObj.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });

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
        const dayOfWeek = dateObj.toLocaleDateString('uk-UA', { weekday: 'short' });
        const dateStr = dateObj.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });

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
    return new Date(t).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

function updateCurrentDate() {
    const options = { weekday: 'long', day: 'numeric', month: 'long' };
    currentDate.textContent = new Date().toLocaleDateString('uk-UA', options);
}

function updateCopyrightYear() {
    const yearEl = document.getElementById('copyright-year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();
}

init();
