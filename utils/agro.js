/**
 * Weather Syndrome Engine (WSE) v2.0 - Модуль професійної агро-аналітики
 * Розрахунок ризиків для рослин на основі даних Weatherbit API
 */

const axios = require('axios');
const History = require('../models/History');

let score = (condition, points) => (condition ? points : 0);

/**
 * Основна функція аналізу
 * @param {Object} d - Дані прогнозу (один об'єкт з масиву data від Weatherbit)
 * @param {Array} history - Масив історичних даних (останні 7-10 днів)
 * @param {Array} userCrops - Масив ID культур користувача
 * @returns {Array} - Відсортований список ризиків
 */
function analyzeAgroRisks(rawD, history = [], userCrops = []) {
    // If we don't have a valid object, we can't analyze.
    if (!rawD || typeof rawD !== 'object') return [];

    // Neutral defaults to prevent crashes while maintaining some logic sanity
    let d = {
        rh: typeof rawD.rh === 'number' ? rawD.rh : 50,
        temp: typeof rawD.temp === 'number' ? rawD.temp : 20,
        max_temp: typeof rawD.max_temp === 'number' ? rawD.max_temp : (rawD.temp || 20),
        min_temp: typeof rawD.min_temp === 'number' ? rawD.min_temp : (rawD.temp || 15),
        precip: typeof rawD.precip === 'number' ? rawD.precip : 0,
        wind_spd: typeof rawD.wind_spd === 'number' ? rawD.wind_spd : 2,
        wind_cdir: rawD.wind_cdir || 'N',
        clouds: typeof rawD.clouds === 'number' ? rawD.clouds : 50,
        dewpt: typeof rawD.dewpt === 'number' ? rawD.dewpt : 10,
        uv: typeof rawD.uv === 'number' ? rawD.uv : 0,
        pop: typeof rawD.pop === 'number' ? rawD.pop : 0,
        slp: typeof rawD.slp === 'number' ? rawD.slp : (rawD.pres || 1013),
        valid_date: rawD.valid_date || rawD.datetime || new Date().toISOString()
    };

    let risks = [];

    // --- 0. НАУКОВИЙ МІСЯЦЬ (Lunar Impact) ---
    try {
        let lunarRisks = analyzeLunarImpact(d);
        risks.push(...lunarRisks);
    } catch (e) {
        console.error('Lunar analysis failed:', e);
    }


    let stage = getGrowthStage();
    let isEarly = stage.id === 'early_spring';

    // --- 1. ФІТОФТОРОЗ (Phytophthora infestans) ---
    let historyPoints = 0;
    if (history && history.length > 0) {
        // Накопичений ризик: якщо останні 3 дні було волого
        let wetDays = history.slice(0, 3).filter(h => (h.rh_avg > 80) || (h.precip > 1)).length;
        historyPoints = wetDays * 15;
    }

    let phytophthora =
        score(d.rh > 85, 30) +
        score(d.temp >= 16 && d.temp <= 22, 25) +
        score(d.precip > 0.8, 25) +
        score(['W', 'NW', 'SW'].includes(d.wind_cdir), 10) +
        score(d.clouds > 80, 10) +
        historyPoints;

    risks.push({
        id: 'phytophthora',
        name: '🍄 Фітофтороз',
        score: Math.min(phytophthora, 100),
        advice: isEarly
            ? 'Профілактика: препарати міді (Медян Екстра, Бордоська суміш). Уникайте вологи на листі.'
            : (phytophthora >= 80 
                ? 'Критична фаза! Терміново: Рідоміл Голд (25г/10л) або Магнікур Фіно (15мл/10л). Припиніть азотні добрива — вони "розм’якшують" лист!' 
                : 'Ризик зростає. Обробіть: Квадріс (6мл/10л) чи Фітоспорин. Підсильте імунітет калієм (Монофосфат калію 10-15г/10л).'),
        details: `Вологість ${Math.round(d.rh)}%, t: ${d.temp.toFixed(1)}°C${d.precip > 0.8 ? ', очікується дощ' : ''}. Ризик +${historyPoints}% від минулих днів.`,
        relatedCrops: ['tomato', 'potato', 'eggplant']
    });

    // --- 2. ПЕРОНОСПОРOZ / НЕСПРАВЖНЯ БОРОШНИСТА РОСА ---
    let downyHistory = (history && history.length > 0) 
        ? history.slice(0, 3).filter(h => h.rh_avg > 85).length * 10 
        : 0;

    let downyMildew =
        score(d.temp - d.dewpt < 2, 40) + // повітря насичене, буде роса
        score(d.temp >= 10 && d.temp <= 18, 30) +
        score(d.rh > 90, 20) +
        score(d.precip > 0, 10) +
        downyHistory;

    risks.push({
        id: 'downy_mildew',
        name: '🥒 Пероноспороз (огірки/цибуля)',
        score: Math.min(downyMildew, 100),
        advice: downyMildew >= 80 
            ? 'Критичний ризик! Терміново: Магнікур Енерджі (25мл/10л, пропамокарб+фосетил) або Ревус (6мл/10л). Забезпечте максимальне провітрювання теплиць!' 
            : 'Ризик конденсату та туману. Профілактика: Квадріс (6мл/10л, азоксистробін) або Курзат (25г/10л). Провітрюйте теплиці та не поливайте ввечері.',
        details: `Точка роси: ${d.dewpt}°C, ризик рясної роси. +${downyHistory}% за вологість минулих днів.`,
        relatedCrops: ['cucumber', 'zucchini', 'grape']
    });

    // --- 3. БОРОШНИСТА РОСА (Powdery Mildew) ---
    let powderyMildew =
        score(d.temp >= 22 && d.temp <= 28, 30) +
        score(d.rh >= 50 && d.rh <= 70, 25) +
        score(d.precip === 0, 25) + // цей грибок не любить змивання водою
        score(d.clouds < 40, 20);
    risks.push({
        id: 'powdery_mildew',
        name: '🍄 Борошниста роса',
        score: Math.min(powderyMildew, 100),
        advice: powderyMildew >= 80
            ? 'Масове поширення! Обробіть системно: Топаз (4мл/10л, пенконазол) або Магнікур Сенсейшн (3.5мл/10л). Дайте калій по листу.'
            : 'Умови сухої спеки. Профілактика: Тіовіт Джет (40-80г/10л, колоїдна сірка). Слідкуйте за вологістю ґрунту — посуха провокує хворобу!',
        details: `Сухо: ${Math.round(d.rh)}%, t: ${d.temp.toFixed(1)}°C. Ідеально для борошнистої роси.`,
        relatedCrops: ['zucchini', 'rose', 'grape', 'apple', 'cucumber']
    });

    // --- 4. ТЕРМІЧНИЙ СТРЕС (Heat Stress) ---
    let heatStress =
        score(d.temp > 30, 30) +
        score(d.temp > 34, 40) +
        score(d.uv > 8, 20) +
        score(d.rh < 35, 10);
    risks.push({
        id: 'heat_stress',
        name: '🔥 Термічний стрес',
        score: Math.min(heatStress, 100),
        advice: heatStress >= 70
            ? 'Екстремальна спека! Рослини в стагнації. Терміново: антистресанти з амінокислотами (Мегафол 25мл/10л або Амінокат). Рясний полив ТІЛЬКИ ввечері.'
            : 'Температурний стрес. Використовуйте Епін-Екстра або Циркон. Обов’язково замульчуйте ґрунт, щоб врятувати коріння від перегріву.',
        details: `Температура ${d.temp.toFixed(1)}°C, вологість ${Math.round(d.rh)}%. Рослина закриває продихи.`,
        relatedCrops: ['tomato', 'pepper', 'cucumber', 'strawberry', 'raspberry']
    });

    // --- СОНЯЧНИЙ ОПІК ТА УФ-РИЗИК ---
    let sunburn =
        score(d.uv >= 5 && d.uv < 7, 25) +
        score(d.uv >= 7, 50) +
        score(d.uv >= 9, 30) +
        score(d.temp > 30, 20) +
        score(d.clouds < 15, 10);
    let uvAdvice = '';
    if (d.uv >= 10) {
        uvAdvice = 'Екстремальний УФ! Потрібна щільна сітка 70-85% або подвійне укриття. Ризик стерильності пилку.';
    } else if (d.uv >= 8) {
        uvAdvice = 'Дуже високий УФ! Необхідна затіняюча сітка 45-60%. Обприскування тільки в глибоких сутінках.';
    } else if (d.uv >= 6) {
        uvAdvice = 'Висока інтенсивність УФ! Рекомендовано сітку 35-45% або щільне біле агроволокно (30-50 г/м²).';
    } else if (d.uv >= 4) {
        uvAdvice = 'Помірний УФ. Для чутливих рослин та молодої розсади використайте легке агроволокно (17-23 г/м²).';
    } else {
        uvAdvice = 'Низький рівень УФ. Спеціальне затінення не потрібне.';
    }

    if (d.temp > 32) {
        uvAdvice += ` Увага: аномальна спека (${d.temp}°C) критично підсилює дію сонця! Обов’язково дайте антистресанти (Мегафол, Амінокат) та рясно полийте ввечері.`;
    } else if (d.temp > 28) {
        uvAdvice += ` Температура ${d.temp}°C підвищує ризик опіків: уникайте поливу по листу вдень, щоб краплі не спрацювали як лінзи.`;
    }

    risks.push({
        id: 'sunburn',
        name: '☀️ Сонячний опік / УФ-шок',
        score: Math.min(sunburn, 100),
        advice: uvAdvice,
        details: `УФ-індекс: ${d.uv.toFixed(1)}, хмарність: ${Math.round(d.clouds)}%, t: ${d.temp.toFixed(1)}°C.`,
        relatedCrops: ['tomato', 'pepper', 'cucumber', 'strawberry', 'hydrangea']
    });

    // --- 5. ВІКНО ДЛЯ ОБПРИСКУВАННЯ (Spraying Window) ---
    let sprayScore = 0;
    let sprayReasons = [];
    if (d.wind_spd > 5) { sprayScore += 60; sprayReasons.push('сильний вітер'); }
    else if (d.wind_spd > 3) { sprayScore += 25; sprayReasons.push('помірний вітер'); }
    
    if (d.precip > 0.1) { sprayScore += 70; sprayReasons.push('опади'); }
    
    if (d.temp > 30) { sprayScore += 50; sprayReasons.push('екстремальна спека'); }
    else if (d.temp > 25) { sprayScore += 20; sprayReasons.push('висока t°'); }
    
    if (d.rh < 40) { sprayScore += 15; sprayReasons.push('низька вологість'); }

    risks.push({
        id: 'spray_check',
        name: '🚜 Вікно для обробки',
        score: Math.min(sprayScore, 100),
        advice: sprayScore >= 70 
            ? `Скасуйте обробку: ${sprayReasons.join(', ')}. Ефективність буде нульовою.` 
            : (sprayScore >= 40 
                ? `Умови ризиковані через ${sprayReasons.join(', ')}. Якщо можливо, перенесіть.` 
                : 'Ідеальні умови для обприскування! Рекомендовано проводити рано вранці або ввечері.'),
        details: `Вітер: ${d.wind_spd.toFixed(1)}м/с, опади: ${d.precip.toFixed(2)}мм, t: ${d.temp.toFixed(1)}°C, вологість: ${Math.round(d.rh)}%.`
    });

    // --- 6. ГІПОКСІЯ / ПЕРЕЗВОЛОЖЕННЯ ---
    let rainHistory = (history && history.length > 0) 
        ? history.slice(0, 5).reduce((sum, h) => sum + (h.precip || 0), 0) 
        : 0;

    let hypoxia =
        score(d.precip > 20, 40) +
        score(rainHistory > 40, 40) + 
        score(d.clouds > 80 && d.rh > 80, 20) +
        score(d.temp < 15, 10);

    risks.push({
        id: 'hypoxia',
        name: '🌊 Задихання коренів',
        score: Math.min(hypoxia, 100),
        advice: hypoxia >= 70 
            ? 'Критичне перезволоження! Прокопайте водовідвідні канавки. Після підсихання — обов’язкове розпушування. Для захисту від гнилей: Магнікур Енерджі (пролив під корінь, пропамокарб+фосетил).' 
            : 'Ґрунт перезволожений. Утримайтеся від поливу. Розпушіть землю ("сухий полив") для доступу кисню до коренів. Небезпечно для цибулі та полуниці.',
        details: `Випало ${d.precip.toFixed(1)}мм (всього за 5 днів: ${rainHistory.toFixed(1)}мм). Ґрунт перенасичений вологою.`,
        relatedCrops: ['cucumber', 'zucchini', 'strawberry', 'potato', 'cabbage', 'onion']
    });

    // --- 7. ПАРША (Venturia) ---
    let scabHistory = (history && history.length > 0) 
        ? history.slice(0, 3).filter(h => h.precip > 0.5).length * 15 
        : 0;

    let scab =
        score(d.precip > 0.5 && d.temp >= 12 && d.temp <= 24, 50) +
        score(d.rh > 80, 30) +
        scabHistory;

    risks.push({
        id: 'scab',
        name: '🍎 Парша плодових',
        score: Math.min(scab, 100),
        advice: scab >= 80 
            ? 'Критичний ризик! Терміново: Скор (2мл/10л, дифеноконазол) або Магнікур Сенсейшн (3.5мл/10л, флуопірам+трифлоксістробін). Уникайте надлишку азоту, він провокує хворобу!' 
            : 'Сприятливі умови для парші. Використовуйте Хорус (3г/10л, ципродиніл). Восени обов’язково обробіть опале листя Карбамідом (5-7%) для знищення інфекції.',
        details: `Вологий лист. Ризик +${scabHistory}% через опади в минулі дні.`,
        relatedCrops: ['apple', 'pear']
    });

    // --- 8. ЗАМОРОЗОК ---
    let frost =
        score(d.min_temp <= 2, 50) +
        score(d.clouds < 20, 30) +
        score(d.wind_spd < 2, 20);
    risks.push({
        id: 'frost',
        name: '❄️ Приморозок',
        score: Math.min(frost, 100),
        advice: frost >= 80
            ? 'КРИТИЧНО! Вкрийте все агроволокном. Обробіть антистресантом (Мегафол, Епін-Екстра — вони діють як антифриз). Вечірній полив допоможе втримати тепло землі.'
            : `Ризик приморозку на ґрунті. ${stage.id === 'late_spring' ? 'Небезпечно для цвіту! Проведіть задимлення або дощування.' : 'Захистіть розсаду. Дайте калій для стійкості.'}`,
        details: `Мін t: ${d.min_temp.toFixed(1)}°C, небо ясне (високе випромінювання тепла).`,
        relatedCrops: ['strawberry', 'grape', 'tomato', 'pepper', 'potato', 'apple', 'cherry', 'peach', 'rose']
    });

    // --- 10. АЛЬТЕРНАРІОЗ (суха плямистість) ---
    let altHistory = (history && history.length > 0) 
        ? history.slice(0, 3).filter(h => h.temp_avg > 25).length * 10 
        : 0;

    let alternaria =
        score(d.temp > 24, 30) +
        score(d.temp > 28, 20) +
        score(d.precip > 0.5, 30) +
        score(d.rh > 65, 20) +
        altHistory;

    risks.push({
        id: 'alternaria',
        name: '🍂 Альтернаріоз',
        score: Math.min(alternaria, 100),
        advice: alternaria >= 80 
            ? 'Критичний ризик! Обробіть системно: Скор (2мл/10л, дифеноконазол) або Сігнум (10г/10л). Видаліть старе листя з концентричними плямами.' 
            : 'Умови для плямистостей. Профілактика: Квадріс (6мл/10л, азоксистробін) або Ревус Топ. Слідкуйте за нижнім листям.',
        details: `Спекотно та волого: ${d.temp.toFixed(1)}°C, ${Math.round(d.rh)}%. Ризик +${altHistory}% від спеки минулих днів.`,
        relatedCrops: ['tomato', 'potato', 'apple', 'sunflower']
    });

    // --- 11. АНТРАКНОЗ ---
    let antHistory = (history && history.length > 0) 
        ? history.slice(0, 3).filter(h => h.precip > 0).length * 15 
        : 0;

    let anthracnose =
        score(d.rh > 75, 20) +
        score(d.temp >= 18 && d.temp <= 28, 30) +
        score(d.precip > 0, 30) +
        antHistory;

    risks.push({
        id: 'anthracnose',
        name: '🥀 Антракноз',
        score: Math.min(anthracnose, 100),
        advice: anthracnose >= 80 
            ? 'Критичний ризик! Світч (10г/10л, ципродиніл+флудіоксоніл) або Сігнум (10г/10л). Не поливайте по листу! Видаліть уражені плоди.' 
            : 'Умови для поширення плямистостей. Профілактика: Квадріс (6мл/10л) або Топсін-М. Підсильте імунітет фосфорно-калійним підживленням.',
        details: `Волого та тепло: ${Math.round(d.rh)}%, t: ${d.temp.toFixed(1)}°C. Ризик +${antHistory}% через минулі дощі.`,
        relatedCrops: ['cucumber', 'watermelon', 'strawberry', 'grape', 'raspberry', 'apple', 'cherry']
    });

    // --- 12. СІРА ГНИЛЬ (Botrytis) ---
    let botryHistory = (history && history.length > 0) 
        ? history.slice(0, 3).filter(h => h.rh_avg > 80).length * 15 
        : 0;

    let botrytis =
        score(d.rh > 80, 30) +
        score(d.temp >= 14 && d.temp <= 24, 30) +
        score(d.precip > 0.2, 20) +
        botryHistory;

    risks.push({
        id: 'botrytis',
        name: '🍓 Сіра гниль',
        score: Math.min(botrytis, 100),
        advice: botrytis >= 80
            ? 'Критичний ризик! Світч (10г/10л, ципродиніл+флудіоксоніл) або Тельдор (8г/10л, фенгексамід). Видаляйте гнилі ягоди.' 
            : 'Ризик гнилі. Профілактика: Фітоспорин та Кальцієва селітра (20г/10л) — вона робить шкірку ягід міцнішою.',
        details: `Вологість: ${Math.round(d.rh)}%, t: ${d.temp.toFixed(1)}°C. Ризик +${botryHistory}% від вологи минулих днів.`,
        relatedCrops: ['strawberry', 'grape', 'raspberry', 'tomato', 'pepper', 'cucumber', 'peony']
    });

    // --- 13. МОНІЛІОЗ (Monilinia) ---
    let monHistory = (history && history.length > 0) 
        ? history.slice(0, 3).filter(h => h.precip > 0.1).length * 15 
        : 0;

    let moniliaScore =
        score(d.temp >= 12 && d.temp <= 26, 30) +
        score(d.rh > 70, 25) +
        score(d.precip > 0, 25) +
        monHistory;

    risks.push({
        id: 'monilia',
        name: '🍑 Моніліоз (опік та плодова гниль)',
        score: Math.min(moniliaScore, 100),
        advice: moniliaScore >= 80
            ? 'Масовий моніліоз! Обробіть: Хорус (3г/10л, ципродиніл) або Магнікур Сенсейшн (3.5мл/10л). Виріжте всохлі гілки на 20см нижче ураження!'
            : `Сприятливі умови. ${stage.id === 'late_spring' ? 'Ризик опіку цвіту. Використовуйте Світч (10г/10л) або Хорус + Бор для зав’язі.' : 'Огляньте плоди на гниль. Обробіть Сігнум або Скор.'}`,
        details: `Сприятлива t: ${d.temp.toFixed(1)}°C. Ризик +${monHistory}% за минулі дощі.`,
        relatedCrops: ['apple', 'pear', 'peach', 'cherry', 'apricot', 'plum']
    });

    // --- 14. ІРЖА (Rust) ---
    let rustHistory = (history && history.length > 0) 
        ? history.slice(0, 3).filter(h => h.rh_avg > 80).length * 15 
        : 0;

    let rust =
        score(d.rh > 75, 25) +
        score(d.temp >= 15 && d.temp <= 26, 30) +
        score(d.wind_spd > 4, 15) +
        rustHistory;

    risks.push({
        id: 'rust',
        name: '🍂 Іржа (плямистість)',
        score: Math.min(rust, 100),
        advice: rust >= 80 
            ? 'Масове ураження! Обробіть: Фалькон (6мл/10л) або Магнікур Сенсейшн (3.5мл/10л). На груші іржа приходить з ялівців!'
            : 'Помаранчеві плями. Профілактика: Скор або Топаз. Дайте мікроелементи (Плантафол 20-20-20 або Хелатин) для імунітету.',
        details: `Помірна t: ${d.temp.toFixed(1)}°C та вологість. Ризик +${rustHistory}% через сиру погоду.`,
        relatedCrops: ['pear', 'rose', 'currant', 'conifers', 'apple', 'plum']
    });

    // --- 15. ПАВУТИННИЙ КЛІЩ (Spider Mite) ---
    let miteHistory = (history && history.length > 0) 
        ? history.slice(0, 3).filter(h => h.temp_avg > 28 && h.rh_avg < 50).length * 15 
        : 0;

    let spiderMiteScore =
        score(d.temp > 26, 30) +
        score(d.rh < 40, 40) +
        score(d.precip === 0, 15) +
        miteHistory;

    risks.push({
        id: 'spider_mite',
        name: '🕷 Павутинний кліщ',
        score: Math.min(spiderMiteScore, 100),
        advice: spiderMiteScore >= 80
            ? 'Масовий кліщ! Обробіть: Вертимек (10мл/10л, абамектин) або Санмайт (5г/10л, піридабен). Обов’язково кропіть нижню сторону листа!'
            : 'Суха спека — рай для кліща. Профілактика: Актофіт (60мл/10л) або Ніссоран (діє на яйця). Підвищуйте вологість (холодне дощування).',
        details: `Екстремально сухо: ${Math.round(d.rh)}%, t: ${d.temp.toFixed(1)}°C. Ризик +${miteHistory}% через спеку минулих днів.`,
        relatedCrops: ['cucumber', 'rose', 'grape', 'strawberry', 'apple', 'pepper', 'eggplant']
    });

    // --- 16. ПОПЕЛИЦЯ (Aphids) ---
    let aphidHistory = (history && history.length > 0) 
        ? history.slice(0, 3).filter(h => h.temp_avg >= 20 && h.temp_avg <= 28).length * 15 
        : 0;

    let aphidScore =
        score(d.temp >= 18 && d.temp <= 27, 30) +
        score(d.wind_spd < 3, 20) +
        score(d.precip === 0, 20) +
        aphidHistory;

    risks.push({
        id: 'aphids',
        name: '🐜 Попелиця (Тля)',
        score: Math.min(aphidScore, 100),
        advice: aphidScore >= 80
            ? 'Високий ризик! Теппекі (2г/10л, флонікамід) — найкращий. Також Енжіо (тіаметоксам+лямбда-цигалотрин) або Актара. Знищуйте мурах!'
            : 'Комфортна t для попелиці. Перевірте верхівки пагонів. Для профілактики: Актофіт (абамектин) або калійне мило.',
        details: `t: ${d.temp.toFixed(1)}°C, штиль. Ризик +${aphidHistory}% через стабільне тепло.`,
        relatedCrops: ['rose', 'apple', 'pepper', 'currant', 'cherry', 'cabbage', 'plum', 'peach']
    });

    // --- 17. ХРУЩ (Травневий жук) ---
    let cockHistory = (history && history.length > 0) 
        ? history.slice(0, 5).filter(h => h.temp_avg > 10).length * 10 
        : 0;

    let cockchaferScore =
        score(d.temp >= 12 && d.temp <= 25, 30) +
        score(d.wind_spd < 5, 10) +
        score(d.precip === 0, 10) +
        cockHistory;

    risks.push({
        id: 'cockchafer',
        name: '🪲 Хрущ (личинка та літ)',
        score: Math.min(cockchaferScore, 100),
        advice: cockchaferScore >= 80
            ? 'Масовий літ та активність личинок! Ґрунт прогрівся — пролийте коріння: Антихрущ (10мл/10л, імідаклоприд+біфентрин) або Актара.'
            : 'Ризик льоту хрущів. Ґрунт теплий, личинки вже біля коріння! Внесіть у землю Белем (циперметрин) або Метаризин.',
        details: `t: ${d.temp.toFixed(1)}°C, вечірній штиль. Ризик +${cockHistory}% через прогрів ґрунту минулих днів.`,
        relatedCrops: ['strawberry', 'lawn_grass', 'conifers', 'apple', 'cherry', 'potato']
    });

    // --- 18. VPD (Vapor Pressure Deficit) ---
    let svp = 0.61078 * Math.exp((17.27 * d.temp) / (d.temp + 237.3));
    let avp = svp * (d.rh / 100);
    let vpd = svp - avp;

    if (vpd > 1.8) {
        risks.push({
            id: 'high_vpd',
            name: '💨 Повітряна посуха (VPD)',
            score: Math.min(vpd * 30, 100),
            advice: 'Повітря занадто сухе, рослини закривають продихи та припиняють ріст. Потрібне зволоження повітря або притінення.',
            details: `VPD: ${vpd.toFixed(2)} кПа (критично > 1.5-2.0).`
        });
    } else if (vpd < 0.4 && d.temp > 15) {
        risks.push({
            id: 'low_vpd',
            name: '🌫 Застій вологи (VPD)',
            score: 50,
            advice: 'Повітря занадто вологе, випаровування з листя зупинилося. Ризик грибкових хвороб. Забезпечте провітрювання.',
            details: `VPD: ${vpd.toFixed(2)} кПа (занадто низький).`
        });
    }

    // --- 19. РИЗИК ЗАПИЛЕННЯ (Pollination Risk) ---
    let pollScore = 0;
    if (d.temp > 32 || d.temp < 12 || d.precip > 0.5 || d.wind_spd > 6) {
        pollScore = score(d.temp > 32, 40) +
            score(d.temp < 12, 30) +
            score(d.precip > 0.5, 40) +
            score(d.wind_spd > 6, 20);

        risks.push({
            id: 'pollination',
            name: '🐝 Ризик запилення',
            score: Math.min(pollScore, 100),
            advice: 'Несприятливі умови для бджіл та стерильність пилку. Можливе осипання зав’язі. Застосуйте препарати на основі Бору (B) для кращого зав’язування.',
            details: `t: ${d.temp.toFixed(1)}°C, вітер: ${d.wind_spd.toFixed(1)}м/с, опади.`,
            relatedCrops: ['tomato', 'pepper', 'cucumber', 'apple', 'pear', 'cherry', 'peach', 'strawberry', 'raspberry', 'grape']
        });
    }

    // --- 20. НІЧНЕ ДИХАННЯ (Respiration Stress) ---
    if (d.min_temp > 20) {
        risks.push({
            id: 'night_respiration',
            name: '🥵 Тепла ніч (Стрес дихання)',
            score: 60,
            advice: 'Рослини за ніч витрачають занадто багато енергії на дихання. Вранці бажано дати антистресанти або підживлення по листу.',
            details: `Мін. t: ${d.min_temp.toFixed(1)}°C (занадто тепло для відпочинку).`
        });
    }

    // --- 21. ВИМИВАННЯ ДОБРИВ (Leaching Risk) ---
    if (d.precip > 15) {
        risks.push({
            id: 'leaching',
            name: '🌊 Вимивання добрив',
            score: 70,
            advice: 'Очікується сильна злива. Не проводьте підживлення під корінь сьогодні — добрива вимиються в глибокі шари.',
            details: `Прогноз опадів: ${d.precip.toFixed(1)} мм.`
        });
    }

    // --- 22. ЗАГАРТОВУВАННЯ РОЗСАДИ (Hardening off) ---
    if (d.min_temp >= 12 && d.temp <= 25 && d.uv < 6 && d.wind_spd < 4) {
        risks.push({
            id: 'hardening',
            name: '🌱 Вікно для загартовування',
            score: 40,
            advice: 'Ідеальні умови, щоб винести розсаду «погуляти» або почати висадку. Сонце не пече, вітру майже немає.',
            details: `Комфортна t та низький УФ.`
        });
    }

    // --- 23. СУХОВІЙ ---
    let drought =
        score(['E', 'SE'].includes(d.wind_cdir), 40) +
        score(d.rh < 30, 40) +
        score(d.wind_spd > 6, 20);
    risks.push({
        id: 'drought',
        name: '💨 Суховій',
        score: Math.min(drought, 100),
        advice: 'Екстремальне випаровування. Додайте мульчу, збільште вечірній полив. Захистіть хвойні від обгорання.',
        details: `Вітер ${d.wind_cdir}, сухість повітря.`,
        relatedCrops: ['conifers', 'lawn_grass', 'strawberry', 'cucumber']
    });

    // --- 24. НАКОПИЧЕНИЙ СТРЕС (ІСТОРІЯ) ---
    if (history && history.length > 0) {
        let heatDays = history.filter(h => h.temp_max > 30).length;
        if (heatDays >= 3) {
            risks.push({
                id: 'cumulative_heat',
                name: '🌵 Тривала спека',
                score: Math.min(40 + (heatDays * 10), 100),
                advice: `Це вже ${heatDays}-й день спеки поспіль. Рослини виснажені. Використовуйте антистресанти та рясний полив ввечері.`,
                details: `Спека триває ${heatDays} днів.`
            });
        }

        let totalRain = history.reduce((sum, h) => sum + (h.precip || 0), 0);
        if (totalRain < 5 && d.temp > 25) {
            risks.push({
                id: 'water_deficit',
                name: '🚱 Дефіцит вологи',
                score: 70,
                advice: 'За останній тиждень майже не було опадів. Потрібен глибокий полив під корінь.',
                details: `Всього ${totalRain.toFixed(1)}мм опадів за тиждень.`
            });
        }
    }

    return risks
        .filter(r => {
            if (!r || typeof r.score !== 'number' || isNaN(r.score)) return false;
            if (r.id === 'spray_check') return true; 
            if (r.score < 40) return false;
            if (!userCrops || userCrops.length === 0) return true;
            if (!r.relatedCrops || !Array.isArray(r.relatedCrops) || r.relatedCrops.length === 0) return true;
            return r.relatedCrops.some(cropId => userCrops.includes(cropId));
        })
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 5)
        .map(r => {
            // Add user-specific crops to the risk object for formatting
            if (userCrops.length > 0 && r.relatedCrops) {
                r.userMatchedCrops = r.relatedCrops.filter(c => userCrops.includes(c));
            }
            return r;
        });
}

