/**
 * Admin panel helpers for Parasol Sentinel.
 * ADMIN_CHAT_ID — private channel (bot must be admin).
 * Notifications about user actions + interactive admin menu.
 */

const User = require('../models/User');
const ErrorLog = require('../models/ErrorLog');
const getBot = require('./bot');

const ADMIN_CHAT_ID = () => process.env.ADMIN_CHAT_ID || null;

function isAdminChat(chatId) {
    const id = ADMIN_CHAT_ID();
    if (!id) return false;
    return String(chatId) === String(id);
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
 * Format one user line as requested:
 * username - ID: 123 - Мова: en - Немає доступу/Безліміт | Обране гео та місто | Цього міс: N вечірніх прогнозів | M алертів | Всього: T
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
                { text: '✉️ Написати користувачу', callback_data: 'adm|msg_user' }
            ],
            [
                { text: '🔄 Оновити меню', callback_data: 'adm|menu' }
            ]
        ]
    };
}

/**
 * Notify admin channel about a user action.
 * Safe to call from any handler; no-ops if ADMIN_CHAT_ID missing.
 */
async function notifyAdmin(from, actionText, extra = {}) {
    const chatId = ADMIN_CHAT_ID();
    if (!chatId || !from) return;

    // Don't echo admin channel activity
    if (extra.chatId && isAdminChat(extra.chatId)) return;

    const bot = getBot();
    const name = displayName(from);
    const uname = from.username ? `@${from.username}` : 'без @username';
    const tgLang = from.language_code || '—';

    // Load profile from DB for rich card
    let u = null;
    try {
        u = await User.findOne({ telegramId: from.id }).lean();
    } catch (e) {
        console.error('[admin] notify DB lookup failed:', e.message);
    }

    const fmtDate = (d) => {
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
    };

    const access = accessLabel(u?.accessLevel || 'unlimited');
    const accessIcon = (u?.accessLevel || 'unlimited') === 'none' ? '🚫' : '✅';
    const botLang = u?.language || tgLang || '—';
    const city = u?.city
        ? `${u.city}${u.lat != null ? ` (${Number(u.lat).toFixed(2)}, ${Number(u.lon).toFixed(2)})` : ''}`
        : 'не обрано';
    const tz = u?.timezone || '—';
    const usage = u?.usage || {};
    const eveningM = usage.eveningThisMonth || 0;
    const alertsM = usage.alertsThisMonth || 0;
    const eveningT = usage.eveningTotal || 0;
    const alertsT = usage.alertsTotal || 0;
    const totalAct = eveningT + alertsT;
    const notif = u?.notificationsEnabled === false ? '🔕 вимк' : '🔔 увімк';
    const evening = u?.eveningForecastEnabled === false ? '🌆 вимк' : '🌆 увімк';
    const geomag = u?.geomagMode || 'quiet';
    const cropsN = Array.isArray(u?.crops) ? u.crops.length : 0;
    const created = fmtDate(u?.createdAt);
    const lastAct = fmtDate(u?.lastActivityAt);
    const temp = u?.lastState?.temp != null ? `${Math.round(u.lastState.temp)}°C` : '—';

    let text =
        `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
        `┃  👤 <b>${escapeHtml(name)}</b>\n` +
        `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
        `${escapeHtml(uname)} · ID: <code>${from.id}</code>\n` +
        `\n` +
        `${accessIcon} <b>Доступ:</b> ${escapeHtml(access)}\n` +
        `🌐 Мова: TG <code>${escapeHtml(tgLang)}</code> · бот <code>${escapeHtml(botLang)}</code>\n` +
        `📍 <b>Місто:</b> ${escapeHtml(city)}\n` +
        `🕒 TZ: <code>${escapeHtml(tz)}</code> · зараз ~ <b>${temp}</b>\n` +
        `\n` +
        `┌ <b>Статус</b>\n` +
        `│ ${notif} · ${evening}\n` +
        `│ 🧲 geomag: <code>${escapeHtml(geomag)}</code> · 🌱 культур: <b>${cropsN}</b>\n` +
        `│\n` +
        `│ 📬 <b>Цього місяця</b>\n` +
        `│   вечірніх: <b>${eveningM}</b> · алертів: <b>${alertsM}</b>\n` +
        `│ 📊 <b>За весь час</b>\n` +
        `│   вечірніх: <b>${eveningT}</b> · алертів: <b>${alertsT}</b> · разом: <b>${totalAct}</b>\n` +
        `│\n` +
        `│ 📅 реєстрація: <code>${escapeHtml(created)}</code>\n` +
        `│ 🕐 остання активність: <code>${escapeHtml(lastAct)}</code>\n` +
        `└\n` +
        `\n` +
        `⚡ <b>Дія:</b> ${escapeHtml(actionText)}`;

    if (extra.messageText) {
        text +=
            `\n\n💬 <b>Повідомлення:</b>\n` +
            `<blockquote>${escapeHtml(extra.messageText).slice(0, 800)}</blockquote>`;
    }
    if (extra.callbackData) {
        text += `\n🔘 Callback: <code>${escapeHtml(extra.callbackData)}</code>`;
    }

    text += `\n\n↩️ <i>Відповісти на це повідомлення → надіслати юзеру</i>`;

    // Keep ID: plain for reply parser (also in card above as ID: <code>)
    try {
        await bot.api.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
    } catch (e) {
        console.error('[admin] notify failed:', e.message);
        // Fallback shorter plain-ish message
        try {
            await bot.api.sendMessage(
                chatId,
                `👤 ${name} (${uname})\nID: ${from.id}\nДія: ${actionText}` +
                    (extra.messageText ? `\n\n${String(extra.messageText).slice(0, 500)}` : ''),
                { disable_web_page_preview: true }
            );
        } catch (e2) {
            console.error('[admin] notify fallback failed:', e2.message);
        }
    }
}

