/**
 * Day-scoped weather baseline helpers.
 *
 * One source of truth per calendar day (YYYY-MM-DD):
 *   eveningState.days[date] = {
 *     asOf: Date,                 // when THIS day was last written/merged
 *     min_temp: Number,
 *     max_temp: Number,
 *     hourlyPrecip: [{ time, precip, prob? }]
 *   }
 *
 * Alert comparison logic is unchanged — only storage / "станом на" attribution.
 * Legacy fields (forecast[], hourlyPrecip[], updatedAt, hourlyPrecipUpdatedAt)
 * are still written for compatibility and for multi-day forecast messages.
 */

const { getLocalDateStr } = require('./helpers');

const dayKey = (d) => String(d?.valid_date || d?.datetime || '').slice(0, 10);

/**
 * Local YYYY-MM-DD for an arbitrary Date in a timezone.
 */
const dateToLocalYmd = (date, timezone = 'Europe/Kyiv') => {
    if (!date) return null;
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).formatToParts(new Date(date));
        const y = parts.find(p => p.type === 'year')?.value;
        const m = parts.find(p => p.type === 'month')?.value;
        const d = parts.find(p => p.type === 'day')?.value;
        if (!y || !m || !d) return null;
        return `${y}-${m}-${d}`;
    } catch {
        return null;
    }
};

/**
 * Read baseline for a calendar day.
 * Prefers eveningState.days[date]; migrates from legacy fields if missing.
 */
const getDayBaseline = (evening, dateStr, timezone = 'Europe/Kyiv') => {
    if (!evening || !dateStr) return null;

    const fromDays = evening.days?.[dateStr];
    if (fromDays && (fromDays.min_temp != null || fromDays.max_temp != null || (fromDays.hourlyPrecip && fromDays.hourlyPrecip.length))) {
        return {
            asOf: fromDays.asOf || null,
            min_temp: fromDays.min_temp,
            max_temp: fromDays.max_temp,
            hourlyPrecip: Array.isArray(fromDays.hourlyPrecip) ? fromDays.hourlyPrecip : []
        };
    }

    // --- Legacy migration (read-only view) ---
    const daily = (evening.forecast || []).find(d => dayKey(d) === dateStr) || null;
    const hourly = (evening.hourlyPrecip || []).filter(o => o?.time && String(o.time).startsWith(dateStr));

    // Prefer hourlyPrecipUpdatedAt only if it falls on the same local calendar day
    let asOf = evening.updatedAt || null;
    if (evening.hourlyPrecipUpdatedAt) {
        const hpuDay = dateToLocalYmd(evening.hourlyPrecipUpdatedAt, timezone);
        if (hpuDay === dateStr) asOf = evening.hourlyPrecipUpdatedAt;
    }

    if (!daily && hourly.length === 0) return null;

    return {
        asOf,
        min_temp: daily?.min_temp,
        max_temp: daily?.max_temp,
        hourlyPrecip: hourly,
        _legacy: true
    };
};

/**
 * Build $set paths for one day slice. Does not wipe other days.
 * `patch` may contain: asOf, min_temp, max_temp, hourlyPrecip
 */
const daySetPaths = (dateStr, patch) => {
    const set = {};
    if (!dateStr || !patch) return set;
    if (patch.asOf !== undefined) set[`eveningState.days.${dateStr}.asOf`] = patch.asOf;
    if (patch.min_temp !== undefined) set[`eveningState.days.${dateStr}.min_temp`] = patch.min_temp;
    if (patch.max_temp !== undefined) set[`eveningState.days.${dateStr}.max_temp`] = patch.max_temp;
    if (patch.hourlyPrecip !== undefined) set[`eveningState.days.${dateStr}.hourlyPrecip`] = patch.hourlyPrecip;
    return set;
};

/**
 * Drop day keys older than keepFromStr (YYYY-MM-DD inclusive).
 * Returns $unset paths object (or empty).
 */
const pruneDaysUnset = (evening, keepFromStr) => {
    const days = evening?.days;
    if (!days || typeof days !== 'object') return {};
    const unset = {};
    for (const k of Object.keys(days)) {
        if (k < keepFromStr) unset[`eveningState.days.${k}`] = 1;
    }
    return unset;
};

/**
 * Merge hourly entries for one date into a flat multi-day array (legacy shape).
 * Keeps other days; replaces hours that start with dateStr.
 */
const mergeHourlyFlat = (existingArr, dateStr, newHoursForDate, keepFromStr) => {
    const byKey = {};
    for (const o of existingArr || []) {
        if (!o?.time) continue;
        const d = String(o.time).slice(0, 10);
        // Drop previous hours for dateStr — they are fully replaced by newHoursForDate
        if (d >= keepFromStr && d !== dateStr) byKey[o.time] = o;
    }
    for (const o of newHoursForDate || []) {
        if (!o?.time) continue;
        byKey[o.time] = o;
    }
    return Object.keys(byKey)
        .filter(t => t.slice(0, 10) >= keepFromStr)
        .sort()
        .map(time => {
            const o = byKey[time];
            const row = { time, precip: o.precip || 0 };
            if (o.prob != null) row.prob = o.prob;
            return row;
        });
};

module.exports = {
    dayKey,
    dateToLocalYmd,
    getDayBaseline,
    daySetPaths,
    pruneDaysUnset,
    mergeHourlyFlat,
    getLocalDateStr
};