function getGrowthStage() {
    let month = new Date().getMonth() + 1;
    if (month >= 3 && month <= 4) return { 
        id: 'early_spring', 
        name: 'Рання весна (стадія бруньки)', 
        fertilizer: 'Високий Азот (N) для росту зелені (напр. NPK 30-10-10 або Селітра). Дозування: 20-30г на 10л.' 
    };
    if (month === 5) return { 
        id: 'late_spring', 
        name: 'Пізня весна (цвітіння)', 
        fertilizer: 'Збалансоване живлення (NPK 20-20-20) + Бор (B) для зав’язі. Дозування: 20г на 10л.' 
    };
    if (month >= 6 && month <= 8) return { 
        id: 'summer', 
        name: 'Літо (плодоношення)', 
        fertilizer: 'Високий Калій (K) для смаку та ваги (напр. NPK 10-11-33 або 5-15-45). Дозування: 25г на 10л.' 
    };
    if (month >= 9 && month <= 10) return { 
        id: 'autumn', 
        name: 'Осінь (підготовка до зими)', 
        fertilizer: 'Без Азоту! Тільки Фосфор та Калій (NPK 0-25-50) для зміцнення кори. Дозування: 20г на 10л.' 
    };
    return { id: 'winter', name: 'Зима (спокій)', fertilizer: 'Підживлення не потрібне.' };
}

