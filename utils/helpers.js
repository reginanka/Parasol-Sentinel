const crypto = require('crypto');

/**
 * Standard sleep/delay function for throttling.
 * @param {number} ms - Milliseconds to sleep.
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Truncate long strings for logging/UI.
 */
const truncate = (str, len = 50) => str.length > len ? str.substring(0, len) + '...' : str;

/**
 * Safely format a URL ensuring it has a protocol and no double slashes.
 */
const formatUrl = (domain, path = '') => {
    if (!domain) return '';
    let protocol = 'https://';
    if (domain.startsWith('http://') || domain.startsWith('https://')) {
        protocol = '';
    } else if (domain.includes('localhost')) {
        protocol = 'http://';
    }
    
    // Normalize path ensure single leading slash
    const normalizedPath = path ? (path.startsWith('/') ? path : '/' + path) : '';
    // Strip trailing slash from domain
    const normalizedDomain = domain.endsWith('/') ? domain.slice(0, -1) : domain;

    return `${protocol}${normalizedDomain}${normalizedPath}`;
};

/**
 * Generates a simple signature for data verification.
 * Used to protect user data from unauthorized access by ID.
 * Uses a secret key for security.
 * @param {string|number} data - Data to sign (e.g. userId).
 * @param {string} secret - Secret key (e.g. process.env.CRON_SECRET).
 */
const generateSignature = (data, secret) => {
    if (!secret) return '';
    return crypto
        .createHmac('sha256', secret)
        .update(String(data))
        .digest('hex')
        .substring(0, 12); // Shorter for URL aesthetics
};

/**
 * Validate Telegram WebApp initData (стандарт Telegram 2025+)
 */
const validateTelegramInitData = (initData, botToken) => {
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        
        // Sort keys alphabetically
        const keys = Array.from(urlParams.keys()).sort();
        const dataCheckString = keys.map(key => `${key}=${urlParams.get(key)}`).join('\n');

        const secretKey = crypto
            .createHmac('sha256', 'WebAppData')
            .update(botToken)
            .digest();

        const calculatedHash = crypto
            .createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        return calculatedHash === hash;
    } catch (e) {
        console.error('InitData validation error:', e.message);
        return false;
    }
};

/**
 * Escapes characters for HTML to prevent Telegram parse errors.
 */
const escapeHTML = (text) => {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
};

/**
 * Returns a robust YYYY-MM-DD string for a given timezone and offset in days.
 */
const getLocalDateStr = (timezone = 'Europe/Kyiv', offsetDays = 0) => {
    const d = new Date(Date.now() + offsetDays * 86400000);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(d);
};

module.exports = {
    sleep,
    truncate,
    formatUrl,
    generateSignature,
    validateTelegramInitData,
    escapeHTML,
    getLocalDateStr
};
