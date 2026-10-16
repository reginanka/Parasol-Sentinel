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
const {
    kyivDayKey,
    kyivDayKeyDaysAgo,
    incDailyStat,
    sumDailyStatsSince,
    getTodayStats
} = require('./stats');

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
 * Send message into admin forum: try preferred thread → TOPIC_GENERAL → no thread.
 * Avoids 400 "message thread not found" when TOPIC_* is wrong or General has no id.
 */
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
                { text: '🔑 Змінити доступ', callback_data: 'adm|access|0' },
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
                { text: '✉️ Написати користувачу', callback_data: 'adm|msg_user|0' },
                { text: '📣 Написати всім', callback_data: 'adm|msg_all' }
            ],
            [
                { text: '👤 Інфо про 👤', callback_data: 'adm|userinfo_pick|0' },
                { text: '🧹 Очистити метрики', callback_data: 'adm|clean_metrics_pick|0' }
            ],
            [
                { text: '🔄 Оновити меню', callback_data: 'adm|menu' }
            ]
        ]
    };
}

/** Застарілі ключі метрик (вже не в меню). Denylist — майбутні ключі не чіпаємо. */
const DEPRECATED_METRICS = new Set(['pollen', 'solar', 'ozone']);

/**
 * Прибрати deprecated + міграція legacy 'aqi' → aqi_now/main/ext.
 * @returns {{ metrics: string[], changed: boolean, removed: string[] }}
 */
function cleanEnabledMetrics(raw) {
    const original = Array.isArray(raw) ? [...raw] : [];
    let metrics = original.filter((m) => !DEPRECATED_METRICS.has(m));
    const removed = original.filter((m) => DEPRECATED_METRICS.has(m));
    if (metrics.includes('aqi')) {
        metrics = metrics.filter((m) => m !== 'aqi');
        removed.push('aqi');
        for (const k of ['aqi_now', 'aqi_main', 'aqi_ext']) {
            if (!metrics.includes(k)) metrics.push(k);
        }
    }
    const changed =
        removed.length > 0 ||
        metrics.length !== original.length ||
        metrics.some((m, i) => m !== original[i]);
    return { metrics, changed, removed: [...new Set(removed)] };
}

/** Inline «🔄 Оновити» для аналітики / інфо. */
function refreshMarkup(callbackData) {
    return {
        inline_keyboard: [[{ text: '🔄 Оновити', callback_data: callbackData }]]
    };
}

/**
 * Клік «🔄 Оновити» саме на картці аналітики / інфо.
 * НЕ спрацьовує на головному меню («🔄 Оновити меню»).
 * Ознака: одна кнопка в розмітці, текст рівно «🔄 Оновити» (без «меню»),
 * callback_data = adm|stats або adm|userinfo|…
 */
