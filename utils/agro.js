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


    let stage = getGrowthStage(history);
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
        score(d.temp >= 22 && d.temp <= 28, 35) +
        score(d.temp >= 18 && d.temp < 22, 15) +
        score(d.rh >= 50 && d.rh <= 75, 20) +
        score(d.precip === 0 && d.temp > 16, 25) +
        score(d.clouds < 30 && d.temp > 16, 20);
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

    // --- 25. М'ЯКА ПІДТРИМКА ТА ІМУНІТЕТ (Soft Advice Engine) ---

    // 1. Модель стану ґрунту
    let totalRain7 = history.slice(0, 7).reduce((sum, h) => sum + (h.precip || 0), 0);
    let soilTemp = d.temp * 0.7 + (history.length > 0 ? (history[0].temp_avg || d.temp) * 0.3 : d.temp);
    let soilMoistureIndex = Math.max(0, (totalRain7 + d.precip) - (history.length * 2));

    if (soilTemp > 10 && soilTemp < 22 && soilMoistureIndex > 10 && soilMoistureIndex < 50) {
        risks.push({
            id: 'soil_perfect',
            name: '🌱 Ідеальний ґрунт',
            score: 41, // Трохи вище 40, щоб проходило фільтр
            advice: 'Температура та вологість ґрунту ідеальні для висадки. Не проґавте вікно!',
            details: `t ґрунту: ~${soilTemp.toFixed(1)}°C, вологи достатньо.`
        });
    }

    // 2. Кумулятивний УФ-стрес
    let heavyUVCount = history.filter(h => (h.uv_max || h.uv || 0) > 7).length;
    if (heavyUVCount >= 2 && d.uv > 7) {
        risks.push({
            id: 'cumulative_uv',
            name: '☀️ УФ-виснаження',
            score: 65,
            advice: 'Це вже декілька днів агресивне сонце. Рослини втратили захисний віск. Потрібне затінення.',
            details: `Серія з ${heavyUVCount + 1} днів високого УФ.`
        });
    }

    // 3. Реабілітація після стресу
    let recentStress = history.slice(0, 3).some(h => (h.temp_min < 1) || (h.wind_spd_max > 12));
    if (recentStress && d.temp > 10) {
        risks.push({
            id: 'recovery_mode',
            name: '🏥 Режим відновлення',
            score: 90,
            advice: 'Рослини після стресу! Тільки антистресанти (Мегафол, Амінокат). Жодних добрив під корінь!',
            details: 'Метаболізм відновлюється після морозу/вітру.'
        });
    }

    // 4. Біо-захист через росу
    if (d.temp - d.dewpt < 2) {
        risks.push({
            id: 'bio_protection',
            name: '🦠 Біо-бар\'єр (Роса)',
            score: 45,
            advice: 'Очікується сильна роса. Використайте Фітоспорин ввечері — він створить живий щит.',
            details: 'Умови ідеальні для активації корисних бактерій.'
        });
    }

    // 5. Зміцнення стінок (Кальцій/Кремній)
    if (d.rh > 80 && d.temp > 18) {
        risks.push({
            id: 'calcium_support',
            name: '🧪 Зміцнення імунітету',
            score: 55,
            advice: 'Сира погода. Підкорміть Кальцієвою селітрою, щоб зміцнити лист до атак грибка.',
            details: 'Підготовка "броні" для клітин.',
            relatedCrops: ['tomato', 'pepper', 'cucumber', 'apple']
        });
    }

    // 6. Запилення та Бор
    if (stage.id === 'late_spring' && (d.wind_spd > 5 || d.precip > 0.5)) {
        risks.push({
            id: 'boron_support',
            name: '🐝 Підтримка зав\'язі',
            score: 60,
            advice: 'Складні умови для комах. Додайте Бор (Бороплюс) для кращого запилення.',
            details: 'Стимуляція запилення.',
            relatedCrops: ['tomato', 'strawberry', 'apple', 'cherry', 'grape']
        });
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

function getGrowthStage(history = []) {
    // Розрахунок СЕТ (Сума Ефективних Температур > 5°C)
    // Якщо історії немає, використовуємо поточну дату як fallback
    if (!history || history.length < 5) {
        let month = new Date().getMonth() + 1;
        if (month >= 3 && month <= 4) return { id: 'early_spring', name: 'Рання весна (стадія бруньки)', gdd: 0, fertilizer: 'Азот (Селітра 20-30г/10л)' };
        if (month === 5) return { id: 'late_spring', name: 'Пізня весна (цвітіння)', gdd: 300, fertilizer: 'Бор (10-15мл) + NPK 20-20-20' };
        if (month >= 6 && month <= 8) return { id: 'summer', name: 'Літо (плодоношення)', gdd: 800, fertilizer: 'Калій (Монофосфат калію 20-25г)' };
        return { id: 'autumn', name: 'Осінь', gdd: 1500, fertilizer: 'Фосфор-Калій (0-25-50)' };
    }

    let gdd5 = history.reduce((sum, h) => sum + Math.max(0, (h.temp_avg || h.temp || 0) - 5), 0);

    if (gdd5 < 150) return { id: 'early_spring', name: 'Рання весна (брунька)', gdd: gdd5, fertilizer: 'Азот (Селітра 20г/10л)' };
    if (gdd5 < 400) return { id: 'late_spring', name: 'Пізня весна (цвітіння)', gdd: gdd5, fertilizer: 'Бор + NPK 20-20-20' };
    if (gdd5 < 1200) return { id: 'summer', name: 'Літо (плодоношення)', gdd: gdd5, fertilizer: 'Калій (Монофосфат калію 20г/10л)' };
    return { id: 'autumn', name: 'Осінь (підготовка)', gdd: gdd5, fertilizer: 'Фосфор-Калій (0-25-50)' };
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

        // Спеціальні пороги для вікна обробки, щоб узгодити з графіком
        if (r.id === 'spray_check') {
            if (r.score >= 70) level = lang === 'uk' ? '🔴 РИЗИКОВАНО' : '🔴 RISKY';
            else if (r.score >= 40) level = lang === 'uk' ? '🟡 ПОМІРНИЙ РИЗИК' : '🟡 MODERATE RISK';
            else level = lang === 'uk' ? '🟢 СПРИЯТЛИВО' : '🟢 FAVORABLE';
        }

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

    // 1. ПЕРВИННИЙ ЗБІР ДАНИХ (Аналізуємо всі 5 днів)
    const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Europe/Kyiv' }).slice(0, 10);
    const relevantForecast = forecastData.filter(day => {
        const d = (day.valid_date || day.datetime || '');
        return d.startsWith(todayStr) || d > todayStr;
    }).slice(0, 5);

    let dailyResults = relevantForecast.map(day => {
        return {
            day: day,
            risks: analyzeAgroRisks(day, history, userCrops),
            date: new Date(day.valid_date || day.datetime)
        };
    });

    // 2. ЕКСПЕРТНИЙ АНАЛІЗ ПЕРІОДУ (Цифровий Агроном)
    let expertSummary = '';
    let stage = getGrowthStage(history);

    if (lang === 'uk') {
        const startD = dailyResults[0].date.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
        const endD = dailyResults[dailyResults.length - 1].date.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
        
        expertSummary = `🚜 <b>РОЗУМНИЙ АГРО-ПЛАН (5 ДНІВ: ${startD} — ${endD})</b>\n━━━━━━━━━━━━━━━━━━━━\n🧐 <b>ЕКСПЕРТНИЙ ВИСНОВОК:</b>\n`;
        
        // а) Аналіз шкідників (Тренди)
        let pestStats = {};
        const pestIds = ['aphids', 'spider_mite', 'cockchafer', 'codling_moth'];
        dailyResults.forEach((res, idx) => {
            res.risks.forEach(r => {
                if (pestIds.includes(r.id)) {
                    if (!pestStats[r.id]) pestStats[r.id] = { name: r.name, scores: [], firstScore: r.score };
                    pestStats[r.id].scores.push(r.score);
                }
            });
        });

        let pestAdvice = '';
        Object.keys(pestStats).forEach(id => {
            let maxS = Math.max(...pestStats[id].scores);
            let lastS = pestStats[id].scores[pestStats[id].scores.length - 1];
            let cleanName = pestStats[id].name.replace(/\p{Emoji_Presentation}/gu, '').replace(/\p{Emoji}/gu, '').trim();
            
            if (maxS >= 80) {
                if (lastS >= maxS) {
                    pestAdvice += `• 🪲 <b>${cleanName}:</b> Прогресує! Досягне максимуму (${Math.round(maxS)}/100) до кінця тижня. <b>Обробка обов'язкова.</b>\n`;
                } else {
                    pestAdvice += `• 🪲 <b>${cleanName}:</b> На піку активності (${Math.round(maxS)}/100). Не зволікайте з захистом.\n`;
                }
            } else if (maxS >= 50) {
                pestAdvice += `• 🪲 <b>${cleanName}:</b> Популяція зростає (${Math.round(maxS)}/100). Готуйте засоби захисту.\n`;
            }
        });
        if (pestAdvice) expertSummary += pestAdvice;

        // б) Аналіз інфекційного фону та імунітету
        let diseaseStats = [];
        const diseaseIds = ['phytophthora', 'downy_mildew', 'powdery_mildew', 'scab', 'alternaria', 'anthracnose', 'botrytis', 'monilia', 'rust'];
        
        dailyResults.forEach(res => {
            res.risks.forEach(r => {
                if (diseaseIds.includes(r.id) && r.score >= 40) {
                    diseaseStats.push(r);
                }
            });
        });

        // Також враховуємо загальний кліматичний індекс інфекції
        let infScore = 0;
        let maxInf = 0;
        relevantForecast.forEach(d => {
            if (d.temp >= 15 && d.temp <= 26 && d.rh > 80) infScore += 12;
            else if (d.clouds < 30 && d.rh < 60) infScore = Math.max(0, infScore - 6);
            if (infScore > maxInf) maxInf = infScore;
        });

        const topDisease = diseaseStats.sort((a, b) => b.score - a.score)[0];
        
        if (topDisease && topDisease.score >= 70) {
            let cleanN = topDisease.name.replace(/\p{Emoji_Presentation}/gu, '').replace(/\p{Emoji}/gu, '').trim();
            expertSummary += `• 🦠 <b>Інфекція:</b> Високий ризик ${cleanN} (${Math.round(topDisease.score)}/100). Потрібні системні фунгіциди.\n`;
        } else if (topDisease || maxInf >= 30) {
            let currentScore = topDisease ? Math.max(topDisease.score, maxInf) : maxInf;
            let logicAdvice = "Підкорміть Кальцієм або Кремнієм для зміцнення стінок листя (Si створює механічний бар'єр).";
            if (stage.id === 'late_spring') logicAdvice = "Стадія цвітіння: додайте Бор та Кальцій — це зміцнить зав'язь та імунітет.";
            else if (stage.id === 'summer') logicAdvice = "Плодоношення: дайте Калій та Кремній для щільності шкірки.";
            
            let name = topDisease ? topDisease.name.replace(/\p{Emoji_Presentation}/gu, '').replace(/\p{Emoji}/gu, '').trim() : "Грибки";
            expertSummary += `• 🦠 <b>Інфекція:</b> ${name} набирають обертів (${Math.round(currentScore)}/100). <b>Дія:</b> ${logicAdvice}\n`;
        } else {
            expertSummary += `• 🦠 <b>Інфекція:</b> Фон чистий. Рослини в безпеці.\n`;
        }

        // в) Реабілітація та фаза
        let isRecovery = dailyResults.some(r => r.risks.some(risk => risk.id === 'recovery_mode'));
        if (isRecovery) {
            expertSummary += `• 🏥 <b>Реабілітація:</b> Рослини в стресі. Тільки амінокислоти, ніяких добрив під корінь!\n`;
        } else {
            expertSummary += `• 🌱 <b>Фаза розвитку:</b> ${stage.name}.\n`;
            expertSummary += `• 🧪 <b>Живлення:</b> ${stage.fertilizer}. ${stage.fertilizer.includes('Азот') ? 'Зараз активний ріст зеленої маси.' : 'Рослина переходить до формування врожаю.'}\n`;
        }

    } else {
        expertSummary = `🚜 <b>SMART AGRO-PLAN (5 DAYS)</b>\n━━━━━━━━━━━━━━━━━━━━\n🧐 <b>EXPERT SUMMARY:</b>\n• Analysis of pests and infection trends included below.\n`;
    }

    expertSummary += `\n📅 <b>ПОКРОКОВИЙ ПЛАН:</b>\n`;

    // 3. ФОРМУВАННЯ ГРАФІКА
    dailyResults.forEach(res => {
        let day = res.day;
        let dayStr = res.date.toLocaleDateString(lang === 'uk' ? 'uk-UA' : 'en-US', { weekday: 'short', day: 'numeric' });

        let sprayRisk = res.risks.find(r => r.id === 'spray_check');
        let sprayScore = sprayRisk ? sprayRisk.score : 0;
        let icon = sprayScore >= 70 ? '🔴' : (sprayScore >= 40 ? '🟡' : '🟢');

        let status = sprayScore >= 70 ? (lang === 'uk' ? 'Ризиковано' : 'Risky') :
            (sprayScore >= 40 ? (lang === 'uk' ? 'Помірний ризик' : 'Moderate risk') :
                (lang === 'uk' ? 'Сприятливо' : 'Favorable'));

        let precipInfo = day.precip > 0.1 ? `, 🌧${day.precip.toFixed(1)}мм` : '';
        expertSummary += `${icon} <b>${dayStr}</b>: ${status} (t:${day.temp.toFixed(0)}°, ${day.wind_spd.toFixed(1)}м/с${precipInfo})\n`;

        if (sprayScore >= 70) {
            // Визначаємо причину ризику
            let reason = 'несприятливі умови';
            if (day.precip > 0.1) reason = 'через очікувані опади';
            else if (day.wind_spd > 5) reason = 'через сильний вітер';
            else if (day.temp > 30) reason = 'через екстремальну спеку';

            expertSummary += `   ↳ ❌ <b>Не рекомендується:</b> Сьогодні ${reason} краще нічого не робити. Відпочиньте!\n`;
        } else {
            // Показуємо декілька головних ризиків з балами
            let otherRisks = res.risks.filter(r => r.id !== 'spray_check' && r.score >= 40).slice(0, 2);
            if (otherRisks.length > 0) {
                const { CROPS_DATA } = require('./crops');
                let riskItems = otherRisks.map(r => {
                    let cleanN = r.name.replace(/\p{Emoji_Presentation}/gu, '').replace(/\p{Emoji}/gu, '').trim();
                    
                    // Пошук культур користувача, яких стосується цей ризик
                    let cropNames = [];
                    if (userCrops && userCrops.length > 0 && r.relatedCrops) {
                        r.relatedCrops.filter(id => userCrops.includes(id)).slice(0, 4).forEach(id => {
                            for (let cat in CROPS_DATA) {
                                if (CROPS_DATA[cat].items[id]) {
                                    cropNames.push(CROPS_DATA[cat].items[id][lang]);
                                    break;
                                }
                            }
                        });
                        if (r.relatedCrops.filter(id => userCrops.includes(id)).length > 4) cropNames.push('...');
                    }
                    
                    let cropLabel = cropNames.length > 0 ? ` <b>[${cropNames.join(', ')}]</b>` : '';
                    return `${cleanN} (${Math.round(r.score)})${cropLabel}`;
                }).join(', ');

                let actionIcon = '🛡️';
                if (otherRisks[0].id === 'cockchafer') actionIcon = '🪲';
                else if (otherRisks[0].id.includes('stress') || otherRisks[0].id === 'frost') actionIcon = '⚠️';

                let shortAdvice = otherRisks[0].advice.split(/[.!?]/).filter(s => s.trim().length > 0)[0].trim();
                expertSummary += `   ↳ ${actionIcon} ${riskItems}: ${shortAdvice}.\n`;
            } else {
                expertSummary += `   ↳ ✅ <b>Все спокійно:</b> Оптимальний час для планових робіт та догляду.\n`;
            }
        }
    });

    expertSummary += `━━━━━━━━━━━━━━━━━━━━\n`;
    return expertSummary;
}

function getLunarPhase(inputDate) {
    const lp = [
        '🌑 Молодик (новий)',
        '🌒 Місяць, що зростає',
        '🌓 Перша чверть',
        '🌔 Місяць, що зростає (випуклий)',
        '🌕 Повня',
        '🌖 Місяць, що спадає (випуклий)',
        '🌗 Остання чверть',
        '🌘 Місяць, що спадає (старий)'
    ];
    const date = (inputDate instanceof Date) ? inputDate : new Date(inputDate);

    // More accurate Julian Date calculation
    const jd = (date.getTime() / 86400000) - (date.getTimezoneOffset() / 1440) + 2440587.5;

    // Days since last known new moon (approx reference point)
    const referenceNewMoon = 2451550.1; // Jan 6, 2000
    const lunarCycle = 29.530588853;
    const age = (jd - referenceNewMoon) % lunarCycle;
    const normalizedAge = age < 0 ? age + lunarCycle : age;

    const phaseIndex = normalizedAge / lunarCycle;

    // Determine phase with precise thresholds
    // Each phase is approx 1/8 of the cycle (0.125)
    // We center the primary phases (0, 0.25, 0.5, 0.75) with a small window
    let b = 0;
    if (phaseIndex < 0.03 || phaseIndex > 0.97) b = 0; // New Moon
    else if (phaseIndex < 0.22) b = 1; // Waxing Crescent
    else if (phaseIndex < 0.28) b = 2; // First Quarter
    else if (phaseIndex < 0.47) b = 3; // Waxing Gibbous
    else if (phaseIndex < 0.53) b = 4; // Full Moon
    else if (phaseIndex < 0.72) b = 5; // Waning Gibbous
    else if (phaseIndex < 0.78) b = 6; // Last Quarter
    else b = 7; // Waning Crescent

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

async function generateHistoricalReport(history, lang = 'uk', userCrops = [], externalId = null) {
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

    // --- 1. ПІДГОТОВКА СЕЗОННОГО КОНТЕКСТУ ---
    const periodStartStr = validHistory[0].date;
    const periodEndStr = validHistory[validHistory.length - 1].date;
    const seasonStartStr = `${new Date(periodEndStr).getFullYear()}-03-01`;

    let fullContext = validHistory;
    if (externalId && periodStartStr > seasonStartStr) {
        try {
            // Завантажуємо дані від початку сезону до початку обраного періоду
            const extra = await History.find({
                externalId,
                date: { $gte: seasonStartStr, $lt: periodStartStr }
            }).sort({ date: 1 }).lean();

            const validExtra = extra.filter(h =>
                (typeof h.temp_avg === 'number' && !isNaN(h.temp_avg)) ||
                (typeof h.temp_max === 'number' && !isNaN(h.temp_max))
            );
            fullContext = [...validExtra, ...validHistory];
        } catch (e) {
            console.error('[Agro] Seasonal context fetch failed:', e.message);
        }
    }

    // Period (Specific) accumulators
    let totalPrecip = 0;
    let heatDays = 0;
    let tropicalNights = 0;
    let coldStressDays = 0;
    let groundFrosts = 0;
    let radiationFrosts = 0;
    let advectiveFrosts = 0;
    let fungalRiskDays = 0;
    let vpdStressDays = 0;
    let windStressDays = 0;
    let pollinationStressDays = 0;
    let hypoxiaDays = 0;
    let totalEvapEstimation = 0;
    let gdd10 = 0;
    let gdd5 = 0;
    let tempSum = 0;
    let absMax = -999;
    let absMin = 999;
    let rhSum = 0;
    let periodInfectionIndex = 0;
    let periodSowingDates = [];
    let advectiveDates = [];
    let radiationDates = [];
    let groundDates = [];

    // Seasonal (Cumulative Context) accumulators
    let seasonalStresses = { advective: 0, radiation: 0, ground: 0, heat: 0, wind: 0, pollination: 0, fungal: 0, hypoxia: 0 };
    let seasonalGDD5 = 0;
    let seasonalGDD10 = 0;
    let seasonalInfectionIndex = 0;
    let seasonalSowingCount = 0;
    let chillHours = 0;
    let hardeningLossEvents = 0;
    let currentGDD5 = 0;
    let prevTempAvg = null;

    // --- 2. ЦИКЛ АНАЛІЗУ ---
    fullContext.forEach(d => {
        let tMax = d.temp_max;
        let tMin = d.temp_min;
        let tAvg = d.temp_avg || (tMax + tMin) / 2;
        let rh = d.rh_avg || 50;
        let month = new Date(d.date).getMonth() + 1;
        const isInPeriod = (d.date >= periodStartStr && d.date <= periodEndStr);

        let dayGDD5 = Math.max(0, tAvg - 5);
        let dayGDD10 = Math.max(0, tAvg - 10);
        seasonalGDD5 += dayGDD5;
        seasonalGDD10 += dayGDD10;
        currentGDD5 += dayGDD5;

        if (isInPeriod) {
            tempSum += tAvg;
            rhSum += rh;
            if (tMax > absMax) absMax = tMax;
            if (tMin < absMin) absMin = tMin;
            totalPrecip += (d.precip || 0);
            gdd5 += dayGDD5;
            gdd10 += dayGDD10;
        }

        let isAgroSeason = (month >= 3 && month <= 10) && (currentGDD5 > 40 || month >= 4);

        if (isAgroSeason) {
            const dateFmt = new Date(d.date).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
            if (tMin < -3) {
                seasonalStresses.advective++;
                if (isInPeriod) { advectiveFrosts++; advectiveDates.push(dateFmt); }
            } else if (tMin <= 0) {
                seasonalStresses.radiation++;
                if (isInPeriod) { radiationFrosts++; radiationDates.push(dateFmt); }
            } else if (tMin <= 2 && (d.clouds_avg || 100) < 30) {
                seasonalStresses.ground++;
                if (isInPeriod) { groundFrosts++; groundDates.push(dateFmt); }
            }
            if (isInPeriod && tMax < 12) coldStressDays++;
        }

        if (tMax > 30) {
            seasonalStresses.heat++;
            if (isInPeriod) heatDays++;
        }
        if (isInPeriod && tMin > 20) tropicalNights++;

        if (tAvg >= 15 && tAvg <= 26 && rh > 80) {
            seasonalStresses.fungal++;
            seasonalInfectionIndex += 10;
            if (isInPeriod) {
                fungalRiskDays++;
                periodInfectionIndex += 10;
            }
        } else if ((d.clouds_avg || 100) < 30 && rh < 60) {
            seasonalInfectionIndex = Math.max(0, seasonalInfectionIndex - 5);
            if (isInPeriod) periodInfectionIndex = Math.max(0, periodInfectionIndex - 5);
        }

        let svp = 0.6108 * Math.exp((17.27 * tAvg) / (tAvg + 237.3));
        let vpd = svp * (1 - rh / 100);
        if (isInPeriod && vpd > 1.2) vpdStressDays++;

        if (isInPeriod) {
            let etoBase = 0.0023 * (tAvg + 17.8) * Math.sqrt(Math.max(0.1, tMax - tMin)) * 14;
            etoBase *= (1 - (d.clouds_avg || 50) / 250);
            etoBase *= (1 + (d.wind_spd_max || 3) / 15);
            totalEvapEstimation += etoBase;
        }

        if ((d.wind_spd_max || 0) > 9) {
            seasonalStresses.wind++;
            if (isInPeriod) windStressDays++;
        }

        if (month >= 4 && month <= 6) {
            if (tMax > 31 || tMax < 13 || (d.precip || 0) > 1 || (d.wind_spd_max || 0) > 8) {
                seasonalStresses.pollination++;
                if (isInPeriod) pollinationStressDays++;
            }
        }

        if (tAvg >= 0 && tAvg <= 7) chillHours += 12;
        else if (tMin >= 0 && tMin <= 7) chillHours += 6;

        if (prevTempAvg !== null && month >= 1 && month <= 3) {
            if (prevTempAvg < 0 && tAvg > 5) hardeningLossEvents++;
            if (prevTempAvg > 5 && tAvg < -3) hardeningLossEvents++;
        }
        prevTempAvg = tAvg;

        if ((d.precip || 0) > 15 && isAgroSeason) {
            seasonalStresses.hypoxia++;
            if (isInPeriod) hypoxiaDays++;
        }

        if (month >= 3 && month <= 5) {
            let soilTempEstimate = tAvg * 0.7 + (prevTempAvg || tAvg) * 0.3;
            if (soilTempEstimate >= 8 && soilTempEstimate <= 18 && (d.precip || 0) < 5 && (d.wind_spd_max || 0) < 7) {
                seasonalSowingCount++;
                if (isInPeriod) {
                    periodSowingDates.push(new Date(d.date).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' }));
                }
            }
        }
    });

    let avgTemp = tempSum / totalDays;
    let waterBalance = totalPrecip - totalEvapEstimation;
    let sunnyDays = validHistory.filter(d => (d.clouds_avg || 100) < 25 || (d.uv_max || 0) > 6).length;

    // --- 3. ДОЗАВАНТАЖЕННЯ ЗИМОВИХ ДАНИХ (ЯКЩО ТРЕБА) ---
    const chillNeeded = userCrops.includes('cherry') || userCrops.includes('apple') || userCrops.includes('pear') || userCrops.includes('peach') || userCrops.includes('apricot');
    const periodMonths = new Set(fullContext.map(d => new Date(d.date).getMonth() + 1));
    const hasWinterMonths = [11, 12, 1, 2].some(m => periodMonths.has(m));

    if (chillNeeded && !hasWinterMonths && externalId) {
        try {
            const periodStart = new Date(validHistory[0].date);
            const winterYear = periodStart.getMonth() < 8 ? periodStart.getFullYear() - 1 : periodStart.getFullYear();
            const winterStart = `${winterYear}-11-01`;
            const winterEnd = `${winterYear + 1}-02-28`;

            const winterData = await History.find({ externalId, date: { $gte: winterStart, $lte: winterEnd } }, { date: 1, temp_avg: 1, temp_min: 1 }).lean();
            if (winterData.length > 0) {
                let prevW = null;
                winterData.forEach(w => {
                    const wAvg = w.temp_avg || 0;
                    const wMin = w.temp_min || 0;
                    if (wAvg >= 0 && wAvg <= 7) chillHours += 12;
                    else if (wMin >= 0 && wMin <= 7) chillHours += 6;
                    if (prevW !== null && (new Date(w.date).getMonth() + 1) <= 3) {
                        if ((prevW < 0 && wAvg > 5) || (prevW > 5 && wAvg < -3)) hardeningLossEvents++;
                    }
                    prevW = wAvg;
                });
            }
        } catch (e) {
            console.error('[Agro] Winter data fetch failed:', e.message);
        }
    }


    let report = lang === 'uk'
        ? `📈 <b>Агро-Архів (${dateRangeStr}):</b>\n━━━━━━━━━━━━━━━━━━━━\n`
        : `📈 <b>Agro-Archive (${dateRangeStr}):</b>\n━━━━━━━━━━━━━━━━━━━━\n`;

    if (lang === 'uk') {
        // 1. Показники за обраний період (Статистика)
        report += `🌡 <b>Погода за ці дні:</b>\n`;
        report += `• Температура: ${avgTemp.toFixed(1)}°C (${absMin.toFixed(1)}° ... ${absMax.toFixed(1)}°)\n`;
        report += `• СЕТ (&gt;5°C/&gt;10°C): ${gdd5.toFixed(0)}°C / ${gdd10.toFixed(0)}°C\n`;
        report += `• Опади / Випаровування: ${totalPrecip.toFixed(1)} мм / ~${totalEvapEstimation.toFixed(1)} мм\n`;
        report += `• Водний баланс: <b>${waterBalance > 0 ? '+' : ''}${waterBalance.toFixed(1)} мм</b>\n`;
        report += `• Сонячних днів: ${sunnyDays}\n\n`;

        // 2. Конкретні події періоду (З датами)
        report += `⚠️ <b>Події за ці дні:</b>\n`;
        let eventsFound = false;
        if (advectiveFrosts > 0) { report += `• Адвективні морози: ${advectiveFrosts} дн. (${advectiveDates.join(', ')}) 🧊\n`; eventsFound = true; }
        if (radiationFrosts > 0) { report += `• Радіаційні заморозки: ${radiationFrosts} дн. (${radiationDates.join(', ')}) ❄️\n`; eventsFound = true; }
        if (groundFrosts > 0) { report += `• Приморозки на ґрунті: ${groundFrosts} дн. (${groundDates.join(', ')}) 🌫\n`; eventsFound = true; }
        if (heatDays > 0) { report += `• Хвилі спеки (&gt;30°C): ${heatDays} дн. 🔥\n`; eventsFound = true; }
        if (periodSowingDates.length > 0) { report += `• Вікна для посадки: ${periodSowingDates.length} дн. (${periodSowingDates.join(', ')}) 🌱\n`; eventsFound = true; }
        if (fungalRiskDays > 0) { report += `• Ризик хвороб: ${fungalRiskDays} дн. 🍄\n`; eventsFound = true; }
        if (hypoxiaDays > 0) { report += `• Гіпоксія коренів: ${hypoxiaDays} дн. 🌊\n`; eventsFound = true; }
        if (pollinationStressDays > 0) { report += `• Проблеми запилення: ${pollinationStressDays} дн. 🐝🚫\n`; eventsFound = true; }
        if (!eventsFound) report += `• Значущих погодних аномалій не виявлено.\n`;

        // 3. Сезонний контекст (Стабільні дані)
        report += `\n📊 <b>Сезонний контекст (з 1 березня):</b>\n`;
        const seasonalDays = fullContext.length;
        let stressScore = (
            (seasonalStresses.advective * 12) + (seasonalStresses.radiation * 6) + (seasonalStresses.ground * 3) +
            (seasonalStresses.heat * 5) + (seasonalStresses.wind * 4) + (seasonalStresses.pollination * 4) +
            (seasonalStresses.fungal * 3)
        ) / seasonalDays;
        let diffIndex = Math.min(10, Math.max(1, Math.round(stressScore * 1.5)));
        let diffLabel = diffIndex > 7 ? "Екстремальний" : (diffIndex > 4 ? "Помірний" : "Легкий");

        report += `• <b>Індекс складності сезону: ${diffIndex}/10 (${diffLabel})</b>\n`;
        report += `• Накопичено СЕТ (&gt;5°C): ${seasonalGDD5.toFixed(0)}°C\n`;
        report += `• Інфекційний фон: ${Math.round(seasonalInfectionIndex)} балів 🦠\n`;
        report += `• Всього заморозків за весну: ${seasonalStresses.advective + seasonalStresses.radiation + seasonalStresses.ground} епізодів.\n`;
        if (chillHours > 0) report += `• Години холоду (Chill Hours): ${chillHours} год.\n`;
        if (seasonalSowingCount > 0) report += `• Всього ідеальних днів для посіву: ${seasonalSowingCount}.\n`;
        report += `━━━━━━━━━━━━━━━━━━━━\n`;

        // 4. Експертний аналіз
        if (totalDays >= 3) {
            report += `🧐 <b>Експертний аналіз:</b>\n`;

            // 4a. Загальний стан за індексом
            let indexSummary = "• <b>Загальний стан:</b> ";
            if (diffIndex >= 8) indexSummary += `Екстремально важкий сезон (${diffIndex}/10). Рослини виживають на межі можливостей, високий ризик втрат. `;
            else if (diffIndex >= 6) indexSummary += `Складні умови (${diffIndex}/10). Потрібен постійний захист та антистресова підтримка. `;
            else if (diffIndex >= 4) indexSummary += `Помірний пресинг (${diffIndex}/10). Регулярні стреси вимагають вашої уваги та контролю. `;
            else if (diffIndex >= 2) indexSummary += `Відносно легкий сезон (${diffIndex}/10). Рослини розвиваються стабільно, догляд плановий. `;
            else indexSummary += `Ідеальні умови (${diffIndex}/10). Сад у зоні повного комфорту. `;
            report += `${indexSummary}\n`;

            // 4b. Сезонний огляд (Кумулятивний стан)
            let seasonalSummary = "";

            // СЕТ та Ріст
            const warmCropsList = ['tomato', 'pepper', 'grape', 'peach', 'watermelon', 'eggplant', 'apricot'];
            const hasWarmCrops = userCrops.some(c => warmCropsList.includes(c));
            let growthState = "Сезон характеризується як ";
            if (avgTemp > 18) growthState += "інтенсивно-теплий. ";
            else if (avgTemp > 12) growthState += "помірно-теплий. ";
            else growthState += "прохолодний. ";

            growthState += `Накопичено СЕТ ${seasonalGDD5.toFixed(0)}°C. `;
            if (seasonalGDD5 > 1200 || (hasWarmCrops && seasonalGDD10 > 800)) {
                growthState += "Умови сприяють стабільному росту. ";
            }
            if (hasWarmCrops && seasonalGDD10 > 1200) {
                growthState += "Ідеально для ваших теплолюбних культур. ";
            }
            seasonalSummary += `• <b>Ріст та СЕТ:</b> ${growthState}\n`;

            // Інфекція
            let healthState = "";
            if (seasonalInfectionIndex > 200) healthState = "Критичний інфекційний фон — патогени активно накопичувалися. ";
            else if (seasonalInfectionIndex > 80) healthState = "Помірний інфекційний тиск, ситуація під контролем. ";
            else healthState = "Чистий фон, ризики мінімальні. ";
            seasonalSummary += `• <b>Здоров'я (сезон):</b> ${healthState}\n`;

            // Зимівля (якщо є дерева)
            const fruitTrees = ['cherry', 'apple', 'pear', 'peach', 'apricot'];
            if (userCrops.some(c => fruitTrees.includes(c)) && chillHours > 0) {
                let winterMsg = "";
                if (chillHours >= 800) winterMsg = `Норма загартовування (${chillHours} год.) виконана — це гарантує стабільне цвітіння. `;
                else if (chillHours >= 500) winterMsg = `Часткове виконання норми (${chillHours} год.) — можливе нерівномірне пробудження бруньок. `;
                else winterMsg = `Критично мало годин холоду (${chillHours} год.) — ризик скидання плодових бруньок. `;

                if (hardeningLossEvents > 0) winterMsg += `Через ${hardeningLossEvents} відлиг взимку частина зимостійкості втрачена. `;
                seasonalSummary += `• <b>Зимівля:</b> ${winterMsg}\n`;
            }

            report += `${seasonalSummary}\n`;

            // 4b. Діагноз за вибрані дні (Конкретні дії)
            report += `• <b>Діагноз за період (${dateRangeStr}):</b> `;
            let periodDiagnosis = "";

            if (waterBalance < -25) periodDiagnosis += `Критичний дефіцит вологи! Терміново потрібен глибокий полив (рослини втратили на ${Math.abs(waterBalance).toFixed(0)}мм більше, ніж випало). `;
            else if (waterBalance < -10) periodDiagnosis += "Помірна посуха — контролюйте вологість ґрунту. ";

            if (advectiveFrosts > 0 || radiationFrosts > 0) {
                periodDiagnosis += `Увага! Зафіксовані заморозки (${advectiveDates.concat(radiationDates).join(', ')}). Це могло пошкодити цвіт або молодий приріст. Перевірте точки росту. `;
            }

            if (heatDays >= 3) periodDiagnosis += `Хвиля спеки тривала ${heatDays} дн. — це спричиняє температурний стрес, притініть чутливі культури та дайте антистресанти. `;

            if (fungalRiskDays > totalDays * 0.4) periodDiagnosis += `Висока вологість (${fungalRiskDays} дн.) загрожує розвитком хвороб — профілактична обробка фунгіцидом була б доречною. `;

            if (hypoxiaDays > 2) periodDiagnosis += `Через інтенсивні опади (${hypoxiaDays} дн. гіпоксії) можливе кисневе голодування коренів — розпушіть грунт. `;

            if (periodSowingDates.length > 0) {
                periodDiagnosis += `Дні ${periodSowingDates.join(', ')} були ідеальними для посадки — сподіваємось, ви скористалися цим вікном! `;
            }

            if (!periodDiagnosis) periodDiagnosis = "Умови в ці дні були стабільними, жодних екстремальних втручань не потрібно.";

            report += `${periodDiagnosis}\n`;
        } else {
            if (waterBalance < -10) report += `💡 <b>Порада:</b> Зафіксовано дефіцит вологи, полийте рослини.\n`;
            else if (fungalRiskDays > 0) report += `💡 <b>Порада:</b> Підвищена вологість, будьте уважні до появи плям на листі.\n`;
        }
    } else {
        // English version (simplified context)
        report += `🌡 <b>Weather:</b> Avg: ${avgTemp.toFixed(1)}°C, SET: ${gdd10.toFixed(0)}°C\n`;
        report += `💧 <b>Water Balance:</b> ${waterBalance.toFixed(1)} mm\n`;
        report += `📊 <b>Season Index:</b> ${diffIndex}/10 (${diffLabel})\n`;
        report += `⚠️ <b>Events:</b> Frosts: ${advectiveFrosts + radiationFrosts}, Heat: ${heatDays}, Sowing: ${periodSowingDates.length}\n`;
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

/**
 * Генерація прогнозу на основі прогнозних даних
 */
async function generateAgroForecastReport(forecast, lang = 'uk', userCrops = [], externalId = null) {
    if (!forecast || !Array.isArray(forecast)) return '';

    // Перетворюємо формат прогнозу Weatherbit у формат, який розуміє двигун аналізу
    const normalizedData = forecast.map(f => ({
        date: f.valid_date || f.datetime,
        temp_max: f.max_temp,
        temp_min: f.min_temp,
        temp_avg: f.temp,
        rh_avg: f.rh,
        precip: f.precip,
        clouds_avg: f.clouds,
        wind_spd_max: f.wind_spd,
        uv_max: f.uv
    }));

    // Викликаємо основний двигун звітності
    let report = await generateHistoricalReport(normalizedData, lang, userCrops, externalId);

    // Замінюємо заголовки архіву на заголовок прогнозу
    const startDate = normalizedData[0].date.split('-').reverse().join('.');
    const endDate = normalizedData[normalizedData.length - 1].date.split('-').reverse().join('.');

    const oldHeader = lang === 'uk' ? /📈 <b>Агро-Архів \(.*?\):<\/b>/ : /📈 <b>Agro-Archive \(.*?\):<\/b>/;
    const newHeader = lang === 'uk'
        ? `🔮 <b>Агро-Прогноз (${startDate} — ${endDate}):</b>`
        : `🔮 <b>Agro-Forecast (${startDate} — ${endDate}):</b>`;

    return report.replace(oldHeader, newHeader);
}

module.exports = {
    analyzeAgroRisks,
    formatAgroReport,
    analyzeSprayingWindow,
    generateHistoricalReport,
    generateAgroForecastReport,
    getLunarPhase,
    getGrowthStage,
    fetchMissingHistory
};