function formatAgroReport(city, risks, lang = 'uk', date = null) {
    const { CROPS_DATA } = require('./crops');
    let esc = (text) => String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let cityEsc = esc(city);

    let dateStr = '';
    if (date) {
        const dObj = new Date(date);
        dateStr = dObj.toLocaleDateString(lang === 'uk' ? 'uk-UA' : 'en-US', { day: 'numeric', month: 'long' });
    }

    if (risks.length === 0) {
        return lang === 'uk'
            ? `🌿 <b>Аналіз на ${dateStr}: м. ${cityEsc}</b>\n\n✅ Критичних агро-ризиків не виявлено. Погода сприятлива!`
            : `🌿 <b>Analysis for ${dateStr}: ${cityEsc}</b>\n\n✅ No critical agro-risks detected. Weather is favorable!`;
    }

    let message = lang === 'uk'
        ? `🧠 <b>Аналітика на ${dateStr}: ${cityEsc}</b>\n━━━━━━━━━━━━━━━━━━━━\n`
        : `🧠 <b>Analytics for ${dateStr}: ${cityEsc}</b>\n━━━━━━━━━━━━━━━━━━━━\n`;

    risks.forEach(r => {
        let level = lang === 'uk' ? '🟡 СЕРЕДНІЙ' : '🟡 MEDIUM';
        if (r.score >= 80) level = lang === 'uk' ? '🔴 КРИТИЧНИЙ' : '🔴 CRITICAL';
        if (r.id === 'spray_check' && r.score < 50) level = lang === 'uk' ? '🟢 СПРИЯТЛИВО' : '🟢 FAVORABLE';

        message += `${esc(r.name)}: ${level} (${Math.round(r.score)}/100)\n`;
        message += `  ↳ <i>${esc(r.details || '')}</i>\n`;
        
        let cropMention = '';
        if (r.userMatchedCrops && r.userMatchedCrops.length > 0) {
            const cropNames = r.userMatchedCrops.map(id => {
                for (let cat in CROPS_DATA) {
                    if (CROPS_DATA[cat].items[id]) return CROPS_DATA[cat].items[id][lang];
                }
                return id;
            });
            cropMention = lang === 'uk' 
                ? `\n  📍 <b>Ваші культури під загрозою:</b> ${cropNames.join(', ')}.`
                : `\n  📍 <b>Your crops at risk:</b> ${cropNames.join(', ')}.`;
        }

        message += lang === 'uk' 
            ? `  👉 <b>Порада:</b> ${esc(r.advice || '')}${cropMention}\n\n` 
            : `  👉 <b>Advice:</b> ${esc(r.advice || '')}${cropMention}\n\n`;
    });

    let stage = getGrowthStage();
    if (lang === 'uk') {
        message += `📅 <b>Сезонна стратегія: ${esc(stage.name)}</b>\n`;
        message += `🧪 <b>Живлення:</b> ${esc(stage.fertilizer)}\n\n`;
    }

    let moon = getLunarPhase(date || new Date());
    message += `━━━━━━━━━━━━━━━━━━━━\n`;
    message += `🌙 ${esc(moon.name)}\n`;
    message += `<i>`;
    message += lang === 'uk'
        ? `Дані мають рекомендаційний характер для прийняття агро-рішень</i>`
        : `Data is for advisory purposes to support agricultural decision-making</i>`;
    return message;
}

