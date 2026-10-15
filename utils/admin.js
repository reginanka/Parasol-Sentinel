/**
 * Admin panel helpers for Parasol Sentinel.
 *
 * Modes:
 * 1) Classic: ADMIN_CHAT_ID = private channel (no topics)
 * 2) Forum supergroup:
 *    ADMIN_CHAT_ID = -100…
 *    TOPIC_GENERAL = 1     → меню / кнопки
 *    TOPIC_LOGS    = 123   → cron-логи (logger.js)
 *    TOPIC_USERS   = 456   → лише текст юзера (повідомлення → відповідь бота)
 *    TOPIC_ACTIONS = 789   → кліки / вибір / callback юзера (ACTIONS_USERS)
 *    ERROR_ID / TOPIC_ERRORS → лише помилки (окрема гілка)
 *    TOPIC_HISTORY / HISTORY_MSG_ID → журнал вихідних і розмов
 */

const User = require('../models/User');
const ErrorLog = require('../models/ErrorLog');
const getBot = require('./bot');
const { CROPS_DATA } = require('./crops');

const ADMIN_CHAT_ID = () => process.env.ADMIN_CHAT_ID || null;

function isAdminChat(chatId) {
    const id = ADMIN_CHAT_ID();
    if (!id || chatId == null) return false;
    // Normalize: "-100123" vs -100123, ignore whitespace
    return String(chatId).trim() === String(id).trim();
}

/** Forum topic id from env: TOPIC_GENERAL / TOPIC_LOGS / TOPIC_USERS / TOPIC_ACTIONS / TOPIC_HISTORY
 *  HISTORY also accepts HISTORY_MSG_ID (Vercel secret alias).
 *  ERRORS also accepts ERROR_ID / TOPIC_ERRORS.
 *  ACTIONS also accepts TOPIC_ACTIONS_USERS / ACTIONS_USERS.
 */
