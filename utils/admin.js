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
    const geomag = u?.geomagMode || 'quiet';
    const cropsN = Array.isArray(u?.crops) ? u.crops.length : 0;
    const temp = u?.lastState?.temp != null ? `${Math.round(u.lastState.temp)}°C` : '—';

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
    <tr><td align="left">Вечірній</td><td align="left">${evening}</td></tr>
    <tr><td align="left">Geomag</td><td align="left"><code>${escapeHtml(geomag)}</code></td></tr>
    <tr><td align="left">Культур</td><td align="left"><b>${cropsN}</b></td></tr>
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
async function notifyAdmin(from, actionText, extra = {}) {
    const chatId = ADMIN_CHAT_ID();
    if (!chatId || !from) return;

    // Don't echo admin channel activity
    if (extra.chatId && isAdminChat(extra.chatId)) return;

    const bot = getBot();
    const name = displayName(from);
    const uname = from.username ? `@${from.username}` : 'без @username';

    // Стан ДО toggle (notify викликається раніше обробки callback у bot.js)
    let userSnapshot = null;
    if (extra.callbackData || actionText === 'callback') {
        try {
            userSnapshot = await User.findOne({ telegramId: from.id }).lean();
        } catch (_) {
            /* ignore */
        }
    }
    const humanAction = describeUserAction(actionText, extra, userSnapshot);

    // Текст, який юзер пише боту → USERS; усе інше (кліки) → ACTIONS
    const isUserText =
        Boolean(extra.messageText) ||
        actionText === 'текст' ||
        actionText === 'text';

    let text =
        `👤 <b>${escapeHtml(name)}</b>\n` +
        `${escapeHtml(uname)}\n` +
        `ID: <code>${from.id}</code>\n` +
        `⚡ Дія: ${escapeHtml(humanAction)}`;

    if (extra.messageText) {
        text += `\n\n💬 ${escapeHtml(String(extra.messageText).slice(0, 500))}`;
    }
    // Сирий callback — лише якщо опис його не «з'їв» (fallback «натиснув кнопку …»)
    if (extra.callbackData && humanAction.includes(extra.callbackData)) {
        text += `\n🔘 <code>${escapeHtml(extra.callbackData)}</code>`;
    }
    text += `\n\n<i>↩️ Reply → надіслати юзеру</i>`;

    const destThread = isUserText ? threadOpts('USERS') : threadOpts('ACTIONS');
    // fallback: якщо ACTIONS не налаштовано — старе поводження (USERS)
    const thread =
        !isUserText && destThread.message_thread_id == null
            ? threadOpts('USERS')
            : destThread;

    const markup = {
        inline_keyboard: [
            [{ text: '👤 Інфо про користувача', callback_data: `adm|userinfo|${from.id}` }]
        ]
    };

    const sendOpts = {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: markup,
        ...thread
    };

    let sentOk = false;
    try {
        await bot.api.sendMessage(chatId, text, sendOpts);
        sentOk = true;
    } catch (e) {
        console.error('[admin] notify sendMessage failed:', e.message);
        try {
            await bot.api.sendMessage(
                chatId,
                `👤 ${name}\nID: ${from.id}\nДія: ${humanAction}` +
                    (extra.messageText ? `\n\n${String(extra.messageText).slice(0, 500)}` : ''),
                { reply_markup: markup, ...thread }
            );
            sentOk = true;
        } catch (e2) {
            console.error('[admin] notify fallback failed:', e2.message);
        }
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
}

/** Extract user telegram id from an admin notification / reply_to message */
function extractUserIdFromNotifyText(raw) {
    if (raw == null) return null;
    // Accept full reply_to_message object or plain string
    let s;
    if (typeof raw === 'object') {
        const parts = [
            raw.text,
            raw.caption,
            raw.quote?.text,
            // last resort: stringify (rich / partial payloads)
            JSON.stringify(raw)
        ].filter(Boolean);
        s = parts.join('\n');
    } else {
        s = String(raw);
    }
    const patterns = [
        /ID:\s*(\d{5,15})/i,
        /\bID[:\s]+(\d{5,15})\b/i,
        /#u(\d{5,15})\b/,
        /користувачу\s+(\d{5,15})/i,
        /user[_\s-]?id[:\s]+(\d{5,15})/i,
        // bare telegram id in code/tags
        /(?:^|[^\d])(\d{8,15})(?:[^\d]|$)/
    ];
    for (const re of patterns) {
        const m = s.match(re);
        if (m) {
            const id = parseInt(m[1], 10);
            // skip obvious non-user ids (too short already filtered)
            if (id > 99999) return id;
        }
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
            await sendAdminMenu(api, chatId, ctx.callbackQuery.message.message_id);
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
                errorsTotal,
                recentErrors
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
                ErrorLog.countDocuments().catch(() => 0),
                ErrorLog.find({}).sort({ createdAt: -1 }).limit(5).lean().catch(() => [])
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

            // Strip HTML / box-drawing junk from old ErrorLog entries so "Останні" stays clean
            const cleanErrMsg = (raw) => {
                let s = String(raw || '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/[┏┓┗┛┃│┌└─━═]+/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                if (s.length > 70) s = s.slice(0, 67) + '…';
                return escapeHtml(s) || '—';
            };

            const errRows = (recentErrors || []).length
                ? recentErrors
                    .map((e) => {
                        const t = new Date(e.createdAt).toLocaleString('uk-UA', {
                            timeZone: 'Europe/Kyiv',
                            day: '2-digit',
                            month: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit'
                        });
                        return `<tr><td align="left">${t}</td><td align="left">${cleanErrMsg(e.message)}</td></tr>`;
                    })
                    .join('')
                : '<tr><td colspan="2" align="center">Помилок ще не зафіксовано</td></tr>';

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

<h3>❌ Помилки</h3>
<p>Цього місяця: <b>${errorsThisMonth}</b> · всього: <b>${errorsTotal}</b></p>
<table bordered striped>
  <thead>
    <tr><th align="left">Час</th><th align="left">Повідомлення</th></tr>
  </thead>
  <tbody>
    ${errRows}
  </tbody>
</table>
`.trim();

            try {
                await api.sendRichMessage(chatId, {
                    html,
                    skip_entity_detection: true
                });
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
                await api.sendMessage(chatId, '❌ Невірний ID користувача.');
                return true;
            }
            const u = await User.findOne({ telegramId: tgId }).lean();
            if (!u) {
                await api.sendMessage(chatId, `❌ Користувача <code>${tgId}</code> немає в БД.`, {
                    parse_mode: 'HTML'
                });
                return true;
            }
            const html = buildUserInfoHtml(u);
            const thr =
                ctx.callbackQuery?.message?.message_thread_id != null
                    ? { message_thread_id: ctx.callbackQuery.message.message_thread_id }
                    : threadOpts('USERS');
            try {
                await api.sendRichMessage(chatId, { html, skip_entity_detection: true }, thr);
            } catch (richErr) {
                console.warn('[admin] userinfo rich failed:', richErr.message);
                await api.sendMessage(chatId, html, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                    ...thr
                });
            }
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

/**
 * Send media (or text) from admin reply to a user.
 * Supports: photo, document, video, animation, voice, audio, sticker + caption.
 */
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

    // ── Reply to a user-notification → send text and/or media to that user ──
    const replyTo = msg.reply_to_message;
    if (replyTo && (text || caption || hasMedia) && !(text || '').startsWith('/')) {
        // Pass full message object — text/caption may be empty for some message types
        const targetId = extractUserIdFromNotifyText(replyTo);
        if (targetId) {
            try {
                const kind = await sendAdminReplyToUser(api, targetId, msg);
                if (!kind) {
                    await api.sendMessage(chatId, 'ℹ️ Нічого надсилати (порожня відповідь).', sameThread);
                    return true;
                }
                await api.sendMessage(
                    chatId,
                    `✅ Відповідь (${kind}) надіслано користувачу <code>${targetId}</code>`,
                    { parse_mode: 'HTML', ...sameThread }
                );
            } catch (e) {
                await api.sendMessage(
                    chatId,
                    `❌ Не вдалося надіслати <code>${targetId}</code>: ${escapeHtml(e.message)}\n` +
                        `(Користувач міг не стартувати бота або заблокував його.)`,
                    { parse_mode: 'HTML', ...sameThread }
                );
            }
            return true;
        }
        await api.sendMessage(
            chatId,
            'ℹ️ Відповідь не привʼязана до користувача.\n' +
                'Відповідай на сповіщення з <code>ID: …</code> або використай:\n' +
                '<code>/msg USER_ID текст</code>',
            { parse_mode: 'HTML', ...sameThread }
        );
        return true;
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
            await api.sendMessage(chatId, `✅ Надіслано користувачу <code>${targetId}</code>`, {
                parse_mode: 'HTML'
            });
        } catch (e) {
            await api.sendMessage(
                chatId,
                `❌ Не вдалося надіслати: ${escapeHtml(e.message)}\n` +
                    `(Користувач міг не стартувати бота або заблокував його.)`,
                { parse_mode: 'HTML' }
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

module.exports = {
    isAdminChat,
    notifyAdmin,
    touchUserProfile,
    ensureMonthCounters,
    incrementUsage,
    formatUserLine,
    adminKeyboard,
    sendAdminMenu,
    handleAdminCallback,
    handleAdminChannelText,
    accessLabel,
    ADMIN_CHAT_ID
};