function analyzeSprayingWindow(forecastData, history = [], lang = 'uk', userCrops = []) {
    if (!forecastData || !Array.isArray(forecastData)) return '';
    let report = lang === 'uk' ? '🚜 <b>Графік робіт на 5 днів:</b>\n' : '🚜 <b>5-Day Treatment Schedule:</b>\n';

    const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Europe/Kyiv' }).slice(0, 10);
    const relevantForecast = forecastData.filter(day => {
        const d = (day.valid_date || day.datetime || '');
        return d.startsWith(todayStr) || d > todayStr;
    });

    relevantForecast.slice(0, 5).forEach(day => {
        let dateObj = new Date(day.valid_date || day.datetime);
        let dayStr = dateObj.toLocaleDateString(lang === 'uk' ? 'uk-UA' : 'en-US', { weekday: 'short', day: 'numeric' });
        
        let dailyRisks = analyzeAgroRisks(day, history, userCrops);
        let sprayRisk = dailyRisks.find(r => r.id === 'spray_check');
        let sprayScore = sprayRisk ? sprayRisk.score : 0;

        let icon = sprayScore >= 70 ? '🔴' : (sprayScore >= 40 ? '🟡' : '🟢');
        
        let topRisks = dailyRisks.filter(r => r.id !== 'spray_check').slice(0, 3).map(r => `${r.name} ${Math.round(r.score)}/100`);
        let topRiskStr = topRisks.length > 0 ? `\n   ↳ ${topRisks.join(', ')}` : '';

        let status = sprayScore >= 70 ? (lang === 'uk' ? 'Ризиковано' : 'Risky') : 
                     (sprayScore >= 40 ? (lang === 'uk' ? 'Помірний ризик' : 'Moderate risk') : 
                     (lang === 'uk' ? 'Сприятливо' : 'Favorable'));
        
        report += `${icon} <b>${dayStr}</b>: ${status}${topRiskStr}\n`;
    });
    return report;
}

