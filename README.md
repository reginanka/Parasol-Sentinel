# Parasol Sentinel ☂️

**Parasol Sentinel** is a premium weather monitoring ecosystem consisting of a smart Telegram bot and a high-performance web dashboard. It's designed to provide real-time weather alerts and sophisticated data visualization.

---

## 🌟 Key Features

- **Smart Telegram Monitoring**: Bot alerts you to sudden temperature changes (>=5°C) or incoming rain/snow.
- **Premium Web Dashboard**: A glassmorphism-styled interface with interactive charts (Temp, Wind, Pressure, etc.).
- **Automated Weather Alerts**: Cron-based monitoring that checks conditions periodically.
- **Evening Forecasts**: Automated daily summaries sent directly to your Telegram.
- **Hyper-Local Data**: Powered by Weatherbit API for high-precision weather metrics.
- **Dark-Mode Aethetics**: Deep midnight themes with weather-responsive color shifting.

## 🛠 Tech Stack

- **Frontend**: Vanilla JS, HTML5, CSS3 (Glassmorphism), Chart.js.
- **Backend**: Node.js, Vercel Serverless Functions.
- **Database**: MongoDB (Mongoose) for user state and data caching.
- **Telegram Logic**: Telegraf.js framework.
- **Deployment**: Optimized for Vercel.

## 🚀 Getting Started

1. **Clone the repository.**
2. **Install dependencies**: `npm install`
3. **Configure Environment Variables**:
   - Create a `.env` file based on `.env.example`.
   - Provide `TG_TOKEN`, `MONGO_URI`, `WEATHERBIT_KEY`, and `DOMAIN`.
4. **Run locally**: `npm start` (for the bot).
5. **Deploy to Vercel**: Connect your GitHub repo to Vercel for automatic deployment of serverless API and frontend.

---
Developed by **Gearberry**
