/**
 * Admin panel helpers for Parasol Sentinel.
 * ADMIN_CHAT_ID — private channel (bot must be admin).
 * Notifications about user actions + interactive admin menu.
 */

const User = require('../models/User');
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
    const uname = from.username ? `@${from.username}` : '—';
    const lang = from.language_code || '—';

    let text =
        `👤 <b>${escapeHtml(name)}</b> (${uname})\n` +
        `ID: <code>${from.id}</code>\n` +
        `Мова TG: ${escapeHtml(lang)}\n` +
        `Дія: <b>${escapeHtml(actionText)}</b>`;

    if (extra.messageText) {
        text += `\n\n💬 Повідомлення:\n<code>${escapeHtml(extra.messageText).slice(0, 800)}</code>`;
    }
    if (extra.callbackData) {
        text += `\n\n🔘 Callback: <code>${escapeHtml(extra.callbackData)}</code>`;
    }

    try {
        await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
        console.error('[admin] notify failed:', e.message);
    }
}

/**
 * Upsert basic profile fields from Telegram user object.
 */
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
            const total = await User.countDocuments();
            const withCity = await User.countDocuments({ city: { $ne: null } });
            const unlimited = await User.countDocuments({ accessLevel: { $ne: 'none' } });
            const blocked = await User.countDocuments({ accessLevel: 'none' });
            const notifOn = await User.countDocuments({ notificationsEnabled: { $ne: false } });
            const eveningOn = await User.countDocuments({ eveningForecastEnabled: { $ne: false } });
            const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const active7 = await User.countDocuments({ lastActivityAt: { $gte: since } });

            const text =
                `📊 <b>Аналітика</b>\n\n` +
                `👥 Всього користувачів: <b>${total}</b>\n` +
                `📍 З містом: <b>${withCity}</b>\n` +
                `🟢 Активні (7д): <b>${active7}</b>\n` +
                `✅ Безліміт: <b>${unlimited}</b>\n` +
                `🚫 Немає доступу: <b>${blocked}</b>\n` +
                `🔔 Сповіщення увімк.: <b>${notifOn}</b>\n` +
                `🌆 Вечірній прогноз увімк.: <b>${eveningOn}</b>`;

            await api.sendMessage(chatId, text, { parse_mode: 'HTML' });
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

    const text = (ctx.message?.text || ctx.channelPost?.text || '').trim();
    const api = ctx.api;

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

module.exports = {
    isAdminChat,
    notifyAdmin,
    touchUserProfile,
    ensureMonthCounters,
    formatUserLine,
    adminKeyboard,
    sendAdminMenu,
    handleAdminCallback,
    handleAdminChannelText,
    accessLabel,
    ADMIN_CHAT_ID
};