function getLunarPhase(date) {
    let lp = ['🌑 Молодик', '🌒 Молодий місяць', '🌓 Перша чверть', '🌔 Випуклий місяць', '🌕 Повня', '🌖 Спадаючий місяць', '🌗 Остання чверть', '🌘 Старий місяць'];
    let year = date.getFullYear();
    let month = date.getMonth() + 1;
    let day = date.getDate();
    let c = 0, e = 0, jd = 0, b = 0;
    if (month < 3) { year--; month += 12; }
    month++;
    c = 365.25 * year;
    e = 30.6 * month;
    jd = c + e + day - 694039.09;
    jd /= 29.5305882;
    b = parseInt(jd);
    jd -= b;
    b = Math.round(jd * 8);
    if (b >= 8) b = 0;
    return { index: b, name: lp[b] };
}

function analyzeLunarImpact(d, lang = 'uk') {
    let date = new Date(d.valid_date || d.datetime || Date.now());
    let moon = getLunarPhase(date);
    let risks = [];
    if ((moon.index === 0 || moon.index === 4) && d.slp < 1005) {
        risks.push({
            id: 'lunar_storm',
            name: '🌪 Штормовий маркер (Місяць)',
            score: 80,
            advice: 'Поєднання Повні/Молодика та низького тиску — маркер сильних шквалів та гроз. Надійно закріпіть теплиці та високі рослини.',
            details: `${moon.name}, тиск: ${d.slp} hPa.`
        });
    }
    return risks;
}