/** Extract user telegram id from an admin notification / confirmation message text */
function extractUserIdFromNotifyText(raw) {
    if (!raw) return null;
    const s = String(raw);
    const patterns = [
        /ID:\s*(\d{5,15})/i,
        /#u(\d{5,15})\b/,
        /користувачу\s+(\d{5,15})/i,
        /user[_\s-]?id[:\s]+(\d{5,15})/i
    ];
    for (const re of patterns) {
        const m = s.match(re);
        if (m) return parseInt(m[1], 10);
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

async function sendAdminMenu(api, chatId, messageId = null) {
    const text =
        '🛡 <b>Адмін-панель Parasol Sentinel</b>\n\n' +
        'Оберіть дію кнопкою нижче.\n' +
        'Будь-яке повідомлення в цей канал знову покаже це меню.';

    const opts = { parse_mode: 'HTML', reply_markup: adminKeyboard() };
    if (messageId) {
        try {
            await api.editMessageText(chatId, messageId, text, opts);
            return;
        } catch (_) {
            /* fall through to send */
        }
    }
    await api.sendMessage(chatId, text, opts);
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
            // Telegram message limit ~4096 — chunk by ~12 users
            const chunkSize = 12;
            for (let i = 0; i < users.length; i += chunkSize) {
                const slice = users.slice(i, i + chunkSize);
                const body = slice.map(formatUserLine).join('\n———————————————\n');
                const header = i === 0
                    ? `📋 <b>Користувачі</b> (показано ${Math.min(users.length, 80)} з ${users.length})\n\n`
                    : '';
                await api.sendMessage(chatId, header + body, { parse_mode: 'HTML' });
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
            const body = users.map(formatUserLine).join('\n———————————————\n');
            await api.sendMessage(
                chatId,
                `🟢 <b>Активні за 7 днів</b> (${users.length}):\n\n${body}`,
                { parse_mode: 'HTML' }
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

            const langLines = (langAgg || [])
                .map((x) => `  · <code>${escapeHtml(String(x._id))}</code> — <b>${x.n}</b>`)
                .join('\n') || '  · —';

            const cityLines = (cityAgg || [])
                .map((x) => `  · ${escapeHtml(String(x._id))} — <b>${x.n}</b>`)
                .join('\n') || '  · —';

            const errLines = (recentErrors || []).length
                ? recentErrors
                    .map((e) => {
                        const t = new Date(e.createdAt).toLocaleString('uk-UA', {
                            timeZone: 'Europe/Kyiv',
                            day: '2-digit',
                            month: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit'
                        });
                        const msg = escapeHtml((e.message || '').slice(0, 120));
                        return `  · <code>${t}</code> ${msg}`;
                    })
                    .join('\n')
                : '  · Помилок ще не зафіксовано';

            const text =
                `📊 <b>Аналітика Parasol Sentinel</b>\n` +
                `<i>${escapeHtml(monthLabel)} · оновлено зараз</i>\n` +
                `\n` +
                `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
                `┃  👥 <b>Користувачі</b>\n` +
                `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
                `Всього: <b>${total}</b>  ·  з містом: <b>${withCity}</b>\n` +
                `Нові цього місяця: <b>${newThisMonth}</b>\n` +
                `✅ Безліміт: <b>${unlimited}</b>  ·  🚫 Немає доступу: <b>${blocked}</b>\n` +
                `🔔 Сповіщення: <b>${notifOn}</b>  ·  🌆 Вечірній: <b>${eveningOn}</b>\n` +
                `\n` +
                `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
                `┃  🟢 <b>Активність</b>\n` +
                `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
                `<code>${bar(active1, maxActive)}</code> 24 год — <b>${active1}</b>\n` +
                `<code>${bar(active7, maxActive)}</code> 7 днів — <b>${active7}</b>\n` +
                `<code>${bar(active30, maxActive)}</code> 30 днів — <b>${active30}</b>\n` +
                `\n` +
                `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
                `┃  📬 <b>Доставка (лічильники)</b>\n` +
                `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
                `<b>Цього місяця</b>\n` +
                `  🌆 Вечірні прогнози: <b>${eveningM}</b>\n` +
                `  🚨 Алерти: <b>${alertsM}</b>\n` +
                `  Разом: <b>${eveningM + alertsM}</b>\n` +
                `<b>За весь час</b>\n` +
                `  🌆 Вечірні прогнози: <b>${eveningT}</b>\n` +
                `  🚨 Алерти: <b>${alertsT}</b>\n` +
                `  Разом: <b>${eveningT + alertsT}</b>\n` +
                `<i>⚠️ Лічильники ростуть після оновлення cron (usage.*)</i>\n` +
                `\n` +
                `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
                `┃  🌐 <b>Мови</b>\n` +
                `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
                `${langLines}\n` +
                `\n` +
                `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
                `┃  📍 <b>Топ міст</b>\n` +
                `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
                `${cityLines}\n` +
                `\n` +
                `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
                `┃  ❌ <b>Помилки</b>\n` +
                `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
                `Цього місяця: <b>${errorsThisMonth}</b>  ·  всього: <b>${errorsTotal}</b>\n` +
                `<b>Останні:</b>\n` +
                `${errLines}`;

            // Telegram limit ~4096
            const chunks = [];
            if (text.length <= 4000) {
                chunks.push(text);
            } else {
                const splitAt = text.indexOf('┏━━━━━━━━━━━━━━━━━━━━┓\n┃  ❌');
                if (splitAt > 0) {
                    chunks.push(text.slice(0, splitAt).trim());
                    chunks.push(text.slice(splitAt).trim());
                } else {
                    chunks.push(text.slice(0, 3900));
                    chunks.push(text.slice(3900));
                }
            }
            for (const chunk of chunks) {
                await api.sendMessage(chatId, chunk, {
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
                    `✅ Cron-forecast відповів: <code>${res.status}</code>\n${escapeHtml(String(res.data).slice(0, 500))}`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                await api.sendMessage(chatId, `❌ Помилка виклику: ${escapeHtml(e.message)}`, {
                    parse_mode: 'HTML'
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
 * Handle text commands posted in admin channel: /msg, or any text → show menu.
 */
async function handleAdminChannelText(ctx) {
    const chatId = ctx.chat?.id || ctx.channelPost?.chat?.id;
    if (!isAdminChat(chatId)) return false;

    const msg = ctx.message || ctx.channelPost || {};
    const text = (msg.text || '').trim();
    const api = ctx.api;

    // ── Reply to a user-notification → send text to that user ──
    const replyTo = msg.reply_to_message;
    if (replyTo && text && !text.startsWith('/')) {
        const src = replyTo.text || replyTo.caption || '';
        const targetId = extractUserIdFromNotifyText(src);
        if (targetId) {
            try {
                await api.sendMessage(
                    targetId,
                    `💬 <b>Відповідь від підтримки Parasol:</b>\n\n${escapeHtml(text)}`,
                    { parse_mode: 'HTML' }
                );
                await api.sendMessage(
                    chatId,
                    `✅ Відповідь надіслано користувачу <code>${targetId}</code>`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                await api.sendMessage(
                    chatId,
                    `❌ Не вдалося надіслати <code>${targetId}</code>: ${escapeHtml(e.message)}\n` +
                        `(Користувач міг не стартувати бота або заблокував його.)`,
                    { parse_mode: 'HTML' }
                );
            }
            return true;
        }
        await api.sendMessage(
            chatId,
            'ℹ️ Відповідь не привʼязана до користувача.\n' +
                'Відповідай на сповіщення з <code>ID: …</code> або використай:\n' +
                '<code>/msg USER_ID текст</code>',
            { parse_mode: 'HTML' }
        );
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

    // Any other text in admin channel → show menu
    await sendAdminMenu(api, chatId);
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
