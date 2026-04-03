# ☂️ Parasol Sentinel: Weather Intelligence Ecosystem

**Parasol Sentinel** is a high-performance weather monitoring solution designed to showcase scalable architecture using Node.js, Vercel Serverless, and MongoDB. This ecosystem features a proactive Telegram bot and a stunning glassmorphism dashboard, demonstrating expert-level integration of real-time data streaming and cost-optimized API management.

---

## 🌟 Key Features & Business Value

### 🚀 1. Hybrid Intelligence Engine (Cost-Optimized)
Most weather services are expensive. Parasol Sentinel implements a **Hybrid Data Layer** to stay 100% within free tiers while providing premium data:
- **Weatherbit API**: Used for ultra-accurate current conditions and 7-day daily forecasts.
- **Open-Meteo API**: Integrated as a high-performance fallback and for granular hourly analytics (visualized in Chart.js).
- **Smart Data Normalization**: A centralized logic layer converts diverse API responses into a unified data format.

### 🔔 2. Proactive Monitoring Ecosystem
Unlike passive bots that only respond to user commands, Parasol is **proactive**:
- **Smart Shift Detection**: Automated cron-based analysis detects temperature shifts (≥5°C) or sudden precipitation threats and alerts users immediately.
- **Daily Executive Forecasts**: Users receive a condensed 3-day forecast every evening (Kyiv time) via automated GitHub Action workflows.

### 🔋 3. Scalable Serverless Infrastructure
- **Vercel-native Architecture**: Tailored for zero-downtime, sub-second execution using isolated serverless functions.
- **Smart Caching Layer**: Implemented a 120-minute time-aware caching system in **MongoDB** to minimize redundant external API calls and maximize performance.
- **Cryptographic Data Protection**: Implemented HMAC-based URL signatures to ensure that private per-user dashboards are only accessible via authenticated Telegram links, preventing unauthorized data scraping.
- **Throttling Engine**: Built-in rate limiting (`sleep(40)`) ensures reliable delivery even for a large subscriber base, respecting Telegram's API boundaries.

### 🌐 4. Premium Glassmorphism Dashboard
- **Visual Analytics**: Interactive data visualization using **Chart.js** for temperature, wind, and precipitation trends.
- **Ultra-Lightweight**: Vanilla JS (ES6+) implementation with zero framework overhead, ensuring Lighthouse scores of 95+.
- **Internationalization (UK/EN)**: Full bilingual support across the entire ecosystem, including automatic detection and personalized notifications in the user's preferred language.

---

## 🛠 Tech Stack

- **Backend**: Node.js (Vercel Serverless), Mongoose (ODM).
- **Frontend**: Vanilla HTML5/CSS3 (Modern Glassmorphism), Chart.js, Leaflet.
- **Ops**: GitHub Actions (Cron orchestration), MongoDB Atlas (Cloud Database).

## 📁 Architecture Overview

- `/api`: Serverless endpoints (Webhook, Hybrid Data Service, Cron Jobs).
- `/models`: Mongoose schemas with indexing for optimized querying.
- `/public`: Frontend assets optimized for minimal TTFB (Time to First Byte).
- `/utils`: Centralized helpers for URL formatting, weather transformation, and DB persistence.
- `.github/workflows`: Scheduled GitHub Actions orchestrating the ecosystem.

## 🚀 Deployment Guide

1. **Environment Config**:
   - Copy `.env.example` to `.env`.
   - Required: `TG_TOKEN`, `MONGO_URI`, `WEATHERBIT_KEY`, `DOMAIN`.
   - Required: `CRON_SECRET` (Random string for cron security and user dashboard hashing).
2. **Local Development**:
   - `npm install` && `npm start` (bot logic).
3. **Vercel Deployment**:
   - Project is pre-configured. Push to main to trigger the build.
   - Set GitHub Secrets for `DOMAIN` and `CRON_SECRET` to enable automated workflows.

---
Designed and developed by **Gearberry** — available for custom ecosystem architecture and high-performance web development.