function generateHistoricalReport(history, lang = 'uk', userCrops = []) {
    const { CROPS_DATA } = require('./crops');
    if (!history || !Array.isArray(history) || history.length === 0) return lang === 'uk' ? '❌ Даних за цей період ще немає.' : '❌ No data for this period.';
    
    // Filter out records that don't have essential temperature data
    let validHistory = history.filter(h => 
        (typeof h.temp_avg === 'number' && !isNaN(h.temp_avg)) || 
        (typeof h.temp_max === 'number' && !isNaN(h.temp_max))
    ).sort((a, b) => new Date(a.date) - new Date(b.date));
    
    if (validHistory.length === 0) return lang === 'uk' ? '❌ Недостатньо даних для аналізу.' : '❌ Not enough data for analysis.';
    
    let totalDays = validHistory.length;
    const startDateStr = validHistory[0].date.split('-').reverse().join('.');
    const endDateStr = validHistory[validHistory.length - 1].date.split('-').reverse().join('.');
    const dateRangeStr = startDateStr === endDateStr ? startDateStr : `${startDateStr} — ${endDateStr}`;

    // Statistics calculation
    let totalPrecip = 0;
    let heatDays = 0;
    let tropicalNights = 0;
    let coldStressDays = 0;
    let frostDays = 0;
    let fungalRiskDays = 0;
    let vpdStressDays = 0;
    let totalEvapEstimation = 0;
    let gdd10 = 0;
    let gdd5 = 0;

    let tempSum = 0;
    let absMax = -999;
    let absMin = 999;
    let rhSum = 0;

    validHistory.forEach(d => {
        let tMax = d.temp_max;
        let tMin = d.temp_min;
        let tAvg = d.temp_avg || (tMax + tMin) / 2;
        let rh = d.rh_avg || 50;

        tempSum += tAvg;
        rhSum += rh;
        if (tMax > absMax) absMax = tMax;
        if (tMin < absMin) absMin = tMin;

        totalPrecip += (d.precip || 0);
        if (tMax > 30) heatDays++;
        if (tMin > 20) tropicalNights++;
        if (tMin < 0) frostDays++;
        if (tMax < 12) coldStressDays++;

        if (tAvg >= 15 && tAvg <= 26 && rh > 80) fungalRiskDays++;
        let svp = 0.6108 * Math.exp((17.27 * tAvg) / (tAvg + 237.3));
        let vpd = svp * (1 - rh / 100);
        if (vpd > 1.2) vpdStressDays++;
        let dailyEvap = 0.2 * (tAvg + 17.8) * Math.sqrt(Math.max(0.1, tMax - tMin)) * 0.1;
        totalEvapEstimation += dailyEvap;
        gdd10 += Math.max(0, tAvg - 10);
        gdd5 += Math.max(0, tAvg - 5);
    });

    let avgTemp = tempSum / totalDays;
    let waterBalance = totalPrecip - totalEvapEstimation;
    let sunnyDays = validHistory.filter(d => (d.clouds_avg || 100) < 25 || (d.uv_max || 0) > 6).length;

    let report = lang === 'uk' 
        ? `📈 <b>Агро-Архів (${dateRangeStr}):</b>\n━━━━━━━━━━━━━━━━━━━━\n`
        : `📈 <b>Agro-Archive (${dateRangeStr}):</b>\n━━━━━━━━━━━━━━━━━━━━\n`;

    if (lang === 'uk') {
        report += `🌡 <b>Температура:</b>\n`;
        report += `• Середня: ${avgTemp.toFixed(1)}°C\n`;
        report += `• Розмах: ${absMin.toFixed(1)}°C ... ${absMax.toFixed(1)}°C\n`;
        report += `• СЕТ (&gt;10°C): ${gdd10.toFixed(1)}°C\n`;
        report += `• СЕТ (&gt;5°C): ${gdd5.toFixed(1)}°C\n`;
        report += `• Сонячних днів: ${sunnyDays}\n\n`;

        report += `💧 <b>Водний баланс:</b>\n`;
        report += `• Опади: ${totalPrecip.toFixed(1)} мм\n`;
        report += `• Випаровування: ~${totalEvapEstimation.toFixed(1)} мм\n`;
        report += `• Баланс: <b>${waterBalance > 0 ? '+' : ''}${waterBalance.toFixed(1)} мм</b>\n\n`;

        report += `⚠️ <b>Стрес-аналітика:</b>\n`;
        if (frostDays > 0) report += `• Заморозки: ${frostDays} ночей 🧊\n`;
        if (heatDays > 0) report += `• Спека (&gt;30°C): ${heatDays} днів 🔥\n`;
        if (tropicalNights > 0) report += `• Тропічні ночі (&gt;20°C): ${tropicalNights} 🥵\n`;
        if (coldStressDays > 0) report += `• Зупинка росту (&lt;12°C): ${coldStressDays} дн. ❄️\n`;
        if (vpdStressDays > 0) report += `• Повітряна посуха: ${vpdStressDays} дн. 💨\n`;
        if (fungalRiskDays > 0) report += `• Ризик грибків: ${fungalRiskDays} дн. 🍄\n`;

        report += `━━━━━━━━━━━━━━━━━━━━\n`;

        // EXPERT SUMMARY SECTION (FOR LONG PERIODS)
        if (totalDays >= 30) {
            report += `🧐 <b>Експертний висновок:</b>\n`;
            
            // 1. Characterization
            let char = "Рік (період) характеризується як ";
            if (avgTemp > 18) char += "інтенсивно-теплий ";
            else if (avgTemp > 12) char += "помірно-теплий ";
            else char += "прохолодний ";
            
            if (waterBalance < -50) char += "з вираженим дефіцитом вологи.";
            else if (waterBalance > 50) char += "з надмірним зволоженням.";
            else char += "з нормальним зволоженням.";
            report += `• ${char}\n`;

            // 2. Growth
            let growth = `Завдяки СЕТ ${gdd10.toFixed(0)}°C, приріст культур мав бути `;
            if (gdd10 > 1500) growth += "максимальним. ";
            else if (gdd10 > 1000) growth += "стабільним. ";
            else growth += "сповільненим. ";
            
            if (userCrops.length > 0) {
                const warmCrops = ['tomato', 'pepper', 'grape', 'peach', 'watermelon'];
                const matchedWarm = userCrops.filter(c => warmCrops.includes(c));
                if (matchedWarm.length > 0 && gdd10 > 1200) {
                    growth += `Умови були ідеальними для ваших теплолюбних рослин (${matchedWarm.length}).`;
                }
            }
            report += `• <b>Ріст:</b> ${growth}\n`;

            // 3. Risks
            if (vpdStressDays > 15) {
                let riskText = `Головною проблемою була повітряна посуха (${vpdStressDays} дн.). `;
                if (userCrops.includes('conifers') || userCrops.includes('hydrangea') || userCrops.includes('cucumber')) {
                    riskText += "Це могло призвести до підсихання листя або хвої у ваших вологолюбних культур, якщо не було дощування.";
                }
                report += `• <b>Ризики:</b> ${riskText}\n`;
            }

            // 4. Health & Frost
            let health = "";
            if (fungalRiskDays < totalDays * 0.1) {
                health = "Низький ризик грибків дозволив зекономити на обробках. ";
            } else {
                health = `Високий інфекційний фон (${fungalRiskDays} дн. вологи) вимагав посиленого фунгіцидного захисту. `;
            }
            
            if (frostDays > 20) {
                health += `Велика кількість заморозки (${frostDays}) вимагала ретельного укриття чутливих рослин навесні.`;
            }
            report += `• <b>Здоров'я:</b> ${health}\n`;
        } else {
            if (waterBalance < -20) {
                report += `💡 <b>Порада:</b> Значний дефіцит вологи! Рослини випарували на ${Math.abs(waterBalance).toFixed(0)}мм більше, ніж випало опадів. Потрібен глибокий полив.\n`;
            } else if (fungalRiskDays > totalDays * 0.3) {
                report += `💡 <b>Порада:</b> Кожен третій день був вологим та теплим. Високий ризик гнилей та фітофтори! Перевірте густину посадок.\n`;
            } else {
                report += `✅ Умови для розвитку стабільні.`;
            }
        }
    } else {
        // English version (simplified)
        report += `🌡 <b>Temperature:</b>\n`;
        report += `• Average: ${avgTemp.toFixed(1)}°C\n`;
        report += `• GDD (>10°C): ${gdd10.toFixed(1)}°C\n\n`;
        report += `💧 <b>Water Balance:</b> ${waterBalance.toFixed(1)} mm\n`;
        report += `⚠️ <b>Stress Analytics:</b> Frosts: ${frostDays}, Heat: ${heatDays}, Fungal: ${fungalRiskDays} days\n`;
        if (totalDays >= 30) {
            report += `\n🧐 <b>Summary:</b> The period was ${avgTemp > 18 ? 'warm' : 'cool'} with ${waterBalance < -50 ? 'water deficit' : 'normal moisture'}.`;
        }
    }

    return report;
}

