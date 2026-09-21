require('dotenv').config();
const axios = require('axios');
const connectDB = require('../utils/db');
const User = require('../models/User');
const City = require('../models/City');
const { generateSignature, validateTelegramInitData } = require('../utils/helpers');
const { degToCard } = require('../utils/weather');

const API_KEY = process.env.WEATHERBIT_KEY;
const DEFAULT_CITY = 'Kyiv';

// How long we trust cron snapshots before forcing a live refresh
const OM_FRESH_MS = 90 * 60 * 1000;    // 90 min — light cron is frequent
const WB_FRESH_MS = 12 * 60 * 60 * 1000; // 12 h — full WB check is rare

module.exports = async (req, res) => {
    try {
        await connectDB();
        const { user: userIdFromUrl, sig, initData, refresh } = req.query;
        const SECRET = process.env.CRON_SECRET;
        const BOT_TOKEN = process.env.TG_TOKEN;

        let userId = userIdFromUrl;
        let isWebApp = false;

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

        let userData = null;
        if (userId) {
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
        const unitsToReturn = userData?.units || { wind: 'ms', pressure: 'mmhg' };
        const cityKey = (lat != null && lon != null)
            ? `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`
            : null;

        // --- Prefer city dashboard snapshot from crons ---
        if (!refresh && cityKey) {
            const cityDoc = await City.findOne({ externalId: cityKey }).lean();
            const snap = cityDoc?.dashboardSnapshot;
            if (snap) {
                const now = Date.now();
                const omAge = snap.updatedAtOm ? now - new Date(snap.updatedAtOm).getTime() : Infinity;
                const wbAge = snap.updatedAtWb ? now - new Date(snap.updatedAtWb).getTime() : Infinity;
                const hasHourly = snap.hourly?.time?.length > 0;
                const hasWbDaily = Array.isArray(snap.daily) && snap.daily.length > 0;
                const hasCurrent = !!snap.current || !!snap.currentOm;

                const omOk = hasHourly && omAge < OM_FRESH_MS;
                const wbOk = hasWbDaily && wbAge < WB_FRESH_MS;
                const currentOk = hasCurrent && (omAge < OM_FRESH_MS || wbAge < WB_FRESH_MS);

                if ((omOk || wbOk) && currentOk) {
                    let current = snap.current;
                    let currentSource = snap.currentSource || 'weatherbit';
                    if (wbAge >= WB_FRESH_MS && snap.currentOm) {
                        current = snap.currentOm;
                        currentSource = 'open-meteo';
                    } else if (!current && snap.currentOm) {
                        current = snap.currentOm;
                        currentSource = 'open-meteo';
                    }

                    const daily = hasWbDaily ? snap.daily : [];
                    const hourly = snap.hourly || { time: [], temperature_2m: [] };

                    const bestTs = Math.max(
                        snap.updatedAtOm ? new Date(snap.updatedAtOm).getTime() : 0,
                        snap.updatedAtWb ? new Date(snap.updatedAtWb).getTime() : 0
                    ) || Date.now();

                    const responseData = {
                        current,
                        hourly,
                        daily,
                        aqi: snap.aqi || null,
                        waqi: snap.waqi || null,
                        geomag: snap.geomag || null,
                        lat: snap.lat ?? lat,
                        lon: snap.lon ?? lon,
                        units: unitsToReturn,
                        fromSnapshot: true,
                        cached: true,
                        meta: {
                            currentSource,
                            dailySource: snap.dailySource || (hasWbDaily ? 'weatherbit' : null),
                            updatedAtOm: snap.updatedAtOm || null,
                            updatedAtWb: snap.updatedAtWb || null,
                            updatedAt: new Date(bestTs)
                        },
                        user: { city, lat, lon }
                    };

                    if (userData) {
                        await User.updateOne(
                            { telegramId: Number(userId) },
                            {
                                $set: {
                                    'lastState.temp': current?.temp,
                                    'lastState.updatedAt': responseData.meta.updatedAt
                                }
                            }
                        ).catch(() => {});
                    }

                    return res.status(200).json(responseData);
                }
            }
        }

        // --- Live fetch (fallback or ?refresh=true) ---
        const currentRes = await axios.get(
            `https://api.weatherbit.io/v2.0/current?lat=${lat}&lon=${lon}&key=${API_KEY}`
        ).catch(e => { console.error('Weatherbit Current Error:', e.message); return null; });
        const dailyRes = await axios.get(
            `https://api.weatherbit.io/v2.0/forecast/daily?lat=${lat}&lon=${lon}&key=${API_KEY}&days=7`
        ).catch(e => { console.error('Weatherbit Daily Error:', e.message); return null; });

        if (!currentRes || !dailyRes) {
            throw new Error('Could not fetch core data from Weatherbit. Check API Key.');
        }

        const { lat: cityLat, lon: cityLon } = currentRes.data.data[0];

        const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${cityLat}&longitude=${cityLon}&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,precipitation_probability,surface_pressure,weather_code&timezone=auto&forecast_days=3`;
        const openMeteoRes = await axios.get(omUrl).catch(e => {
            console.error('Open-Meteo Hourly Error:', e.message);
            return null;
        });

        const currentRaw = currentRes.data.data[0];
        const normalizedCurrent = {
            ...currentRaw,
            wind_cdir: currentRaw.wind_dir != null ? degToCard(currentRaw.wind_dir) : 'N',
            source: 'weatherbit'
        };

        const responseData = {
            current: normalizedCurrent,
            hourly: openMeteoRes ? {
                time: openMeteoRes.data.hourly.time,
                temperature_2m: openMeteoRes.data.hourly.temperature_2m,
                wind_speed_10m: openMeteoRes.data.hourly.wind_speed_10m,
                wind_gusts_10m: openMeteoRes.data.hourly.wind_gusts_10m || [],
                precipitation: openMeteoRes.data.hourly.precipitation,
                precipitation_probability: openMeteoRes.data.hourly.precipitation_probability,
                surface_pressure: openMeteoRes.data.hourly.surface_pressure,
                weather_code: openMeteoRes.data.hourly.weather_code || []
            } : { time: [], temperature_2m: [] },
            daily: dailyRes.data.data.map(d => ({
                ...d,
                max_temp: d.max_temp,
                min_temp: d.min_temp,
                pop: d.pop,
                gust: d.wind_gust_spd,
                vis: d.vis,
                uv: d.uv,
                sunrise: d.sunrise_ts * 1000,
                sunset: d.sunset_ts * 1000,
                wind_cdir: d.wind_dir != null ? degToCard(d.wind_dir) : (d.wind_cdir || 'N')
            })),
            aqi: null,
            lat: cityLat,
            lon: cityLon
        };

        try {
            const omAqiUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${cityLat}&longitude=${cityLon}&hourly=us_aqi,birch_pollen,grass_pollen,ragweed_pollen&timezone=auto`;
            const aqiRes = await axios.get(omAqiUrl);
            responseData.aqi = aqiRes.data.hourly;
        } catch (e) {
            console.error('Open-Meteo AQI Error:', e.message);
        }

        const WAQI_TOKEN = process.env.WAQI_TOKEN;
        if (WAQI_TOKEN) {
            try {
                const waqiUrl = `https://api.waqi.info/feed/geo:${cityLat};${cityLon}/?token=${WAQI_TOKEN}`;
                const waqiRes = await axios.get(waqiUrl);
                if (waqiRes.data && waqiRes.data.status === 'ok') {
                    const waqiData = waqiRes.data.data;
                    const aqiVal = waqiData.aqi;
                    let aqiBadge = '🟢';
                    if (aqiVal > 150) aqiBadge = '🔴';
                    else if (aqiVal > 100) aqiBadge = '🟠';
                    else if (aqiVal > 50) aqiBadge = '🟡';
                    responseData.waqi = {
                        aqi: aqiVal,
                        aqiBadge,
                        pm25: waqiData.iaqi?.pm25?.v ?? null,
                        pm10: waqiData.iaqi?.pm10?.v ?? null,
                        pm1: waqiData.iaqi?.pm1?.v ?? null,
                        station: waqiData.city?.name || null
                    };
                }
            } catch (e) {
                console.error('WAQI Error:', e.message);
            }
        }

        // NOAA planetary Kp (geomagnetic — global, relevant "now")
        try {
            const noaaRes = await axios.get(
                'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
                { timeout: 10000 }
            );
            if (noaaRes.data && Array.isArray(noaaRes.data) && noaaRes.data.length > 0) {
                const nowMs = Date.now();
                const next24h = noaaRes.data
                    .filter(r => {
                        const t = new Date(r.time_tag).getTime();
                        return t >= nowMs - 3 * 3600 * 1000 && t <= nowMs + 24 * 3600 * 1000;
                    })
                    .map(r => parseFloat(r.kp))
                    .filter(v => !isNaN(v));
                const kpValues = next24h.length > 0
                    ? next24h
                    : noaaRes.data.slice(0, 8).map(r => parseFloat(r.kp)).filter(v => !isNaN(v));
                const maxKp = kpValues.length > 0 ? Math.max(...kpValues) : null;
                if (maxKp !== null) {
                    let badge = '🟢';
                    if (maxKp >= 5) badge = '🔴';
                    else if (maxKp >= 4) badge = '🟡';
                    responseData.geomag = { maxKp, badge, updatedAt: new Date() };
                }
            }
        } catch (e) {
            console.error('NOAA geomag Error:', e.message);
        }

        const now = new Date();
        responseData.meta = {
            currentSource: 'weatherbit',
            dailySource: 'weatherbit',
            updatedAtOm: openMeteoRes ? now : null,
            updatedAtWb: now,
            updatedAt: now
        };
        responseData.fromSnapshot = false;
        responseData.units = unitsToReturn;
        responseData.user = { city, lat, lon };

        if (cityKey) {
            const setFields = {
                name: city || currentRaw.city_name || cityKey,
                lat: cityLat,
                lon: cityLon,
                timezone: currentRaw.timezone,
                'dashboardSnapshot.updatedAtWb': now,
                'dashboardSnapshot.current': normalizedCurrent,
                'dashboardSnapshot.currentSource': 'weatherbit',
                'dashboardSnapshot.hourly': responseData.hourly,
                'dashboardSnapshot.daily': responseData.daily,
                'dashboardSnapshot.dailySource': 'weatherbit',
                'dashboardSnapshot.aqi': responseData.aqi,
                'dashboardSnapshot.waqi': responseData.waqi,
                'dashboardSnapshot.geomag': responseData.geomag || null,
                'dashboardSnapshot.lat': cityLat,
                'dashboardSnapshot.lon': cityLon,
                'dashboardSnapshot.timezone': currentRaw.timezone
            };
            if (openMeteoRes) setFields['dashboardSnapshot.updatedAtOm'] = now;

            await City.findOneAndUpdate(
                { externalId: cityKey },
                { $set: setFields },
                { upsert: true }
            ).catch(e => console.error('Snapshot save error:', e.message));
        }

        if (userData) {
            await User.updateOne(
                { telegramId: Number(userId) },
                {
                    lastState: {
                        temp: currentRes.data.data[0].temp,
                        weatherCode: currentRes.data.data[0].weather.code,
                        updatedAt: now,
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
};