function topicId(name) {
    const upper = String(name).toUpperCase();
    const keys = [`TOPIC_${upper}`];
    if (upper === 'HISTORY') {
        keys.push('HISTORY_MSG_ID', 'History_msg_ID', 'HISTORY_TOPIC_ID');
    }
    if (upper === 'ERRORS' || upper === 'ERROR') {
        keys.push('ERROR_ID', 'TOPIC_ERRORS', 'ERRORS_ID');
    }
    if (upper === 'ACTIONS') {
        keys.push('TOPIC_ACTIONS_USERS', 'ACTIONS_USERS');
    }
    for (const key of keys) {
        const raw = process.env[key];
        if (raw == null || raw === '') continue;
        const n = Number(raw);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

/** Options with message_thread_id when topic is configured */
function threadOpts(topicName) {
    const id = topicId(topicName);
    return id != null ? { message_thread_id: id } : {};
}

/**
 * Thread for admin UI replies: stay in the topic where the button was pressed.
 * General often omits message_thread_id — fall back to TOPIC_GENERAL, never USERS.
 */
function adminThreadFromCtx(ctx) {
    const mid =
        ctx?.callbackQuery?.message?.message_thread_id ??
        ctx?.message?.message_thread_id ??
        null;
    if (mid != null && mid !== undefined) {
        return { message_thread_id: Number(mid) };
    }
    const gen = topicId('GENERAL');
    if (gen != null) return { message_thread_id: gen };
    return {};
}


function displayName(from) {
    if (!from) return 'unknown';
    const parts = [from.first_name, from.last_name].filter(Boolean).join(' ');
    const uname = from.username ? `@${from.username}` : '';
    return (parts || uname || `id${from.id}`).trim();
}

function accessLabel(level) {
    if (level === 'none') return 'Немає доступу';
    if (level === 'unlimited') return 'Безліміт';
    return level || 'Безліміт';
}

/**
 * Format one user line (plain HTML fallback / access updates).
 */
function formatUserLine(u) {
    const name = u.username
        ? u.username
        : [u.firstName, u.lastName].filter(Boolean).join(' ') || `user_${u.telegramId}`;
    const lang = u.language || u.languageCode || '—';
    const access = accessLabel(u.accessLevel || 'unlimited');
    const geo = u.city
        ? `${u.city}${u.lat != null ? ` (${Number(u.lat).toFixed(2)}, ${Number(u.lon).toFixed(2)})` : ''}`
        : 'Місто не обрано';
    const usage = u.usage || {};
    const eveningM = usage.eveningThisMonth || 0;
    const alertsM = usage.alertsThisMonth || 0;
    const total = (usage.eveningTotal || 0) + (usage.alertsTotal || 0);

    return (
        `<b>${escapeHtml(name)}</b> — ID: <code>${u.telegramId}</code> — Мова: ${escapeHtml(lang)} — ` +
        `<b>${access}</b> | ${escapeHtml(geo)} | ` +
        `Цього міс: ${eveningM} вечірніх прогнозів | ${alertsM} алертів | Всього: ${total}`
    );
}

/** One table row for user list / active list (Rich Message). */
function formatUserRow(u) {
    const name = u.username
        ? `@${u.username}`
        : [u.firstName, u.lastName].filter(Boolean).join(' ') || '—';
    const lang = u.language || u.languageCode || '—';
    const access = accessLabel(u.accessLevel || 'unlimited');
    const city = u.city || '—';
    // Separate cells — long-press in Telegram to copy
    const idCell = String(u.telegramId);
    const geoCell =
        u.lat != null && u.lon != null
            ? `${Number(u.lat).toFixed(5)}, ${Number(u.lon).toFixed(5)}`
            : '—';
    const usage = u.usage || {};
    const eveningM = usage.eveningThisMonth || 0;
    const alertsM = usage.alertsThisMonth || 0;
    return (
        `<tr>` +
        `<td align="left">${escapeHtml(name)}</td>` +
        `<td align="left"><code>${idCell}</code></td>` +
        `<td align="center">${escapeHtml(lang)}</td>` +
        `<td align="left">${escapeHtml(access)}</td>` +
        `<td align="left">${escapeHtml(city)}</td>` +
        `<td align="left"><code>${geoCell}</code></td>` +
        `<td align="center">${eveningM}</td>` +
        `<td align="center">${alertsM}</td>` +
        `</tr>`
    );
}

/** Build users table HTML (Rich Message). */
function usersTableHtml(title, users, totalHint) {
    const rows = users.map(formatUserRow).join('\n');
    const hint = totalHint
        ? `<p><i>${escapeHtml(totalHint)}</i><br/>Натисни й тримай ID або гео — скопіювати</p>`
        : `<p><i>Натисни й тримай ID або гео — скопіювати</i></p>`;
    return `
<h1>${title}</h1>
${hint}
<table bordered striped>
  <thead>
    <tr>
      <th align="left">Ім'я</th>
      <th align="left">ID</th>
      <th align="center">Мова</th>
      <th align="left">Доступ</th>
      <th align="left">Місто</th>
      <th align="left">Гео</th>
      <th align="center">Веч.</th>
      <th align="center">Алерт</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
</table>
`.trim();
}

async function sendUsersRich(api, chatId, title, users, totalHint) {
    const html = usersTableHtml(title, users, totalHint);
    try {
        await api.sendRichMessage(chatId, { html, skip_entity_detection: true });
    } catch (e) {
        console.warn('[admin] users sendRichMessage failed:', e.message);
        const body = users.map(formatUserLine).join('\n———————————————\n');
        await api.sendMessage(chatId, `<b>${escapeHtml(title)}</b>\n\n${body}`, { parse_mode: 'HTML' });
    }
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** Inline keyboard for admin panel */
function adminKeyboard() {
    return {
        inline_keyboard: [
            [
                { text: '📋 Список користувачів', callback_data: 'adm|list' },
                { text: '🟢 Активні', callback_data: 'adm|active' }
            ],
            [
                { text: '🔑 Змінити доступ', callback_data: 'adm|access' },
                { text: '📊 Аналітика', callback_data: 'adm|stats' }
            ],
            [
                { text: '🌆 Розсилка вечір. прогнозу', callback_data: 'adm|broadcast_evening' },
                { text: '🧪 Вечірній тест', callback_data: 'adm|evening_test' }
            ],
            [
                { text: '🎯 Вечірній крон обраним', callback_data: 'adm|evening_one' },
                { text: '🔍 Крон чек', callback_data: 'adm|cron_check' }
            ],
            [
                { text: '✉️ Написати користувачу', callback_data: 'adm|msg_user' },
                { text: '🔄 Оновити меню', callback_data: 'adm|menu' }
            ]
        ]
    };
}

function fmtUaDate(d) {
    if (!d) return '—';
    try {
        return new Date(d).toLocaleString('uk-UA', {
            timeZone: 'Europe/Kyiv',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch {
        return '—';
    }
}

/** Full user profile as Rich Message HTML (tables). */

/** Crop ids → Ukrainian labels from CROPS_DATA */
function formatCropsUa(crops) {
    if (!Array.isArray(crops) || crops.length === 0) return '—';
    const map = {};
    try {
        for (const cat of Object.values(CROPS_DATA || {})) {
            const items = cat && cat.items;
            if (!items) continue;
            for (const [id, labels] of Object.entries(items)) {
                map[id] = (labels && (labels.uk || labels.en)) || id;
            }
        }
    } catch (_) { /* ignore */ }
    const names = crops.map((raw) => {
        const id = String(raw || '').includes('|')
            ? String(raw).split('|').pop()
            : String(raw);
        return map[id] || id;
    });
    return `${names.length} — ${names.join(', ')}`;
}

const GEOMAG_UA = {
    quiet: 'тихий',
    active: 'активний',
    off: 'вимк'
};

function buildUserInfoHtml(u, from = null) {
    const tgId = u?.telegramId || from?.id || '—';
    const name =
        (from && displayName(from)) ||
        (u?.username ? u.username : null) ||
        [u?.firstName, u?.lastName].filter(Boolean).join(' ') ||
        `user_${tgId}`;
    const uname = u?.username
        ? `@${u.username}`
        : from?.username
          ? `@${from.username}`
          : 'без @username';
    const tgLang = from?.language_code || u?.languageCode || '—';
    const access = accessLabel(u?.accessLevel || 'unlimited');
    const accessIcon = (u?.accessLevel || 'unlimited') === 'none' ? '🚫' : '✅';
    const botLang = u?.language || tgLang || '—';
    const city = u?.city || 'не обрано';
    const geo =
        u?.lat != null && u?.lon != null
            ? `${Number(u.lat).toFixed(5)}, ${Number(u.lon).toFixed(5)}`
            : '—';
    const tz = u?.timezone || '—';
    const usage = u?.usage || {};
    const eveningM = usage.eveningThisMonth || 0;
    const alertsM = usage.alertsThisMonth || 0;
    const eveningT = usage.eveningTotal || 0;
    const alertsT = usage.alertsTotal || 0;
    const notif = u?.notificationsEnabled === false ? '🔕 вимк' : '🔔 увімк';
    const evening = u?.eveningForecastEnabled === false ? '🌆 вимк' : '🌆 увімк';
    const geomagMode = u?.geomagMode || 'quiet';
    const geomag = GEOMAG_UA[geomagMode] || geomagMode;
    const cropsLabel = formatCropsUa(u?.crops);
    const temp = u?.lastState?.temp != null ? `${Math.round(u.lastState.temp)}°C` : '—';

    // Evening forecast metrics (UA labels)
    const enabledMetrics = Array.isArray(u?.forecastSettings?.enabledMetrics)
        ? u.forecastSettings.enabledMetrics
        : [];
    const metricsLabel = enabledMetrics.length
        ? enabledMetrics.map((k) => METRIC_NAMES_UA[k] || k).join(', ')
        : '—';
    const daysCount = u?.forecastSettings?.daysCount != null ? u.forecastSettings.daysCount : '—';

    // Alert triggers — for magnetic storms show geomag mode, not just on/off
    const triggers = u?.alertTriggers || {};
    const chk = (on) => (on ? '✅' : '⬜️');
    const alertTemp = triggers.temperature !== false;
    const alertPrecip = triggers.precip !== false;
    const alertAir = triggers.airQuality !== false;
    // magneticStorm false / geomag off → вимк; else show mode (тихий / активний)
    let alertGeomagLabel;
    if (geomagMode === 'off' || triggers.magneticStorm === false) {
        alertGeomagLabel = `${chk(false)} вимк`;
    } else {
        alertGeomagLabel = `${chk(true)} ${geomag}`;
    }
    const alertsLabel = [
        `${chk(alertTemp)} температура`,
        `${chk(alertPrecip)} опади`,
        `${chk(alertAir)} якість повітря`,
        `${alertGeomagLabel} · магнітні бурі`
    ].join('<br/>');

    return `
<h1>👤 ${escapeHtml(name)}</h1>
<p>${escapeHtml(uname)} · ID: <code>${tgId}</code></p>
<table bordered striped>
  <thead>
    <tr><th align="left">Поле</th><th align="left">Значення</th></tr>
  </thead>
  <tbody>
    <tr><td align="left">Доступ</td><td align="left">${accessIcon} ${escapeHtml(access)}</td></tr>
    <tr><td align="left">Мова TG / бот</td><td align="left"><code>${escapeHtml(tgLang)}</code> / <code>${escapeHtml(botLang)}</code></td></tr>
    <tr><td align="left">Місто</td><td align="left">${escapeHtml(city)}</td></tr>
    <tr><td align="left">Гео</td><td align="left"><code>${geo}</code></td></tr>
    <tr><td align="left">TZ</td><td align="left"><code>${escapeHtml(tz)}</code></td></tr>
    <tr><td align="left">Темп. зараз</td><td align="left"><b>${temp}</b></td></tr>
    <tr><td align="left">Сповіщення</td><td align="left">${notif}</td></tr>
    <tr><td align="left">Вечірній</td><td align="left">${evening} · ${daysCount} дн.</td></tr>
    <tr><td align="left">Культури</td><td align="left">${escapeHtml(cropsLabel)}</td></tr>
    <tr><td align="left">Метрики вечірнього</td><td align="left">${escapeHtml(metricsLabel)}</td></tr>
    <tr><td align="left">Алерти</td><td align="left">${alertsLabel}</td></tr>
  </tbody>
</table>
<h3>📬 Доставка</h3>
<table bordered striped>
  <thead>
    <tr><th align="left">Показник</th><th align="center">Місяць</th><th align="center">Всього</th></tr>
  </thead>
  <tbody>
    <tr><td align="left">🌆 Вечірні</td><td align="center"><b>${eveningM}</b></td><td align="center"><b>${eveningT}</b></td></tr>
    <tr><td align="left">🚨 Алерти</td><td align="center"><b>${alertsM}</b></td><td align="center"><b>${alertsT}</b></td></tr>
    <tr><td align="left">Разом</td><td align="center"><b>${eveningM + alertsM}</b></td><td align="center"><b>${eveningT + alertsT}</b></td></tr>
  </tbody>
</table>
<table bordered striped>
  <thead>
    <tr><th align="left">Дата</th><th align="left">Значення</th></tr>
  </thead>
  <tbody>
    <tr><td align="left">📅 Реєстрація</td><td align="left">${escapeHtml(fmtUaDate(u?.createdAt))}</td></tr>
    <tr><td align="left">🕐 Остання активність</td><td align="left">${escapeHtml(fmtUaDate(u?.lastActivityAt))}</td></tr>
  </tbody>
</table>
`.trim();
}

/**
 * Notify admin about a user action — short card + button «Інфо».
 * Reply to this message → send text/media to the user (ID: in text).
 */
/** Назви метрик для людських описів у notify */
const METRIC_NAMES_UA = {
    condition: 'стан неба',
    temp: 'температура',
    precip: 'опади',
    wind: 'вітер',
    pressure: 'тиск',
    dew: 'точка роси',
    uv: 'УФ-індекс',
    visibility: 'видимість',
    soil0: 'ґрунт 0 см',
    soil6: 'ґрунт 6 см',
    moon: 'місяць',
    sun: 'сонце',
    aqi_now: 'AQI зараз',
    aqi_main: 'AQI основний',
    aqi_ext: 'AQI розширений',
    aqi: 'якість повітря',
    geomag: 'магнітні бурі'
};

/**
 * Людський опис дії користувача для адмін-нотифікацій.
 * userSnapshot — стан ДО обробки callback (notify викликається раніше toggle).
 */
function describeUserAction(actionText, extra = {}, userSnapshot = null) {
    const rawAct = String(actionText || '').trim();
    if (rawAct.startsWith('меню:')) {
        return rawAct; // already human uk label from bot.js
    }
    if (rawAct === 'меню') return 'натиснув пункт меню';

    const cb = String(extra.callbackData || '').trim();
    const parts = cb ? cb.split('|') : [];
    const head = parts[0] || '';
    const u = userSnapshot;

    const helpTopics = {
        uv: 'УФ-індекс',
        wind: 'вітер',
        press: 'тиск',
        hum: 'вологість',
        precip: 'опади',
        dew: 'точка роси',
        feels: 'відчувається як',
        cloud: 'хмарність',
        soil0: 'ґрунт 0 см',
        soil6: 'ґрунт 6 см',
        geomag: 'магнітні бурі',
        how: 'як це працює'
    };

    const onOff = (willBeOn) => (willBeOn ? 'увімкнув' : 'вимкнув');

    // Explicit known actions without callback payload
    if (!cb) {
        if (actionText === '/start') return 'натиснув /start (старт бота)';
        if (actionText === 'текст' || actionText === 'text') {
            return 'надіслав текст (пошук міста або повідомлення)';
        }
        return String(actionText || 'невідома дія');
    }

    // City pick: set|lat|lon
    if (head === 'set' && parts.length >= 3) {
        return `обрав місто на карті (${parts[1]}, ${parts[2]})`;
    }

    // Toggles that need user state (notify is BEFORE DB update → invert current)
    if (cb === 'toggle_notifications') {
        const wasOn = u ? u.notificationsEnabled !== false : null;
        if (wasOn == null) return 'перемкнув усі сповіщення';
        return `${onOff(!wasOn)} усі сповіщення`;
    }
    if (cb === 'toggle_evening_forecast') {
        const wasOn = u ? u.eveningForecastEnabled !== false : null;
        if (wasOn == null) return 'перемкнув вечірній прогноз';
        return `${onOff(!wasOn)} вечірній прогноз`;
    }

    const map = {
        open_settings: 'відкрив загальні налаштування',
        open_help: 'відкрив допомогу',
        forecast_menu: 'відкрив налаштування вечірнього прогнозу',
        alert_settings: 'відкрив налаштування сповіщень',
        change_city: 'хоче змінити місто',
        delete_city: 'видалив місто',
        crops_main: 'відкрив меню культур',
        agro_forecast_menu: 'відкрив агро-прогноз',
        agro_archive_menu: 'відкрив агро-архів',
        agro_tomorrow: 'запросив агро-рекомендації на завтра',
        agro_schedule_only: 'запросив графік обробок',
        agro_5day: 'запросив 5-денний агро-прогноз',
        geomag_fc: 'відкрив прогноз магнітних бур',
        noop: 'натиснув службову кнопку (без дії)'
    };
    if (map[cb]) return map[cb];
    if (parts.length === 1 && map[head]) return map[head];

    if (head === 'forecast') {
        if (parts[1] === 'days' && parts[2]) {
            return `обрав ${parts[2]} дн. у вечірньому прогнозі`;
        }
        if (parts[1] === 'toggle' && parts[2]) {
            const key = parts[2];
            const m = METRIC_NAMES_UA[key] || key;
            let metrics = u?.forecastSettings?.enabledMetrics || [];
            if (metrics.includes('aqi') && ['aqi_now', 'aqi_main', 'aqi_ext'].includes(key)) {
                return `${onOff(false)} метрику «${m}» у вечірньому прогнозі`;
            }
            const wasOn = metrics.includes(key);
            if (u) return `${onOff(!wasOn)} метрику «${m}» у вечірньому прогнозі`;
            return `перемкнув метрику «${m}» у вечірньому прогнозі`;
        }
    }

    if (head === 'alert') {
        if (parts[1] === 'toggle_all' && parts[2] === 'on') return 'увімкнув усі алерти';
        if (parts[1] === 'toggle_all' && parts[2] === 'off') return 'вимкнув усі алерти';
        if (parts[1] === 'toggle' && parts[2]) {
            const names = {
                temperature: 'температура',
                precip: 'опади',
                airQuality: 'якість повітря',
                magneticStorm: 'магнітні бурі'
            };
            const key = parts[2];
            const label = names[key] || key;
            if (u?.alertTriggers && Object.prototype.hasOwnProperty.call(u.alertTriggers, key)) {
                const wasOn = u.alertTriggers[key] !== false;
                return `${onOff(!wasOn)} алерт «${label}»`;
            }
            return `перемкнув алерт «${label}»`;
        }
    }

    if (head === 'geomag_mode') {
        const modes = {
            active: 'активний (усі зміни)',
            quiet: 'тихий (лише сильніші за план)',
            off: 'вимкнено'
        };
        return `встановив режим магнітних бур: ${modes[parts[1]] || parts[1]}`;
    }

    if (head === 'unit') {
        if (parts[1] === 'wind') {
            return parts[2] === 'kmh' ? 'одиниці вітру: км/год' : 'одиниці вітру: м/с';
        }
        if (parts[1] === 'pressure') {
            return parts[2] === 'hpa' ? 'одиниці тиску: гПа' : 'одиниці тиску: мм рт. ст.';
        }
        if (parts[1] === 'temp') {
            return parts[2] === 'f' ? 'температура: °F' : 'температура: °C';
        }
    }

    if (head === 'help') {
        const t = helpTopics[parts[1]] || parts[1];
        return `читає довідку: ${t}`;
    }

    if (head === 'crops_cat') return `обрав категорію культур: ${parts[1] || '—'}`;
    if (head === 'crops_toggle') {
        const cropId = parts[2] || '?';
        const crops = Array.isArray(u?.crops) ? u.crops : [];
        const wasOn = crops.includes(cropId) || crops.includes(`${parts[1]}|${cropId}`);
        if (u) return `${onOff(!wasOn)} культуру «${cropId}»`;
        return `перемкнув культуру (${parts[1] || '?'}/${cropId})`;
    }

    if (head === 'archive') {
        const periods = {
            '7': '7 днів',
            '30': '30 днів',
            '180': '6 місяців',
            '365': 'рік',
            custom: 'своя дата',
            last_year: 'минулий рік'
        };
        return `агро-архів: ${periods[parts[1]] || parts[1]}`;
    }

    if (head === 'forecast_hourly') {
        return parts[1]
            ? `погодинний прогноз (Open-Meteo) на ${parts[1]}`
            : 'погодинний прогноз (Open-Meteo)';
    }
    if (head === 'forecast_verify') {
        return parts[1]
            ? `перевірка прогнозу (Tomorrow.io) на ${parts[1]}`
            : 'перевірка прогнозу (Tomorrow.io)';
    }

    // Fallback: human-ish without dumping only the word "callback"
    if (actionText === 'callback') {
        return `натиснув кнопку «${cb}»`;
    }
    return `${actionText}${cb ? ` (${cb})` : ''}`;
}

/**
 * Notify admin about a user action.
 * - Текст юзера (messageText / actionText === 'текст') → TOPIC_USERS
 * - Кліки / callback / /start тощо → TOPIC_ACTIONS (ACTIONS_USERS)
 * - Якщо send впав → дубль у TOPIC_ERRORS / ERROR_ID
 * Людський опис через describeUserAction (не сирий "callback").
 */
/**
 * Notify admin about a user action.
 * - Текст юзера → TOPIC_USERS (+ Rich details з хвостом переписки)
 * - Кліки / callback / /start → TOPIC_ACTIONS
 * - Якщо send впав → дубль у TOPIC_ERRORS / ERROR_ID
 */
async function notifyAdmin(from, actionText, extra = {}) {
    const chatId = ADMIN_CHAT_ID();
    if (!chatId || !from) return;

    // Don't echo admin channel activity
    if (extra.chatId && isAdminChat(extra.chatId)) return;

    const bot = getBot();
    const name = displayName(from);
    const uname = from.username ? `@${from.username}` : 'без @username';

    // Текст юзера → USERS; кліки → ACTIONS
    const isUserText =
        Boolean(extra.messageText) ||
        actionText === 'текст' ||
        actionText === 'text';

    // Snapshot: для callback (toggle state) і для хвоста переписки
    let userSnapshot = null;
    try {
        userSnapshot = await User.findOne({ telegramId: from.id }).lean();
    } catch (_) {
        /* ignore */
    }
    const humanAction = describeUserAction(actionText, extra, userSnapshot);

    // Хвіст переписки з supportHistory (для details)
    const DETAILS_LIMIT = 1800;
    let transcriptTail = '';
    const fullTranscript =
        (userSnapshot &&
            userSnapshot.supportHistory &&
            userSnapshot.supportHistory.transcript) ||
        '';
    // Для текстового notify — додамо поточне повідомлення, якщо його ще немає в transcript
    // (appendSupportConversation викликається після notify)
    let previewTranscript = fullTranscript;
    if (extra.messageText) {
        const curLine = formatSupportLine(
            '👤 Юзер',
            null,
            String(extra.messageText).slice(0, 500)
        );
        previewTranscript = fullTranscript
            ? `${fullTranscript}\n${curLine}`
            : curLine;
    }
    if (previewTranscript) {
        transcriptTail =
            previewTranscript.length > DETAILS_LIMIT
                ? '…\n' + previewTranscript.slice(previewTranscript.length - DETAILS_LIMIT)
                : previewTranscript;
    }

    // --- Plain HTML (sendMessage fallback) ---
    let text =
        `👤 <b>${escapeHtml(name)}</b>\n` +
        `${escapeHtml(uname)}\n` +
        `ID: <code>${from.id}</code> · #u${from.id}\n` +
        `⚡ Дія: ${escapeHtml(humanAction)}`;

    if (extra.messageText) {
        text += `\n\n💬 ${escapeHtml(String(extra.messageText).slice(0, 500))}`;
    }
    if (extra.callbackData && humanAction.includes(extra.callbackData)) {
        text += `\n🔘 <code>${escapeHtml(extra.callbackData)}</code>`;
    }
    if (transcriptTail && isUserText) {
        // у звичайному HTML details може не розгортатись — короткий прев'ю
        const short = transcriptTail.length > 400
            ? '…\n' + transcriptTail.slice(transcriptTail.length - 400)
            : transcriptTail;
        text += `\n\n💬 <i>Остання переписка:</i>\n<code>${escapeHtml(short)}</code>`;
    }
    text += `\n\n<i>↩️ Reply → надіслати юзеру</i>`;

    // --- Rich Message (details collapsible) ---
    let richHtml =
        `<p>👤 <b>${escapeHtml(name)}</b><br/>` +
        `${escapeHtml(uname)} · ID: <code>${from.id}</code> · #u${from.id}</p>` +
        `<p>⚡ <b>Дія:</b> ${escapeHtml(humanAction)}</p>`;
    if (extra.messageText) {
        richHtml += `<p>💬 ${escapeHtml(String(extra.messageText).slice(0, 500))}</p>`;
    }
    if (extra.callbackData && humanAction.includes(extra.callbackData)) {
        richHtml += `<p>🔘 <code>${escapeHtml(extra.callbackData)}</code></p>`;
    }
    if (transcriptTail && isUserText) {
        const lines = transcriptTail.split('\n').length;
        richHtml +=
            `<details>` +
            `<summary>💬 Остання переписка (${lines} рядків — натисни)</summary>` +
            `<pre>${escapeHtml(transcriptTail)}</pre>` +
            `</details>`;
    }
    richHtml += `<p><i>↩️ Reply → надіслати юзеру</i></p>`;

    const destThread = isUserText ? threadOpts('USERS') : threadOpts('ACTIONS');
    const thread =
        !isUserText && destThread.message_thread_id == null
            ? threadOpts('USERS')
            : destThread;

    const markup = {
        inline_keyboard: [
            [{ text: '👤 Інфо про користувача', callback_data: `adm|userinfo|${from.id}` }]
        ]
    };

        let sentOk = false;
    let sentMessageId = null;

    // 1) Rich Message — details розгортається тапом
    try {
        const sent = await bot.api.sendRichMessage(
            chatId,
            { html: richHtml, skip_entity_detection: true },
            { reply_markup: markup, ...thread }
        );
        sentMessageId = sent?.message_id ?? sent?.message?.message_id ?? sent?.result?.message_id ?? null;
        sentOk = true;
    } catch (richErr) {
        console.warn('[admin] notify sendRichMessage failed, HTML fallback:', richErr.message);
        try {
            const sent = await bot.api.sendMessage(chatId, text, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_markup: markup,
                ...thread
            });
            sentMessageId = sent?.message_id;
            sentOk = true;
        } catch (e) {
            console.error('[admin] notify sendMessage failed:', e.message);
            try {
                const sent = await bot.api.sendMessage(
                    chatId,
                    `👤 ${name}
ID: ${from.id} · #u${from.id}
Дія: ${humanAction}` +
                        (extra.messageText
                            ? `

${String(extra.messageText).slice(0, 500)}`
                            : ''),
                    { reply_markup: markup, ...thread }
                );
                sentMessageId = sent?.message_id;
                sentOk = true;
            } catch (e2) {
                console.error('[admin] notify fallback failed:', e2.message);
            }
        }
    }

    // Map message_id → user for reliable Reply (esp. Rich Message)
    if (sentOk && sentMessageId != null) {
        await rememberNotifyMessage(from.id, sentMessageId);
    }

    // Помилка відправки → пінг у гілку ERROR
    if (!sentOk) {
        const errThread = threadOpts('ERRORS');
        const errText =
            `🚨 <b>Notify failed</b>\n` +
            `👤 ${escapeHtml(name)} · <code>${from.id}</code>\n` +
            `Дія: ${escapeHtml(humanAction)}\n` +
            (extra.messageText
                ? `💬 ${escapeHtml(String(extra.messageText).slice(0, 300))}\n`
                : '') +
            `Гілка: ${isUserText ? 'USERS' : 'ACTIONS'}`;
        try {
            await bot.api.sendMessage(chatId, errText, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                ...errThread
            });
        } catch (e3) {
            console.error('[admin] error-topic notify failed:', e3.message);
        }
    }

    // Текст юзера → картка розмови в HISTORY
    if (extra.messageText) {
        try {
            await appendSupportConversation(
                bot.api,
                from.id,
                '👤 Юзер',
                String(extra.messageText)
            );
        } catch (e) {
            console.warn('[admin] support log from notify failed:', e.message);
        }
    }
}

/** Extract user telegram id from an admin notification / reply_to message */
/** Own bot id from TG_TOKEN (bots cannot message bots). */
function ownBotId() {
    const tok = process.env.TG_TOKEN || '';
    const m = String(tok).match(/^(\d+):/);
    return m ? Number(m[1]) : null;
}

/**
 * Extract user telegram id from an admin notification / reply_to message.
 * Prefer explicit markers (#u123, ID: 123). Never use reply.from (that is the bot).
 */
function extractUserIdFromNotifyText(raw) {
    if (raw == null) return null;

    // Only human-readable fields — avoid JSON.stringify(from.id of the bot)
    let s = '';
    if (typeof raw === 'object') {
        s = [raw.text, raw.caption, raw.quote?.text, raw.quote?.html]
            .filter(Boolean)
            .join('\n');
    } else {
        s = String(raw);
    }

    const plain = String(s)
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();

    if (!plain) return null;

    const botId = ownBotId();
    const isValidUserId = (id) => {
        if (!Number.isFinite(id) || id < 100000 || id > 999999999999) return false;
        if (botId && id === botId) return false;
        return true;
    };

    // 1) Hard marker embedded in every notify: #u123456789
    let m = plain.match(/#u(\d{5,15})\b/i);
    if (m) {
        const id = parseInt(m[1], 10);
        if (isValidUserId(id)) return id;
    }

    // 2) "ID: 123" after HTML strip
    m = plain.match(/\bID\s*[:：]\s*(\d{5,15})\b/i);
    if (m) {
        const id = parseInt(m[1], 10);
        if (isValidUserId(id)) return id;
    }

    m = plain.match(/користувачу\s+(\d{5,15})/i);
    if (m) {
        const id = parseInt(m[1], 10);
        if (isValidUserId(id)) return id;
    }

    return null;
}

/**
 * Remember admin-notify message_id → user, so Reply works for Rich Messages.
 * Writes to User.supportHistory.notifyMessageIds (last 40).
 * Also mirrors into collection admin_notify_map as belt-and-suspenders (serverless).
 */
async function rememberNotifyMessage(telegramId, messageId) {
    if (!telegramId || messageId == null) return;
    const tid = Number(telegramId);
    const mid = Number(messageId);
    if (!Number.isFinite(tid) || !Number.isFinite(mid)) return;

    try {
        await User.updateOne(
            { telegramId: tid },
            {
                $push: {
                    'supportHistory.notifyMessageIds': {
                        $each: [mid],
                        $slice: -40
                    }
                },
                $set: { 'supportHistory.updatedAt': new Date() }
            },
            { upsert: false }
        );
    } catch (e) {
        console.warn('[admin] rememberNotifyMessage User.updateOne:', e.message);
    }

    // Fallback map (survives schema lag / strict paths)
    try {
        const col = User.db.collection('admin_notify_map');
        await col.updateOne(
            { messageId: mid },
            {
                $set: {
                    messageId: mid,
                    telegramId: tid,
                    at: new Date()
                }
            },
            { upsert: true }
        );
    } catch (e) {
        console.warn('[admin] rememberNotifyMessage map:', e.message);
    }
}

/**
 * Resolve target user id from a reply_to message:
 * 1) text markers #u / ID:
 * 2) User.supportHistory.notifyMessageIds
 * 3) admin_notify_map collection
 */
async function resolveTargetUserId(replyTo) {
    const fromText = extractUserIdFromNotifyText(replyTo);
    if (fromText) return fromText;

    const mid = replyTo && replyTo.message_id;
    if (mid == null) return null;
    const midN = Number(mid);

    try {
        const u = await User.findOne({
            'supportHistory.notifyMessageIds': midN
        })
            .select('telegramId')
            .lean();
        if (u && u.telegramId) return Number(u.telegramId);
    } catch (e) {
        console.warn('[admin] resolveTargetUserId user lookup:', e.message);
    }

    try {
        const col = User.db.collection('admin_notify_map');
        const row = await col.findOne({ messageId: midN });
        if (row && row.telegramId) return Number(row.telegramId);
    } catch (e) {
        console.warn('[admin] resolveTargetUserId map lookup:', e.message);
    }

    return null;
}




async function touchUserProfile(from, lang = 'uk') {
    if (!from?.id) return null;
    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    const update = {
        $set: {
            username: from.username || undefined,
            firstName: from.first_name || undefined,
            lastName: from.last_name || undefined,
            languageCode: from.language_code || undefined,
            lastActivityAt: now
        },
        $setOnInsert: {
            language: lang,
            accessLevel: 'unlimited',
            createdAt: now,
            'usage.monthKey': monthKey,
            'usage.eveningThisMonth': 0,
            'usage.alertsThisMonth': 0,
            'usage.eveningTotal': 0,
            'usage.alertsTotal': 0
        }
    };

    // Avoid overwriting username with undefined
    Object.keys(update.$set).forEach((k) => {
        if (update.$set[k] === undefined) delete update.$set[k];
    });

    return User.findOneAndUpdate(
        { telegramId: from.id },
        update,
        { upsert: true, new: true }
    );
}

/**
 * Reset monthly counters if month changed.
 */
function ensureMonthCounters(user) {
    if (!user) return user;
    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!user.usage) user.usage = {};
    if (user.usage.monthKey !== monthKey) {
        user.usage.monthKey = monthKey;
        user.usage.eveningThisMonth = 0;
        user.usage.alertsThisMonth = 0;
    }
    return user;
}

async function sendAdminMenu(api, chatId, messageId = null, preferredThreadId = null) {
    const text =
        '🛡 <b>Адмін-панель Parasol Sentinel</b>\n\n' +
        'Оберіть дію кнопкою нижче.\n' +
        'Напиши /admin або будь-який текст у General — знову покаже меню.';

    const base = { parse_mode: 'HTML', reply_markup: adminKeyboard() };
    if (messageId) {
        try {
            await api.editMessageText(chatId, messageId, text, base);
            return;
        } catch (_) {
            /* fall through to send */
        }
    }

    // Try: caller's thread → TOPIC_GENERAL → no thread (Telegram General default)
    const attempts = [];
    if (preferredThreadId != null && preferredThreadId !== undefined) {
        attempts.push({ message_thread_id: preferredThreadId });
    }
    const gen = topicId('GENERAL');
    if (gen != null) attempts.push({ message_thread_id: gen });
    attempts.push({});

    let lastErr = null;
    for (const thr of attempts) {
        try {
            await api.sendMessage(chatId, text, { ...base, ...thr });
            return;
        } catch (e) {
            lastErr = e;
            console.warn('[admin] sendAdminMenu failed:', e.message, thr);
        }
    }
    throw lastErr || new Error('sendAdminMenu failed');
}

async function handleAdminCallback(ctx) {
    const data = (ctx.callbackQuery?.data || '').split('|');
    if (data[0] !== 'adm') return false;

    const chatId = ctx.callbackQuery.message?.chat?.id;
    if (!isAdminChat(chatId)) {
        await ctx.answerCallbackQuery({ text: '❌ Лише в адмін-каналі' }).catch(() => {});
        return true;
    }

    await ctx.answerCallbackQuery().catch(() => {});
    const api = ctx.api;
    const sub = data[1];

    try {
        if (sub === 'menu') {
            await sendAdminMenu(
                api,
                chatId,
                ctx.callbackQuery.message.message_id,
                ctx.callbackQuery.message.message_thread_id
            );
            return true;
        }

        if (sub === 'list') {
            const users = await User.find({}).sort({ lastActivityAt: -1 }).limit(80).lean();
            if (!users.length) {
                await api.sendMessage(chatId, '📭 Користувачів ще немає.', { parse_mode: 'HTML' });
                return true;
            }
            // Rich Message tables — fewer rows (more columns: ID + geo)
            const chunkSize = 10;
            for (let i = 0; i < users.length; i += chunkSize) {
                const slice = users.slice(i, i + chunkSize);
                const part =
                    users.length > chunkSize
                        ? `показано ${i + 1}–${i + slice.length} з ${users.length}`
                        : `показано ${users.length}`;
                await sendUsersRich(
                    api,
                    chatId,
                    i === 0 ? '📋 Користувачі' : `📋 Користувачі (прод.)`,
                    slice,
                    part
                );
            }
            return true;
        }

        if (sub === 'active') {
            const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const users = await User.find({ lastActivityAt: { $gte: since } })
                .sort({ lastActivityAt: -1 })
                .limit(50)
                .lean();
            if (!users.length) {
                await api.sendMessage(chatId, '🟢 Немає активних за останні 7 днів.', { parse_mode: 'HTML' });
                return true;
            }
            await sendUsersRich(
                api,
                chatId,
                '🟢 Активні за 7 днів',
                users,
                `${users.length} користувач(ів)`
            );
            return true;
        }

        if (sub === 'stats') {
            const now = new Date();
            const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
            const d1 = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const d7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const d30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
            const monthLabel = now.toLocaleString('uk-UA', { month: 'long', year: 'numeric', timeZone: 'Europe/Kyiv' });

            const [
                total,
                withCity,
                unlimited,
                blocked,
                notifOn,
                eveningOn,
                newThisMonth,
                active1,
                active7,
                active30,
                usageAgg,
                langAgg,
                cityAgg,
                errorsThisMonth,
                errorsTotal
            ] = await Promise.all([
                User.countDocuments(),
                User.countDocuments({ city: { $ne: null, $exists: true } }),
                User.countDocuments({ accessLevel: { $ne: 'none' } }),
                User.countDocuments({ accessLevel: 'none' }),
                User.countDocuments({ notificationsEnabled: { $ne: false } }),
                User.countDocuments({ eveningForecastEnabled: { $ne: false } }),
                User.countDocuments({ createdAt: { $gte: monthStart } }),
                User.countDocuments({ lastActivityAt: { $gte: d1 } }),
                User.countDocuments({ lastActivityAt: { $gte: d7 } }),
                User.countDocuments({ lastActivityAt: { $gte: d30 } }),
                User.aggregate([
                    {
                        $group: {
                            _id: null,
                            eveningMonth: {
                                $sum: {
                                    $cond: [
                                        { $eq: ['$usage.monthKey', monthKey] },
                                        { $ifNull: ['$usage.eveningThisMonth', 0] },
                                        0
                                    ]
                                }
                            },
                            alertsMonth: {
                                $sum: {
                                    $cond: [
                                        { $eq: ['$usage.monthKey', monthKey] },
                                        { $ifNull: ['$usage.alertsThisMonth', 0] },
                                        0
                                    ]
                                }
                            },
                            eveningTotal: { $sum: { $ifNull: ['$usage.eveningTotal', 0] } },
                            alertsTotal: { $sum: { $ifNull: ['$usage.alertsTotal', 0] } }
                        }
                    }
                ]),
                User.aggregate([
                    { $group: { _id: { $ifNull: ['$language', '—'] }, n: { $sum: 1 } } },
                    { $sort: { n: -1 } },
                    { $limit: 6 }
                ]),
                User.aggregate([
                    { $match: { city: { $ne: null, $exists: true } } },
                    { $group: { _id: '$city', n: { $sum: 1 } } },
                    { $sort: { n: -1 } },
                    { $limit: 8 }
                ]),
                ErrorLog.countDocuments({ createdAt: { $gte: monthStart } }).catch(() => 0),
                ErrorLog.countDocuments().catch(() => 0)
            ]);

            const u = usageAgg[0] || {};
            const eveningM = u.eveningMonth || 0;
            const alertsM = u.alertsMonth || 0;
            const eveningT = u.eveningTotal || 0;
            const alertsT = u.alertsTotal || 0;

            const bar = (n, max, width = 8) => {
                if (!max || max <= 0) return '░'.repeat(width);
                const filled = Math.min(width, Math.round((n / max) * width));
                return '█'.repeat(filled) + '░'.repeat(width - filled);
            };
            const maxActive = Math.max(active1, active7, active30, 1);

            const langRows = (langAgg || [])
                .map((x) => `<tr><td align="left">${escapeHtml(String(x._id))}</td><td align="center"><b>${x.n}</b></td></tr>`)
                .join('') || '<tr><td colspan="2" align="center">—</td></tr>';

            const cityRows = (cityAgg || [])
                .map((x) => `<tr><td align="left">${escapeHtml(String(x._id))}</td><td align="center"><b>${x.n}</b></td></tr>`)
                .join('') || '<tr><td colspan="2" align="center">—</td></tr>';

            // Same Rich Message dialect as evening forecasts (h1/h3, table bordered striped)
            const html = `
<h1>📊 Аналітика Parasol Sentinel</h1>
<p><i>${escapeHtml(monthLabel)} · оновлено зараз</i></p>

<h3>👥 Користувачі</h3>
<table bordered striped>
  <thead>
    <tr>
      <th align="left">Показник</th>
      <th align="center">К-сть</th>
    </tr>
  </thead>
  <tbody>
    <tr><td align="left">Всього</td><td align="center"><b>${total}</b></td></tr>
    <tr><td align="left">З містом</td><td align="center"><b>${withCity}</b></td></tr>
    <tr><td align="left">Нові цього місяця</td><td align="center"><b>${newThisMonth}</b></td></tr>
    <tr><td align="left">✅ Безліміт</td><td align="center"><b>${unlimited}</b></td></tr>
    <tr><td align="left">🚫 Немає доступу</td><td align="center"><b>${blocked}</b></td></tr>
    <tr><td align="left">🔔 Сповіщення</td><td align="center"><b>${notifOn}</b></td></tr>
    <tr><td align="left">🌆 Вечірній</td><td align="center"><b>${eveningOn}</b></td></tr>
  </tbody>
</table>

<h3>🟢 Активність</h3>
<table bordered striped>
  <thead>
    <tr>
      <th align="left">Період</th>
      <th align="center">К-сть</th>
    </tr>
  </thead>
  <tbody>
    <tr><td align="left">24 години</td><td align="center"><b>${active1}</b></td></tr>
    <tr><td align="left">7 днів</td><td align="center"><b>${active7}</b></td></tr>
    <tr><td align="left">30 днів</td><td align="center"><b>${active30}</b></td></tr>
  </tbody>
</table>

<h3>📬 Доставка</h3>
<table bordered striped>
  <thead>
    <tr>
      <th align="left">Показник</th>
      <th align="center">Місяць</th>
      <th align="center">Всього</th>
    </tr>
  </thead>
  <tbody>
    <tr><td align="left">🌆 Вечірні</td><td align="center"><b>${eveningM}</b></td><td align="center"><b>${eveningT}</b></td></tr>
    <tr><td align="left">🚨 Алерти</td><td align="center"><b>${alertsM}</b></td><td align="center"><b>${alertsT}</b></td></tr>
    <tr><td align="left">Разом</td><td align="center"><b>${eveningM + alertsM}</b></td><td align="center"><b>${eveningT + alertsT}</b></td></tr>
  </tbody>
</table>
<p><i>⚠️ Лічильники ростуть після оновлення cron (usage.*)</i></p>

<h3>🌐 Мови</h3>
<table bordered striped>
  <thead>
    <tr><th align="left">Мова</th><th align="center">К-сть</th></tr>
  </thead>
  <tbody>
    ${langRows}
  </tbody>
</table>

<h3>📍 Топ міст</h3>
<table bordered striped>
  <thead>
    <tr><th align="left">Місто</th><th align="center">К-сть</th></tr>
  </thead>
  <tbody>
    ${cityRows}
  </tbody>
</table>

<h3>❌ Помилки (кількість)</h3>
<table bordered striped>
  <thead>
    <tr><th align="left">Період</th><th align="left">К-сть</th></tr>
  </thead>
  <tbody>
    <tr><td align="left">Цього місяця</td><td align="left"><b>${errorsThisMonth}</b></td></tr>
    <tr><td align="left">Всього</td><td align="left"><b>${errorsTotal}</b></td></tr>
  </tbody>
</table>
<p><i>Деталі помилок — у гілці ERROR_ID (окремий топік)</i></p>
`.trim();

            const thr = adminThreadFromCtx(ctx);
            const originId = ctx.callbackQuery?.message?.message_id;
            if (originId != null) {
                try { await api.deleteMessage(chatId, originId); } catch (_) {}
            }
            try {
                await api.sendRichMessage(chatId, {
                    html,
                    skip_entity_detection: true
                }, thr);
            } catch (richErr) {
                console.warn('[admin] stats sendRichMessage failed, fallback:', richErr.message);
                // Plain fallback without tables
                const plain =
                    `📊 <b>Аналітика Parasol Sentinel</b>\n` +
                    `<i>${escapeHtml(monthLabel)}</i>\n\n` +
                    `👥 Всього: <b>${total}</b> · місто: <b>${withCity}</b>\n` +
                    `✅ Безліміт: <b>${unlimited}</b> · 🚫: <b>${blocked}</b>\n` +
                    `🔔: <b>${notifOn}</b> · 🌆: <b>${eveningOn}</b>\n\n` +
                    `🟢 24г: <b>${active1}</b> · 7д: <b>${active7}</b> · 30д: <b>${active30}</b>\n\n` +
                    `📬 Місяць — вечірні: <b>${eveningM}</b>, алерти: <b>${alertsM}</b>\n` +
                    `Всього — вечірні: <b>${eveningT}</b>, алерти: <b>${alertsT}</b>\n\n` +
                    `❌ Помилки місяць/всього: <b>${errorsThisMonth}</b>/<b>${errorsTotal}</b>`;
                await api.sendMessage(chatId, plain, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
            }
            return true;
        }

        if (sub === 'access') {
            // List first 30 users with toggle buttons
            const users = await User.find({}).sort({ lastActivityAt: -1 }).limit(30).lean();
            if (!users.length) {
                await api.sendMessage(chatId, '📭 Немає користувачів.', { parse_mode: 'HTML' });
                return true;
            }
            const rows = users.map((u) => {
                const label = u.username || u.firstName || String(u.telegramId);
                const cur = accessLabel(u.accessLevel || 'unlimited');
                const next = (u.accessLevel || 'unlimited') === 'none' ? 'unlimited' : 'none';
                const nextLabel = next === 'none' ? '🚫 Заборонити' : '✅ Дати безліміт';
                return [
                    {
                        text: `${label} · ${cur}`,
                        callback_data: `adm|noop|${u.telegramId}`
                    },
                    {
                        text: nextLabel,
                        callback_data: `adm|setaccess|${u.telegramId}|${next}`
                    }
                ];
            });
            rows.push([{ text: '◀️ Меню', callback_data: 'adm|menu' }]);
            await api.sendMessage(chatId, '🔑 <b>Змінити доступ</b> (останні 30):', {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: rows }
            });
            return true;
        }

        if (sub === 'setaccess') {
            const tgId = parseInt(data[2], 10);
            const level = data[3] === 'none' ? 'none' : 'unlimited';
            const updated = await User.findOneAndUpdate(
                { telegramId: tgId },
                { $set: { accessLevel: level } },
                { new: true }
            );
            if (!updated) {
                await api.sendMessage(chatId, `❌ Користувача ${tgId} не знайдено.`);
                return true;
            }
            await api.sendMessage(
                chatId,
                `✅ Доступ оновлено:\n${formatUserLine(updated)}`,
                { parse_mode: 'HTML' }
            );
            return true;
        }

        if (sub === 'broadcast_evening') {
            await api.sendMessage(
                chatId,
                '🌆 <b>Розсилка вечірнього прогнозу</b>\n\n' +
                    'Щоб запустити зараз, натисніть «Підтвердити».\n' +
                    'Це викличе той самий cron, що й щовечора (лише для користувачів з увімкненим вечірнім прогнозом і access ≠ none).',
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ Підтвердити розсилку', callback_data: 'adm|do_broadcast' },
                                { text: '❌ Скасувати', callback_data: 'adm|menu' }
                            ]
                        ]
                    }
                }
            );
            return true;
        }

        if (sub === 'do_broadcast') {
            const DOMAIN = process.env.DOMAIN || '';
            const secret = process.env.CRON_SECRET || '';
            if (!DOMAIN || !secret) {
                await api.sendMessage(
                    chatId,
                    '❌ DOMAIN або CRON_SECRET не налаштовані — не можу викликати cron-forecast.'
                );
                return true;
            }
            await api.sendMessage(chatId, '⏳ Запускаю розсилку…');
            try {
                const axios = require('axios');
                const url = `https://${DOMAIN.replace(/^https?:\/\//, '')}/api/cron-forecast`;
                const res = await axios.get(url, {
                    headers: { Authorization: `Bearer ${secret}` },
                    timeout: 55000,
                    validateStatus: () => true
                });
                await api.sendMessage(
                    chatId,
                    `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
                        `┃  🌆 <b>Розсилка вечір. прогнозу</b>\n` +
                        `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
                        `Статус: <code>${res.status}</code>\n` +
                        `<pre>${escapeHtml(String(res.data).slice(0, 800))}</pre>`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                await api.sendMessage(chatId, `❌ Помилка виклику: ${escapeHtml(e.message)}`, {
                    parse_mode: 'HTML'
                });
            }
            return true;
        }

        // ─── Вечірній тест (cron-forecast-test, TEST_USER_ID) ───
        if (sub === 'evening_test') {
            await api.sendMessage(
                chatId,
                '🧪 <b>Вечірній тест</b>\n\n' +
                    'Запускає <code>cron-forecast-test</code> для користувача з <code>TEST_USER_ID</code> (env).\n' +
                    'Підтвердіть запуск:',
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ Запустити тест', callback_data: 'adm|do_evening_test' },
                                { text: '❌ Скасувати', callback_data: 'adm|menu' }
                            ]
                        ]
                    }
                }
            );
            return true;
        }

        if (sub === 'do_evening_test') {
            const DOMAIN = process.env.DOMAIN || '';
            const secret = process.env.CRON_SECRET || '';
            if (!DOMAIN || !secret) {
                await api.sendMessage(
                    chatId,
                    '❌ DOMAIN або CRON_SECRET не налаштовані — не можу викликати cron-forecast-test.'
                );
                return true;
            }
            await api.sendMessage(chatId, '⏳ Запускаю вечірній тест…');
            try {
                const axios = require('axios');
                const url = `https://${DOMAIN.replace(/^https?:\/\//, '')}/api/cron-forecast-test`;
                const res = await axios.get(url, {
                    headers: { Authorization: `Bearer ${secret}` },
                    timeout: 55000,
                    validateStatus: () => true
                });
                await api.sendMessage(
                    chatId,
                    `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
                        `┃  🧪 <b>Вечірній тест</b>\n` +
                        `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
                        `Статус: <code>${res.status}</code>\n` +
                        `<pre>${escapeHtml(String(res.data).slice(0, 800))}</pre>`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                await api.sendMessage(chatId, `❌ Помилка виклику: ${escapeHtml(e.message)}`, {
                    parse_mode: 'HTML'
                });
            }
            return true;
        }

        // ─── Вечірній крон для одного обраного користувача ───
        if (sub === 'evening_one') {
            const users = await User.find({
                notificationsEnabled: true,
                eveningForecastEnabled: { $ne: false },
                accessLevel: { $ne: 'none' },
                lat: { $ne: null },
                lon: { $ne: null }
            })
                .sort({ lastActivityAt: -1 })
                .limit(20)
                .lean();

            if (!users.length) {
                await api.sendMessage(chatId, '📭 Немає підходящих користувачів для вечірнього прогнозу.', {
                    parse_mode: 'HTML'
                });
                return true;
            }

            const rows = users.map((u) => {
                const label =
                    (u.username ? `@${u.username}` : u.firstName || String(u.telegramId)) +
                    (u.city ? ` · ${u.city}` : '');
                return [
                    {
                        text: label.slice(0, 60),
                        callback_data: `adm|do_evening_one|${u.telegramId}`
                    }
                ];
            });
            rows.push([{ text: '◀️ Меню', callback_data: 'adm|menu' }]);

            await api.sendMessage(
                chatId,
                '🎯 <b>Вечірній крон обраним</b>\n\n' +
                    'Оберіть користувача — буде надіслано вечірній прогноз лише йому:\n',
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: rows }
                }
            );
            return true;
        }

        if (sub === 'do_evening_one') {
            const targetId = data[2];
            if (!targetId) {
                await api.sendMessage(chatId, '❌ Не вказано ID користувача.');
                return true;
            }
            const DOMAIN = process.env.DOMAIN || '';
            const secret = process.env.CRON_SECRET || '';
            if (!DOMAIN || !secret) {
                await api.sendMessage(
                    chatId,
                    '❌ DOMAIN або CRON_SECRET не налаштовані — не можу викликати cron-forecast.'
                );
                return true;
            }
            await api.sendMessage(
                chatId,
                `⏳ Запускаю вечірній прогноз для <code>${escapeHtml(targetId)}</code>…`,
                { parse_mode: 'HTML' }
            );
            try {
                const axios = require('axios');
                const url = `https://${DOMAIN.replace(/^https?:\/\//, '')}/api/cron-forecast?userId=${encodeURIComponent(targetId)}`;
                const res = await axios.get(url, {
                    headers: { Authorization: `Bearer ${secret}` },
                    timeout: 55000,
                    validateStatus: () => true
                });
                await api.sendMessage(
                    chatId,
                    `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
                        `┃  🎯 <b>Вечірній крон (1 юзер)</b>\n` +
                        `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
                        `Користувач: <code>${escapeHtml(targetId)}</code>\n` +
                        `Статус: <code>${res.status}</code>\n` +
                        `<pre>${escapeHtml(String(res.data).slice(0, 800))}</pre>`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                await api.sendMessage(chatId, `❌ Помилка виклику: ${escapeHtml(e.message)}`, {
                    parse_mode: 'HTML'
                });
            }
            return true;
        }

        // ─── Крон чек (light) ───
        if (sub === 'cron_check') {
            await api.sendMessage(
                chatId,
                '🔍 <b>Крон чек (light)</b>\n\n' +
                    'Запускає <code>cron-check-light</code> — легка перевірка алертів без Weatherbit.\n' +
                    'Підтвердіть запуск:',
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ Запустити крон чек', callback_data: 'adm|do_cron_check' },
                                { text: '❌ Скасувати', callback_data: 'adm|menu' }
                            ]
                        ]
                    }
                }
            );
            return true;
        }

        if (sub === 'do_cron_check') {
            const DOMAIN = process.env.DOMAIN || '';
            const secret = process.env.CRON_SECRET || '';
            if (!DOMAIN || !secret) {
                await api.sendMessage(
                    chatId,
                    '❌ DOMAIN або CRON_SECRET не налаштовані — не можу викликати cron-check-light.'
                );
                return true;
            }
            await api.sendMessage(chatId, '⏳ Запускаю крон чек (light)…');
            try {
                const axios = require('axios');
                const url = `https://${DOMAIN.replace(/^https?:\/\//, '')}/api/cron-check-light`;
                const res = await axios.get(url, {
                    headers: { Authorization: `Bearer ${secret}` },
                    timeout: 55000,
                    validateStatus: () => true
                });
                await api.sendMessage(
                    chatId,
                    `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
                        `┃  🔍 <b>Крон чек (light)</b>\n` +
                        `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
                        `Статус: <code>${res.status}</code>\n` +
                        `<pre>${escapeHtml(String(res.data).slice(0, 800))}</pre>`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                await api.sendMessage(chatId, `❌ Помилка виклику: ${escapeHtml(e.message)}`, {
                    parse_mode: 'HTML'
                });
            }
            return true;
        }

        if (sub === 'userinfo') {
            const tgId = data[2] ? Number(data[2]) : null;
            if (!tgId || Number.isNaN(tgId)) {
                await api.sendMessage(chatId, '❌ Невірний ID користувача.', adminThreadFromCtx(ctx));
                return true;
            }
            const u = await User.findOne({ telegramId: tgId }).lean();
            if (!u) {
                await api.sendMessage(
                    chatId,
                    `❌ Користувача <code>${tgId}</code> немає в БД.`,
                    { parse_mode: 'HTML', ...adminThreadFromCtx(ctx) }
                );
                return true;
            }
            const html = buildUserInfoHtml(u);
            const thr = adminThreadFromCtx(ctx);
            const originMsg = ctx.callbackQuery?.message;
            const originId = originMsg?.message_id;
            // Rich HTML (<h1>…) cannot use editMessageText / parse_mode HTML —
            // delete old card (if any) and send Rich Message in the SAME topic.
            if (originId != null) {
                try {
                    await api.deleteMessage(chatId, originId);
                } catch (_) { /* ignore */ }
            }
            try {
                await api.sendRichMessage(
                    chatId,
                    { html, skip_entity_detection: true },
                    thr
                );
            } catch (richErr) {
                console.warn('[admin] userinfo rich failed:', richErr.message);
                const plain = String(html)
                    .replace(/<h1[^>]*>/gi, '👤 ')
                    .replace(/<\/h1>/gi, '\n')
                    .replace(/<h3[^>]*>/gi, '\n')
                    .replace(/<\/h3>/gi, '\n')
                    .replace(/<br\s*\/?\s*>/gi, '\n')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/[ \t]+/g, ' ')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
                await api.sendMessage(chatId, plain.slice(0, 4000), {
                    disable_web_page_preview: true,
                    ...thr
                });
            }
            try {
                await ctx.answerCallbackQuery({ text: '🔄 Оновлено' });
            } catch (_) { /* ignore */ }
            return true;
        }

        if (sub === 'msg_user') {
            await api.sendMessage(
                chatId,
                '✉️ <b>Написати користувачу</b>\n\n' +
                    'Надішліть у цей канал повідомлення у форматі:\n' +
                    '<code>/msg USER_ID текст повідомлення</code>\n\n' +
                    'Приклад:\n<code>/msg 7574257471 Привіт! Перевірка адмінки.</code>',
                { parse_mode: 'HTML' }
            );
            return true;
        }

        if (sub === 'noop') {
            return true;
        }
    } catch (e) {
        console.error('[admin] callback error:', e);
        await api.sendMessage(chatId, `❌ Помилка: ${escapeHtml(e.message)}`, { parse_mode: 'HTML' }).catch(() => {});
    }
    return true;
}




