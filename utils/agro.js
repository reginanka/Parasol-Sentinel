/**
 * Weather Syndrome Engine (WSE) v2.0 - Модуль професійної агро-аналітики
 * Розрахунок ризиків для рослин на основі даних Weatherbit API
 */

const score = (condition, points) => (condition ? points : 0);

/**
 * Основна функція аналізу
 * @param {Object} d - Дані прогнозу (один об'єкт з масиву data від Weatherbit)
 * @param {Array} history - Масив історичних даних (останні 7-10 днів)
 * @returns {Array} - Відсортований список ризиків
 */
function analyzeAgroRisks(rawD, history = [], userCrops = []) {
    // If we don't have a valid object, we can't analyze.
    if (!rawD || typeof rawD !== 'object') return [];

    // Neutral defaults to prevent crashes while maintaining some logic sanity
    const d = {
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

    const risks = [];

    // --- 0. НАУКОВИЙ МІСЯЦЬ (Lunar Impact) ---
    try {
        const lunarRisks = analyzeLunarImpact(d);
        risks.push(...lunarRisks);
    } catch (e) {
        console.error('Lunar analysis failed:', e);
    }


    const stage = getGrowthStage();
    const isEarly = stage === 'early_spring';

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
        advice: isEarly
            ? 'Профілактика: препарати міді (Медян Екстра, Бордоська суміш). Уникайте вологи на листі.'
            : 'Критична фаза! Обробіть системними фунгіцидами (Рідоміл Голд, Квадріс).',
        details: `Вологість ${d.rh}%, t: ${d.temp}°C, очікується дощ.`,
        relatedCrops: ['tomato', 'potato']
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
        details: `Точка роси: ${d.dewpt}°C (дуже близько до t), ризик конденсату.`,
        relatedCrops: ['cucumber', 'zucchini', 'grape']
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
        details: `Сухо: ${d.rh}%, t: ${d.temp}°C, дощу не буде.`,
        relatedCrops: ['zucchini', 'rose', 'grape', 'apple']
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

    // --- СОНЯЧНИЙ ОПІК ТА УФ-РИЗИК ---
    // Логіка: 5-6 — помірно (попередження лише при спеці), 7+ — високий ризик
    const sunburn =
        score(d.uv >= 5 && d.uv < 7, 25) + // Помірна небезпека
        score(d.uv >= 7, 50) +             // Висока небезпека (High)
        score(d.uv >= 9, 30) +             // Екстремальна небезпека (Very High)
        score(d.temp > 30, 20) +
        score(d.clouds < 15, 10);
    risks.push({
        id: 'sunburn',
        name: '☀️ Сонячний опік / УФ-шок',
        score: Math.min(sunburn, 100),
        advice: d.uv >= 7
            ? 'Висока інтенсивність УФ! Обов’язкове притінення та вечірній полив. Уникайте обприскування вдень.'
            : 'Помірний рівень УФ. Чутливі рослини можуть потребувати легкого захисту при t > 30°C.',
        details: `УФ-індекс: ${d.uv}, хмарність: ${d.clouds}%, t: ${d.temp}°C.`
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
        advice: 'Обробіть фунгіцидом до дощу. Ефективні: Скор, Хорус (при t < 15°C) або системні препарати.',
        details: `Вологий лист при t: ${d.temp}°C.`,
        relatedCrops: ['apple', 'pear']
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
        advice: 'Спека + волога. Можлива поява чорних плям. Рекомендовано препарати міді або Квадріс.',
        details: `t: ${d.temp}°C, вологість присутня.`,
        relatedCrops: ['tomato', 'potato', 'apple']
    });

    // --- 11. АНТРАКНОЗ ---
    const anthracnose =
        score(d.rh > 80, 35) +
        score(d.temp >= 20 && d.temp <= 27, 30) +
        score(d.precip > 0, 25) +
        score(d.clouds > 70, 10);
    risks.push({
        id: 'anthracnose',
        name: '🥀 Антракноз',
        score: Math.min(anthracnose, 100),
        advice: 'Волога спека — ідеально для антракнозу. Характерні вдавлені плями на плодах та листі. Уникайте густих посадок, обробіть фунгіцидом.',
        details: `Вологість: ${d.rh}%, t: ${d.temp}°C, очікуються опади.`
    });

    // --- 12. СІРА ГНИЛЬ (Botrytis) ---
    const botrytis =
        score(d.rh > 85, 40) +
        score(d.temp >= 15 && d.temp <= 22, 30) +
        score(d.precip > 0.5, 20) +
        score(d.clouds > 80, 10);
    risks.push({
        id: 'botrytis',
        name: '🍓 Сіра гниль',
        score: Math.min(botrytis, 100),
        advice: 'Висока вологість + помірна температура. Небезпечно для ягід та квітів. Забезпечте провітрювання, видаліть пошкоджені частини.',
        details: `Вологість: ${d.rh}%, t: ${d.temp}°C, вогко.`,
        relatedCrops: ['strawberry', 'grape', 'raspberry', 'peony', 'hydrangea']
    });

    // --- 13. МОНІЛІОЗ (Плодова гниль) ---
    const monilia =
        score(d.temp >= 15 && d.temp <= 25, 30) +
        score(d.rh > 75, 30) +
        score(d.precip > 0.2, 30) +
        score(d.wind_spd > 4, 10);
    risks.push({
        id: 'monilia',
        name: '🍑 Моніліоз / Плодова гниль',
        score: Math.min(monilia, 100),
        advice: 'Ризик гниття плодів та опіку пагонів. Обробіть дерева препаратами проти гнилі, зберіть гнилі плоди.',
        details: `Сприятлива t: ${d.temp}°C та вологість для спороношення.`,
        relatedCrops: ['apple', 'pear', 'peach', 'cherry']
    });

    // --- 14. ІРЖА (Rust) ---
    const rust =
        score(d.rh > 80, 40) +
        score(d.temp >= 18 && d.temp <= 24, 30) +
        score(d.clouds > 50, 20) +
        score(d.wind_spd > 3, 10);
    risks.push({
        id: 'rust',
        name: '🍂 Іржа рослин',
        score: Math.min(rust, 100),
        advice: 'Помаранчеві плями на листі. Особливо небезпечно для груш та троянд. Обробіть фунгіцидами (Топаз, Скор).',
        details: `t: ${d.temp}°C, висока вологість — ідеально для іржі.`,
        relatedCrops: ['pear', 'rose', 'currant', 'conifers', 'apple']
    });

    // --- 15. ПАВУТИННИЙ КЛІЩ (Spider Mite) ---
    const spiderMite =
        score(d.temp > 28, 40) +
        score(d.rh < 45, 40) +
        score(d.precip === 0, 20);
    risks.push({
        id: 'spider_mite',
        name: '🕷 Павутинний кліщ',
        score: Math.min(spiderMite, 100),
        advice: 'Суха спека — рай для кліща. Він висмоктує соки, листя жовтіє. Збільште вологість (обприскування водою вечорами) або застосуйте акарициди.',
        details: `Спека: ${d.temp}°C, низька вологість: ${d.rh}%.`,
        relatedCrops: ['cucumber', 'rose', 'grape', 'strawberry', 'apple']
    });

    // --- 16. ПОПЕЛИЦЯ (Aphids) ---
    const aphids =
        score(d.temp >= 20 && d.temp <= 26, 40) +
        score(d.wind_spd < 3, 30) +
        score(d.precip === 0, 30);
    risks.push({
        id: 'aphids',
        name: '🐜 Попелиця (Тля)',
        score: Math.min(aphids, 100),
        advice: 'Комфортна температура та відсутність дощу сприяють розмноженню попелиці. Перевірте молоді пагони та наявність мурах.',
        details: `t: ${d.temp}°C, штиль, без опадів.`,
        relatedCrops: ['rose', 'apple', 'pepper', 'currant', 'cherry']
    });

    // --- 17. ХРУЩ (Травневий жук) ---
    let cockchaferScore = 0;
    let cockchaferAdvice = '';
    let cockchaferDetails = '';

    // Аналіз льоту (дорослих особин)
    if (d.temp >= 12 && d.temp <= 22 && d.wind_spd < 4 && d.precip === 0) {
        cockchaferScore += 60;
        cockchaferAdvice = 'Сприятливі умови для масового льоту хрущів у вечірній час. Захистіть листя молодих дерев та плодових чагарників.';
        cockchaferDetails = 'Вечірнє тепло та штиль сприяють льоту.';
    }

    // Аналіз активності личинок (через історію прогріву ґрунту)
    if (history && Array.isArray(history) && history.length >= 3) {
        const validHistory = history.filter(h => typeof h.temp_avg === 'number');
        if (validHistory.length >= 3) {
            const avgTemp = validHistory.reduce((sum, h) => sum + h.temp_avg, 0) / validHistory.length;
            if (avgTemp > 10) {
                cockchaferScore += 30;
                if (cockchaferScore >= 80) {
                    cockchaferAdvice += ' Ґрунт прогрівся, личинки піднялися до коріння. Час для грунтових інсектицидів.';
                } else {
                    cockchaferAdvice = 'Ґрунт прогрівся, личинки активізувалися. Особливо вразливі полуниця та газон.';
                    cockchaferDetails = `Середня t за тиждень: ${avgTemp.toFixed(1)}°C.`;
                }
            }
        }
    }

    if (cockchaferScore > 0) {
        risks.push({
            id: 'cockchafer',
            name: '🪲 Хрущ (активність)',
            score: Math.min(cockchaferScore, 100),
            advice: cockchaferAdvice,
            details: cockchaferDetails,
            relatedCrops: ['strawberry', 'lawn_grass', 'conifers', 'apple', 'cherry']
        });
    }

    // --- 18. VPD (Vapor Pressure Deficit) - Дефіцит пружності водяної пари ---
    // Формула Тетенса для тиску насиченої пари (svp) та реального тиску (avp)
    const svp = 0.61078 * Math.exp((17.27 * d.temp) / (d.temp + 237.3));
    const avp = svp * (d.rh / 100);
    const vpd = svp - avp; // Значення в кПа

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
            details: `t: ${d.temp}°C, вітер: ${d.wind_spd}м/с, опади.`,
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
            details: `Мін. t: ${d.min_temp}°C (занадто тепло для відпочинку).`
        });
    }

    // --- 21. ВИМИВАННЯ ДОБРИВ (Leaching Risk) ---
    if (d.precip > 15) {
        risks.push({
            id: 'leaching',
            name: '🌊 Вимивання добрив',
            score: 70,
            advice: 'Очікується сильна злива. Не проводьте підживлення під корінь сьогодні — добрива вимиються в глибокі шари.',
            details: `Прогноз опадів: ${d.precip} мм.`
        });
    }

    // --- 22. ЗАГАРТОВУВАННЯ РОЗСАДИ (Hardening off) ---
    if (d.min_temp >= 12 && d.temp <= 25 && d.uv < 6 && d.wind_spd < 4) {
        risks.push({
            id: 'hardening',
            name: '🌱 Вікно для загартовування',
            score: 40, // Це позитивний показник, але ми виводимо як пораду
            advice: 'Ідеальні умови, щоб винести розсаду «погуляти» або почати висадку. Сонце не пече, вітру майже немає.',
            details: `Комфортна t та низький УФ.`
        });
    }







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

    // --- 11. НАКОПИЧЕНИЙ СТРЕС (ІСТОРІЯ) ---
    if (history && history.length > 0) {
        // Рахуємо дні спеки
        const heatDays = history.filter(h => h.temp_max > 30).length;
        if (heatDays >= 3) {
            risks.push({
                id: 'cumulative_heat',
                name: '🌵 Тривала спека',
                score: Math.min(40 + (heatDays * 10), 100),
                advice: `Це вже ${heatDays}-й день спеки поспіль. Рослини виснажені. Використовуйте антистресанти та рясний полив ввечері.`,
                details: `Спека триває ${heatDays} днів.`
            });
        }

        // Рахуємо дефіцит опадів за 7 днів
        const totalRain = history.reduce((sum, h) => sum + (h.precip || 0), 0);
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
            // Safe score check
            if (!r || typeof r.score !== 'number' || isNaN(r.score) || r.score < 40) return false;

            // Якщо у користувача порожній список — показуємо все
            if (!userCrops || userCrops.length === 0) return true;

            // Якщо у ризику немає прив'язки до культур — він універсальний
            if (!r.relatedCrops || !Array.isArray(r.relatedCrops) || r.relatedCrops.length === 0) return true;

            // Інакше показуємо тільки якщо культура збігається
            return r.relatedCrops.some(cropId => userCrops.includes(cropId));
        })
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 5);
}

