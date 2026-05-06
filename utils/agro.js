/**
 * Weather Syndrome Engine (WSE) v2.0 - Модуль професійної агро-аналітики
 * Розрахунок ризиків для рослин на основі даних Weatherbit API
 */

const score = (condition, points) => (condition ? points : 0);

/**
 * Основна функція аналізу
 * @param {Object} d - Дані прогнозу (один об'єкт з масиву data від Weatherbit)
 * @returns {Array} - Відсортований список ризиків
 */
function analyzeAgroRisks(d) {
    const risks = [];

    // --- 1. ФІТОФТОРОЗ (Phytophthora infestans) ---
    const phytophthora = 
        score(d.rh > 85, 30) +
        score(d.temp >= 16 && d.temp <= 22, 25) +
        score(d.precip > 0.8, 25) +
        score(['W', 'NW', 'SW'].includes(d.wind_cdir), 10) +
        score(d.clouds > 80, 10);
    risks.push({
        id: 'phytophthora',
        name: '🍄 Фітофтороз',
        score: Math.min(phytophthora, 100),
        advice: 'Ідеальні умови для грибка. Обробіть томати та картоплю. Уникайте зволоження листя.',
        details: `Вологість ${d.rh}%, t: ${d.temp}°C, очікується дощ.`
    });

    // --- 2. ПЕРОНОСПОРOZ / НЕСПРАВЖНЯ БОРОШНИСТА РОСА ---
    const downyMildew = 
        score(d.temp - d.dewpt < 2, 40) + // повітря насичене, буде роса
        score(d.temp >= 10 && d.temp <= 18, 30) +
        score(d.rh > 90, 20) +
        score(d.precip > 0, 10);
    risks.push({
        id: 'downy_mildew',
        name: '🥒 Пероноспороз (огірки/цибуля)',
        score: Math.min(downyMildew, 100),
        advice: 'Ризик рясної роси та туману. Забезпечте провітрювання в теплицях, не поливайте ввечері.',
        details: `Точка роси: ${d.dewpt}°C (дуже близько до t), ризик конденсату.`
    });

    // --- 3. БОРОШНИСТА РОСА (Powdery Mildew) ---
    const powderyMildew = 
        score(d.temp >= 22 && d.temp <= 28, 30) +
        score(d.rh >= 50 && d.rh <= 70, 25) +
        score(d.precip === 0, 25) + // цей грибок не любить змивання водою
        score(d.clouds < 40, 20);
    risks.push({
        id: 'powdery_mildew',
        name: '🍄 Борошниста роса',
        score: Math.min(powderyMildew, 100),
        advice: 'Суха спека + нічний конденсат. Обробіть сіркою. Особливо вразливі кабачки, троянди, виноград.',
        details: `Сухо: ${d.rh}%, t: ${d.temp}°C, дощу не буде.`
    });

    // --- 4. ТЕРМІЧНИЙ СТРЕС (Heat Stress) ---
    const heatStress = 
        score(d.temp > 32, 40) +
        score(d.temp > 35, 30) +
        score(d.uv > 8, 20) +
        score(d.rh < 30, 10);
    risks.push({
        id: 'heat_stress',
        name: '🔥 Термічний стрес',
        score: Math.min(heatStress, 100),
        advice: 'Рослини "завмирають", фотосинтез зупиняється. Рясний полив ввечері, стимулятори (амінокислоти).',
        details: `Екстремальна t: ${d.temp}°C, UV: ${d.uv}.`
    });

    // --- 5. ВІКНО ДЛЯ ОБПРИСКУВАННЯ (Spraying Window) ---
    const sprayRisk = 
        score(d.wind_spd > 5, 50) + // знос препарату
        score(d.precip > 0.2, 40) + // змивання препарату
        score(d.temp > 25, 10);    // швидке випаровування
    risks.push({
        id: 'spray_check',
        name: '🚫 Ризик оприскування',
        score: Math.min(sprayRisk, 100),
        advice: sprayRisk > 50 ? 'Скасуйте обробку: вітер або дощ нівелюють дію препарату.' : 'Умови для обробки задовільні.',
        details: `Вітер: ${d.wind_spd}м/с, ймовірність опадів: ${d.pop}%`
    });

    // --- 6. ГІПОКСІЯ / ПЕРЕЗВОЛОЖЕННЯ ---
    const hypoxia = 
        score(d.precip > 20, 50) + 
        score(d.clouds > 90 && d.rh > 90, 30) +
        score(d.temp < 15, 20);
    risks.push({
        id: 'hypoxia',
        name: '🌊 Задихання коренів',
        score: Math.min(hypoxia, 100),
        advice: 'Ризик застою води. Після підсихання обов’язково розпушіть ґрунт (сухий полив).',
        details: `Злива: ${d.precip}мм за добу.`
    });

    // --- 7. ПАРША (Venturia) ---
    const scab = 
        score(d.precip > 0.5 && d.temp >= 14 && d.temp <= 22, 60) +
        score(d.rh > 85, 40);
    risks.push({
        id: 'scab',
        name: '🍎 Парша плодових',
        score: Math.min(scab, 100),
        advice: 'Критичний момент для зараження листя дерев. Обробіть фунгіцидом до дощу.',
        details: `Вологий лист при t: ${d.temp}°C.`
    });

    // --- 8. ЗАМОРОЗОК ---
    const frost = 
        score(d.min_temp <= 2, 50) +
        score(d.clouds < 20, 30) +
        score(d.wind_spd < 2, 20);
    risks.push({
        id: 'frost',
        name: '❄️ Приморозок',
        score: Math.min(frost, 100),
        advice: 'Ризик заморозку на ґрунті. Вкрийте розсаду, проведіть вечірній полив (вода віддає тепло).',
        details: `Мін t: ${d.min_temp}°C, небо ясне.`
    });

    // --- 9. АЛЬТЕРНАРІОЗ ---
    const alternaria = 
        score(d.temp > 26, 40) +
        score(d.precip > 0.5, 30) +
        score(d.rh > 70, 30);
    risks.push({
        id: 'alternaria',
        name: '🍂 Альтернаріоз',
        score: Math.min(alternaria, 100),
        advice: 'Спека + волога. Можлива поява чорних плям на листі. Обробіть препаратами міді.',
        details: `t: ${d.temp}°C, вологість присутня.`
    });

    // --- 10. СУХОВІЙ ---
    const drought = 
        score(['E', 'SE'].includes(d.wind_cdir), 40) +
        score(d.rh < 30, 40) +
        score(d.wind_spd > 6, 20);
    risks.push({
        id: 'drought',
        name: '💨 Суховій',
        score: Math.min(drought, 100),
        advice: 'Екстремальне випаровування. Додайте мульчу, збільште вечірній полив.',
        details: `Вітер ${d.wind_cdir}, сухість повітря.`
    });

    return risks
        .filter(r => r.score >= 40)
        .sort((a, b) => b.score - a.score)
        .slice(0, 4);
}

