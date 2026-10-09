const { Bot } = require('grammy');

/**
 * Creates and returns a grammY bot instance.
 * Centralized here to handle missing tokens gracefully and avoid duplicate initialization code.
 */
const getBot = () => {
    const token = process.env.TG_TOKEN;
    if (!token) {
        console.warn('WARNING: TG_TOKEN is missing. Bot functionality will be disabled.');
        // Return a bot with a dummy token so callers don't crash on import.
        // Handlers guard against missing TG_TOKEN before processing updates.
        return new Bot('000000000:DUMMY_TOKEN_FOR_MISSING_ENV');
    }
    return new Bot(token);
};

module.exports = getBot;