// ===== HISTORY SUPPORT (auto) =====

async function sendInAdminThread(api, chatId, text, extra = {}, preferredThreadId = null) {
    const attempts = [];
    const seen = new Set();
    const push = (thr) => {
        const key = thr.message_thread_id != null ? String(thr.message_thread_id) : '__none__';
        if (seen.has(key)) return;
        seen.add(key);
        attempts.push(thr);
    };
    if (preferredThreadId != null && preferredThreadId !== undefined && preferredThreadId !== '') {
        const n = Number(preferredThreadId);
        if (Number.isFinite(n)) push({ message_thread_id: n });
    }
    const gen = topicId('GENERAL');
    if (gen != null) push({ message_thread_id: gen });
    push({}); // root / non-forum / default General

    let lastErr = null;
    for (const thr of attempts) {
        try {
            return await api.sendMessage(chatId, text, { ...extra, ...thr });
        } catch (e) {
            lastErr = e;
            const msg = e?.message || String(e);
            // Only retry on thread-related errors; rethrow others
            if (!/thread not found|MESSAGE_THREAD|message thread/i.test(msg)) {
                throw e;
            }
            console.warn('[admin] sendInAdminThread retry:', msg, thr);
        }
    }
    throw lastErr || new Error('sendInAdminThread failed');
}

