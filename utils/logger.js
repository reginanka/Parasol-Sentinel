/**
 * Helper to send a message to a private log channel.
 * Useful for monitoring cron jobs in real-time via Telegram.
 * Also persists failure-like messages to ErrorLog for admin analytics.
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

async function logToTelegram(bot, chatId, text) {
    if (!chatId) {
        console.warn('⚠️ Telemetry Warning: LOG_CHAT_ID is missing. Logs won\'t be sent to Telegram.');
        // Still try to persist errors even without LOG_CHAT_ID
        await persistErrorIfNeeded(text);
        return;
    }

    console.log(`📡 Attempting to send log to Chat ID: ${chatId}`);

    try {
        await bot.api.sendMessage(chatId, text, { parse_mode: 'html' });
        console.log('✅ Log successfully sent to Telegram.');
        await persistErrorIfNeeded(text);
    } catch (e) {
        console.error('❌ Log send error for Chat ID:', chatId);
        console.error('Error Code/Message:', e.code, '|', e.message);

        if (e.message.includes('chat not found') && !String(chatId).startsWith('-')) {
            console.warn('💡 PRO TIP: Group/Channel IDs usually start with a minus sign (e.g., -100123456). Current ID:', chatId);
        }

        if (e.message.includes("can't parse entities")) {
            try {
                await bot.api.sendMessage(chatId, '🚨 Warning: Failed to send formatted log. Sending plain text fallback:\n\n' + text.replace(/<[^>]*>/g, ''));
                console.log('✅ Fallback log sent successfully.');
            } catch (fallbackErr) {
                console.error('❌ Fallback log send failed too:', fallbackErr.message);
            }
        }

        await persistErrorIfNeeded(text);
        await persistErrorIfNeeded(`Log send failed: ${e.message}`);
    }
}

module.exports = logToTelegram;
