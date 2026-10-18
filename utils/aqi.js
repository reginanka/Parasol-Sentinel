/**
 * Unified AQI scale helpers for Parasol Sentinel.
 *
 * Rules (same everywhere — alerts, evening forecast, dashboard snap):
 * - WAQI station (≤10 km): US-style AQI, thresholds 50 / 100 / 150
 * - Open-Meteo CAMS: prefer EAQI, thresholds 40 / 60 / 80; fallback US AQI
 *
 * Tier 0 🟢 good · 1 🟡 moderate · 2 🟠 poor · 3 🔴 very poor
 */

const BADGES = ['🟢', '🟡', '🟠', '🔴'];

/** US / WAQI breakpoints */
function tierFromUsAqi(v) {
    if (v == null || Number.isNaN(Number(v))) return 0;
    const n = Number(v);
    if (n > 150) return 3;
    if (n > 100) return 2;
    if (n > 50) return 1;
    return 0;
}

/** European AQI (Open-Meteo european_aqi) breakpoints — aligned with cron-forecast */
function tierFromEaqi(v) {
    if (v == null || Number.isNaN(Number(v))) return 0;
    const n = Number(v);
    if (n > 80) return 3;
    if (n > 60) return 2;
    if (n > 40) return 1;
    return 0;
}

function badgeFromTier(tier) {
    return BADGES[Math.max(0, Math.min(3, tier | 0))] || '🟢';
}

function badgeFromUsAqi(v) {
    return badgeFromTier(tierFromUsAqi(v));
}

function badgeFromEaqi(v) {
    return badgeFromTier(tierFromEaqi(v));
}

/**
 * Pick primary index + tier for decision-making and display.
 * @param {{ eaqi?: number|null, usAqi?: number|null, waqiAqi?: number|null, provider?: string }} opts
 * @returns {{ aqiVal: number|null, displayAqi: number|null, aqiLabel: string, scale: 'eaqi'|'us'|null, tier: number, badge: string }}
 */
function resolveAqiPrimary(opts = {}) {
    const { eaqi = null, usAqi = null, waqiAqi = null, provider = null } = opts;

    // Nearby WAQI station → always US-style AQI from that station
    if (provider === 'waqi' && waqiAqi != null && !Number.isNaN(Number(waqiAqi))) {
        const n = Number(waqiAqi);
        const tier = tierFromUsAqi(n);
        return {
            aqiVal: n,
            displayAqi: Math.round(n),
            aqiLabel: 'AQI',
            scale: 'us',
            tier,
            badge: badgeFromTier(tier)
        };
    }

    // Open-Meteo (or unknown): prefer EAQI
    if (eaqi != null && !Number.isNaN(Number(eaqi))) {
        const n = Number(eaqi);
        const tier = tierFromEaqi(n);
        return {
            aqiVal: n,
            displayAqi: Math.round(n),
            aqiLabel: 'EAQI',
            scale: 'eaqi',
            tier,
            badge: badgeFromTier(tier)
        };
    }

    if (usAqi != null && !Number.isNaN(Number(usAqi))) {
        const n = Number(usAqi);
        const tier = tierFromUsAqi(n);
        return {
            aqiVal: n,
            displayAqi: Math.round(n),
            aqiLabel: 'US AQI',
            scale: 'us',
            tier,
            badge: badgeFromTier(tier)
        };
    }

    return {
        aqiVal: null,
        displayAqi: null,
        aqiLabel: 'AQI',
        scale: null,
        tier: 0,
        badge: '🟢'
    };
}

/**
 * Advice tier text thresholds — same as resolveAqiPrimary scale.
 * Returns 0–3 for advice blocks.
 */
function adviceTier(aqiVal, scale) {
    if (aqiVal == null) return 0;
    return scale === 'eaqi' ? tierFromEaqi(aqiVal) : tierFromUsAqi(aqiVal);
}

module.exports = {
    tierFromUsAqi,
    tierFromEaqi,
    badgeFromTier,
    badgeFromUsAqi,
    badgeFromEaqi,
    resolveAqiPrimary,
    adviceTier
};
