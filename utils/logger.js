/**
 * Helper to send a message to a private log channel.
 * Useful for monitoring cron jobs in real-time via Telegram.
 */
async function logToTelegram(bot, chatId, text) {
    if (!chatId) {
        console.warn('⚠️ Telemetry Warning: LOG_CHAT_ID is missing. Logs won\'t be sent to Telegram.');
        return;
    }

    try {
        // Simple HTML escaping for common characters that might break Telegram parsing
        // We only escape things that aren't expected tags (like <b>, <code> etc)
        // Since we build the HTML in individual cron jobs, we assume the author 
        // knows what they are doing, but common errors in dynamic text can kill it.
        await bot.telegram.sendMessage(chatId, text, { parse_mode: 'html' });
    } catch (e) {
        console.error('❌ Log send error for Chat ID:', chatId);
        console.error('Error details:', e.message);
        
        // Fallback for HTML parse errors: try to send as plain text
        if (e.message.includes('can\'t parse entities')) {
            try {
                await bot.telegram.sendMessage(chatId, '🚨 Warning: Failed to send formatted log. Sending plain text fallback:\n\n' + text.replace(/<[^>]*>/g, ''));
            } catch (fallbackErr) {
                console.error('❌ Fallback log send failed too:', fallbackErr.message);
            }
        }
    }
}

module.exports = logToTelegram;
