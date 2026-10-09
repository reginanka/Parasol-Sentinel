/**
 * Test-only endpoint: visual preview of ALL alert types as Rich Messages.
 * - No weather APIs, no DB writes, no baseline changes
 * - Hardcoded sample texts (UK)
 * - Sends ONLY to TEST_USER_ID (same pattern as cron-forecast-test.js)
 *
 * Trigger manually:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR_DOMAIN/api/cron-check-test
 *
 * Required env: TG_TOKEN, CRON_SECRET, TEST_USER_ID
 */
require('dotenv').config();
const getBot = require('../utils/bot');
const bot = getBot();
const logToTelegram = require('../utils/logger');

module.exports = async (req, res) => {
    const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
    const log = (text) => logToTelegram(bot, LOG_CHAT_ID, text);

    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).send('Unauthorized');
    }

    const TEST_USER_ID = process.env.TEST_USER_ID ? Number(process.env.TEST_USER_ID) : null;
    if (!TEST_USER_ID) {
        return res.status(400).send('TEST_USER_ID is not set in secrets');
    }

    if (!process.env.TG_TOKEN) {
        return res.status(500).send('TG_TOKEN is missing');
    }

    const startTime = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

    try {
        // ── Hardcoded rich HTML samples (all alert types in one message) ──
        // Values are fictional — only for visual QA. Nothing is persisted.
        const richHtml = `
<h3>🧪 Тест алертів (візуал)</h3>
<p>Нижче — зразки всіх типів сповіщень у форматі Rich Message. Дані вигадані.</p>

<hr/>

<h3>🌤 Час опадів змістився</h3>
<table bordered striped compact>
  <tr><th></th><th>Інтервал</th><th>Сума</th></tr>
  <tr><td>Було</td><td>06:00–24:00</td><td>—</td></tr>
  <tr><td>Зараз</td><td><b>09:00–16:00</b></td><td><b>2.7 мм</b></td></tr>
</table>
<p><i>станом на 09.10, 06:06</i></p>

<hr/>

<h3>🌤 Опади триватимуть довше</h3>
<table bordered striped compact>
  <tr><th></th><th>Інтервал</th><th>Сума</th></tr>
  <tr><td>Було</td><td>09:00–16:00</td><td>—</td></tr>
  <tr><td>Зараз</td><td><b>06:00–24:00</b></td><td><b>2.3 мм</b></td></tr>
</table>
<p><i>станом на 09.10, 08:06</i></p>

<hr/>

<h3>⚠️ Зʼявилися опади</h3>
<table bordered striped compact>
  <tr><th></th><th>Інтервал</th><th>Сума</th></tr>
  <tr><td>Було</td><td>—</td><td>0 мм</td></tr>
  <tr><td>Зараз</td><td><b>14:00–18:00</b></td><td><b>1.2 мм</b></td></tr>
</table>
<p><i>станом на 09.10, 12:00</i></p>

<hr/>

<h3>☀️ Опади скасовано</h3>
<p>Гарні новини! Опади на сьогодні <b>скасовано</b>.</p>
<p>Було (станом на 09.10, 10:00): <b>12:00–17:00</b> · сумарно 3.1 мм</p>

<hr/>

<h3>📊 Прогноз температури змінився</h3>
<table bordered striped compact>
  <tr><th></th><th>Ніч</th><th>День</th></tr>
  <tr><td>Очікували</td><td>8°C</td><td>14°C</td></tr>
  <tr><td>Зараз</td><td><b>5°C</b></td><td><b>11°C</b></td></tr>
  <tr><td>Зміна</td><td>−3°C</td><td>−3°C</td></tr>
</table>
<p><i>станом на 09.10, 07:00</i></p>

<hr/>

<h3>⚠️ Аномальна температура</h3>
<p>Зараз: <b>+18°C</b> — значно <b>вище</b>, ніж очікувалось на цей час.</p>
<p>Очікували (станом на 09.10, 11:00): <b>10…13°C</b></p>

<hr/>

<h3>🧲 Увага! Магнітна буря (Kp 6)</h3>
<p>Активне збурення геомагнітного поля · рівень <b>G2</b> (помірна).</p>
<blockquote>
Метеозалежним: зменшити навантаження, пити більше води та тримати під рукою ліки.
</blockquote>

<hr/>

<h3>🧲 Збурення магнітного поля (Kp 4)</h3>
<p>Можливе незначне погіршення самопочуття у метеочутливих людей.</p>

<hr/>

<h3>🍃 Якість повітря погіршилась</h3>
<table bordered striped compact>
  <tr><th>Показник</th><th>Значення</th></tr>
  <tr><td>AQI</td><td><b>128</b> 🟠</td></tr>
  <tr><td>PM2.5</td><td>48 µg/m³</td></tr>
  <tr><td>PM10</td><td>72 µg/m³</td></tr>
</table>
<p>Шкідливо для чутливих груп. Краще зачинити вікна та обмежити тривалі прогулянки.</p>

<hr/>

<h3>🍃 Якість повітря покращилась</h3>
<p>🟢 AQI <b>42</b> — повітря знову в безпечній зоні.</p>
<p>Можна провітрювати та спокійно гуляти.</p>
`.trim();

        const btnText = '⚙️ Налаштувати сповіщення';

        await bot.api.sendRichMessage(TEST_USER_ID, {
            html: richHtml,
            skip_entity_detection: true
        }, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: btnText, callback_data: 'alert_settings' }]
                ]
            }
        });

        await log(`🧪 cron-check-test OK → user ${TEST_USER_ID} @ ${startTime}`);
        return res.status(200).send(`OK: rich alert preview sent to ${TEST_USER_ID}`);
    } catch (e) {
        console.error('cron-check-test error:', e);
        await log(`❌ cron-check-test: ${e.message}`).catch(() => {});
        return res.status(500).send(`Error: ${e.message}`);
    }
};