/**
 * Дозавантаження відсутніх історичних даних
 * @param {Object} cityDoc - Документ міста з БД
 * @param {number} days - Глибина перевірки в днях
 */
async function fetchMissingHistory(cityDoc, days = 30) {
    if (!cityDoc || !cityDoc.lat || !cityDoc.lon) return;

    const externalId = cityDoc.externalId || `${cityDoc.lat.toFixed(2)},${cityDoc.lon.toFixed(2)}`;
    
    // 1. Визначаємо часовий проміжок
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - days);
    
    const startDateStr = startDate.toISOString().split('T')[0];
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const endDateStr = yesterday.toISOString().split('T')[0];

    // 2. Отримуємо список дат, які вже є в базі
    const existingRecords = await History.find({
        externalId,
        date: { $gte: startDateStr, $lte: endDateStr }
    }, { date: 1 }).lean();
    
    const existingDates = new Set(existingRecords.map(r => r.date));

    // 3. Генеруємо список усіх дат у проміжку
    const allDates = [];
    let current = new Date(startDate);
    // Set time to noon to avoid DST and time-of-day edge cases
    current.setHours(12, 0, 0, 0);
    const end = new Date(yesterday);
    end.setHours(12, 0, 0, 0);

    while (current <= end) {
        allDates.push(current.toISOString().split('T')[0]);
        current.setDate(current.getDate() + 1);
    }

    // 4. Знаходимо пропущені дати
    const missingDates = allDates.filter(d => !existingDates.has(d));
    
    if (missingDates.length === 0) return;

    console.log(`[Agro] Missing ${missingDates.length} days for ${cityDoc.name}. Fetching...`);

    try {
        // Отримуємо дані з Open-Meteo Archive API за весь період (так простіше і швидше за 1 запит)
        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${cityDoc.lat}&longitude=${cityDoc.lon}&start_date=${startDateStr}&end_date=${endDateStr}&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,relative_humidity_2m_mean,wind_speed_10m_max,cloud_cover_mean&timezone=auto`;
        
        const response = await axios.get(url);
        const daily = response.data.daily;

        if (!daily || !daily.time) return;

        const bulkOps = [];
        for (let i = 0; i < daily.time.length; i++) {
            const date = daily.time[i];
            
            // ДОДАЄМО ТІЛЬКИ ЯКЩО ДАТИ НЕМАЄ В БАЗІ (як просив користувач)
            if (missingDates.includes(date)) {
                bulkOps.push({
                    updateOne: {
                        filter: { externalId, date },
                        update: {
                            $setOnInsert: { // Використовуємо $setOnInsert про всяк випадок, хоча ми вже відфільтрували
                                temp_max: daily.temperature_2m_max[i],
                                temp_min: daily.temperature_2m_min[i],
                                temp_avg: daily.temperature_2m_mean[i],
                                precip: daily.precipitation_sum[i],
                                rh_avg: daily.relative_humidity_2m_mean[i],
                                wind_spd_max: daily.wind_speed_10m_max[i] / 3.6,
                                clouds_avg: daily.cloud_cover_mean[i]
                            }
                        },
                        upsert: true
                    }
                });
            }
        }

        if (bulkOps.length > 0) {
            await History.bulkWrite(bulkOps, { ordered: false });
            console.log(`[Agro] Successfully loaded ${bulkOps.length} missing records for ${cityDoc.name}`);
        }
    } catch (error) {
        console.error(`[Agro] Failed to fetch missing history for ${cityDoc.name}:`, error.message);
    }
}

module.exports = { 
    analyzeAgroRisks, 
    formatAgroReport, 
    analyzeSprayingWindow, 
    generateHistoricalReport, 
    getLunarPhase, 
    getGrowthStage,
    fetchMissingHistory 
};
