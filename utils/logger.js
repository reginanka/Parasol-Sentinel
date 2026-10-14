/**
 * Helper to send a message to a private log channel / forum topic.
 * Prefer native Rich Message API (Bot API 10.1+); fall back to HTML sendMessage.
 * Also persists failure-like messages to ErrorLog for admin analytics.
 *
 * Destination (priority):
 * 1) ADMIN_CHAT_ID + TOPIC_LOGS  → forum topic "Логи"
 * 2) chatId argument (usually process.env.LOG_CHAT_ID)
 */

async function persistErrorIfNeeded(text) {
    if (!text || typeof text !== 'string') return;
    const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const looksLikeError =
        /FAILED|Помилок\s*:|❌|Error:|failed|EXCEPTION/i.test(plain) ||
        /errorsCount|errors:\s*[1-9]/i.test(plain);
    if (!looksLikeError) return;

    try {
        const connectDB = require('./db');
        const ErrorLog = require('../models/ErrorLog');
        await connectDB();
        await ErrorLog.create({
            source: 'cron',
            message: plain.slice(0, 1500)
        });
    } catch (e) {
        console.error('[logger] ErrorLog persist failed:', e.message);
    }
}

function resolveLogDest(chatId) {
    const admin = process.env.ADMIN_CHAT_ID || null;
    const topicLogs = process.env.TOPIC_LOGS ? Number(process.env.TOPIC_LOGS) : null;
    if (admin && topicLogs && !Number.isNaN(topicLogs)) {
        return { chatId: admin, threadId: topicLogs };
    }
    if (chatId) {
        return { chatId, threadId: null };
    }
    if (process.env.LOG_CHAT_ID) {
        return { chatId: process.env.LOG_CHAT_ID, threadId: null };
    }
    return { chatId: null, threadId: null };
}

/**
 * Send log as Rich Message when possible.
 * @param {object} bot - grammY bot
 * @param {string|number} chatId - fallback (LOG_CHAT_ID); ignored if TOPIC_LOGS set
 * @param {string} html - HTML body
 */
async function logToTelegram(bot, chatId, html) {
    const { chatId: dest, threadId } = resolveLogDest(chatId);
    if (!dest) {
        console.warn('⚠️ Telemetry Warning: no LOG dest (set ADMIN_CHAT_ID+TOPIC_LOGS or LOG_CHAT_ID).');
        await persistErrorIfNeeded(html);
        return;
    }

    const threadOpts = threadId != null ? { message_thread_id: threadId } : {};
    console.log(`📡 Log → chat ${dest}` + (threadId != null ? ` topic ${threadId}` : ''));

    try {
        await bot.api.sendRichMessage(
            dest,
            { html, skip_entity_detection: true },
            threadOpts
        );
        console.log('✅ Rich log sent.');
        await persistErrorIfNeeded(html);
        return;
    } catch (richErr) {
        console.warn('[logger] sendRichMessage failed, falling back to HTML:', richErr.message);
    }

    try {
        await bot.api.sendMessage(dest, html, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...threadOpts
        });
        console.log('✅ Fallback HTML log sent.');
        await persistErrorIfNeeded(html);
    } catch (e) {
        console.error('❌ Log send error:', dest, e.code, e.message);
        if (e.message && e.message.includes("can't parse entities")) {
            try {
                await bot.api.sendMessage(
                    dest,
                    '🚨 Log (plain):\n\n' +
                        String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
                    threadOpts
                );
            } catch (fallbackErr) {
                console.error('❌ Plain fallback failed:', fallbackErr.message);
            }
        }
        await persistErrorIfNeeded(html);
        await persistErrorIfNeeded(`Log send failed: ${e.message}`);
    }
}

module.exports = logToTelegram;