function isBroadcastAllTarget(raw) {
    if (raw == null) return false;
    let s;
    if (typeof raw === 'object') {
        s = [raw.text, raw.caption].filter(Boolean).join('\n');
    } else {
        s = String(raw);
    }
    return /ID:\s*BROADCAST_ALL\b/i.test(s) || /#broadcast_all\b/i.test(s);
}

async function broadcastToAllUsers(api, msg) {
    const users = await User.find({ accessLevel: { $ne: 'none' } })
        .select('telegramId')
        .lean();
    let ok = 0;
    let fail = 0;
    for (const u of users) {
        if (!u?.telegramId) continue;
        try {
            const kind = await sendAdminReplyToUser(api, u.telegramId, msg);
            if (kind) ok += 1;
            else fail += 1;
        } catch (e) {
            fail += 1;
            console.warn('[admin] broadcast fail', u.telegramId, e.message);
        }
    }
    return { ok, fail, total: users.length };
}

async function cleanupScenarioMessages(api, chatId, adminMsg, instructionMsg) {
    const ids = [];
    if (adminMsg?.message_id != null) ids.push(adminMsg.message_id);
    if (instructionMsg?.message_id != null) ids.push(instructionMsg.message_id);
    for (const id of ids) {
        try {
            await api.deleteMessage(chatId, id);
        } catch (e) {
            console.warn('[admin] cleanupScenarioMessages failed', id, e.message);
        }
    }
}