/**
 * Визначення стадії росту за календарем
 */
function getGrowthStage() {
    const month = new Date().getMonth() + 1; // 1-12
    if (month >= 3 && month <= 4) return 'early_spring';
    if (month === 5) return 'late_spring';
    if (month >= 6 && month <= 8) return 'summer';
    if (month >= 9 && month <= 10) return 'autumn';
    return 'winter';
}

/**
 * Форматування звіту для Telegram
 */
function formatAgroReport(city, risks, lang = 'uk') {
    const esc = (text) => String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cityEsc = esc(city);

    if (risks.length === 0) {
        return lang === 'uk'
            ? `🌿 <b>Аналіз для м. ${cityEsc}</b>\n\n✅ Критичних агро-ризиків на завтра не виявлено. Погода сприятлива!`
            : `🌿 <b>Analysis for ${cityEsc}</b>\n\n✅ No critical agro-risks detected for tomorrow. Weather is favorable!`;
    }

    let message = lang === 'uk'
        ? `🧠 <b>Аналітика: ${cityEsc}</b>\n━━━━━━━━━━━━━━━━━━━━\n`
        : `🧠 <b>Analytics: ${cityEsc}</b>\n━━━━━━━━━━━━━━━━━━━━\n`;

    risks.forEach(r => {
        let level = lang === 'uk' ? '🟡 СЕРЕДНІЙ' : '🟡 MEDIUM';
        if (r.score >= 80) level = lang === 'uk' ? '🔴 КРИТИЧНИЙ' : '🔴 CRITICAL';
        if (r.id === 'spray_check' && r.score < 50) level = lang === 'uk' ? '🟢 СПРИЯТЛИВО' : '🟢 FAVORABLE';

        message += `${esc(r.name)}: ${level} (${Math.round(r.score)}/100)\n`;
        message += `  ↳ <i>${esc(r.details || '')}</i>\n`;
        message += lang === 'uk' ? `  👉 <b>Порада:</b> ${esc(r.advice || '')}\n\n` : `  👉 <b>Advice:</b> ${esc(r.advice || '')}\n\n`;
    });

    const moon = getLunarPhase(new Date());
    message += `━━━━━━━━━━━━━━━━━━━━\n`;
    message += `🌙 ${esc(moon.name)}\n`;
    message += `<i>`;
    message += lang === 'uk'
        ? `Прогноз побудовано на біологічних циклах патогенів</i>`
        : `Forecast based on biological cycles of pathogens</i>`;
    return message;
}


