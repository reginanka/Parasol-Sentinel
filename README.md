# ☂️ Parasol Sentinel: Advanced Weather & Environmental Intelligence Ecosystem

**Parasol Sentinel** is a high-performance weather, environmental, and agronomic monitoring solution designed to showcase scalable architecture using Node.js, Vercel Serverless, and MongoDB. This ecosystem features a proactive Telegram bot and a stunning glassmorphism dashboard, demonstrating expert-level integration of real-time environmental data streaming, space weather tracking, air quality analysis, and cost-optimized API management.

<p align="center">
  <img src="preview1.png" width="800" alt="Parasol Sentinel Dashboard Preview">
</p>

---

## 🌟 Key Features & Latest Updates

### 🍃 1. Real-time Air Quality (AQI) & Particulate Monitoring (**New!**)
- **WAQI (World Air Quality Index) Integration**: Real-time measurement of fine particulate matter (**PM2.5**), coarse dust (**PM10**), and overall **AQI** from ground sensors.
- **Current-Moment Verification**: Evening forecasts explicitly clarify live air quality state (`🍃 Якість повітря (на момент зараз)` / `🍃 Air Quality (current moment)`).
- **Proactive AQI Deterioration Alerts**: Automated daytime checks detect air quality degradation (AQI > 50 / > 100 / > 150 or PM2.5/PM10 spikes) and immediately issue alerts with targeted health advice (e.g. closing windows, air purifier activation, smog protection).

### 🧲 2. Space Weather & Geomagnetic Storm Tracking (**New!**)
- **NOAA SWPC Integration**: Real-time parsing of NOAA planetary **Kp-index (0–9)** to track geomagnetic activity.
- **Proactive & Evening Forecasts**: Alerts weather-sensitive individuals about upcoming or sudden magnetic storms ($Kp \ge 5$) and geomagnetic disturbances ($Kp = 4$).
- **Smart Anti-Spam Locking**: State-aware database tracking (`lastGeomagAlert`) prevents duplicate hourly spam while allowing escalation alerts if storm intensity increases.

### 🌱 3. Agronomic Risk Engine & Crop Intelligence (**New!**)
- **Custom Crop Management**: Select specific crops (vegetables, fruit trees, berries) to receive tailored agricultural advisories.
- **Spraying Window & Disease Risk**: Analyzes wind speed, temperature, and leaf wetness to calculate optimal spraying windows for treatments and phytophthora/fungal risk alerts.
- **Historical Agro-Analytics**: Historical report generation across 7-day, 30-day, 6-month, 1-year, or custom date ranges to analyze climate trends and historical impact.
- **Lunar Phase Engine**: Built-in lunar calendar calculations (New Moon, Waxing Crescent, Full Moon, etc.) for optimal planting schedules.

### 🌧 4. Smart Precipitation Shift & Hourly Rain Alerts (**New!**)
- **Open-Meteo Hourly Engine**: Tracks hourly precipitation depth (mm) and probability.
- **Rain Appearance & Cancellation Alerts**: Automatically notifies users if new rain appears in today's forecast or if previously predicted rain gets completely canceled (*"☀️ Great news! Rain canceled for today"*).

### ⚙️ 5. Granular Forecast Customization & Unit Sync
- **Customizable Forecast Metrics**: Users can toggle 12+ individual metrics (Sky condition, Temperature, Precip, Wind, Pressure, Dew Point, UV, Visibility, Moon, Sun, AQI, Geomagnetic storms) and forecast range (1–6 days).
- **Non-Destructive Telegram UX**: Inline settings sub-menus preserve the original forecast message context.
- **Personalized Unit Synchronization**: Instant multi-device sync for **°C / °F**, **m/s / km/h**, and **mmHg / hPa** between the Telegram Bot and WebApp Dashboard.

### 🚀 6. Hybrid Intelligence Engine 2.0 (Cost-Optimized)
- **Weatherbit API (Core)**: High-accuracy daily and current conditions.
- **Open-Meteo API (Utility)**: Hourly charts, precipitation breakdown, and fallback data.
- **Smart Caching Layer**: Time-aware 120-minute cache in **MongoDB Atlas** to minimize external API rate limits.

### 🛡️ 7. Enterprise-Grade Security & Performance
- **Cryptographic URL Protection**: HMAC-SHA256 signature generation for per-user WebApp dashboards.
- **Telegram WebApp Integration**: Direct settings management within the dashboard using `initData` validation.
- **Vercel-native Architecture**: Sub-second execution using isolated serverless Node.js endpoints.

### 🌐 8. Premium Multilingual Ecosystem (UK / EN)
- **Native Bilingual Support**: Complete Ukrainian and English localization across all bot messages, alerts, help documentation, agronomic advice, space weather alerts, and settings menus.
- **Automatic & User Preferences**: Seamless language detection and per-user preference storage synchronized across Telegram and WebApp interfaces.

---

## 🛠 Tech Stack

- **Backend**: Node.js (Vercel Serverless), Telegraf (Telegram Bot Framework), Mongoose (ODM).
- **Frontend**: Vanilla HTML5/CSS3 (Modern Glassmorphism), Chart.js, Leaflet.js.
- **Database**: MongoDB Atlas (Cloud Database).
- **External Data APIs**: Weatherbit API, Open-Meteo API, WAQI API, NOAA SWPC API, OpenStreetMap Nominatim.
- **Operations**: GitHub Actions & Vercel Cron.

## 📁 Architecture Overview

- `/api`: Serverless endpoints (`cron-check.js`, `cron-forecast.js`, `cron-forecast-test.js`, `bot.js`, `weather-data.js`).
- `/models`: Mongoose schemas (`User.js`, `City.js`, `History.js`).
- `/public`: Glassmorphism WebApp assets optimized for minimal TTFB.
- `/utils`: Centralized helper modules (`weather.js`, `agro.js`, `crops.js`, `helpers.js`, `logger.js`, `db.js`).

## 🚀 Deployment Guide

1. **Environment Config**:
   - Copy `.env.example` to `.env`.
   - Required: `TG_TOKEN`, `MONGO_URI`, `WEATHERBIT_KEY`, `DOMAIN`.
   - Required: `CRON_SECRET` (For security and dashboard URL hashing).
2. **Local Development**:
   - `npm install` && `npm start` (Runs the bot in polling mode).
3. **Vercel Deployment**:
   - Connect your repo to Vercel. Pushing to `main` triggers an automatic build.
   - Set GitHub Secrets for `DOMAIN` and `CRON_SECRET` to enable automated GitHub Action workflows.

---

## 👤 Developer & Socials

Designed and developed by **Gearberry** — available for custom ecosystem architecture and high-performance web development.

- [Telegram](https://t.me/Gearberry) | [YouTube](https://www.youtube.com/@Gearberry) | [Instagram](https://www.instagram.com/gearberry_) | [Facebook](https://www.facebook.com/profile.php?id=61586878866628) | [Threads](https://www.threads.com/@gearberry_)

[![Rehina Nanaka profile views](https://u8views.com/api/v1/github/profiles/212413806/views/day-week-month-total-count.svg)](https://u8views.com/github/reginanka)
