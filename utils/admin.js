/**
 * Admin panel helpers for Parasol Sentinel.
 *
 * Modes:
 * 1) Classic: ADMIN_CHAT_ID = private channel (no topics)
 * 2) Forum supergroup:
 *    ADMIN_CHAT_ID = -100…
 *    TOPIC_GENERAL = 1     → меню / кнопки
 *    TOPIC_LOGS    = 123   → cron-логи (logger.js)
 *    TOPIC_USERS   = 456   → notify про юзерів + reply → юзеру
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

/** Forum topic id from env: TOPIC_GENERAL / TOPIC_LOGS / TOPIC_USERS / TOPIC_HISTORY
 *  HISTORY also accepts HISTORY_MSG_ID (Vercel secret alias).
 */
function topicId(name) {
    const upper = String(name).toUpperCase();
    const keys = [`TOPIC_${upper}`];
    if (upper === 'HISTORY') {
        keys.push('HISTORY_MSG_ID', 'History_msg_ID', 'HISTORY_TOPIC_ID');
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
async function notifyAdmin(from, actionText, extra = {}) {
    const chatId = ADMIN_CHAT_ID();
    if (!chatId || !from) return;

    // Don't echo admin channel activity
    if (extra.chatId && isAdminChat(extra.chatId)) return;

    const bot = getBot();
    const name = displayName(from);
    const uname = from.username ? `@${from.username}` : 'без @username';

    let text =
        `👤 <b>${escapeHtml(name)}</b>\n` +
        `${escapeHtml(uname)}\n` +
        `ID: <code>${from.id}</code>\n` +
        `⚡ Дія: ${escapeHtml(actionText)}`;

    if (extra.messageText) {
        text += `\n\n💬 ${escapeHtml(String(extra.messageText).slice(0, 500))}`;
    }
    if (extra.callbackData) {
        text += `\n🔘 <code>${escapeHtml(extra.callbackData)}</code>`;
    }
    text += `\n\n<i>↩️ Reply → надіслати юзеру</i>`;

    const usersThread = threadOpts('USERS');
    const markup = {
        inline_keyboard: [
            [{ text: '👤 Інфо про користувача', callback_data: `adm|userinfo|${from.id}` }]
        ]
    };

    try {
        await bot.api.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: markup,
            ...usersThread
        });
    } catch (e) {
        console.error('[admin] notify sendMessage failed:', e.message);
        try {
            await bot.api.sendMessage(
                chatId,
                `👤 ${name}\nID: ${from.id}\nДія: ${actionText}` +
                    (extra.messageText ? `\n\n${String(extra.messageText).slice(0, 500)}` : ''),
                { reply_markup: markup, ...usersThread }
            );
        } catch (e2) {
            console.error('[admin] notify fallback failed:', e2.message);
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

    await sendInAdminThread(api, chatId, text, base, preferredThreadId);
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
            const curText = ctx.callbackQuery?.message?.text || '';
            const isMainMenu =
                curText.includes('Адмін-панель Parasol Sentinel') ||
                curText.includes('Оберіть дію кнопкою');
            if (isMainMenu) {
                // Refresh main menu in place
                await sendAdminMenu(api, chatId, ctx.callbackQuery.message.message_id);
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
    if (!msg) return { media: null, text: '' };
    const text = (msg.caption || msg.text || '').trim();
    let media = null;
    if (msg.photo && msg.photo.length) media = '📷 фото';
    else if (msg.document) media = `📎 ${msg.document.file_name || 'документ'}`;
    else if (msg.video) media = '🎬 відео';
    else if (msg.animation) media = '🎞 gif';
    else if (msg.voice) media = '🎤 голосове';
    else if (msg.audio) media = '🎵 аудіо';
    else if (msg.sticker) media = '😊 sticker';
    return { media, text };
}

function historyThreadOpts() {
    return threadOpts('HISTORY');
}

function formatSupportLine(who, media, text, ts = new Date()) {
    const time = ts.toLocaleString('uk-UA', {
        timeZone: 'Europe/Kyiv',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
    const parts = [`[${time}] ${who}:`];
    if (media) parts.push(media);
    if (text) parts.push(text.slice(0, 1500));
    if (!media && !text) parts.push('(порожньо)');
    return parts.join(' ');
}

/**
 * Log outbound admin delivery into HISTORY topic (not USERS).
 * kind: 'all' | 'one'
 */
async function logDeliveryToHistory(api, { kind, targetLabel, msg, okCount, failCount, total }) {
    const chatId = ADMIN_CHAT_ID();
    if (!chatId) return;
    const { media, text } = describeMsgContent(msg);
    let head;
    if (kind === 'all') {
        head = `📣 <b>Відправлено всім</b>`;
        if (okCount != null) {
            head += `\n✅ ${okCount}` + (failCount != null ? ` · ❌ ${failCount}` : '') +
                (total != null ? ` · з ${total}` : '');
        }
    } else {
        head = `✉️ <b>Відправлено</b> ${targetLabel || ''}`;
    }
    const bodyParts = [head];
    if (media) bodyParts.push(escapeHtml(media));
    if (text) bodyParts.push(escapeHtml(text.slice(0, 1000)));
    const body = bodyParts.join('\n');
    try {
        await sendInAdminThread(api, chatId, body, {
            parse_mode: 'HTML',
            disable_web_page_preview: true
        }, topicId('HISTORY'));
    } catch (e) {
        console.warn('[admin] logDeliveryToHistory failed:', e.message);
    }
}

/**
 * Append a line to per-user support transcript and upsert one message in HISTORY topic.
 * Stores supportHistory.messageId on User for later edits.
 */
async function appendSupportConversation(api, telegramId, who, msgOrText) {
    const chatId = ADMIN_CHAT_ID();
    if (!chatId || !telegramId) return;

    let media = null;
    let text = '';
    if (typeof msgOrText === 'string') {
        text = msgOrText;
    } else {
        const d = describeMsgContent(msgOrText);
        media = d.media;
        text = d.text;
    }

    const line = formatSupportLine(who, media, text);
    let user = await User.findOne({ telegramId: Number(telegramId) });
    if (!user) {
        user = await User.findOneAndUpdate(
            { telegramId: Number(telegramId) },
            { $setOnInsert: { telegramId: Number(telegramId), accessLevel: 'unlimited' } },
            { upsert: true, new: true }
        );
    }

    const prev = (user.supportHistory && user.supportHistory.transcript) || '';
    let transcript = prev ? `${prev}\n${line}` : line;
    if (transcript.length > 3500) {
        transcript = '…\n' + transcript.slice(transcript.length - 3400);
    }

    const label =
        (user.username ? `@${user.username}` : [user.firstName, user.lastName].filter(Boolean).join(' ') || 'user') +
        ` · <code>${telegramId}</code>`;
    const header = `💬 <b>Розмова з</b> ${label}\n<code>ID: ${telegramId}</code>\n\n`;
    const full = header + escapeHtml(transcript);

    const thrId = topicId('HISTORY');
    const histMsgId = user.supportHistory && user.supportHistory.messageId;

    let newMsgId = histMsgId;
    try {
        if (histMsgId) {
            try {
                await api.editMessageText(chatId, histMsgId, full, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
            } catch (editErr) {
                console.warn('[admin] support edit failed, resend:', editErr.message);
                const sent = await sendInAdminThread(
                    api,
                    chatId,
                    full,
                    { parse_mode: 'HTML', disable_web_page_preview: true },
                    thrId
                );
                newMsgId = sent?.message_id;
            }
        } else {
            const sent = await sendInAdminThread(
                api,
                chatId,
                full,
                { parse_mode: 'HTML', disable_web_page_preview: true },
                thrId
            );
            newMsgId = sent?.message_id;
        }
    } catch (e) {
        console.warn('[admin] appendSupportConversation send failed:', e.message);
    }

    user.supportHistory = {
        messageId: newMsgId || histMsgId || null,
        transcript,
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
                const uDoc = await User.findOne({ telegramId: targetId }).lean();
                const whoLabel =
                    (uDoc?.username ? `@${uDoc.username}` : uDoc?.firstName || '') +
                    ` <code>${targetId}</code>`;
                await logDeliveryToHistory(api, {
                    kind: 'one',
                    targetLabel: whoLabel,
                    msg
                });
                await appendSupportConversation(api, targetId, '🛡 Адмін', msg);
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
            const fakeMsg = { text: body };
            const uDoc = await User.findOne({ telegramId: targetId }).lean();
            const whoLabel =
                (uDoc?.username ? `@${uDoc.username}` : uDoc?.firstName || '') +
                ` <code>${targetId}</code>`;
            await logDeliveryToHistory(api, { kind: 'one', targetLabel: whoLabel, msg: fakeMsg });
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
    appendSupportConversation,
    logDeliveryToHistory,
    accessLabel,
    ADMIN_CHAT_ID
};
