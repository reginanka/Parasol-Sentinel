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
 * Escapes characters for HTML to prevent Telegram parse errors.
 */
const escapeHTML = (text) => {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
};

module.exports = {
    sleep,
    truncate,
    formatUrl,
    generateSignature,
    escapeHTML
};
