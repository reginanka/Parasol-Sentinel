/**
 * Helper to send a message to a private log channel.
 * Useful for monitoring cron jobs in real-time via Telegram.
 */
async function logToTelegram(bot, chatId, text) {
    if (!chatId) {
        console.warn('⚠️ Telemetry Warning: LOG_CHAT_ID is missing. Logs won\'t be sent to Telegram.');
        return;
    }

    console.log(`📡 Attempting to send log to Chat ID: ${chatId}`);

    try {
        // Optional: Verify bot connection once or per call if debugging
        // const me = await bot.api.getMe();
        // console.log(`🤖 Log Bot Identity: @${me.username}`);

        await bot.api.sendMessage(chatId, text, { parse_mode: 'html' });
        console.log('✅ Log successfully sent to Telegram.');
    } catch (e) {
        console.error('❌ Log send error for Chat ID:', chatId);
        console.error('Error Code/Message:', e.code, '|', e.message);
        
        // If it's a "Chat not found" error, it's often due to missing minus sign for groups/channels
        if (e.message.includes('chat not found') && !String(chatId).startsWith('-')) {
            console.warn('💡 PRO TIP: Group/Channel IDs usually start with a minus sign (e.g., -100123456). Current ID:', chatId);
        }

        // Fallback for HTML parse errors: try to send as plain text
        if (e.message.includes('can\'t parse entities')) {
            try {
                await bot.api.sendMessage(chatId, '🚨 Warning: Failed to send formatted log. Sending plain text fallback:\n\n' + text.replace(/<[^>]*>/g, ''));
                console.log('✅ Fallback log sent successfully.');
            } catch (fallbackErr) {
                console.error('❌ Fallback log send failed too:', fallbackErr.message);
            }
        }
    }
}

module.exports = logToTelegram;
