/**
 * Helper to send a message to a private log channel.
 * Prefer native Rich Message API (Bot API 10.1+); fall back to HTML sendMessage.
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

/**
 * Send log as Rich Message when possible.
 * @param {object} bot - grammY bot
 * @param {string|number} chatId
 * @param {string} html - HTML body (use <h3>, <p>, <br/>, <table>, <b>, etc.)
 */
async function logToTelegram(bot, chatId, html) {
    if (!chatId) {
        console.warn('⚠️ Telemetry Warning: LOG_CHAT_ID is missing. Logs won\'t be sent to Telegram.');
        await persistErrorIfNeeded(html);
        return;
    }

    console.log(`📡 Attempting to send log to Chat ID: ${chatId}`);

    // Prefer native Rich Message (same API as evening forecasts)
    try {
        await bot.api.sendRichMessage(chatId, {
            html: html,
            skip_entity_detection: true
        });
        console.log('✅ Rich log sent to Telegram.');
        await persistErrorIfNeeded(html);
        return;
    } catch (richErr) {
        console.warn('[logger] sendRichMessage failed, falling back to HTML:', richErr.message);
    }

    // Fallback: classic HTML message
    try {
        await bot.api.sendMessage(chatId, html, {
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
        console.log('✅ Fallback HTML log sent.');
        await persistErrorIfNeeded(html);
    } catch (e) {
        console.error('❌ Log send error for Chat ID:', chatId);
        console.error('Error Code/Message:', e.code, '|', e.message);

        if (e.message && e.message.includes('chat not found') && !String(chatId).startsWith('-')) {
            console.warn('💡 PRO TIP: Group/Channel IDs usually start with a minus sign (e.g., -100123456). Current ID:', chatId);
        }

        if (e.message && e.message.includes("can't parse entities")) {
            try {
                await bot.api.sendMessage(
                    chatId,
                    '🚨 Warning: Failed to send formatted log. Plain fallback:\n\n' +
                        String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
                );
                console.log('✅ Plain fallback log sent.');
            } catch (fallbackErr) {
                console.error('❌ Fallback log send failed too:', fallbackErr.message);
            }
        }

        await persistErrorIfNeeded(html);
        await persistErrorIfNeeded(`Log send failed: ${e.message}`);
    }
}

module.exports = logToTelegram;
