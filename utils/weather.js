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

module.exports = {
    WEATHER_CODES,
    WIND_DIRECTIONS,
    getWeatherDesc,
    getWindDir,
    degToCard,
    getIconMapping
};