function describeMsgContent(msg) {
    if (!msg) return { media: null, text: '', kind: null, fileId: null };
    const text = (msg.caption || msg.text || '').trim();
    let media = null;
    let kind = null;
    let fileId = null;
    if (msg.photo && msg.photo.length) {
        media = '📷 фото';
        kind = 'photo';
        fileId = msg.photo[msg.photo.length - 1].file_id;
    } else if (msg.document) {
        media = `📎 ${msg.document.file_name || 'документ'}`;
        kind = 'document';
        fileId = msg.document.file_id;
    } else if (msg.video) {
        media = '🎬 відео';
        kind = 'video';
        fileId = msg.video.file_id;
    } else if (msg.animation) {
        media = '🎞 gif';
        kind = 'animation';
        fileId = msg.animation.file_id;
    } else if (msg.voice) {
        media = '🎤 голосове';
        kind = 'voice';
        fileId = msg.voice.file_id;
    } else if (msg.audio) {
        media = '🎵 аудіо';
        kind = 'audio';
        fileId = msg.audio.file_id;
    } else if (msg.sticker) {
        media = '😊 sticker';
        kind = 'sticker';
        fileId = msg.sticker.file_id;
    }
    return { media, text, kind, fileId };
}

function historyThreadOpts() {
    return threadOpts('HISTORY');
}

