# ☂️ Parasol Sentinel: Advanced Weather Intelligence Ecosystem

**Parasol Sentinel** is a high-performance weather monitoring solution designed to showcase scalable architecture using Node.js, Vercel Serverless, and MongoDB. This ecosystem features a proactive Telegram bot and a stunning glassmorphism dashboard, demonstrating expert-level integration of real-time data streaming and cost-optimized API management.

<p align="center">
  <img src="preview1.png" width="800" alt="Parasol Sentinel Dashboard Preview">
</p>

---

## 🌟 Key Features & Latest Updates

### 🚀 1. Hybrid Intelligence Engine 2.0 (Cost-Optimized)
Most weather services are expensive. Parasol Sentinel implements a **Hybrid Data Layer** to stay 100% within free tiers while providing premium, low-latency data:
- **Weatherbit API (Core)**: Used for ultra-accurate current conditions and 7-day daily forecasts.
- **Open-Meteo API (Utility)**: Integrated as a high-performance fallback and for granular hourly analytics (visualized in Chart.js).
- **Smart Data Normalization**: A centralized logic layer converts diverse API responses into a unified, lightweight data format.
- **Smart Caching Layer**: Implemented a 120-minute time-aware caching system in **MongoDB** to minimize redundant external API calls and maximize performance.

### 🔔 2. Proactive Monitoring & Smart Alerts
Unlike passive bots that only respond to user commands, Parasol is **proactive**:
- **Smart Shift Detection**: Automated cron-based analysis detects significant temperature shifts (≥5°C) or sudden precipitation threats and alerts users immediately.
- **Comparison Engine**: Compares current conditions with the previous evening's state to provide context for "yesterday vs. today" alerts.
- **Daily Executive Forecasts**: Users receive a condensed 3-day forecast every evening via automated GitHub Action workflows.

### ⚙️ 3. Personalized Unit Synchronization (**New!**)
Full customization of how you see the weather, with instant synchronization between the bot and the dashboard:
- **Temperature**: Toggle between **Celsius (°C)** and **Fahrenheit (°F)**.
- **Wind Speed**: Choose between **m/s** and **km/h**.
- **Atmospheric Pressure**: Support for **mmHg** and **hPa**.
- **Unified Preferences**: Settings adjusted in the Telegram Bot are instantly reflected in the WebApp dashboard and vice versa.

### 🛡️ 4. Enterprise-Grade Security & Performance
- **Cryptographic Protection**: Implemented HMAC-based URL signatures to ensure that private per-user dashboards are only accessible via authenticated Telegram links.
- **Telegram WebApp Integration**: Direct settings management within the dashboard using `initData` validation for secure, seamless interaction.
- **Vercel-native Architecture**: Tailored for zero-downtime, sub-second execution using isolated serverless functions.
- **Lighthouse Optimized**: Vanilla JS (ES6+) implementation with zero framework overhead, ensuring Lighthouse scores of 95+.

### 🌐 5. Premium Multilingual UI (UK/EN)
- **Visual Analytics**: Interactive data visualization using **Chart.js** for temperature, wind, and precipitation trends.
- **Native Localization**: Full bilingual support (Ukrainian & English) across the entire ecosystem, including automatic detection and personalized notifications.

---

## 🛠 Tech Stack

- **Backend**: Node.js (Vercel Serverless), Mongoose (ODM).
- **Frontend**: Vanilla HTML5/CSS3 (Modern Glassmorphism), Chart.js, Leaflet.
- **Database**: MongoDB Atlas (Cloud Database).
- **Operations**: GitHub Actions (Cron orchestration & Automated deployments).

## 📁 Architecture Overview

- `/api`: Serverless endpoints (Webhook, Hybrid Data Service, Settings API, Cron Jobs).
- `/models`: Mongoose schemas with unit preference support and indexing.
- `/public`: Frontend assets optimized for minimal TTFB (Time to First Byte).
- `/utils`: Centralized helpers for signature generation, weather transformation, and validation.
- `.github/workflows`: Scheduled GitHub Actions orchestrating the daily alerts and environment synchronization.

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
