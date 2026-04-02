const axios = require('axios');
const connectDB = require('../utils/db');
const User = require('../models/User');

const API_KEY = process.env.WEATHERBIT_KEY;
const DEFAULT_CITY = 'Kyiv';

module.exports = async (req, res) => {
    try {
        await connectDB();
        const { user: userId, refresh } = req.query;

        let userData = null;
        if (userId) {
            userData = await User.findOne({ telegramId: Number(userId) });
        }

        const city = userData ? userData.city : DEFAULT_CITY;
        const lat = userData ? userData.lat : 50.4501;
        const lon = userData ? userData.lon : 30.5234;

        // If no refresh requested, try to return cached data from MongoDB
        // SMART CHECK: only use cache if it has hourly data (from Open-Meteo) and is less than 30 minutes old
        const lastUpdated = userData?.lastState?.updatedAt ? new Date(userData.lastState.updatedAt).getTime() : 0;
        const isCacheValid = (Date.now() - lastUpdated) < 30 * 60 * 1000;

        if (!refresh && isCacheValid && userData && userData.lastState && userData.lastState.fullData && 
            userData.lastState.fullData.hourly && userData.lastState.fullData.hourly.time && 
            userData.lastState.fullData.hourly.time.length > 0) {
            
            return res.status(200).json({
                cached: true,
                user: { city: userData.city, lat: userData.lat, lon: userData.lon },
                lastState: userData.lastState
            });
        }

        // Fetch FRESH data - HYBRID ENGINE
        // 1. Weatherbit (Accuracy) - Current & Daily
        const currentRes = await axios.get(`https://api.weatherbit.io/v2.0/current?city=${encodeURIComponent(city)}&key=${API_KEY}&lang=uk`).catch(e => { console.error('Weatherbit Current Error:', e.message); return null; });
        const dailyRes = await axios.get(`https://api.weatherbit.io/v2.0/forecast/daily?city=${encodeURIComponent(city)}&key=${API_KEY}&days=7&lang=uk`).catch(e => { console.error('Weatherbit Daily Error:', e.message); return null; });

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

        res.status(200).json(responseData);
    } catch (error) {
        console.error('Weather Data Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ 
            error: 'Failed to fetch weather data', 
            details: error.response ? error.response.data : error.message 
        });
    }
}
