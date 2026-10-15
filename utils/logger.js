/**
 * Helper to send a message to a private log channel / forum topic.
 * Prefer native Rich Message API (Bot API 10.1+); fall back to HTML sendMessage.
 * Also persists failure-like messages to ErrorLog for admin analytics.
 *
 * Destination (priority for normal logs):
 * 1) ADMIN_CHAT_ID + TOPIC_LOGS  → forum topic "Логи"
 * 2) chatId argument (usually process.env.LOG_CHAT_ID)
 *
 * Real errors only → ADMIN_CHAT_ID + ERROR_ID (or TOPIC_ERRORS)
 * Success summaries with "Помилок: 0" stay in normal logs.
 */

function stripHtml(text) {
    return String(text || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * True only for real failures — not success reports that merely mention "Помилок 0".
 */
function looksLikeErrorText(text) {
    if (!text || typeof text !== 'string') return false;
    const plain = stripHtml(text);

    // Explicit failure titles / stack traces
    if (/\bFAILED\b|EXCEPTION|Error:\s*\S/i.test(plain)) return true;
    if (/Weather Check FAILED|Light Weather Check FAILED/i.test(plain)) return true;

    // "Помилок" / "errors" with a non-zero number nearby
    // e.g. "Помилок 3", "Помилок: 2", "errors: 1", "errorsCount 5"
    const errCount =
        plain.match(/Помилок\s*:?\s*(\d+)/i) ||
        plain.match(/\berrors?\s*:?\s*(\d+)/i) ||
        plain.match(/errorsCount\s*[:=]?\s*(\d+)/i);
    if (errCount && Number(errCount[1]) > 0) return true;

    // Standalone failure markers without a zero-error report structure
    // Avoid matching the label "❌ Помилок" in a successful table
    if (/❌\s*(FAILED|Помилка\b|Error\b)/i.test(plain)) return true;

    return false;
}

async function persistErrorIfNeeded(text) {
    if (!looksLikeErrorText(text)) return;

    try {
        const connectDB = require('./db');
        const ErrorLog = require('../models/ErrorLog');
        await connectDB();
        await ErrorLog.create({
            source: 'cron',
            message: stripHtml(text).slice(0, 1500)
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

/** Окрема гілка для помилок: ERROR_ID або TOPIC_ERRORS у тому ж ADMIN_CHAT_ID */
function resolveErrorDest() {
    const admin = process.env.ADMIN_CHAT_ID || null;
    const raw = process.env.ERROR_ID || process.env.TOPIC_ERRORS || null;
    if (!admin || raw == null || raw === '') return null;
    const threadId = Number(raw);
    if (Number.isNaN(threadId)) return null;
    return { chatId: admin, threadId };
}

async function sendToDest(bot, dest, html) {
    if (!dest || !dest.chatId) return false;
    const threadOpts =
        dest.threadId != null && !Number.isNaN(dest.threadId)
            ? { message_thread_id: dest.threadId }
            : {};

    try {
        await bot.api.sendRichMessage(
            dest.chatId,
            { html, skip_entity_detection: true },
            threadOpts
        );
        return true;
    } catch (richErr) {
        console.warn('[logger] sendRichMessage failed, falling back to HTML:', richErr.message);
    }

    try {
        await bot.api.sendMessage(dest.chatId, html, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...threadOpts
        });
        return true;
    } catch (e) {
        console.error('❌ Log send error:', dest.chatId, e.code, e.message);
        if (e.message && e.message.includes("can't parse entities")) {
            try {
                await bot.api.sendMessage(
                    dest.chatId,
                    '🚨 Log (plain):\n\n' + stripHtml(html),
                    threadOpts
                );
                return true;
            } catch (fallbackErr) {
                console.error('❌ Plain fallback failed:', fallbackErr.message);
            }
        }
        return false;
    }
}

/**
 * Send log as Rich Message when possible.
 * @param {object} bot - grammY bot
 * @param {string|number} chatId - fallback (LOG_CHAT_ID); ignored if TOPIC_LOGS set
 * @param {string} html - HTML body
 */
async function logToTelegram(bot, chatId, html) {
    const isError = looksLikeErrorText(html);
    const errorDest = isError ? resolveErrorDest() : null;

    // Реальні помилки — лише в ERROR_ID; успішні звіти з «Помилок: 0» — у звичайний лог
    if (errorDest) {
        console.log(`📡 Error log → chat ${errorDest.chatId} topic ${errorDest.threadId}`);
        const ok = await sendToDest(bot, errorDest, html);
        if (ok) console.log('✅ Error log sent to ERROR_ID topic.');
        await persistErrorIfNeeded(html);
        return;
    }

    const { chatId: dest, threadId } = resolveLogDest(chatId);
    if (!dest) {
        console.warn(
            '⚠️ Telemetry Warning: no LOG dest (set ADMIN_CHAT_ID+TOPIC_LOGS or LOG_CHAT_ID).'
        );
        await persistErrorIfNeeded(html);
        return;
    }

    console.log(`📡 Log → chat ${dest}` + (threadId != null ? ` topic ${threadId}` : ''));
    const ok = await sendToDest(bot, { chatId: dest, threadId }, html);
    if (ok) console.log('✅ Log sent.');
    await persistErrorIfNeeded(html);
}

module.exports = logToTelegram;