function isRefreshClick(msg) {
    const rows = msg?.reply_markup?.inline_keyboard || [];
    if (rows.length !== 1 || (rows[0] || []).length !== 1) return false;
    const b = rows[0][0] || {};
    const t = String(b.text || '').trim();
    const cb = String(b.callback_data || '');
    if (t.includes('меню') || t.includes('Меню')) return false;
    if (t !== '🔄 Оновити' && !/^🔄\s*Оновити$/.test(t)) return false;
    return cb === 'adm|stats' || /^adm\|userinfo\|\d+$/.test(cb);
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

/** Map crop keys (tomato, lawn_grass…) to Ukrainian labels from CROPS_DATA. */
function cropLabelUk(key) {
    for (const cat of Object.values(CROPS_DATA || {})) {
        if (cat?.items?.[key]?.uk) return cat.items[key].uk;
    }
    return key;
}

function formatCropsList(crops) {
    const list = Array.isArray(crops) ? crops : [];
    if (!list.length) return '—';
    return list.map(cropLabelUk).join(', ');
}

/** Resolve geomag mode with legacy fallback (same logic as bot.js). */
function resolveGeomagModeAdmin(u) {
    if (u?.geomagMode === 'active' || u?.geomagMode === 'quiet' || u?.geomagMode === 'off') {
        return u.geomagMode;
    }
    return (u?.alertTriggers?.magneticStorm === false) ? 'off' : 'quiet';
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
    const geomagModes = {
        active: 'активний (усі зміни)',
        quiet: 'тихий',
        off: 'вимкнено'
    };
    const geomagMode = resolveGeomagModeAdmin(u);
    const geomag = geomagModes[geomagMode] || geomagMode || 'тихий';
    const cropsList = Array.isArray(u?.crops) ? u.crops : [];
    const cropsN = cropsList.length;
    const cropsStr = formatCropsList(cropsList);
    const temp = u?.lastState?.temp != null ? `${Math.round(u.lastState.temp)}°C` : '—';
    // tgMeta + legacy flat fields (якщо раніше писали в корінь документа)
    const m = resolveTgMetaDisplay(u, from);

    const units = u?.units || {};
    const windU = units.wind === 'kmh' ? 'км/год' : 'м/с';
    const pressU = units.pressure === 'hpa' ? 'гПа' : 'мм рт. ст.';
    const tempU = units.temp === 'f' ? '°F' : '°C';

    const daysCount = u?.forecastSettings?.daysCount ?? 3;
    let metrics = u?.forecastSettings?.enabledMetrics || [];
    if (metrics.includes('aqi')) {
        metrics = metrics.filter((x) => x !== 'aqi').concat(['aqi_now', 'aqi_main', 'aqi_ext']);
    }
    const metricsStr = metrics.length
        ? metrics.map((x) => METRIC_NAMES_UA[x] || x).join(', ')
        : 'немає';

    const triggers = u?.alertTriggers || {};
    const alertLine = (key, label) =>
        `${triggers[key] === false ? '⬜️' : '✅'} ${label}`;
    // Магнітні бурі — окремі режими (active / quiet / off), назви як у налаштуваннях
    const geomagMark = (mode) => (geomagMode === mode ? '✅' : '⬜️');
    const alertsStr =
        [
            alertLine('temperature', 'температура'),
            alertLine('precip', 'опади'),
            alertLine('airQuality', 'якість повітря')
        ].join('<br>') +
        '<br>' +
        [
            `${geomagMark('active')} всі сповіщ. магн.бур`,
            `${geomagMark('quiet')} тихий`,
            `${geomagMark('off')} без сповіщ. магн.бур`
        ].join('<br>');

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
  </tbody>
</table>

<details>
<summary>🌱 Культури${cropsN ? ` (${cropsN})` : ''}</summary>
${cropsN
    ? `<p>${cropsList.map((k) => escapeHtml(cropLabelUk(k))).join('<br>')}</p>`
    : '<p>—</p>'}
</details>

<details>
<summary>⚙️ Налаштування</summary>
<table bordered striped>
  <thead>
    <tr><th align="left">Параметр</th><th align="left">Значення</th></tr>
  </thead>
  <tbody>
    <tr><td align="left">Одиниці</td><td align="left">${windU}<br>${pressU}<br>${tempU}</td></tr>
    <tr><td align="left">Днів у прогнозі</td><td align="left"><b>${daysCount}</b></td></tr>
    <tr><td align="left">Метрики вечірнього</td><td align="left">${escapeHtml(metricsStr)}</td></tr>
    <tr><td align="left">Алерти</td><td align="left">${alertsStr}</td></tr>
  </tbody>
</table>
</details>

<details>
<summary>📬 Доставка</summary>
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
</details>

<details>
<summary>📅 Активність</summary>
<table bordered striped>
  <thead>
    <tr><th align="left">Дата</th><th align="left">Значення</th></tr>
  </thead>
  <tbody>
    <tr><td align="left">📅 Реєстрація</td><td align="left">${escapeHtml(fmtUaDate(u?.createdAt))}</td></tr>
    <tr><td align="left">🕐 Остання активність</td><td align="left">${escapeHtml(fmtUaDate(u?.lastActivityAt))}</td></tr>
  </tbody>
</table>
</details>

<details>
<summary>🛠 Системні</summary>
<table bordered striped>
  <thead>
    <tr><th align="left">Поле</th><th align="left">Значення</th></tr>
  </thead>
  <tbody>
    <tr><td align="left">Telegram ID</td><td align="left"><code>${tgId}</code></td></tr>
    <tr><td align="left">Це бот</td><td align="left">${ynTg(m.isBot)}</td></tr>
    <tr><td align="left">Ім'я</td><td align="left">${escapeHtml(u?.firstName || from?.first_name || '—')}</td></tr>
    <tr><td align="left">Прізвище</td><td align="left">${escapeHtml(u?.lastName || from?.last_name || '—')}</td></tr>
    <tr><td align="left">Username</td><td align="left">${escapeHtml(uname)}</td></tr>
    <tr><td align="left">Мова клієнта TG</td><td align="left"><code>${escapeHtml(tgLang)}</code></td></tr>
    <tr><td align="left">Telegram Premium</td><td align="left">${ynTg(m.isPremium)}</td></tr>
    <tr><td align="left">У меню вкладень</td><td align="left">${ynTg(m.addedToAttachmentMenu)}</td></tr>
    <tr><td align="left">Може вступати в групи</td><td align="left">${ynTg(m.canJoinGroups)}</td></tr>
    <tr><td align="left">Читає всі повідомлення в групах</td><td align="left">${ynTg(m.canReadAllGroupMessages)}</td></tr>
    <tr><td align="left">Підтримує inline-запити</td><td align="left">${ynTg(m.supportsInlineQueries)}</td></tr>
    <tr><td align="left">Підключення до Business</td><td align="left">${ynTg(m.canConnectToBusiness)}</td></tr>
    <tr><td align="left">Є головний Web App</td><td align="left">${ynTg(m.hasMainWebApp)}</td></tr>
    <tr><td align="left">Join request queries</td><td align="left">${ynTg(m.joinToSendMessages)}</td></tr>
    <tr><td align="left">Guest queries</td><td align="left">${ynTg(m.hasGuestQueries)}</td></tr>
    <tr><td align="left">Оновлено з TG</td><td align="left">${escapeHtml(fmtUaDate(m.updatedAt))}</td></tr>
  </tbody>
</table>
</details>
`.trim();
}

/** ✅ так / ❌ ні / — for Telegram boolean flags */
function ynTg(v) {
    if (v === true) return '✅ так';
    if (v === false) return '❌ ні';
    return '—';
}

/**
 * Зібрати tg-прапорці для «Системні» з tgMeta + legacy-полів у корені User + from.
 * Не губить дані, якщо вони лежали під іншими ключами в БД.
 */
function resolveTgMetaDisplay(u, from = null) {
    const t = (u && u.tgMeta) || {};
    const pick = (...vals) => {
        for (const v of vals) {
            if (typeof v === 'boolean') return v;
        }
        return null;
    };
    return {
        isBot: pick(t.isBot, u?.isBot, u?.is_bot, from?.is_bot),
        isPremium: pick(t.isPremium, u?.isPremium, u?.is_premium, from?.is_premium),
        addedToAttachmentMenu: pick(
            t.addedToAttachmentMenu,
            u?.addedToAttachmentMenu,
            u?.added_to_attachment_menu,
            from?.added_to_attachment_menu
        ),
        canJoinGroups: pick(t.canJoinGroups, u?.canJoinGroups, u?.can_join_groups),
        canReadAllGroupMessages: pick(
            t.canReadAllGroupMessages,
            u?.canReadAllGroupMessages,
            u?.can_read_all_group_messages
        ),
        supportsInlineQueries: pick(
            t.supportsInlineQueries,
            u?.supportsInlineQueries,
            u?.supports_inline_queries
        ),
        canConnectToBusiness: pick(
            t.canConnectToBusiness,
            u?.canConnectToBusiness,
            u?.can_connect_to_business
        ),
        hasMainWebApp: pick(t.hasMainWebApp, u?.hasMainWebApp, u?.has_main_web_app),
        joinToSendMessages: pick(
            t.joinToSendMessages,
            u?.joinToSendMessages,
            u?.join_to_send_messages
        ),
        hasGuestQueries: pick(t.hasGuestQueries, u?.hasGuestQueries, u?.has_guest_queries),
        updatedAt: t.updatedAt || u?.tgMetaUpdatedAt || u?.tgUpdatedAt || null
    };
}

/**
 * Same profile as buildUserInfoHtml, but only Telegram-safe HTML tags
 * (b, i, code — no h1/table). For sendMessage / editMessageText fallback.
 */
function buildUserInfoPlain(u, from = null) {
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
    const geomagModes = {
        active: 'активний (усі зміни)',
        quiet: 'тихий',
        off: 'вимкнено'
    };
    const geomagMode = resolveGeomagModeAdmin(u);
    const geomag = geomagModes[geomagMode] || geomagMode || 'тихий';
    const cropsList = Array.isArray(u?.crops) ? u.crops : [];
    const cropsN = cropsList.length;
    const cropsStr = formatCropsList(cropsList);
    const temp = u?.lastState?.temp != null ? `${Math.round(u.lastState.temp)}°C` : '—';

    const units = u?.units || {};
    const windU = units.wind === 'kmh' ? 'км/год' : 'м/с';
    const pressU = units.pressure === 'hpa' ? 'гПа' : 'мм рт. ст.';
    const tempU = units.temp === 'f' ? '°F' : '°C';

    const daysCount = u?.forecastSettings?.daysCount ?? 3;
    let metrics = u?.forecastSettings?.enabledMetrics || [];
    if (metrics.includes('aqi')) {
        metrics = metrics.filter((m) => m !== 'aqi').concat(['aqi_now', 'aqi_main', 'aqi_ext']);
    }
    const metricsStr = metrics.length
        ? metrics.map((m) => METRIC_NAMES_UA[m] || m).join(', ')
        : 'немає';

    const triggers = u?.alertTriggers || {};
    const alertLine = (key, label) =>
        `${triggers[key] === false ? '⬜️' : '✅'} ${label}`;
    // Магнітні бурі — окремі режими (active / quiet / off), назви як у налаштуваннях
    const geomagMark = (m) => (geomagMode === m ? '✅' : '⬜️');
    const alertsStr =
        [
            alertLine('temperature', 'температура'),
            alertLine('precip', 'опади'),
            alertLine('airQuality', 'якість повітря')
        ].join('\n') +
        '\n' +
        [
            `${geomagMark('active')} всі сповіщ. магн.бур`,
            `${geomagMark('quiet')} тихий`,
            `${geomagMark('off')} без сповіщ. магн.бур`
        ].join('\n');

    return (
        `👤 <b>${escapeHtml(name)}</b>\n` +
        `${escapeHtml(uname)} · ID: <code>${tgId}</code>\n\n` +
        `${accessIcon} Доступ: <b>${escapeHtml(access)}</b>\n` +
        `Мова TG / бот: <code>${escapeHtml(tgLang)}</code> / <code>${escapeHtml(botLang)}</code>\n` +
        `📍 Місто: ${escapeHtml(city)}\n` +
        `Гео: <code>${geo}</code>\n` +
        `TZ: <code>${escapeHtml(tz)}</code>\n` +
        `Темп. зараз: <b>${temp}</b>\n` +
        `Сповіщення: ${notif}\n` +
        `Вечірній: ${evening}\n\n` +
        `<b>🌱 Культури${cropsN ? ` (${cropsN})` : ''}</b>\n` +
        `${cropsN ? escapeHtml(cropsStr) : '—'}\n\n` +
        `<b>⚙️ Налаштування</b>\n` +
        `Одиниці: ${windU}\n${pressU}\n${tempU}\n` +
        `Днів у прогнозі: <b>${daysCount}</b>\n` +
        `Метрики: ${escapeHtml(metricsStr)}\n` +
        `Алерти: ${escapeHtml(alertsStr)}\n\n` +
        `<b>📬 Доставка</b>\n` +
        `🌆 Вечірні: <b>${eveningM}</b> / <b>${eveningT}</b> (міс/всього)\n` +
        `🚨 Алерти: <b>${alertsM}</b> / <b>${alertsT}</b>\n` +
        `Разом: <b>${eveningM + alertsM}</b> / <b>${eveningT + alertsT}</b>\n\n` +
        `<b>📅 Активність</b>\n` +
        `📅 Реєстрація: ${escapeHtml(fmtUaDate(u?.createdAt))}\n` +
        `🕐 Остання активність: ${escapeHtml(fmtUaDate(u?.lastActivityAt))}`
    );
}

/**
 * Notify admin about a user action — short card + button «Інфо».
 * Reply to this message → send text/media to the user (ID: in text).
 */
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
        if (actionText === 'текст') return 'надіслав текст (пошук міста або повідомлення)';
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
            // legacy aqi
            if (metrics.includes('aqi') && ['aqi_now', 'aqi_main', 'aqi_ext'].includes(key)) {
                const wasOn = true; // treated as on before first split
                return `${onOff(!wasOn)} метрику «${m}» у вечірньому прогнозі`;
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

    // Fallback: still human-ish
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

    // Історія гілки — лише для реального тексту (акордеон <details> у rich message)
    let histSnippet = '';
    if (extra.messageText) {
        try {
            const uHist = await User.findOne({ telegramId: from.id })
                .select('supportHistory.transcript')
                .lean();
            const rawHist = uHist?.supportHistory?.transcript || '';
            const lines = rawHist.split('\n').filter(Boolean);
            if (lines.length) {
                histSnippet = lines.slice(-8).join('\n');
                if (histSnippet.length > 1200) {
                    histSnippet = '…\n' + histSnippet.slice(histSnippet.length - 1200);
                }
            }
        } catch (e) {
            console.warn('[admin] history snippet failed:', e.message);
        }
    }

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

    // Plain HTML (sendMessage fallback) — ID обовʼязково для Reply
    let text =
        `👤 <b>${escapeHtml(name)}</b>\n` +
        `${escapeHtml(uname)}\n` +
        `ID: <code>${from.id}</code>\n` +
        `⚡ Дія: ${escapeHtml(humanAction)}`;
    if (extra.messageText) {
        text += `\n\n💬 ${escapeHtml(String(extra.messageText).slice(0, 500))}`;
    }
    if (extra.callbackData && humanAction.includes(extra.callbackData)) {
        text += `\n🔘 <code>${escapeHtml(extra.callbackData)}</code>`;
    }
    if (histSnippet) {
        text +=
            `\n\n📜 <b>Останні повідомлення:</b>\n` +
            `<blockquote expandable>${escapeHtml(histSnippet)}</blockquote>`;
    }
    text += `\n\n<i>↩️ Reply → надіслати юзеру</i>`;
    if (text.length > 4000) text = text.slice(0, 3990) + '…';

    // Rich Message з акордеоном <details> (як аналітика / інфо)
    const richParts = [
        `<h2>👤 ${escapeHtml(name)}</h2>`,
        `<p>${escapeHtml(uname)} · ID: <code>${from.id}</code></p>`,
        `<p>⚡ Дія: ${escapeHtml(humanAction)}</p>`
    ];
    if (extra.messageText) {
        richParts.push(`<p>💬 ${escapeHtml(String(extra.messageText).slice(0, 500))}</p>`);
    }
    if (extra.callbackData && humanAction.includes(extra.callbackData)) {
        richParts.push(`<p>🔘 <code>${escapeHtml(extra.callbackData)}</code></p>`);
    }
    if (histSnippet) {
        richParts.push(
            `<details><summary>📜 Останні повідомлення</summary>` +
                `<p>${escapeHtml(histSnippet).replace(/\n/g, '<br>')}</p>` +
                `</details>`
        );
    }
    richParts.push(`<p><i>↩️ Reply → надіслати юзеру</i></p>`);
    // Прихований ID для extractUserIdFromNotifyText (якщо rich не кладе текст у .text)
    richParts.push(`<p><code>ID: ${from.id}</code></p>`);
    const richHtml = richParts.join('\n');

    let sentOk = false;
    try {
        await bot.api.sendRichMessage(
            chatId,
            { html: richHtml, skip_entity_detection: true },
            { reply_markup: markup, ...thread }
        );
        sentOk = true;
    } catch (e) {
        console.warn('[admin] notify rich failed, plain:', e.message);
        try {
            await bot.api.sendMessage(chatId, text, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_markup: markup,
                ...thread
            });
            sentOk = true;
        } catch (e2) {
            console.error('[admin] notify fallback failed:', e2.message);
        }
    }

    // Успішна фіксація дії юзера → денний лічильник actions
    if (sentOk) {
        incDailyStat('actions').catch(() => {});
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

    // Mirror only real user text into HISTORY conversation card (not every button tap)
    if (extra.messageText) {
        try {
            await appendSupportConversation(bot.api, from.id, '👤 Юзер', String(extra.messageText));
        } catch (e) {
            console.warn('[admin] support log from notify failed:', e.message);
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

/** true if reply target is «надіслати всім» instruction */
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

/**
 * Broadcast admin media/text to all users with access ≠ none.
 * Returns { ok, fail, total }.
 */
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

/**
 * Map Telegram User / Chat object → tgMeta fields we store.
 * Only sets keys that are actually present on the payload.
 */
function extractTgMeta(fromOrChat) {
    if (!fromOrChat || typeof fromOrChat !== 'object') return null;
    const meta = {};
    const setBool = (key, ...vals) => {
        for (const v of vals) {
            if (typeof v === 'boolean') {
                meta[key] = v;
                return;
            }
        }
    };
    setBool('isBot', fromOrChat.is_bot);
    setBool('isPremium', fromOrChat.is_premium);
    setBool('addedToAttachmentMenu', fromOrChat.added_to_attachment_menu);
    setBool('canJoinGroups', fromOrChat.can_join_groups);
    setBool(
        'canReadAllGroupMessages',
        fromOrChat.can_read_all_group_messages
    );
    setBool('supportsInlineQueries', fromOrChat.supports_inline_queries);
    setBool('canConnectToBusiness', fromOrChat.can_connect_to_business);
    setBool('hasMainWebApp', fromOrChat.has_main_web_app);
    setBool(
        'joinToSendMessages',
        fromOrChat.join_to_send_messages,
        fromOrChat.can_join_join_request
    );
    setBool('hasGuestQueries', fromOrChat.has_guest_queries);
    if (Object.keys(meta).length === 0) return null;
    meta.updatedAt = new Date();
    return meta;
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
            'usage.dayKey': kyivDayKey(now),
            'usage.eveningThisMonth': 0,
            'usage.alertsThisMonth': 0,
            'usage.eveningToday': 0,
            'usage.alertsToday': 0,
            'usage.eveningTotal': 0,
            'usage.alertsTotal': 0
        }
    };

    const meta = extractTgMeta(from);
    if (meta) {
        for (const [k, v] of Object.entries(meta)) {
            update.$set[`tgMeta.${k}`] = v;
        }
    }

    // Avoid overwriting username with undefined
    Object.keys(update.$set).forEach((k) => {
        if (update.$set[k] === undefined) delete update.$set[k];
    });

    // Кожна взаємодія юзера → денний лічильник activity
    incDailyStat('activity').catch(() => {});

    return User.findOneAndUpdate(
        { telegramId: from.id },
        update,
        { upsert: true, new: true }
    );
}

/**
 * Reset monthly / daily counters if period changed (Kyiv calendar for day).
 */
function ensureMonthCounters(user) {
    if (!user) return user;
    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const dayKey = kyivDayKey(now);
    if (!user.usage) user.usage = {};
    if (user.usage.monthKey !== monthKey) {
        user.usage.monthKey = monthKey;
        user.usage.eveningThisMonth = 0;
        user.usage.alertsThisMonth = 0;
    }
    if (user.usage.dayKey !== dayKey) {
        user.usage.dayKey = dayKey;
        user.usage.eveningToday = 0;
        user.usage.alertsToday = 0;
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
            return { edited: true, messageId };
        } catch (e) {
            const msg = e?.message || String(e);
            // Telegram: same text+markup → "message is not modified" — це успіх, не слати нове
            if (/message is not modified/i.test(msg)) {
                return { edited: true, messageId, unchanged: true };
            }
            console.warn('[admin] sendAdminMenu edit failed:', msg);
            // Не шлемо дубль, якщо редагування не вдалось з іншої причини —
            // лише коли messageId не передавали (нове меню з /admin).
            return { edited: false, messageId, error: msg };
        }
    }

    const sent = await sendInAdminThread(api, chatId, text, base, preferredThreadId);
    return { edited: false, messageId: sent?.message_id };
}


/**
 * Edit the callback message in-place (remove buttons), or fall back to send in same thread.
 * Used so confirm → "starting" → result all stay on one message.
 */
async function editCallbackMessage(api, ctx, text, extra = {}) {
    const msg = ctx.callbackQuery?.message;
    const chatId = msg?.chat?.id;
    const messageId = msg?.message_id;
    const opts = { parse_mode: 'HTML', ...extra };
    // Clear buttons unless caller explicitly passes reply_markup
    if (!Object.prototype.hasOwnProperty.call(extra, 'reply_markup')) {
        opts.reply_markup = { inline_keyboard: [] };
    }
    if (chatId != null && messageId != null) {
        try {
            await api.editMessageText(chatId, messageId, text, opts);
            return { edited: true, messageId };
        } catch (e) {
            console.warn('[admin] editCallbackMessage failed:', e.message);
        }
    }
    const preferred =
        msg?.message_thread_id != null ? msg.message_thread_id : topicId('GENERAL');
    // strip any stale thread from opts — sendInAdminThread owns it
    const { message_thread_id: _drop, ...rest } = opts;
    const sent = await sendInAdminThread(api, chatId, text, rest, preferred);
    return { edited: false, messageId: sent?.message_id };
}

/**
 * Edit a specific message by id (after we already know messageId from previous step).
 */
async function editMessageById(api, chatId, messageId, text, extra = {}, threadId = null) {
    const opts = { parse_mode: 'HTML', ...extra };
    if (!Object.prototype.hasOwnProperty.call(extra, 'reply_markup')) {
        opts.reply_markup = { inline_keyboard: [] };
    }
    if (messageId != null) {
        try {
            await api.editMessageText(chatId, messageId, text, opts);
            return true;
        } catch (e) {
            console.warn('[admin] editMessageById failed:', e.message);
        }
    }
    const preferred = threadId != null ? threadId : topicId('GENERAL');
    const { message_thread_id: _drop, ...rest } = opts;
    await sendInAdminThread(api, chatId, text, rest, preferred);
    return false;
}

/**
 * Start a new admin scenario as a SEPARATE message (keeps main menu intact).
 * Same forum topic as the callback message.
 */
async function startScenarioMessage(api, ctx, text, extra = {}) {
    const msg = ctx.callbackQuery?.message;
    const chatId = msg?.chat?.id;
    const preferred =
        msg?.message_thread_id != null ? msg.message_thread_id : topicId('GENERAL');
    const opts = { parse_mode: 'HTML', ...extra };
    const { message_thread_id: _drop, ...rest } = opts;
    const sent = await sendInAdminThread(api, chatId, text, rest, preferred);
    return sent?.message_id;
}

/** Delete the callback message (cancel / cleanup). */
async function deleteCallbackMessage(api, ctx) {
    const msg = ctx.callbackQuery?.message;
    if (!msg?.chat?.id || msg.message_id == null) return false;
    try {
        await api.deleteMessage(msg.chat.id, msg.message_id);
        return true;
    } catch (e) {
        console.warn('[admin] deleteCallbackMessage failed:', e.message);
        return false;
    }
}

/**
 * After successful outbound message: delete admin reply + bot instruction in General.
 */
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


/**
 * Final step of cron/scenario: show «Зроблено», then delete the scenario message.
 */
async function finishScenarioDone(api, ctx, summaryHtml = '') {
    const msg = ctx.callbackQuery?.message;
    const chatId = msg?.chat?.id;
    const messageId = msg?.message_id;
    const body =
        `✅ <b>Зроблено</b>` + (summaryHtml ? `\n${summaryHtml}` : '');
    if (chatId != null && messageId != null) {
        try {
            await api.editMessageText(chatId, messageId, body, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [] }
            });
        } catch (e) {
            console.warn('[admin] finishScenarioDone edit failed:', e.message);
        }
        try {
            await api.deleteMessage(chatId, messageId);
        } catch (e) {
            console.warn('[admin] finishScenarioDone delete failed:', e.message);
        }
    }
}

/** Paginated user picker for «Написати користувачу». */
function buildMsgUserPage(users, page) {
    const PAGE = ACCESS_PAGE_SIZE;
    const total = users.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE));
    const p = Math.min(Math.max(0, page), totalPages - 1);
    const slice = users.slice(p * PAGE, (p + 1) * PAGE);

    const rows = slice.map((u) => {
        const label =
            (u.username ? `@${u.username}` : u.firstName || String(u.telegramId)) +
            (u.city ? ` · ${u.city}` : '');
        return [
            {
                text: label.slice(0, 60),
                callback_data: `adm|msg_pick|${u.telegramId}`
            }
        ];
    });

    if (totalPages > 1) {
        const nav = [];
        if (p > 0) nav.push({ text: '◀️', callback_data: `adm|msg_user|${p - 1}` });
        nav.push({ text: `${p + 1}/${totalPages}`, callback_data: 'adm|noop|page' });
        if (p < totalPages - 1) nav.push({ text: '▶️', callback_data: `adm|msg_user|${p + 1}` });
        rows.push(nav);
    }
    rows.push([{ text: '❌ Скасувати', callback_data: 'adm|menu' }]);

    const from = total ? p * PAGE + 1 : 0;
    const to = Math.min((p + 1) * PAGE, total);
    const text =
        `✉️ <b>Написати користувачу</b>\n` +
        `<i>Оберіть отримувача (${from}–${to} з ${total})</i>`;
    return { text, reply_markup: { inline_keyboard: rows } };
}

/** Paginated user picker for «Інфо про 👤». */
function buildUserInfoPickPage(users, page) {
    const PAGE = ACCESS_PAGE_SIZE;
    const total = users.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE));
    const p = Math.min(Math.max(0, page), totalPages - 1);
    const slice = users.slice(p * PAGE, (p + 1) * PAGE);

    const rows = slice.map((u) => {
        const label =
            (u.username ? `@${u.username}` : u.firstName || String(u.telegramId)) +
            (u.city ? ` · ${u.city}` : '');
        return [
            {
                text: label.slice(0, 60),
                callback_data: `adm|userinfo|${u.telegramId}`
            }
        ];
    });

    if (totalPages > 1) {
        const nav = [];
        if (p > 0) nav.push({ text: '◀️', callback_data: `adm|userinfo_pick|${p - 1}` });
        nav.push({ text: `${p + 1}/${totalPages}`, callback_data: 'adm|noop|page' });
        if (p < totalPages - 1) nav.push({ text: '▶️', callback_data: `adm|userinfo_pick|${p + 1}` });
        rows.push(nav);
    }
    rows.push([{ text: '❌ Скасувати', callback_data: 'adm|menu' }]);

    const from = total ? p * PAGE + 1 : 0;
    const to = Math.min((p + 1) * PAGE, total);
    const text =
        `👤 <b>Інфо про 👤</b>\n` +
        `<i>Оберіть користувача (${from}–${to} з ${total})</i>`;
    return { text, reply_markup: { inline_keyboard: rows } };
}

/** Paginated user picker for «Очистити метрики». */
function buildCleanMetricsPickPage(users, page) {
    const PAGE = ACCESS_PAGE_SIZE;
    const total = users.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE));
    const p = Math.min(Math.max(0, page), totalPages - 1);
    const slice = users.slice(p * PAGE, (p + 1) * PAGE);

    const rows = slice.map((u) => {
        const raw = u.forecastSettings?.enabledMetrics || [];
        const { changed, removed } = cleanEnabledMetrics(raw);
        const dirty = changed ? ' ⚠️' : '';
        const label =
            (u.username ? `@${u.username}` : u.firstName || String(u.telegramId)) +
            (u.city ? ` · ${u.city}` : '') +
            dirty;
        return [
            {
                text: label.slice(0, 60),
                callback_data: `adm|clean_metrics|${u.telegramId}`
            }
        ];
    });

    if (totalPages > 1) {
        const nav = [];
        if (p > 0) nav.push({ text: '◀️', callback_data: `adm|clean_metrics_pick|${p - 1}` });
        nav.push({ text: `${p + 1}/${totalPages}`, callback_data: 'adm|noop|page' });
        if (p < totalPages - 1) nav.push({ text: '▶️', callback_data: `adm|clean_metrics_pick|${p + 1}` });
        rows.push(nav);
    }
    rows.push([{ text: '🧹 Очистити всім', callback_data: 'adm|clean_metrics_all' }]);
    rows.push([{ text: '❌ Скасувати', callback_data: 'adm|menu' }]);

    const from = total ? p * PAGE + 1 : 0;
    const to = Math.min((p + 1) * PAGE, total);
    const text =
        `🧹 <b>Очистити метрики</b>\n` +
        `<i>Прибирає pollen / solar / ozone + legacy aqi.\n` +
        `⚠️ = є що чистити. Оберіть юзера (${from}–${to} з ${total})</i>`;
    return { text, reply_markup: { inline_keyboard: rows } };
}



/** Users per page in «Змінити доступ» (2 buttons/row → keep under TG limits). */
const ACCESS_PAGE_SIZE = 8;

/**
 * Build keyboard + title for access toggle list (paginated).
 * @returns {{ text: string, reply_markup: object }}
 */
function buildAccessPage(users, page) {
    const total = users.length;
    const totalPages = Math.max(1, Math.ceil(total / ACCESS_PAGE_SIZE));
    const p = Math.min(Math.max(0, page), totalPages - 1);
    const slice = users.slice(p * ACCESS_PAGE_SIZE, (p + 1) * ACCESS_PAGE_SIZE);

    const rows = slice.map((u) => {
        const label = u.username || u.firstName || String(u.telegramId);
        const cur = accessLabel(u.accessLevel || 'unlimited');
        const next = (u.accessLevel || 'unlimited') === 'none' ? 'unlimited' : 'none';
        const nextLabel = next === 'none' ? '🚫 Заборонити' : '✅ Дати безліміт';
        return [
            {
                text: `${String(label).slice(0, 28)} · ${cur}`,
                callback_data: `adm|noop|${u.telegramId}`
            },
            {
                text: nextLabel,
                callback_data: `adm|setaccess|${u.telegramId}|${next}|${p}`
            }
        ];
    });

    // Pagination row
    if (totalPages > 1) {
        const nav = [];
        if (p > 0) {
            nav.push({ text: '◀️', callback_data: `adm|access|${p - 1}` });
        }
        nav.push({
            text: `${p + 1}/${totalPages}`,
            callback_data: 'adm|noop|page'
        });
        if (p < totalPages - 1) {
            nav.push({ text: '▶️', callback_data: `adm|access|${p + 1}` });
        }
        rows.push(nav);
    }

    rows.push([{ text: '◀️ Меню', callback_data: 'adm|menu' }]);

    const from = total ? p * ACCESS_PAGE_SIZE + 1 : 0;
    const to = Math.min((p + 1) * ACCESS_PAGE_SIZE, total);
    const text =
        `🔑 <b>Змінити доступ</b>\n` +
        `<i>Показано ${from}–${to} з ${total}</i>`;

    return {
        text,
        reply_markup: { inline_keyboard: rows }
    };
}

async function handleAdminCallback(ctx) {
    const data = (ctx.callbackQuery?.data || '').split('|');
    if (data[0] !== 'adm') return false;

    const chatId = ctx.callbackQuery.message?.chat?.id;
    if (!isAdminChat(chatId)) {
        await ctx.answerCallbackQuery({ text: '❌ Лише в адмін-каналі' }).catch(() => {});
        return true;
    }

    const api = ctx.api;
    const sub = data[1];

    // Toast on access toggle; otherwise clear loading state immediately
    if (sub === 'setaccess') {
        const level = data[3] === 'none' ? 'none' : 'unlimited';
        await ctx
            .answerCallbackQuery({
                text: level === 'none' ? '🚫 Доступ заборонено' : '✅ Безліміт надано'
            })
            .catch(() => {});
    } else {
        await ctx.answerCallbackQuery().catch(() => {});
    }

    try {
        if (sub === 'menu') {
            const curMsg = ctx.callbackQuery?.message;
            const curText = curMsg?.text || curMsg?.caption || '';
            const isMainMenu =
                curText.includes('Адмін-панель Parasol Sentinel') ||
                curText.includes('Оберіть дію кнопкою');
            if (isMainMenu && curMsg?.message_id != null) {
                // Єдина кнопка, що має перезаписувати повідомлення меню (edit, не send)
                const result = await sendAdminMenu(api, chatId, curMsg.message_id);
                if (!result.edited && result.error) {
                    // Повідомлення зникло / недоступне — тоді вже нове
                    await sendAdminMenu(
                        api,
                        chatId,
                        null,
                        curMsg.message_thread_id ?? topicId('GENERAL')
                    );
                }
            } else {
                // Scenario cancel — delete this message, leave main menu alone
                await deleteCallbackMessage(api, ctx);
            }
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
                errorsCron,
                errorsOther,
                statsToday,
                stats7d,
                stats30d,
                statsMonth,
                statsAll,
                userFailTodayRaw,
                userFailMonthRaw
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
                            eveningToday: {
                                $sum: {
                                    $cond: [
                                        { $eq: ['$usage.dayKey', kyivDayKey()] },
                                        { $ifNull: ['$usage.eveningToday', 0] },
                                        0
                                    ]
                                }
                            },
                            alertsToday: {
                                $sum: {
                                    $cond: [
                                        { $eq: ['$usage.dayKey', kyivDayKey()] },
                                        { $ifNull: ['$usage.alertsToday', 0] },
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
                ErrorLog.countDocuments({ source: 'cron' }).catch(() => 0),
                ErrorLog.countDocuments({ source: { $ne: 'cron' } }).catch(() => 0),
                getTodayStats(),
                sumDailyStatsSince(kyivDayKeyDaysAgo(6)),
                sumDailyStatsSince(kyivDayKeyDaysAgo(29)),
                sumDailyStatsSince(kyivDayKey().slice(0, 8) + '01'),
                sumDailyStatsSince('2000-01-01'),
                // Помилки в діях за сьогодні (ErrorLog, не cron)
                ErrorLog.countDocuments({
                    createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
                    source: { $ne: 'cron' }
                }).catch(() => 0),
                ErrorLog.countDocuments({
                    createdAt: { $gte: monthStart },
                    source: { $ne: 'cron' }
                }).catch(() => 0)
            ]);

            const u = usageAgg[0] || {};
            const eveningM = u.eveningMonth || 0;
            const alertsM = u.alertsMonth || 0;
            const eveningT = u.eveningTotal || 0;
            const alertsT = u.alertsTotal || 0;
            const eveningToday = u.eveningToday || 0;
            const alertsToday = u.alertsToday || 0;

            const actToday = (statsToday && statsToday.activity) || 0;
            const act7 = (stats7d && stats7d.activity) || 0;
            const act30 = (stats30d && stats30d.activity) || 0;
            const actionsToday = (statsToday && statsToday.actions) || 0;
            const actionsMonth = (statsMonth && statsMonth.actions) || 0;
            const actionsTotal = (statsAll && statsAll.actions) || 0;
            const cronOkToday = (statsToday && statsToday.cronOk) || 0;
            const cronOkMonth = (statsMonth && statsMonth.cronOk) || 0;
            const cronOkTotal = (statsAll && statsAll.cronOk) || 0;
            const cronFailToday = (statsToday && statsToday.cronFail) || 0;
            const cronFailMonth = (statsMonth && statsMonth.cronFail) || 0;
            const cronFailTotal = (statsAll && statsAll.cronFail) || 0;

            const cronAttemptsToday = cronOkToday + cronFailToday;
            const cronFailPctToday =
                cronAttemptsToday > 0 ? Math.round((100 * cronFailToday) / cronAttemptsToday) : 0;
            const userFailToday = userFailTodayRaw || 0;
            const userFailMonth = userFailMonthRaw || 0;
            const userFailTotal = errorsOther || 0;
            const actionAttemptsToday = actionsToday || 0;
            const userFailPctToday =
                actionAttemptsToday > 0
                    ? Math.round((100 * userFailToday) / actionAttemptsToday)
                    : 0;

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
            // Помилки — лише кількість (без тексту «коли і що впало»)
            const html = `
<h1>📊 Аналітика Parasol Sentinel</h1>
<p><i>${escapeHtml(monthLabel)} · оновлено зараз</i></p>

<details>
<summary>👥 Користувачі (${total})</summary>
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
</details>

<details>
<summary>🟢 Активність (${active1} / ${actToday})</summary>
<table bordered striped>
  <thead>
    <tr>
      <th align="left">Період</th>
      <th align="center">Юзерів</th>
      <th align="center">Дій</th>
    </tr>
  </thead>
  <tbody>
    <tr><td align="left">Сьогодні / 24г</td><td align="center"><b>${active1}</b></td><td align="center"><b>${actToday}</b></td></tr>
    <tr><td align="left">7 днів</td><td align="center"><b>${active7}</b></td><td align="center"><b>${act7}</b></td></tr>
    <tr><td align="left">30 днів</td><td align="center"><b>${active30}</b></td><td align="center"><b>${act30}</b></td></tr>
  </tbody>
</table>
<p><i>Юзерів — унікальні з lastActivityAt. Дій — кожна взаємодія (touch). У дужках: юзери 24г / дій сьогодні.</i></p>
</details>

<details>
<summary>📬 Доставка (${eveningToday + alertsToday})</summary>
<table bordered striped>
  <thead>
    <tr>
      <th align="left">Показник</th>
      <th align="center">Сьогодні</th>
      <th align="center">Місяць</th>
      <th align="center">Всього</th>
    </tr>
  </thead>
  <tbody>
    <tr><td align="left">🌆 Вечірні</td><td align="center"><b>${eveningToday}</b></td><td align="center"><b>${eveningM}</b></td><td align="center"><b>${eveningT}</b></td></tr>
    <tr><td align="left">🚨 Алерти</td><td align="center"><b>${alertsToday}</b></td><td align="center"><b>${alertsM}</b></td><td align="center"><b>${alertsT}</b></td></tr>
    <tr><td align="left">Разом</td><td align="center"><b>${eveningToday + alertsToday}</b></td><td align="center"><b>${eveningM + alertsM}</b></td><td align="center"><b>${eveningT + alertsT}</b></td></tr>
  </tbody>
</table>
<p><i>У дужках — доставлено сьогодні (вечірні + алерти). День за календарем Києва.</i></p>
</details>

<details>
<summary>🌐 Мови</summary>
<table bordered striped>
  <thead>
    <tr><th align="left">Мова</th><th align="center">К-сть</th></tr>
  </thead>
  <tbody>
    ${langRows}
  </tbody>
</table>
</details>

<details>
<summary>📍 Топ міст</summary>
<table bordered striped>
  <thead>
    <tr><th align="left">Місто</th><th align="center">К-сть</th></tr>
  </thead>
  <tbody>
    ${cityRows}
  </tbody>
</table>
</details>

<details>
<summary>❌ Помилки кронів (${cronFailToday} / ${cronAttemptsToday}) = ${cronFailPctToday}% · ❌ Помилки в діях (${userFailToday} / ${actionAttemptsToday}) = ${userFailPctToday}%</summary>
<table bordered striped>
  <thead>
    <tr>
      <th align="left">Показник</th>
      <th align="center">Сьогодні</th>
      <th align="center">Місяць</th>
      <th align="center">Всього</th>
    </tr>
  </thead>
  <tbody>
    <tr><td align="left">✅ Успішні крони</td><td align="center"><b>${cronOkToday}</b></td><td align="center"><b>${cronOkMonth}</b></td><td align="center"><b>${cronOkTotal}</b></td></tr>
    <tr><td align="left">❌ Невдалі крони</td><td align="center"><b>${cronFailToday}</b></td><td align="center"><b>${cronFailMonth}</b></td><td align="center"><b>${cronFailTotal}</b></td></tr>
    <tr><td align="left">⚡ Дії юзерів</td><td align="center"><b>${actionsToday}</b></td><td align="center"><b>${actionsMonth}</b></td><td align="center"><b>${actionsTotal}</b></td></tr>
    <tr><td align="left">❌ Помилки в діях</td><td align="center"><b>${userFailToday}</b></td><td align="center"><b>${userFailMonth}</b></td><td align="center"><b>${userFailTotal}</b></td></tr>
  </tbody>
</table>
<p><i>У дужках: помилки / усі спроби за сьогодні, далі — частка помилок %. Лічильники з моменту деплою.</i></p>
</details>
`.trim();

            const statsRefresh = refreshMarkup('adm|stats');
            const cbMsg = ctx.callbackQuery?.message;
            const messageId = cbMsg?.message_id;
            const preferredThr =
                cbMsg?.message_thread_id != null ? cbMsg.message_thread_id : topicId('GENERAL');
            const thr =
                preferredThr != null && Number.isFinite(Number(preferredThr))
                    ? { message_thread_id: Number(preferredThr) }
                    : {};
            const isRefresh = isRefreshClick(cbMsg);

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

            // Оновити: edit rich нестабільний (2-й клік → plain).
            // Надійно: прибрати старе повідомлення картки і надіслати нове rich.
            // Головне меню НЕ чіпаємо — isRefreshClick вже відсікає «Оновити меню».
            if (isRefresh && messageId != null) {
                try {
                    await api.deleteMessage(chatId, messageId);
                } catch (_) {
                    /* ignore */
                }
            }

            try {
                await api.sendRichMessage(
                    chatId,
                    { html, skip_entity_detection: true },
                    { reply_markup: statsRefresh, ...thr }
                );
            } catch (richErr) {
                console.warn('[admin] stats sendRichMessage failed:', richErr.message);
                // Без thread
                try {
                    await api.sendRichMessage(
                        chatId,
                        { html, skip_entity_detection: true },
                        { reply_markup: statsRefresh }
                    );
                } catch (e2) {
                    console.warn('[admin] stats rich no-thread failed:', e2.message);
                    await sendInAdminThread(
                        api,
                        chatId,
                        plain,
                        {
                            parse_mode: 'HTML',
                            disable_web_page_preview: true,
                            reply_markup: statsRefresh
                        },
                        preferredThr
                    );
                }
            }
            return true;
        }

        if (sub === 'access') {
            const page = data[2] != null && data[2] !== '' ? parseInt(data[2], 10) : 0;
            const users = await User.find({}).sort({ lastActivityAt: -1 }).lean();
            if (!users.length) {
                const curText = ctx.callbackQuery?.message?.text || '';
                if (curText.includes('Змінити доступ')) {
                    await editCallbackMessage(api, ctx, '📭 Немає користувачів.');
                } else {
                    await startScenarioMessage(api, ctx, '📭 Немає користувачів.');
                }
                return true;
            }
            const safePage = Number.isFinite(page) && page >= 0 ? page : 0;
            const { text, reply_markup } = buildAccessPage(users, safePage);
            const curText = ctx.callbackQuery?.message?.text || '';
            // Pagination / refresh after setaccess → edit; open from main menu → new message
            if (curText.includes('Змінити доступ')) {
                await editCallbackMessage(api, ctx, text, { reply_markup });
            } else {
                await startScenarioMessage(api, ctx, text, { reply_markup });
            }
            return true;
        }

        if (sub === 'setaccess') {
            const tgId = parseInt(data[2], 10);
            const level = data[3] === 'none' ? 'none' : 'unlimited';
            const page = data[4] != null && data[4] !== '' ? parseInt(data[4], 10) : 0;
            const updated = await User.findOneAndUpdate(
                { telegramId: tgId },
                { $set: { accessLevel: level } },
                { new: true }
            );
            if (!updated) {
                await editCallbackMessage(api, ctx, `❌ Користувача ${tgId} не знайдено.`);
                return true;
            }
            // Refresh the same page in-place (button flips, no separate "оновлено" message)
            const users = await User.find({}).sort({ lastActivityAt: -1 }).lean();
            const safePage = Number.isFinite(page) && page >= 0 ? page : 0;
            const { text, reply_markup } = buildAccessPage(users, safePage);
            await editCallbackMessage(api, ctx, text, { reply_markup });
            return true;
        }

        if (sub === 'broadcast_evening') {
            await startScenarioMessage(
                api,
                ctx,
                '🌆 <b>Розсилка вечірнього прогнозу</b>\n\n' +
                    'Щоб запустити зараз, натисніть «Підтвердити».\n' +
                    'Це викличе той самий cron, що й щовечора (лише для користувачів з увімкненим вечірнім прогнозом і access ≠ none).',
                {
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
            const msgId = ctx.callbackQuery?.message?.message_id;
            const threadId = ctx.callbackQuery?.message?.message_thread_id ?? null;
            if (!DOMAIN || !secret) {
                await editCallbackMessage(
                    api,
                    ctx,
                    '❌ DOMAIN або CRON_SECRET не налаштовані — не можу викликати cron-forecast.'
                );
                return true;
            }
            await editCallbackMessage(api, ctx, '⏳ Запускаю розсилку…');
            try {
                const axios = require('axios');
                const url = `https://${DOMAIN.replace(/^https?:\/\//, '')}/api/cron-forecast`;
                const res = await axios.get(url, {
                    headers: { Authorization: `Bearer ${secret}` },
                    timeout: 55000,
                    validateStatus: () => true
                });
                await finishScenarioDone(
                    api,
                    ctx,
                    `🌆 Розсилка · статус <code>${res.status}</code>`
                );
            } catch (e) {
                await editMessageById(
                    api,
                    chatId,
                    msgId,
                    `❌ Помилка виклику: ${escapeHtml(e.message)}`,
                    {},
                    threadId
                );
            }
            return true;
        }

        // ─── Вечірній тест (cron-forecast-test, TEST_USER_ID) ───
        if (sub === 'evening_test') {
            await startScenarioMessage(
                api,
                ctx,
                '🧪 <b>Вечірній тест</b>\n\n' +
                    'Запускає <code>cron-forecast-test</code> для користувача з <code>TEST_USER_ID</code> (env).\n' +
                    'Підтвердіть запуск:',
                {
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
            const msgId = ctx.callbackQuery?.message?.message_id;
            const threadId = ctx.callbackQuery?.message?.message_thread_id ?? null;
            if (!DOMAIN || !secret) {
                await editCallbackMessage(
                    api,
                    ctx,
                    '❌ DOMAIN або CRON_SECRET не налаштовані — не можу викликати cron-forecast-test.'
                );
                return true;
            }
            await editCallbackMessage(api, ctx, '⏳ Запускаю вечірній тест…');
            try {
                const axios = require('axios');
                const url = `https://${DOMAIN.replace(/^https?:\/\//, '')}/api/cron-forecast-test`;
                const res = await axios.get(url, {
                    headers: { Authorization: `Bearer ${secret}` },
                    timeout: 55000,
                    validateStatus: () => true
                });
                await finishScenarioDone(
                    api,
                    ctx,
                    `🧪 Вечірній тест · статус <code>${res.status}</code>`
                );
            } catch (e) {
                await editMessageById(
                    api,
                    chatId,
                    msgId,
                    `❌ Помилка виклику: ${escapeHtml(e.message)}`,
                    {},
                    threadId
                );
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
                await startScenarioMessage(
                    api,
                    ctx,
                    '📭 Немає підходящих користувачів для вечірнього прогнозу.'
                );
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

            await startScenarioMessage(
                api,
                ctx,
                '🎯 <b>Вечірній крон обраним</b>\n\n' +
                    'Оберіть користувача — буде надіслано вечірній прогноз лише йому:\n',
                { reply_markup: { inline_keyboard: rows } }
            );
            return true;
        }

        if (sub === 'do_evening_one') {
            const targetId = data[2];
            const msgId = ctx.callbackQuery?.message?.message_id;
            const threadId = ctx.callbackQuery?.message?.message_thread_id ?? null;
            if (!targetId) {
                await editCallbackMessage(api, ctx, '❌ Не вказано ID користувача.');
                return true;
            }
            const DOMAIN = process.env.DOMAIN || '';
            const secret = process.env.CRON_SECRET || '';
            if (!DOMAIN || !secret) {
                await editCallbackMessage(
                    api,
                    ctx,
                    '❌ DOMAIN або CRON_SECRET не налаштовані — не можу викликати cron-forecast.'
                );
                return true;
            }
            await editCallbackMessage(
                api,
                ctx,
                `⏳ Запускаю вечірній прогноз для <code>${escapeHtml(targetId)}</code>…`
            );
            try {
                const axios = require('axios');
                const url = `https://${DOMAIN.replace(/^https?:\/\//, '')}/api/cron-forecast?userId=${encodeURIComponent(targetId)}`;
                const res = await axios.get(url, {
                    headers: { Authorization: `Bearer ${secret}` },
                    timeout: 55000,
                    validateStatus: () => true
                });
                await finishScenarioDone(
                    api,
                    ctx,
                    `🎯 Юзер <code>${escapeHtml(targetId)}</code> · статус <code>${res.status}</code>`
                );
            } catch (e) {
                await editMessageById(
                    api,
                    chatId,
                    msgId,
                    `❌ Помилка виклику: ${escapeHtml(e.message)}`,
                    {},
                    threadId
                );
            }
            return true;
        }

        // ─── Крон чек (light) ───
        if (sub === 'cron_check') {
            await startScenarioMessage(
                api,
                ctx,
                '🔍 <b>Крон чек (light)</b>\n\n' +
                    'Запускає <code>cron-check-light</code> — легка перевірка алертів без Weatherbit.\n' +
                    'Підтвердіть запуск:',
                {
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
            const msgId = ctx.callbackQuery?.message?.message_id;
            const threadId = ctx.callbackQuery?.message?.message_thread_id ?? null;
            if (!DOMAIN || !secret) {
                await editCallbackMessage(
                    api,
                    ctx,
                    '❌ DOMAIN або CRON_SECRET не налаштовані — не можу викликати cron-check-light.'
                );
                return true;
            }
            await editCallbackMessage(api, ctx, '⏳ Запускаю крон чек (light)…');
            try {
                const axios = require('axios');
                const url = `https://${DOMAIN.replace(/^https?:\/\//, '')}/api/cron-check-light`;
                const res = await axios.get(url, {
                    headers: { Authorization: `Bearer ${secret}` },
                    timeout: 55000,
                    validateStatus: () => true
                });
                await finishScenarioDone(
                    api,
                    ctx,
                    `🔍 Крон чек · статус <code>${res.status}</code>`
                );
            } catch (e) {
                await editMessageById(
                    api,
                    chatId,
                    msgId,
                    `❌ Помилка виклику: ${escapeHtml(e.message)}`,
                    {},
                    threadId
                );
            }
            return true;
        }

        // ─── Очистити застарілі метрики (denylist) ───
        if (sub === 'clean_metrics_pick') {
            const page = data[2] != null && data[2] !== '' ? parseInt(data[2], 10) : 0;
            const users = await User.find({}).sort({ lastActivityAt: -1 }).lean();
            if (!users.length) {
                await startScenarioMessage(api, ctx, '📭 Немає користувачів.');
                return true;
            }
            const safePage = Number.isFinite(page) && page >= 0 ? page : 0;
            const { text, reply_markup } = buildCleanMetricsPickPage(users, safePage);
            const curText = ctx.callbackQuery?.message?.text || '';
            if (curText.includes('Очистити метрики')) {
                await editCallbackMessage(api, ctx, text, { reply_markup });
            } else {
                await startScenarioMessage(api, ctx, text, { reply_markup });
            }
            return true;
        }

        if (sub === 'clean_metrics') {
            const tgId = data[2] ? Number(data[2]) : null;
            if (!tgId || Number.isNaN(tgId)) {
                await startScenarioMessage(api, ctx, '❌ Невірний ID користувача.');
                return true;
            }
            const u = await User.findOne({ telegramId: tgId });
            if (!u) {
                await startScenarioMessage(
                    api,
                    ctx,
                    `❌ Користувача <code>${tgId}</code> немає в БД.`
                );
                return true;
            }
            const before = Array.isArray(u.forecastSettings?.enabledMetrics)
                ? [...u.forecastSettings.enabledMetrics]
                : [];
            const { metrics, changed, removed } = cleanEnabledMetrics(before);
            if (!changed) {
                await editCallbackMessage(
                    api,
                    ctx,
                    `✅ <b>ID ${tgId}</b> — метрики вже чисті.\n<code>${escapeHtml(before.join(', ') || '—')}</code>`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '◀️ Назад', callback_data: 'adm|clean_metrics_pick|0' }],
                                [{ text: '🏠 Меню', callback_data: 'adm|menu' }]
                            ]
                        }
                    }
                );
                return true;
            }
            if (!u.forecastSettings) u.forecastSettings = {};
            u.forecastSettings.enabledMetrics = metrics;
            u.markModified('forecastSettings');
            await u.save();
            await editCallbackMessage(
                api,
                ctx,
                `🧹 <b>Очищено ID ${tgId}</b>\n` +
                    `Прибрано: <code>${escapeHtml(removed.join(', ') || '—')}</code>\n` +
                    `Було: <code>${escapeHtml(before.join(', ') || '—')}</code>\n` +
                    `Стало: <code>${escapeHtml(metrics.join(', ') || '—')}</code>`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '◀️ Назад', callback_data: 'adm|clean_metrics_pick|0' }],
                            [{ text: '🏠 Меню', callback_data: 'adm|menu' }]
                        ]
                    }
                }
            );
            return true;
        }

        if (sub === 'clean_metrics_all') {
            const users = await User.find({}).lean();
            let cleaned = 0;
            const details = [];
            for (const u of users) {
                const before = Array.isArray(u.forecastSettings?.enabledMetrics)
                    ? u.forecastSettings.enabledMetrics
                    : [];
                const { metrics, changed, removed } = cleanEnabledMetrics(before);
                if (!changed) continue;
                await User.updateOne(
                    { telegramId: u.telegramId },
                    { $set: { 'forecastSettings.enabledMetrics': metrics } }
                );
                cleaned += 1;
                if (details.length < 15) {
                    details.push(
                        `<code>${u.telegramId}</code> −${escapeHtml(removed.join(','))}`
                    );
                }
            }
            const body =
                cleaned === 0
                    ? '✅ У всіх користувачів метрики вже чисті.'
                    : `🧹 <b>Очищено: ${cleaned}</b> з ${users.length}\n` +
                      (details.length ? details.join('\n') : '') +
                      (cleaned > details.length ? `\n… ще ${cleaned - details.length}` : '');
            await editCallbackMessage(api, ctx, body, {
                reply_markup: {
                    inline_keyboard: [[{ text: '🏠 Меню', callback_data: 'adm|menu' }]]
                }
            });
            return true;
        }

        // ─── Інфо про 👤: список → вибір → замінити повідомлення на профіль ───
        if (sub === 'userinfo_pick') {
            const page = data[2] != null && data[2] !== '' ? parseInt(data[2], 10) : 0;
            const users = await User.find({}).sort({ lastActivityAt: -1 }).lean();
            if (!users.length) {
                await startScenarioMessage(api, ctx, '📭 Немає користувачів.');
                return true;
            }
            const safePage = Number.isFinite(page) && page >= 0 ? page : 0;
            const { text, reply_markup } = buildUserInfoPickPage(users, safePage);
            const curText = ctx.callbackQuery?.message?.text || '';
            if (curText.includes('Інфо про')) {
                await editCallbackMessage(api, ctx, text, { reply_markup });
            } else {
                await startScenarioMessage(api, ctx, text, { reply_markup });
            }
            return true;
        }

        if (sub === 'userinfo') {
            const tgId = data[2] ? Number(data[2]) : null;
            if (!tgId || Number.isNaN(tgId)) {
                await api.sendMessage(chatId, '❌ Невірний ID користувача.');
                return true;
            }
            let u = await User.findOne({ telegramId: tgId }).lean();
            if (!u) {
                await api.sendMessage(chatId, `❌ Користувача <code>${tgId}</code> немає в БД.`, {
                    parse_mode: 'HTML'
                });
                return true;
            }

            // Підтягнути свіжі прапорці з Telegram (getChat) → tgMeta
            try {
                const chat = await api.getChat(tgId);
                const meta = extractTgMeta(chat);
                const $set = {};
                if (chat.first_name) $set.firstName = chat.first_name;
                if (chat.last_name) $set.lastName = chat.last_name;
                if (chat.username) $set.username = chat.username;
                if (meta) {
                    for (const [k, v] of Object.entries(meta)) {
                        $set[`tgMeta.${k}`] = v;
                    }
                }
                if (Object.keys($set).length) {
                    u = await User.findOneAndUpdate(
                        { telegramId: tgId },
                        { $set },
                        { new: true }
                    ).lean();
                }
            } catch (e) {
                console.warn('[admin] userinfo getChat failed:', e.message);
            }

            const html = buildUserInfoHtml(u);
            const plain = buildUserInfoPlain(u);
            const cbMsg = ctx.callbackQuery?.message;
            const messageId = cbMsg?.message_id;
            const fromPicker = (cbMsg?.text || '').includes('Інфо про');
            const fromRefresh = isRefreshClick(cbMsg);

            // Залишаємося в тій самій гілці, звідки натиснули.
            // З пікера / оновлення — General (або поточний thread).
            // З notify (кнопка «Інфо») — гілка USERS/ACTIONS повідомлення.
            const preferredThr =
                cbMsg?.message_thread_id != null
                    ? cbMsg.message_thread_id
                    : fromPicker || fromRefresh
                      ? topicId('GENERAL')
                      : topicId('USERS');
            const thr =
                preferredThr != null &&
                Number.isFinite(Number(preferredThr)) &&
                Number(preferredThr) > 0
                    ? { message_thread_id: Number(preferredThr) }
                    : {};

            const infoRefresh = refreshMarkup(`adm|userinfo|${tgId}`);

            // Оновити / пікер: delete + нове rich (edit rich ламається з 2-го кліку)
            if ((fromRefresh || fromPicker) && messageId != null) {
                try {
                    await api.deleteMessage(chatId, messageId);
                } catch (_) {
                    /* ignore */
                }
            }

            try {
                await api.sendRichMessage(
                    chatId,
                    { html, skip_entity_detection: true },
                    { reply_markup: infoRefresh, ...thr }
                );
            } catch (richErr) {
                const msg = richErr?.message || String(richErr);
                console.warn('[admin] userinfo rich failed:', msg);

                if (/thread not found|MESSAGE_THREAD|message thread/i.test(msg) && Object.keys(thr).length) {
                    try {
                        await api.sendRichMessage(
                            chatId,
                            { html, skip_entity_detection: true },
                            { reply_markup: infoRefresh }
                        );
                        return true;
                    } catch (e2) {
                        console.warn('[admin] userinfo rich no-thread failed:', e2.message);
                    }
                }

                try {
                    await api.sendRichMessage(
                        chatId,
                        { html, skip_entity_detection: true },
                        { reply_markup: infoRefresh }
                    );
                } catch (e3) {
                    await sendInAdminThread(
                        api,
                        chatId,
                        plain,
                        {
                            parse_mode: 'HTML',
                            disable_web_page_preview: true,
                            reply_markup: infoRefresh
                        },
                        preferredThr
                    );
                }
            }
            return true;
        }

        if (sub === 'msg_user') {
            const page = data[2] != null && data[2] !== '' ? parseInt(data[2], 10) : 0;
            const users = await User.find({}).sort({ lastActivityAt: -1 }).lean();
            if (!users.length) {
                await startScenarioMessage(api, ctx, '📭 Немає користувачів.');
                return true;
            }
            const safePage = Number.isFinite(page) && page >= 0 ? page : 0;
            const { text, reply_markup } = buildMsgUserPage(users, safePage);
            const curText = ctx.callbackQuery?.message?.text || '';
            if (curText.includes('Написати користувачу')) {
                await editCallbackMessage(api, ctx, text, { reply_markup });
            } else {
                await startScenarioMessage(api, ctx, text, { reply_markup });
            }
            return true;
        }

        if (sub === 'msg_pick') {
            const targetId = data[2];
            if (!targetId) {
                await startScenarioMessage(api, ctx, '❌ Невірний ID.');
                return true;
            }
            await deleteCallbackMessage(api, ctx);
            await startScenarioMessage(
                api,
                ctx,
                `✉️ <b>Написати користувачу</b> <code>${escapeHtml(String(targetId))}</code>\n\n` +
                    `Відповідай на <b>це</b> повідомлення (Reply) — текст, фото, голос, файл.\n` +
                    `Після відправки воно піде цьому користувачу.\n\n` +
                    `ID: <code>${escapeHtml(String(targetId))}</code>`
            );
            return true;
        }

        if (sub === 'msg_all') {
            await startScenarioMessage(
                api,
                ctx,
                `📣 <b>Написати всім</b>\n\n` +
                    `Відповідай на <b>це</b> повідомлення (Reply) — текст, фото, голос, файл.\n` +
                    `Після відправки воно піде <b>усім</b> користувачам з доступом (access ≠ none).\n\n` +
                    `ID: <code>BROADCAST_ALL</code>`
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
 * Describe media on an admin/user message for logs.
 */
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

/**
 * Send media asset into HISTORY topic with label + #assetId for later search.
 */
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

/**
 * Log outbound broadcast summary into HISTORY (personal replies use conversation card only).
 */
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
 * Archive full support transcript as .txt into HISTORY when the in-message card would overflow.
 * Old content is preserved in the file — not erased.
 */
async function archiveTranscriptToFile(api, chatId, telegramId, namePart, fullTranscript) {
    const { InputFile } = require('grammy');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `support_${telegramId}_${stamp}.txt`;
    const header =
        `Parasol Sentinel — архів розмови\n` +
        `User: ${namePart}\n` +
        `Telegram ID: ${telegramId}\n` +
        `Archived at: ${new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}\n` +
        `${'='.repeat(48)}\n\n`;
    const body = header + String(fullTranscript || '');
    const caption =
        `📎 Архів розмови з <b>${escapeHtml(namePart)}</b>\n` +
        `<code>${telegramId}</code>\n` +
        `<i>Попередній транскрипт (ліміт повідомлення перевищено)</i>`;

    const thrId = topicId('HISTORY');
    const file = new InputFile(Buffer.from(body, 'utf8'), filename);
    const attempts = [];
    if (thrId != null) attempts.push({ message_thread_id: thrId });
    attempts.push({});

    let lastErr = null;
    for (const thr of attempts) {
        try {
            await api.sendDocument(chatId, file, {
                caption,
                parse_mode: 'HTML',
                ...thr
            });
            return true;
        } catch (e) {
            lastErr = e;
            if (!/thread not found|MESSAGE_THREAD/i.test(e.message || '')) {
                console.warn('[admin] archiveTranscriptToFile failed:', e.message);
                return false;
            }
        }
    }
    if (lastErr) console.warn('[admin] archiveTranscriptToFile failed:', lastErr.message);
    return false;
}

/**
 * Append a line to per-user support transcript and upsert one message in HISTORY topic.
 * Media → line has type + #assetId; asset itself is sent as a separate HISTORY message.
 * Over 3500 chars → full content archived as .txt, card keeps only the fresh tail.
 */
async function appendSupportConversation(api, telegramId, who, msgOrText) {
    const chatId = ADMIN_CHAT_ID();
    if (!chatId || !telegramId) return;

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

    // Asset id: A{telegramId}-{seq}  (e.g. A95508004-2) — matches HISTORY media caption
    let assetId = null;
    if (kind && rawMsg) {
        const seq = ((user.supportHistory && user.supportHistory.assetSeq) || 0) + 1;
        assetId = `A${telegramId}-${seq}`;
        if (!user.supportHistory) user.supportHistory = {};
        user.supportHistory.assetSeq = seq;
    }

    const line = formatSupportLine(who, media, text, assetId);
    const prev = (user.supportHistory && user.supportHistory.transcript) || '';
    let transcript = prev ? `${prev}\n${line}` : line;

    // One ID only (in the title line)
    const namePart =
        user.username
            ? `@${user.username}`
            : [user.firstName, user.lastName].filter(Boolean).join(' ') || 'user';

    // Over char limit → archive full transcript as .txt (no data loss), keep fresh tail in card
    const MAX_TRANSCRIPT = 3500;
    const KEEP_TAIL = 2800;
    if (transcript.length > MAX_TRANSCRIPT) {
        try {
            await archiveTranscriptToFile(api, chatId, telegramId, namePart, transcript);
        } catch (e) {
            console.warn('[admin] archive on overflow failed:', e.message);
        }
        if (line.length >= KEEP_TAIL) {
            transcript = line.slice(0, KEEP_TAIL);
        } else {
            const budget = KEEP_TAIL - line.length - 1;
            const tailPrev = prev.length > budget ? prev.slice(prev.length - budget) : prev;
            transcript = (tailPrev ? `…\n${tailPrev}\n` : '') + line;
        }
    }

    // Rich card — акордеон <details> (як аналітика / інфо)
    const richHtml = `
<h2>💬 Розмова з ${escapeHtml(namePart)}</h2>
<p><code>${telegramId}</code></p>
<details>
<summary>📜 Переписка</summary>
<p>${escapeHtml(transcript).replace(/\n/g, '<br>')}</p>
</details>
`.trim();

    // Plain fallback (HTML parse_mode)
    const plainFull =
        `💬 <b>Розмова з</b> ${escapeHtml(namePart)} · <code>${telegramId}</code>\n\n` +
        `<blockquote expandable>${escapeHtml(transcript)}</blockquote>`;

    const thrId = topicId('HISTORY');
    const thr =
        thrId != null && Number.isFinite(Number(thrId)) && Number(thrId) > 0
            ? { message_thread_id: Number(thrId) }
            : {};
    const histMsgId = user.supportHistory && user.supportHistory.messageId;

    let newMsgId = histMsgId;
    try {
        if (histMsgId) {
            // Prefer edit as rich; if fails — plain edit; if fails — resend rich
            try {
                await api.raw.editMessageText({
                    chat_id: chatId,
                    message_id: histMsgId,
                    rich_message: { html: richHtml, skip_entity_detection: true }
                });
            } catch (editRichErr) {
                try {
                    await api.editMessageText(chatId, histMsgId, plainFull, {
                        parse_mode: 'HTML',
                        disable_web_page_preview: true
                    });
                } catch (editPlainErr) {
                    console.warn(
                        '[admin] support edit failed, resend:',
                        editPlainErr.message || editRichErr.message
                    );
                    try {
                        const sent = await api.sendRichMessage(
                            chatId,
                            { html: richHtml, skip_entity_detection: true },
                            thr
                        );
                        newMsgId = sent?.message_id;
                    } catch (sendRichErr) {
                        const sent = await sendInAdminThread(
                            api,
                            chatId,
                            plainFull,
                            { parse_mode: 'HTML', disable_web_page_preview: true },
                            thrId
                        );
                        newMsgId = sent?.message_id;
                    }
                }
            }
        } else {
            try {
                const sent = await api.sendRichMessage(
                    chatId,
                    { html: richHtml, skip_entity_detection: true },
                    thr
                );
                newMsgId = sent?.message_id;
            } catch (sendRichErr) {
                console.warn('[admin] support rich failed, plain:', sendRichErr.message);
                const sent = await sendInAdminThread(
                    api,
                    chatId,
                    plainFull,
                    { parse_mode: 'HTML', disable_web_page_preview: true },
                    thrId
                );
                newMsgId = sent?.message_id;
            }
        }
    } catch (e) {
        console.warn('[admin] appendSupportConversation send failed:', e.message);
    }

    // Mirror media asset next to the conversation card
    if (assetId && rawMsg) {
        try {
            await sendAssetToHistory(api, rawMsg, assetId, media || '📎');
        } catch (e) {
            console.warn('[admin] mirror asset failed:', e.message);
        }
    }

    user.supportHistory = {
        messageId: newMsgId || histMsgId || null,
        transcript,
        assetSeq: (user.supportHistory && user.supportHistory.assetSeq) || 0,
        updatedAt: new Date()
    };
    user.markModified('supportHistory');
    await user.save().catch((e) => console.warn('[admin] supportHistory save:', e.message));
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
                    msg,
                    okCount: ok,
                    failCount: fail,
                    total
                });
                await cleanupScenarioMessages(api, chatId, msg, replyTo);
            } catch (e) {
                await api.sendMessage(
                    chatId,
                    `❌ Помилка розсилки всім: ${escapeHtml(e.message)}`,
                    { parse_mode: 'HTML', ...sameThread }
                );
            }
            return true;
        }
        const targetId = extractUserIdFromNotifyText(replyTo);
        if (targetId) {
            try {
                const kind = await sendAdminReplyToUser(api, targetId, msg);
                if (!kind) {
                    await api.sendMessage(chatId, 'ℹ️ Нічого надсилати (порожня відповідь).', sameThread);
                    return true;
                }
                await appendSupportConversation(api, targetId, '🛡 Адмін', msg);
                await cleanupScenarioMessages(api, chatId, msg, replyTo);
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
                'Відповідай на інструкцію з <code>ID: …</code> або оберіть «Написати користувачу» в меню.',
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
            await appendSupportConversation(api, targetId, '🛡 Адмін', body);
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
 * Also bumps today (Kyiv dayKey) + month + total.
 */
async function incrementUsage(telegramId, type) {
    if (!telegramId) return;
    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const dayKey = kyivDayKey(now);
    try {
        const user = await User.findOne({ telegramId });
        if (!user) return;
        ensureMonthCounters(user);
        if (!user.usage) user.usage = {};
        user.usage.monthKey = monthKey;
        user.usage.dayKey = dayKey;
        if (type === 'evening') {
            user.usage.eveningToday = (user.usage.eveningToday || 0) + 1;
            user.usage.eveningThisMonth = (user.usage.eveningThisMonth || 0) + 1;
            user.usage.eveningTotal = (user.usage.eveningTotal || 0) + 1;
        } else {
            user.usage.alertsToday = (user.usage.alertsToday || 0) + 1;
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
 * Never sends to ACTIONS/USERS — only ERRORS.
 * Debounce: uid + текст (без where) — один клік часто дає 2 виклики
 * (reply-hook + catch у handler) з різним where.
 */
const _recentUserErrors = new Map(); // key -> ts

async function notifyUserError(from, err, extra = {}) {
    const _plainMsg = String((err && err.message) || err || '')
        .replace(/^Error:\s*/i, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
    const _msgKey = `${from && from.id}|${_plainMsg}`;
    const _now = Date.now();
    const _prev = _recentUserErrors.get(_msgKey);
    if (_prev && _now - _prev < 15000) return; // 15 с: один клік = одне в ERROR
    _recentUserErrors.set(_msgKey, _now);
    if (_recentUserErrors.size > 200) {
        for (const [k, ts] of _recentUserErrors) {
            if (_now - ts > 60000) _recentUserErrors.delete(k);
        }
    }

    const chatId = ADMIN_CHAT_ID();
    let msg = (err && err.message) || String(err || 'unknown error');
    msg = String(msg).replace(/^Error:\s*/i, '').trim();
    const stack = err && err.stack ? String(err.stack).slice(0, 900) : '';
    const name = from ? displayName(from) : 'невідомий';
    const uname = from && from.username ? `@${from.username}` : '';
    const uid = from && from.id != null ? from.id : null;
    const cb = extra.callbackData ? String(extra.callbackData) : '';
    const where = extra.where ? String(extra.where) : '';

    const isSoft =
        /^⚠️/.test(msg) ||
        /недоступн|не готов|немає даних|not (yet )?available|not ready|try again later|спробуйте пізніше/i.test(
            msg
        );

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

    if (!isSoft && stack) {
        const frames = stack
            .split('\n')
            .filter((l) => /^\s*at /.test(l))
            .slice(0, 4);
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