function formatSupportLine(who, media, text, assetId, ts = new Date()) {
    const time = ts.toLocaleString('uk-UA', {
        timeZone: 'Europe/Kyiv',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
    const parts = [`[${time}] ${who}:`];
    if (media) {
        parts.push(assetId ? `${media} #${assetId}` : media);
    }
    if (text) parts.push(text.slice(0, 1500));
    if (!media && !text) parts.push('(порожньо)');
    return parts.join(' ');
}

async function sendAssetToHistory(api, msg, assetId, mediaLabel) {
    const chatId = ADMIN_CHAT_ID();
    if (!chatId || !msg) return;
    const thrId = topicId('HISTORY');
    const { kind, fileId } = describeMsgContent(msg);
    if (!kind || !fileId) return;

    const caption = `${mediaLabel} <code>#${assetId}</code>`;
    const attempts = [];
    if (thrId != null) attempts.push({ message_thread_id: thrId });
    attempts.push({});

    const sendOnce = async (thr) => {
        const opts = { caption, parse_mode: 'HTML', ...thr };
        if (kind === 'photo') return api.sendPhoto(chatId, fileId, opts);
        if (kind === 'document') return api.sendDocument(chatId, fileId, opts);
        if (kind === 'video') return api.sendVideo(chatId, fileId, opts);
        if (kind === 'animation') return api.sendAnimation(chatId, fileId, opts);
        if (kind === 'voice') return api.sendVoice(chatId, fileId, opts);
        if (kind === 'audio') return api.sendAudio(chatId, fileId, opts);
        if (kind === 'sticker') {
            await api.sendSticker(chatId, fileId, thr);
            return api.sendMessage(chatId, caption, { parse_mode: 'HTML', ...thr });
        }
        return null;
    };

    let lastErr = null;
    for (const thr of attempts) {
        try {
            await sendOnce(thr);
            return;
        } catch (e) {
            lastErr = e;
            if (!/thread not found|MESSAGE_THREAD/i.test(e.message || '')) throw e;
        }
    }
    if (lastErr) console.warn('[admin] sendAssetToHistory failed:', lastErr.message);
}

async function logDeliveryToHistory(api, { kind, targetLabel, msg, okCount, failCount, total }) {
    const chatId = ADMIN_CHAT_ID();
    if (!chatId) return;
    // Personal one-to-one: no separate «Відправлено» card (already in «Розмова з…»)
    if (kind === 'one') return;

    const { media, text } = describeMsgContent(msg);
    let head = `📣 <b>Відправлено всім</b>`;
    if (okCount != null) {
        head += `\n✅ ${okCount}` + (failCount != null ? ` · ❌ ${failCount}` : '') +
            (total != null ? ` · з ${total}` : '');
    }
    const bodyParts = [head];
    if (media) bodyParts.push(escapeHtml(media));
    if (text) bodyParts.push(escapeHtml(text.slice(0, 1000)));
    try {
        await sendInAdminThread(api, chatId, bodyParts.join('\n'), {
            parse_mode: 'HTML',
            disable_web_page_preview: true
        }, topicId('HISTORY'));
    } catch (e) {
        console.warn('[admin] logDeliveryToHistory failed:', e.message);
    }
}

/**
 * Append a line to per-user support transcript and upsert one message in HISTORY topic.
 * - Full transcript always stored in DB (never truncated).
 * - Telegram card shows only the recent tail if too long.
 * - When over limit: attach/update a .txt file with the FULL conversation.
 * Media → line has type + #assetId; asset itself is sent as a separate HISTORY message.
 */
async function appendSupportConversation(api, telegramId, who, msgOrText) {
    const chatId = ADMIN_CHAT_ID();
    if (!chatId || !telegramId) return;

    const CARD_LIMIT = 3200; // tail visible in message (under TG 4096 with header)

    let media = null;
    let text = '';
    let kind = null;
    let rawMsg = null;
    if (typeof msgOrText === 'string') {
        text = msgOrText;
    } else if (msgOrText) {
        rawMsg = msgOrText;
        const d = describeMsgContent(msgOrText);
        media = d.media;
        text = d.text;
        kind = d.kind;
    }

    let user = await User.findOne({ telegramId: Number(telegramId) });
    if (!user) {
        user = await User.findOneAndUpdate(
            { telegramId: Number(telegramId) },
            { $setOnInsert: { telegramId: Number(telegramId), accessLevel: 'unlimited' } },
            { upsert: true, new: true }
        );
    }

    let assetId = null;
    if (kind && rawMsg) {
        const seq = ((user.supportHistory && user.supportHistory.assetSeq) || 0) + 1;
        // Унікально між юзерами: A{telegramId}-{seq}
        assetId = `A${telegramId}-${seq}`;
        if (!user.supportHistory) user.supportHistory = {};
        user.supportHistory.assetSeq = seq;
    }

    const line = formatSupportLine(who, media, text, assetId);
    const prev = (user.supportHistory && user.supportHistory.transcript) || '';
    // FULL history — never truncate in DB
    const transcript = prev ? `${prev}\n${line}` : line;

    const namePart =
        user.username
            ? `@${user.username}`
            : [user.firstName, user.lastName].filter(Boolean).join(' ') || 'user';
    const header =
        `💬 <b>Розмова з</b> ${escapeHtml(namePart)} · <code>${telegramId}</code>\n\n`;

    const overflow = transcript.length > CARD_LIMIT;
    let visible = transcript;
    if (overflow) {
        visible = '…\n' + transcript.slice(transcript.length - CARD_LIMIT);
    }
    let body =
        header +
        escapeHtml(visible) +
        (overflow
            ? `\n\n<i>📎 Повна розмова у файлі <code>chat_${telegramId}.txt</code> (усі рядки збережено)</i>`
            : '');

    const thrId = topicId('HISTORY');
    const histMsgId = user.supportHistory && user.supportHistory.messageId;
    let newMsgId = histMsgId;

    try {
        if (histMsgId) {
            try {
                await api.editMessageText(chatId, histMsgId, body, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
            } catch (editErr) {
                console.warn('[admin] support edit failed, resend:', editErr.message);
                const sent = await sendInAdminThread(
                    api,
                    chatId,
                    body,
                    { parse_mode: 'HTML', disable_web_page_preview: true },
                    thrId
                );
                newMsgId = sent?.message_id;
            }
        } else {
            const sent = await sendInAdminThread(
                api,
                chatId,
                body,
                { parse_mode: 'HTML', disable_web_page_preview: true },
                thrId
            );
            newMsgId = sent?.message_id;
        }
    } catch (e) {
        console.warn('[admin] appendSupportConversation send failed:', e.message);
    }

    // Over limit → .txt with FULL transcript (replace previous file msg if any)
    let fileMessageId = (user.supportHistory && user.supportHistory.fileMessageId) || null;
    if (overflow) {
        try {
            if (fileMessageId) {
                try {
                    await api.deleteMessage(chatId, fileMessageId);
                } catch (_) {
                    /* ignore — already gone */
                }
            }
            const { InputFile } = require('grammy');
            const fileName = `chat_${telegramId}.txt`;
            const fileBody =
                `Parasol support chat · user ${telegramId} · ${namePart}\n` +
                `Updated: ${new Date().toISOString()}\n` +
                `${'='.repeat(40)}\n\n` +
                transcript;
            const thr = thrId != null ? { message_thread_id: thrId } : {};
            const doc = await api.sendDocument(
                chatId,
                new InputFile(Buffer.from(fileBody, 'utf8'), fileName),
                {
                    caption: `📎 Повна розмова з <code>${telegramId}</code> (${transcript.split('\n').length} рядків)`,
                    parse_mode: 'HTML',
                    ...thr
                }
            );
            fileMessageId = doc?.message_id || null;
        } catch (e) {
            console.warn('[admin] support full-file failed:', e.message);
        }
    }

    // Mirror media asset next to the conversation card
    if (assetId && rawMsg) {
        try {
            await sendAssetToHistory(api, rawMsg, assetId, media || '📎');
        } catch (e) {
            console.warn('[admin] mirror asset failed:', e.message);
        }
    }

    const prevNotifyIds =
        (user.supportHistory && user.supportHistory.notifyMessageIds) || [];
    user.supportHistory = {
        messageId: newMsgId || histMsgId || null,
        fileMessageId: fileMessageId,
        notifyMessageIds: prevNotifyIds,
        transcript, // full, never truncated
        assetSeq: (user.supportHistory && user.supportHistory.assetSeq) || 0,
        updatedAt: new Date()
    };
    user.markModified('supportHistory');
    await user.save().catch((e) => console.warn('[admin] supportHistory save:', e.message));
}

// ===== END HISTORY SUPPORT =====

async function sendAdminReplyToUser(api, targetId, msg) {
    const caption = (msg.caption || msg.text || '').trim();
    const header = '💬 Відповідь від підтримки Parasol:';
    const fullCaption = caption ? `${header}\n\n${caption}` : header;

    if (msg.photo && msg.photo.length) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await api.sendPhoto(targetId, fileId, {
            caption: fullCaption,
            parse_mode: caption ? undefined : undefined
        });
        return 'photo';
    }
    if (msg.document) {
        await api.sendDocument(targetId, msg.document.file_id, { caption: fullCaption });
        return 'document';
    }
    if (msg.video) {
        await api.sendVideo(targetId, msg.video.file_id, { caption: fullCaption });
        return 'video';
    }
    if (msg.animation) {
        await api.sendAnimation(targetId, msg.animation.file_id, { caption: fullCaption });
        return 'animation';
    }
    if (msg.voice) {
        await api.sendVoice(targetId, msg.voice.file_id, { caption: fullCaption });
        return 'voice';
    }
    if (msg.audio) {
        await api.sendAudio(targetId, msg.audio.file_id, { caption: fullCaption });
        return 'audio';
    }
    if (msg.sticker) {
        await api.sendSticker(targetId, msg.sticker.file_id);
        if (caption) {
            await api.sendMessage(targetId, fullCaption);
        }
        return 'sticker';
    }
    if (caption) {
        await api.sendMessage(targetId, `💬 <b>Відповідь від підтримки Parasol:</b>\n\n${escapeHtml(caption)}`, {
            parse_mode: 'HTML'
        });
        return 'text';
    }
    return null;
}

/**
 * Handle posts in admin channel: reply to user (text/photo/media), /msg, /setaccess, or show menu.
 * Works for both message and channel_post (text + media).
 */
async function handleAdminChannelText(ctx) {
    const chatId = ctx.chat?.id || ctx.channelPost?.chat?.id;
    if (!isAdminChat(chatId)) return false;

    const msg = ctx.message || ctx.channelPost || {};
    const text = (msg.text || '').trim();
    const caption = (msg.caption || '').trim();
    const api = ctx.api;
    const hasMedia = !!(
        (msg.photo && msg.photo.length) ||
        msg.document ||
        msg.video ||
        msg.animation ||
        msg.voice ||
        msg.audio ||
        msg.sticker
    );
    // Stay in the same forum topic when confirming
    const sameThread =
        msg.message_thread_id != null
            ? { message_thread_id: msg.message_thread_id }
            : threadOpts('USERS');

    // ── Reply to instruction / user-notification → one user or ALL ──
    const replyTo = msg.reply_to_message;
    if (replyTo && (text || caption || hasMedia) && !(text || '').startsWith('/')) {
        if (isBroadcastAllTarget(replyTo)) {
            try {
                const { ok, fail, total } = await broadcastToAllUsers(api, msg);
                await logDeliveryToHistory(api, {
                    kind: 'all',
                    targetLabel: 'усім',
                    msg,
                    okCount: ok,
                    failCount: fail,
                    total
                });
                await cleanupScenarioMessages(api, chatId, msg, replyTo);
            } catch (e) {
                await api.sendMessage(
                    chatId,
                    `❌ Broadcast failed: ${escapeHtml(e.message)}`,
                    { parse_mode: 'HTML', ...sameThread }
                );
            }
            return true;
        }

        const targetId = await resolveTargetUserId(replyTo);
        if (targetId) {
            try {
                const kind = await sendAdminReplyToUser(api, targetId, msg);
                if (!kind) {
                    await api.sendMessage(chatId, 'ℹ️ Нічого надсилати (порожня відповідь).', sameThread);
                    return true;
                }
                // Картка розмови в HISTORY + asset #A1…; прибрати reply з USERS/ACTIONS
                await appendSupportConversation(api, targetId, '🛡 Адмін', msg);
                await cleanupScenarioMessages(api, chatId, msg, replyTo);
            } catch (e) {
                const hint = /can't send messages to the bot/i.test(e.message || '')
                    ? 'Схоже, ID вказано бота (не користувача). Відповідь роби на нове сповіщення з маркером #u…'
                    : 'Користувач міг не стартувати бота або заблокував його.';
                await api.sendMessage(
                    chatId,
                    `❌ Не вдалося надіслати <code>${targetId}</code>: ${escapeHtml(e.message)}
` +
                        `(${hint})`,
                    { parse_mode: 'HTML', ...sameThread }
                );
            }
            return true;
        }
        {
            const mid = replyTo?.message_id;
            const preview = [replyTo?.text, replyTo?.caption].filter(Boolean).join(' ').slice(0, 120);
            await api.sendMessage(
                chatId,
                'ℹ️ Не вдалося визначити користувача з цієї відповіді.\n' +
                    (mid != null ? `message_id сповіщення: <code>${mid}</code>\n` : '') +
                    (preview
                        ? `текст: <code>${escapeHtml(preview)}</code>\n`
                        : 'текст reply_to порожній (типово для Rich Message)\n') +
                    'Відповідь спрацює на <b>нових</b> сповіщеннях після деплою.\n' +
                    'Або: <code>/msg USER_ID текст</code>',
                { parse_mode: 'HTML', ...sameThread }
            );
            return true;
        }
    }

    // Media without reply in admin channel — ignore (don't open menu)
    if (hasMedia && !replyTo) {
        return true;
    }

    // /admin or /menu → always show panel
    if (/^\/(admin|menu)(@\w+)?\s*$/i.test(text)) {
        try {
            await sendAdminMenu(api, chatId, null, msg.message_thread_id);
        } catch (e) {
            await api
                .sendMessage(
                    chatId,
                    `❌ Не вдалося показати меню: ${escapeHtml(e.message)}\n` +
                        `chat=${chatId} thread=${msg.message_thread_id ?? '—'} ADMIN_CHAT_ID=${ADMIN_CHAT_ID()}`,
                    { parse_mode: 'HTML', ...sameThread }
                )
                .catch(() => {});
        }
        return true;
    }

    // /msg <id> <text>
    const msgMatch = text.match(/^\/msg\s+(\d+)\s+([\s\S]+)$/i);
    if (msgMatch) {
        const targetId = parseInt(msgMatch[1], 10);
        const body = msgMatch[2].trim();
        try {
            await api.sendMessage(targetId, body);
            await appendSupportConversation(api, targetId, '🛡 Адмін', body);
            try {
                if (msg.message_id != null) await api.deleteMessage(chatId, msg.message_id);
            } catch (_) { /* ignore */ }
        } catch (e) {
            await api.sendMessage(
                chatId,
                `❌ Не вдалося надіслати: ${escapeHtml(e.message)}\n` +
                    `(Користувач міг не стартувати бота або заблокував його.)`,
                { parse_mode: 'HTML', ...sameThread }
            );
        }
        return true;
    }

    // /setaccess <id> none|unlimited
    const accMatch = text.match(/^\/setaccess\s+(\d+)\s+(none|unlimited)\s*$/i);
    if (accMatch) {
        const tgId = parseInt(accMatch[1], 10);
        const level = accMatch[2].toLowerCase();
        const updated = await User.findOneAndUpdate(
            { telegramId: tgId },
            { $set: { accessLevel: level } },
            { new: true }
        );
        if (!updated) {
            await api.sendMessage(chatId, `❌ Користувача ${tgId} не знайдено.`);
        } else {
            await api.sendMessage(chatId, `✅\n${formatUserLine(updated)}`, { parse_mode: 'HTML' });
        }
        return true;
    }

    // Any other text in admin chat → show menu
    if (text) {
        try {
            await sendAdminMenu(api, chatId, null, msg.message_thread_id);
        } catch (e) {
            await api
                .sendMessage(
                    chatId,
                    `❌ Не вдалося показати меню: ${escapeHtml(e.message)}\n` +
                        `chat=${chatId} thread=${msg.message_thread_id ?? '—'} ADMIN=${ADMIN_CHAT_ID()}`,
                    { parse_mode: 'HTML', ...sameThread }
                )
                .catch(() => {});
        }
    }
    return true;
}



/**
 * Increment usage counters after successful delivery.
 * type: 'evening' | 'alert'
 */
async function incrementUsage(telegramId, type) {
    if (!telegramId) return;
    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    try {
        const user = await User.findOne({ telegramId });
        if (!user) return;
        ensureMonthCounters(user);
        if (!user.usage) user.usage = {};
        user.usage.monthKey = monthKey;
        if (type === 'evening') {
            user.usage.eveningThisMonth = (user.usage.eveningThisMonth || 0) + 1;
            user.usage.eveningTotal = (user.usage.eveningTotal || 0) + 1;
        } else {
            user.usage.alertsThisMonth = (user.usage.alertsThisMonth || 0) + 1;
            user.usage.alertsTotal = (user.usage.alertsTotal || 0) + 1;
        }
        user.markModified('usage');
        await user.save();
    } catch (e) {
        console.error('[admin] incrementUsage failed:', e.message);
    }
}


/**
 * Ping ERROR topic when a user hits a handler error (button / text / etc.).
 * Also persists a short row in ErrorLog (source: user).
 */
const _recentUserErrors = new Map(); // key -> ts, debounce 8s

async function notifyUserError(from, err, extra = {}) {
    const _msgKey = [
        from && from.id,
        extra && extra.where,
        (err && err.message) || String(err || '')
    ].join('|').slice(0, 240);
    const _now = Date.now();
    const _prev = _recentUserErrors.get(_msgKey);
    if (_prev && _now - _prev < 8000) return;
    _recentUserErrors.set(_msgKey, _now);
    if (_recentUserErrors.size > 200) {
        for (const [k, ts] of _recentUserErrors) {
            if (_now - ts > 60000) _recentUserErrors.delete(k);
        }
    }

    const chatId = ADMIN_CHAT_ID();
    let msg = (err && err.message) || String(err || 'unknown error');
    // strip duplicated "Error: " prefix from Error objects built from user text
    msg = String(msg).replace(/^Error:\s*/i, '').trim();
    const stack = err && err.stack ? String(err.stack).slice(0, 900) : '';
    const name = from ? displayName(from) : 'невідомий';
    const uname = from && from.username ? `@${from.username}` : '';
    const uid = from && from.id != null ? from.id : null;
    const cb = extra.callbackData ? String(extra.callbackData) : '';
    const where = extra.where ? String(extra.where) : '';

    // Soft UX warning (⚠️ / short missing-data) — no stack trace
    const isSoft =
        /^⚠️/.test(msg) ||
        /недоступн|не готов|немає даних|not (yet )?available|not ready|try again later|спробуйте пізніше/i.test(
            msg
        );

    // Human action description (same as ACTIONS)
    let actionHuman = '';
    try {
        actionHuman = describeUserAction(cb ? 'callback' : where || 'error', extra, null);
    } catch (_) {
        actionHuman = cb || where || '';
    }

    const lines = [];
    if (isSoft) {
        lines.push(`⚠️ <b>Попередження</b>`);
    } else {
        lines.push(`🚨 <b>Помилка в боті</b>`);
    }

    if (uid != null) {
        lines.push(
            `👤 <b>${escapeHtml(name)}</b>` +
                (uname ? ` · ${escapeHtml(uname)}` : '') +
                ` · <code>${uid}</code> · #u${uid}`
        );
    } else {
        lines.push(`👤 ${escapeHtml(name)}`);
    }

    if (actionHuman && actionHuman !== 'натиснув кнопку') {
        lines.push(`⚡ Дія: ${escapeHtml(actionHuman)}`);
    } else if (cb) {
        lines.push(`⚡ Дія: натиснув <code>${escapeHtml(cb.slice(0, 120))}</code>`);
    }

    if (extra.messageText) {
        lines.push(`💬 ${escapeHtml(String(extra.messageText).slice(0, 300))}`);
    }

    lines.push(`📝 ${escapeHtml(msg.slice(0, 500))}`);

    // Stack only for real exceptions, not soft "data not ready" messages
    if (!isSoft && stack) {
        const frames = stack.split('\n').filter((l) => /^\s*at /.test(l)).slice(0, 4);
        if (frames.length) {
            lines.push(`<pre>${escapeHtml(frames.join('\n'))}</pre>`);
        }
    }

    const text = lines.join('\n');

    if (chatId) {
        const bot = getBot();
        try {
            await bot.api.sendMessage(chatId, text, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                ...threadOpts('ERRORS')
            });
        } catch (e) {
            console.error('[admin] notifyUserError send failed:', e.message);
        }
    }

    try {
        await ErrorLog.create({
            source: 'user',
            message: [
                uid != null ? `uid=${uid}` : '',
                cb ? `cb=${cb.slice(0, 120)}` : '',
                where ? `where=${where}` : '',
                msg
            ]
                .filter(Boolean)
                .join(' | ')
                .slice(0, 1500)
        });
    } catch (e) {
        console.error('[admin] notifyUserError ErrorLog failed:', e.message);
    }
}

module.exports = {
    isAdminChat,
    notifyAdmin,
    notifyUserError,
    touchUserProfile,
    ensureMonthCounters,
    incrementUsage,
    formatUserLine,
    adminKeyboard,
    sendAdminMenu,
    handleAdminCallback,
    handleAdminChannelText,
    appendSupportConversation,
    logDeliveryToHistory,
    accessLabel,
    ADMIN_CHAT_ID
};
