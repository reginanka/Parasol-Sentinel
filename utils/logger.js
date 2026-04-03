/**
 * Helper to send a message to a private log channel.
 * Useful for monitoring cron jobs in real-time via Telegram.
 */
async function logToTelegram(bot, chatId, text) {
    if (!chatId) return;
    try {
        await bot.telegram.sendMessage(chatId, text, { parse_mode: 'html' });
    } catch (e) {
        console.error('Log send error:', e.message);
    }
}

module.exports = logToTelegram;