/**
 * Форматування звіту для Telegram
 */
function formatAgroReport(city, risks, lang = 'uk') {
    if (risks.length === 0) {
        return lang === 'uk' 
            ? `🌿 **Аналіз для м. ${city}**\n\n✅ Критичних агро-ризиків на завтра не виявлено. Погода сприятлива!`
            : `🌿 **Analysis for ${city}**\n\n✅ No critical agro-risks detected for tomorrow. Weather is favorable!`;
    }

    let message = lang === 'uk'
        ? `🧠 **Weather Syndrome Analysis: ${city}**\n━━━━━━━━━━━━━━━━━━━━\n`
        : `🧠 **Weather Syndrome Analysis: ${city}**\n━━━━━━━━━━━━━━━━━━━━\n`;
    
    risks.forEach(r => {
        let level = lang === 'uk' ? '🟡 СЕРЕДНІЙ' : '🟡 MEDIUM';
        if (r.score >= 80) level = lang === 'uk' ? '🔴 КРИТИЧНИЙ' : '🔴 CRITICAL';
        if (r.id === 'spray_check' && r.score < 50) level = lang === 'uk' ? '🟢 СПРИЯТЛИВО' : '🟢 FAVORABLE';

        message += `${r.name}: ${level} (${r.score}/100)\n`;
        message += `  ↳ _${r.details}_\n`;
        message += lang === 'uk' ? `  👉 **Порада:** ${r.advice}\n\n` : `  👉 **Advice:** ${r.advice}\n\n`;
    });

    message += `━━━━━━━━━━━━━━━━━━━━\n_`;
    message += lang === 'uk' 
        ? `Прогноз побудовано на біологічних циклах патогенів_`
        : `Forecast based on biological cycles of pathogens_`;
    return message;
}

module.exports = { analyzeAgroRisks, formatAgroReport };