/**
 * Аналіз вікна для обприскування на 5 днів
 */
function analyzeSprayingWindow(forecastData, lang = 'uk') {
    if (!forecastData || !Array.isArray(forecastData)) return '';

    let report = lang === 'uk'
        ? '🚜 <b>Графік обробок (5 днів):</b>\n'
        : '🚜 <b>Spraying Schedule (5 days):</b>\n';

    forecastData.slice(0, 5).forEach(day => {
        const dateObj = new Date(day.valid_date || day.datetime);
        const dayStr = dateObj.toLocaleDateString(lang === 'uk' ? 'uk-UA' : 'en-US', { weekday: 'short', day: 'numeric' });

        let score = 0;
        let reasons = [];

        if (day.wind_spd > 5) { score += 40; reasons.push(lang === 'uk' ? 'вітер' : 'wind'); }
        if (day.precip > 1) { score += 50; reasons.push(lang === 'uk' ? 'дощ' : 'rain'); }
        if (day.max_temp > 28) { score += 20; reasons.push(lang === 'uk' ? 'спека' : 'heat'); }

        let icon = '🟢';
        if (score >= 40) icon = '🟡';
        if (score >= 70) icon = '🔴';

        const reasonStr = reasons.length > 0 ? ` (${reasons.join(', ')})` : '';
        report += `${icon} <b>${dayStr}</b>: ${icon === '🟢' ? (lang === 'uk' ? 'Ідеально' : 'Perfect') : (lang === 'uk' ? 'Ризик' : 'Risk')}${reasonStr}\n`;
    });

    return report;
}

