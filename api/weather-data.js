require('dotenv').config();
const axios = require('axios');
const connectDB = require('../utils/db');
const User = require('../models/User');
const { generateSignature, validateTelegramInitData } = require('../utils/helpers');

const API_KEY = process.env.WEATHERBIT_KEY;
const DEFAULT_CITY = 'Kyiv';

module.exports = async (req, res) => {
    try {
        await connectDB();
        const { user: userIdFromUrl, sig, initData, refresh } = req.query;
        const SECRET = process.env.CRON_SECRET;
        const BOT_TOKEN = process.env.TG_TOKEN;

        let userId = userIdFromUrl;
        let isWebApp = false;

        // === НОВИЙ БЛОК: підтримка Telegram WebApp ===
        if (initData && BOT_TOKEN) {
            const isValid = validateTelegramInitData(initData, BOT_TOKEN);
            if (isValid) {
                const params = new URLSearchParams(initData);
                const userParam = params.get('user');
                if (userParam) {
                    const data = JSON.parse(userParam);
                    userId = data.id?.toString();
                    isWebApp = true;
                }
            } else {
                return res.status(401).json({ error: 'Invalid Telegram initData' });
            }
        }
        // ============================================

        let userData = null;
        if (userId) {
            // Verify signature for normal links or use WebApp validation status
            if (!isWebApp) {
                const expectedSig = generateSignature(userId, SECRET);
                if (!sig || sig !== expectedSig) {
                    return res.status(401).json({ error: 'Unauthorized access: Invalid or missing signature' });
                }
            }
            userData = await User.findOne({ telegramId: Number(userId) });
        }

        const city = userData ? userData.city : DEFAULT_CITY;
        const lat = userData ? userData.lat : 50.4501;
        const lon = userData ? userData.lon : 30.5234;

        // If no refresh requested, try to return cached data from MongoDB
        // SMART CHECK: only use cache if it has hourly data (from Open-Meteo) and is less than 120 minutes old
        const lastUpdated = userData?.lastState?.updatedAt ? new Date(userData.lastState.updatedAt).getTime() : 0;
        const isCacheValid = (Date.now() - lastUpdated) < 120 * 60 * 1000;

        if (!refresh && isCacheValid && userData && userData.lastState && userData.lastState.fullData && 
            userData.lastState.fullData.hourly && userData.lastState.fullData.hourly.time && 
            userData.lastState.fullData.hourly.time.length > 0) {
            
            return res.status(200).json({
                cached: true,
                user: { city: userData.city, lat: userData.lat, lon: userData.lon },
                units: userData.units || { wind: 'ms', pressure: 'mmhg' },
                lastState: userData.lastState
            });
        }

        const lang = userData?.language || 'uk';

        // Fetch FRESH data - HYBRID ENGINE
        // 1. Weatherbit (Accuracy) - Current & Daily
        const currentRes = await axios.get(`https://api.weatherbit.io/v2.0/current?lat=${lat}&lon=${lon}&key=${API_KEY}&lang=${lang}`).catch(e => { console.error('Weatherbit Current Error:', e.message); return null; });
        const dailyRes = await axios.get(`https://api.weatherbit.io/v2.0/forecast/daily?lat=${lat}&lon=${lon}&key=${API_KEY}&days=7&lang=${lang}`).catch(e => { console.error('Weatherbit Daily Error:', e.message); return null; });

        if (!currentRes || !dailyRes) {
            throw new Error('Could not fetch core data from Weatherbit. Check API Key.');
        }

        const { lat: cityLat, lon: cityLon } = currentRes.data.data[0];

        // 2. Open-Meteo (Utility) - Hourly Forecast for the Chart (Free)
        const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${cityLat}&longitude=${cityLon}&hourly=temperature_2m,wind_speed_10m,precipitation,precipitation_probability,surface_pressure&timezone=auto`;
        const openMeteoRes = await axios.get(omUrl).catch(e => { console.error('Open-Meteo Hourly Error:', e.message); return null; });

        const responseData = {
            current: currentRes.data.data[0],
            hourly: openMeteoRes ? {
                time: openMeteoRes.data.hourly.time,
                temperature_2m: openMeteoRes.data.hourly.temperature_2m,
                wind_speed_10m: openMeteoRes.data.hourly.wind_speed_10m,
                precipitation: openMeteoRes.data.hourly.precipitation,
                precipitation_probability: openMeteoRes.data.hourly.precipitation_probability,
                surface_pressure: openMeteoRes.data.hourly.surface_pressure
            } : { time: [], temperature_2m: [] }, // Fallback if OM fails
            daily: dailyRes.data.data.map(d => ({
                ...d,
                max_temp: d.max_temp,
                min_temp: d.min_temp,
                pop: d.pop,
                gust: d.wind_gust_spd,
                vis: d.vis,
                uv: d.uv,
                sunrise: d.sunrise_ts * 1000,
                sunset: d.sunset_ts * 1000
            })),
            lat: cityLat,
            lon: cityLon
        };

        // Attach user unit preferences so the site can display correctly
        const unitsToReturn = userData?.units || { wind: 'ms', pressure: 'mmhg' };

        // Cache update in DB if user is registered
        if (userData) {
            await User.updateOne(
                { telegramId: Number(userId) },
                { 
                    lastState: {
                        temp: currentRes.data.data[0].temp,
                        weatherCode: currentRes.data.data[0].weather.code,
                        updatedAt: new Date(),
                        fullData: responseData
                    }
                }
            );
        }

        res.status(200).json({ ...responseData, units: unitsToReturn });
    } catch (error) {
        console.error('Weather Data Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ 
            error: 'Failed to fetch weather data', 
            details: error.response ? error.response.data : error.message 
        });
    }
}
