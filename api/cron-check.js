const axios = require('axios');
const mongoose = require('mongoose');
const { Telegraf } = require('telegraf');
const User = require('../models/User');

const bot = new Telegraf(process.env.TG_TOKEN);
const API_KEY = process.env.WEATHERBIT_KEY;

const connectDB = require('../utils/db');

module.exports = async (req, res) => {
    // Basic auth/token check for Vercel Cron
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).send('Unauthorized');

    try {
        await connectDB();
        const users = await User.find({ notificationsEnabled: true });

        for (const user of users) {
            try {
                const response = await axios.get(`https://api.weatherbit.io/v2.0/current?city=${encodeURIComponent(user.city)}&key=${API_KEY}&lang=uk`);
                const current = response.data.data[0];

                const oldTemp = user.lastState?.temp || current.temp;
                const newTemp = current.temp;
                const deltaT = Math.abs(newTemp - oldTemp);
                const oldCode = user.lastState?.weatherCode || 800;
                const newCode = current.weather.code;

                let alertMessage = '';

                // Condition 1: Sharp temperature change (>= 5°C)
                if (deltaT >= 5) {
                    alertMessage = `⚠️ **Увага! Погода різко змінилася!**\nТемпература стрибнула на ${deltaT.toFixed(1)}°C і зараз становить ${newTemp}°C.`;
                }

                // Condition 2: From Clear/Clouds to Rain/Snow/Storm
                if (oldCode >= 800 && newCode < 700) {
                    alertMessage = `⛈️ **Попередження про опади!**\nСхоже, погода у місті ${user.city} погіршується. Зараз: ${current.weather.description}.`;
                }

                if (alertMessage) {
                    await bot.telegram.sendMessage(user.telegramId, alertMessage, { 
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: "🔗 Детальний прогноз", url: `https://parasol-sentinel.vercel.app/?user=${user.telegramId}` }
                            ]]
                        }
                    });
                }

                // Update state in DB
                user.lastState = {
                    temp: newTemp,
                    weatherCode: newCode,
                    updatedAt: new Date()
                };
                await user.save();

            } catch (err) {
                console.error(`Error processing user ${user.telegramId}:`, err.message);
            }
        }

        res.status(200).send(`Processed ${users.length} users`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Cron Check Error');
    }
}