/**
 * Розрахунок фази Місяця (спрощений)
 */
function getLunarPhase(date) {
    const lp = [
        '🌑 Молодик', '🌒 Молодий місяць', '🌓 Перша чверть', '🌔 Випуклий місяць',
        '🌕 Повня', '🌖 Спадаючий місяць', '🌗 Остання чверть', '🌘 Старий місяць'
    ];
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();

    let c = 0, e = 0, jd = 0, b = 0;
    if (month < 3) { year--; month += 12; }
    month++;
    c = 365.25 * year;
    e = 30.6 * month;
    jd = c + e + day - 694039.09; // Julian day relative to 1900
    jd /= 29.5305882; // Lunar month
    b = parseInt(jd);
    jd -= b;
    b = Math.round(jd * 8);
    if (b >= 8) b = 0;
    return { index: b, name: lp[b] };
}

/**
 * Аналіз впливу Місяця та тиску (Науковий Місяць)
 */
function analyzeLunarImpact(d, lang = 'uk') {
    const date = new Date(d.valid_date || d.datetime || Date.now());
    const moon = getLunarPhase(date);
    const risks = [];

    // Перевірка на "Припливний пік" + Падіння тиску
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

/**
 * Агрегація історії (Архів)
 */
async function generateHistoricalReport(history, lang = 'uk') {
    if (!history || !Array.isArray(history) || history.length === 0) return lang === 'uk' ? '❌ Даних за цей період ще немає.' : '❌ No data for this period.';

    const validHistory = history.filter(h => typeof h.temp_avg === 'number');
    if (validHistory.length === 0) return lang === 'uk' ? '❌ Недостатньо даних для аналізу.' : '❌ Not enough data for analysis.';

    const count = validHistory.length;
    const avgTemp = validHistory.reduce((s, h) => s + h.temp_avg, 0) / count;
    const totalRain = validHistory.reduce((s, h) => s + (h.precip || 0), 0);
    const heatDays = validHistory.filter(h => (h.temp_max || 0) > 30).length;

    let report = lang === 'uk'
        ? `📈 <b>Агро-Архів за останні ${count} днів:</b>\n━━━━━━━━━━━━━━━━━━━━\n`
        : `📈 <b>Agro-Archive for last ${count} days:</b>\n━━━━━━━━━━━━━━━━━━━━\n`;

    report += lang === 'uk'
        ? `🌡 Сер. температура: ${avgTemp.toFixed(1)}°C\n`
        : `🌡 Avg Temperature: ${avgTemp.toFixed(1)}°C\n`;

    report += lang === 'uk'
        ? `🌧 Сума опадів: ${totalRain.toFixed(1)} мм\n`
        : `🌧 Total Precip: ${totalRain.toFixed(1)} mm\n`;

    report += lang === 'uk'
        ? `🔥 Днів спеки (>30°C): ${heatDays}\n`
        : `🔥 Heat days (>30°C): ${heatDays}\n`;

    report += `━━━━━━━━━━━━━━━━━━━━\n`;

    if (totalRain < 5 && avgTemp > 20) {
        report += lang === 'uk' ? '⚠️ Спостерігається накопичений дефіцит вологи.' : '⚠️ Accumulated moisture deficit observed.';
    } else if (totalRain > 50) {
        report += lang === 'uk' ? '⚠️ Ризик вимивання поживних речовин через надмірні дощі.' : '⚠️ Risk of nutrient leaching due to excessive rain.';
    }

    return report;
}

module.exports = {
    analyzeAgroRisks,
    formatAgroReport,
    analyzeSprayingWindow,
    generateHistoricalReport,
    getLunarPhase,
    getGrowthStage
};

