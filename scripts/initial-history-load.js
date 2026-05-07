require('dotenv').config();
const axios = require('axios');
const connectDB = require('../utils/db');
const City = require('../models/City');
const History = require('../models/History');

async function loadInitialHistory() {
    try {
        await connectDB();
        console.log('--- Starting One-Time History Load (3 years) ---');

        const cities = await City.find();
        if (cities.length === 0) {
            console.log('No cities found in database. Please add cities first.');
            process.exit(0);
        }

        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        const threeYearsAgo = new Date(today);
        threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
        const startDateStr = threeYearsAgo.toISOString().split('T')[0];

        console.log(`Period: ${startDateStr} to ${yesterdayStr}`);
        console.log(`Processing ${cities.length} cities...`);

        for (const city of cities) {
            console.log(`\nProcessing city: ${city.name} (${city.lat}, ${city.lon})`);
            const externalId = city.externalId || `${city.lat.toFixed(2)},${city.lon.toFixed(2)}`;

            try {
                // Open-Meteo Archive API call
                const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${city.lat}&longitude=${city.lon}&start_date=${startDateStr}&end_date=${yesterdayStr}&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,relative_humidity_2m_mean,wind_speed_10m_max,cloud_cover_mean&timezone=auto`;
                
                const response = await axios.get(url);
                const daily = response.data.daily;

                if (!daily || !daily.time) {
                    console.error(`No data for ${city.name}`);
                    continue;
                }

                const bulkOps = daily.time.map((date, index) => {
                    return {
                        updateOne: {
                            filter: { externalId: externalId, date: date },
                            update: {
                                $set: {
                                    temp_max: daily.temperature_2m_max[index],
                                    temp_min: daily.temperature_2m_min[index],
                                    temp_avg: daily.temperature_2m_mean[index],
                                    precip: daily.precipitation_sum[index],
                                    rh_avg: daily.relative_humidity_2m_mean[index],
                                    wind_spd_max: daily.wind_speed_10m_max[index] / 3.6, // Convert km/h to m/s
                                    clouds_avg: daily.cloud_cover_mean[index]
                                }
                            },
                            upsert: true
                        }
                    };
                });

                console.log(`Writing ${bulkOps.length} records for ${city.name}...`);
                const result = await History.bulkWrite(bulkOps, { ordered: false });
                console.log(`Done. Upserted: ${result.upsertedCount}, Modified: ${result.modifiedCount}`);

            } catch (cityErr) {
                console.error(`Error processing ${city.name}:`, cityErr.message);
            }
        }

        console.log('\n--- History Load Completed ---');
        process.exit(0);

    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

loadInitialHistory();
