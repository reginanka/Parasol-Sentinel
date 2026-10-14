const getBot = require('../utils/bot');
const bot = getBot();
const axios = require('axios');
require('dotenv').config();

const User = require('../models/User');
const City = require('../models/City');
const History = require('../models/History');
const connectDB = require('../utils/db');
const { formatUrl, generateSignature, formatLocalDateTime } = require('../utils/helpers');
const {
    analyzeAgroRisks,
    formatAgroReport,
    analyzeSprayingWindow,
    generateHistoricalReport,
    generateAgroForecastReport,
    fetchMissingHistory
} = require('../utils/agro');
const { CROPS_DATA } = require('../utils/crops');
const { getSoilFrostInfo, frostWarningText, frostOccurredText, isFrostSeason, getGeomagLevel } = require('../utils/weather');

/**
 * Parasol Sentinel Bot - Core logic handler.
 * Design Choice: Using a hybrid approach (Serverless Webhook + Polling for Local Dev).
 * Migrated from Telegraf to grammY.
 */

const dict = {
    uk: {
        welcome: "👋 Вітаю! Мене звати **Parasol**.\n\nЯ буду стежити за погодою у вашому місті та надсилати сповіщення про різкі зміни.\n\nБудь ласка, введіть назву вашого міста (українською або англійською):",
        select: "🔍 Оберіть правильний варіант зі списку:",
        notFound: "❌ Не вдалося знайти це місто. Спробуйте уточнити запит (наприклад, додайте область).",
        errorSearch: "❌ Сталася помилка пошуку. Спробуйте пізніше.",
        citySet: "Місто {city} успішно встановлено!",
        citySetFull: "✅ **Місто встановлено:** {city}\n🌐 Координати: {lat}, {lon}\n🌡️ Поточна температура: {temp}°C\n💧 Точка роси: {dewpt}°C",
        dashboard: "📊",
        settingsBtn: "Налаштування",
        helpBtn: "Допомога",
        helpSelect: "🔍 Оберіть тему, яка вас цікавить:",
        help_uv: "☀️ Що таке УФ-індекс?",
        help_wind: "🌬️ Напрямки вітру",
        help_press: "🧭 Тиск та здоров'я",
        help_hum: "💧 Вологість та видимість",
        help_precip: "🌧️ Шанс опадів",
        help_dew: "💧 Точка роси",
        help_feels: "🌡️ Відчувається як",
        help_cloud: "☁️ Хмарність",
        help_how: "ℹ️ Як це працює",
        help_uv_desc: "<h3>☀️ УФ-індекс</h3><p>Рівень інтенсивності ультрафіолету. Впливає на шкіру та рослини.</p><table bordered striped compact><tr><th>Рівень</th><th>Що робити</th></tr><tr><td>🟢 0–2 Низький</td><td>Безпечно. SPF не обовʼязковий. Рослинам затінення не потрібне</td></tr><tr><td>🟡 3–5 Помірний</td><td>SPF, капелюх, окуляри. Розсаду привчати до сонця поступово</td></tr><tr><td>🟠 6–7 Високий</td><td>Тінь 11:00–16:00. Сітка 20–30% для чутливих культур</td></tr><tr><td>🔴 8–10 Дуже високий</td><td>Мінімум на сонці. Затінення + полив лише вранці/ввечері</td></tr><tr><td>🟣 11+ Екстремальний</td><td>Уникати вулиці вдень. Максимальне затінення рослин</td></tr></table>",
        help_wind_desc: "<h3>🌬️ Напрямки вітру</h3><p>16-румбова система — вказано, <b>звідки</b> дме вітер.</p><ul><li><b>Основні:</b> Пн (N), Пд (S), Сх (E), Зх (W)</li><li><b>Проміжні:</b> Пн-Сх (NE), Пд-Зх (SW) тощо</li><li><b>Третє коліно:</b> до 22.5° (напр. Пд-Пд-Сх)</li></ul><h3>🌡️ Вплив на метеоумови</h3><table bordered striped compact><tr><th>Напрямок</th><th>Ефект</th></tr><tr><td>🔹 Північні</td><td><b>«Арктичне втручання»</b><br/>Похолодання, нічні заморозки, хуртовини</td></tr><tr><td>🔸 Східні</td><td><b>«Суховій»</b><br/>Висушує ґрунт і повітря, пил, швидке випаровування</td></tr><tr><td>🔹 Західні</td><td><b>«Вологий фронт»</b><br/>Опади, висока вологість, ризик грибків і фітофтори</td></tr><tr><td>🔸 Південні</td><td><b>«Теплий сектор»</b><br/>Тропічне повітря, різке потепління, перегрів</td></tr></table><details open><summary>⚠️ Чому важлива деталізація?</summary><ol><li><b>Раннє попередження:</b> зміна вектора на ~20° — ознака фронту ще до зміни тиску</li><li><b>Вектор руху:</b> знос для дронів/авіації, штормовий нагін у прибережних зонах</li><li><b>Локальні ефекти:</b> відрізняє транзитний вітер від того, що заходить у бухти</li></ol></details>",
        help_press_desc: "<h3>🧭 Атмосферний тиск</h3><p>Сила, з якою повітря тисне на поверхню Землі.</p><ul><li><b>Норма:</b> 760 мм рт. ст. (1013 гПа) на рівні моря</li><li><b>Падіння (циклон):</b> хмари, опади, вітер. Для рослин — сокорух, але ризик грибків</li><li><b>Ріст (антициклон):</b> ясно, сухо, вітер вщухає</li></ul><details open><summary>⚠️ Вплив на рослини</summary><p>Високий тиск + чисте небо → різко зростає радіація. Ризик опіків листя вищий в обід. Затіняйте теплиці та розсаду.</p><p><i>Перепади понад 1–2 мм/год часто дають головний біль і стрес у рослин.</i></p></details>",
        help_hum_desc: "<h3>💧 Вологість та видимість</h3><p><b>Вологість</b> — відносна кількість вологи. Комфорт: <b>40–60%</b>.</p><ul><li><b>&gt;70%:</b> важче охолоджуватися; для рослин — грибок і пліснява</li><li><b>&lt;30%:</b> сухі слизові; вʼянення листя</li></ul><p>Низька вологість + високий UV → швидша втрата вологи й опіки. Затіняйте чутливі культури.</p><h3>👁 Видимість</h3><ul><li><b>10+ км</b> — відмінна</li><li><b>&lt;1 км</b> — густий туман, обережно за кермом</li></ul><details open><summary>⚠️ Туман і рослини</summary><ul><li><b>Навесні:</b> радіаційні заморозки навіть якщо повітря &gt;0°C — дивіться температуру біля землі</li><li><b>Восени:</b> застій вологи → патогени і гниль</li><li><b>Точка роси ~0°C</b> при високій вологості → можливий заморозок на ґрунті</li><li><b>VPD:</b> вологість &lt;30% і t &gt;25°C → затінення обовʼязкове</li><li>Туман 4–6+ год при +15…+20°C — добре вікно для обробки від грибків</li></ul></details>",
        help_precip_desc: "<h3>🌧️ Ймовірність та кількість опадів</h3><p>Дивіться <b>обидва</b> показники:</p><ul><li><b>Шанс (%):</b> чи дійде дощ. 30–40% — лотерея, 80% — майже гарантія</li><li><b>Кількість (мм):</b> обʼєм води. 0 мм — символічно; &gt;2 мм — повноцінний полив</li></ul><details open><summary>🌱 Поради для саду</summary><ul><li><b>Опіки:</b> сонце після дощу — краплі як лінзи. Затініть або струсіть воду</li><li><b>1–2 мм:</b> лише верхній пил, не замінює полив</li><li><b>Багато мм + вітер:</b> підвʼяжіть високі культури заздалегідь</li></ul></details>",
        help_dew_desc: "<h3>💧 Точка роси</h3><p>Показує, наскільки «важким» відчувається повітря.</p><table bordered striped compact><tr><th>Точка роси</th><th>Що це означає</th></tr><tr><td>&lt;10°C</td><td>Комфортно, сухо. Ґрунт сохне швидше</td></tr><tr><td>12–15°C</td><td>Приємно. Ідеальний баланс для більшості культур</td></tr><tr><td>16–20°C</td><td>Вологість відчутна. Ризик грибків, можливі опіки через краплі</td></tr><tr><td>&gt;21°C</td><td>Душно. Рослини «задихаються» — затіняйте сіткою</td></tr></table>",
        help_feels_desc: "<h3>🌡️ Відчувається як</h3><p>Субʼєктивна температура з урахуванням вологості та вітру.</p><ul><li><b>Влітку:</b> висока вологість → рослини «задихаються», тепловий стрес</li><li><b>Взимку:</b> вітер прискорює втрату вологи й обмороження</li></ul><details open><summary>🌵 Вплив на рослини</summary><ul><li>Якщо «відчувається як» значно вище реальної t — пік сонця, час затінювати</li><li>Високі значення → швидше випаровування: перевіряйте ґрунт, без крапель на листі під сонцем</li></ul></details>",
        help_cloud_desc: "<h3>☁️ Хмарність</h3><p>Відсоток неба, закритого хмарами.</p><table bordered striped compact><tr><th>Хмарність</th><th>Рекомендація</th></tr><tr><td>0–10% Ясно</td><td><b>Високий ризик опіків</b> — затіняти в обід</td></tr><tr><td>11–30% Майже ясно</td><td>Жорстке світло; стежити за вологістю ґрунту</td></tr><tr><td>31–70% Мінлива</td><td>Найкращий режим для більшості культур</td></tr><tr><td>71–90% Хмарно</td><td>Розсіяне світло, затінення не потрібне</td></tr><tr><td>91–100% Похмуро</td><td>Без опіків; довго → витягування розсади</td></tr></table>",
                help_soil0_desc: "<h3>🌱 Ґрунт 0 см (поверхня)</h3><p>Температура «шкіри» землі.</p><ul><li>Визначає <b>радіаційний заморозок</b> — поверхня &lt;0°C при плюсовому повітрі</li><li>Критично для квітів, розсади, полуниці, сходів</li><li>У прогнозі: <b>мін … макс</b> за добу</li><li>Джерело: Open-Meteo</li></ul>",
        help_soil6_desc: "<h3>🌱 Ґрунт 6 см</h3><p>Температура в кореневмісному шарі — стабільніша за поверхню.</p><ul><li>Краще для оцінки умов коренів і мікробіоти</li><li>Менш чутлива до коротких нічних прохолод</li><li>Корисна для сівби та ризику заморозків у ґрунті</li><li>Джерело: Open-Meteo</li></ul>",
help_how_desc: "<h3>ℹ️ Як це працює</h3><ol><li>Напишіть місто — бот визначить координати і стежитиме за погодою.</li><li><b>Сповіщення про зміни:</b> зсув температури, аномальна t, дощ зʼявився/скасували, AQI, магнітна буря.</li><li><b>Вечірній прогноз</b> на кілька днів — можна обрати метрики й кількість днів; у блоці «Парасоль підказує» також зʼявляються офіційні попередження Укргідрометцентру для вашої локації (якщо є).</li><li>Сповіщення налаштовуються окремо або вимикаються всі разом.</li><li>Також: агро-аналітика, історія, дашборд.</li></ol><p>Усе в меню <b>Налаштування</b>.</p><details open><summary>📡 Джерела даних</summary><ul><li>Погода — Weatherbit, Open-Meteo, Tomorrow.io</li><li>Повітря — WAQI, Open-Meteo</li><li>Магнітне поле — NOAA SWPC</li><li>Офіційні погодні попередження (Україна) — Укргідрометцентр через MeteoAlarm (CAP)</li><li>Геокодування — OpenStreetMap</li></ul></details>",
        saveError: "❌ Не вдалося зберегти вибір. Перевірте конфігурацію сервера.",
        settings: "⚙️ *Налаштування*",
        settingsWind: "🌬️ Вітер:",
        settingsPress: "🧭 Тиск:",
        settingsCity: "📍 Змінити місто",
        settingsDeleteCity: "🗑 Видалити місто",
        settingsUnsubscribe: "🔕 Вимкнути всі сповіщення",
        settingsSubscribe: "🔔 Увімкнути всі сповіщення",
        cityDeleted: "🗑 Місто видалено. Бот більше не стежить за погодою. Щоб відновити — надішліть назву міста.",
        notifDisabled: "🔕 Сповіщення вимкнено. Бот продовжує стежити за погодою, але не надсилатиме повідомлення.",
        notifEnabled: "🔔 Сповіщення увімкнено!",
        settingsSaved: "✅ Налаштування збережено!",
        unitMs: "м/с",
        unitKmh: "км/год",
        unitMmhg: "мм рт.ст.",
        unitHpa: "гПа",
        unitC: "°C",
        unitF: "°F",
        settingsTemp: "🌡️ Темп:",
        cropsBtn: "🌱 Мої культури",
        cropsSelectCat: "📂 Оберіть категорію рослин:",
        cropsSelectItem: "✅ Відмітьте, що ви вирощуєте у категорії {cat}:",
        backBtn: "⬅️ Назад",
        agroForecastBtn: "Агро-Прогноз",
        agroArchiveBtn: "Архів",
        agroRecBtn: "📝 Рекомендації на {date}",
        agroScheduleBtn: "🚜 Графік обробок",
        agroFiveDayBtn: "📅 Прогноз на 5 днів",
        settingsForecastBtn: "⚙️ Налаштувати прогноз",
        forecastSettingsTitle: "🛠 **Налаштування прогнозу**\n\nОберіть кількість днів та показники, які ви хочете бачити у щоденному звіті:",
        daysCount: "📅 Кількість днів:",
        metricsTitle: "📊 Показники:",
        metric_condition: "Стан неба",
        metric_temp: "Температура",
        metric_precip: "Опади",
        metric_wind: "Вітер",
        metric_pressure: "Тиск",
        metric_dew: "Точка роси",
        metric_uv: "УФ-індекс",
        metric_visibility: "Видимість",
        metric_soil0: "🌱 Ґрунт (поверхня)",
        metric_soil6: "🌱 Ґрунт (6 см)",
        metric_moon: "Місяць",
        metric_sun: "Схід/Захід сонця",
        agroAnalyticsBtn: "📉 Агро-аналітика",
        metric_aqi_now: "🍃 Повітря зараз",
        metric_aqi_main: "🍃 Повітря основне",
        metric_aqi_ext: "🍃 Повітря розш.",
        metric_geomag: "🧲 Магнітні бурі",
        help_aqi: "🍃 Якість повітря",
        help_geomag: "🧲 Магнітні бурі",
        help_soil0: "🌱 Ґрунт 0 см",
        help_soil6: "🌱 Ґрунт 6 см",
        help_aqi_desc: "<h3>🍃 Якість повітря</h3><p>Три фракції <b>PM</b> — мікроскопічний пил у повітрі.</p><details open><summary>🔹 Фракції PM</summary><ul><li><b>PM₁</b> — ультрадрібний (сажа, вихлоп). У кров, шкодить судинам</li><li><b>PM₂.₅</b> — дрібний; норма 0–12 мкг/м³. Смог, осідає в легенях</li><li><b>PM₁₀</b> — великий; норма 0–45 мкг/м³. Пісок, пилок, носоглотка</li></ul></details><h3>📊 Рівні AQI</h3><table bordered striped compact><tr><th>AQI</th><th>Рекомендація</th></tr><tr><td>🟢 0–50 Чисто</td><td>Гуляти, провітрювати, спорт OK</td></tr><tr><td>🟡 51–100 Помірно</td><td>Чутливим зменшити навантаження на вулиці</td></tr><tr><td>🟠 101–150 Шкідливо</td><td>Дітям і хворим — у приміщенні, вікна зачинити</td></tr><tr><td>🔴 151+ Небезпечно</td><td>Без спорту на вулиці; респіратор; протерти рослини</td></tr></table>",
        help_geomag_desc: "<h3>🧲 Магнітні бурі</h3><p>Збурення магнітного поля Землі через сонячну активність (NOAA SWPC).</p><p>📡 <b>Kp-індекс</b> (0–9) та шкала NOAA <b>G1–G5</b>:</p><table bordered striped compact><tr><th>Kp / G</th><th>Рівень</th><th>Що очікувати</th></tr><tr><td>🟢 0–3</td><td>Спокійно</td><td>Поле в нормі, самопочуття стабільне</td></tr><tr><td>🟡 4</td><td>Збурення</td><td>Легкий дискомфорт у дуже чутливих</td></tr><tr><td>🟠 5 · G1</td><td>Слабка буря</td><td>Легкий головний біль, перепади настрою; мінімальний вплив на техніку</td></tr><tr><td>🔴 6 · G2</td><td>Помірна буря</td><td>Втома, зниження концентрації; можливі збої GPS у високих широтах</td></tr><tr><td>🔴 7 · G3</td><td>Сильна буря</td><td>Помітний вплив на самопочуття; збої навігації, радіо</td></tr><tr><td>🟣 8 · G4</td><td>Дуже сильна</td><td>Серйозний дискомфорт; широкі збої систем</td></tr><tr><td>⚫ 9 · G5</td><td>Екстремальний шторм</td><td>Максимальний вплив; уникати навантажень</td></tr></table><details open><summary>⚕️ Поради під час бурі</summary><ul><li>Більше води, менше стресу і інтенсивних тренувань</li><li>Ліки під рукою, якщо ви метеозалежні</li><li>Не пересаджуйте рослини в ці дні</li></ul></details>",
        alertSettingsTitle: "🔔 Сповіщення про зміни",
        alertSettingsDesc: `<p>Тут ви вмикаєте або вимикаєте лише <b>проактивні сповіщення</b> про різкі зміни протягом дня. Вечірній прогноз налаштовується окремо.</p>

<details><summary>🌡 Температура</summary>
<ul>
  <li>Зміна прогнозу на ≥ 4 °C</li>
  <li>Аномалія зараз (відхилення &gt; 5 °C від очікуваного діапазону)</li>
</ul>
</details>

<details><summary>🌧 Опади</summary>
<ul>
  <li>Несподівані опади або їх скасування</li>
  <li>Значно більше опадів (≥ 1.5 мм)</li>
  <li>Триваліший дощ або зміщення в часі</li>
</ul>
</details>

<details><summary>💨 Якість повітря</summary>
<ul>
  <li>Погіршення AQI (&gt; 50 / 100 / 150) або різке зростання PM2.5 / PM10</li>
  <li>Повернення повітря в безпечну зону</li>
</ul>
</details>

<details><summary>🧲 Магнітні бурі</summary>
<ul>
  <li><b>Всі зміни магн.бур</b> — активний режим для метеочутливих людей. Бот буде надсилати повідомлення про усі підвищення і зниження рівня (Kp)</li>
  <li><b>Тихий</b> — лише якщо буря сильніша, ніж планувалась (у вечірньому прогнозі), а також коли магнітне поле повністю заспокоїться</li>
  <li><b>Без сповіщ. магнітн. бур</b> — сповіщення про бурі приходити не будуть</li>
</ul>
</details>`,
        alert_temperature: "Температура",
        alert_precip: "Опади",
        alert_magneticStorm: "Магнітні бурі",
                geomagMode_active: "🧲 Всі зміни магн.бур",
        geomagMode_quiet: "🧲 Тихий",
        geomagMode_off: "🧲 Без сповіщ.магн.бур",
        geomagModeHint: "Тихий: алерт лише якщо буря сильніша за вечірній план.\nАктивний: усі підвищення й зниження рівня.",
        geomagForecastTitle: "🧲 Прогноз магнітних бур",
        geomagForecastEmpty: "Немає даних NOAA зараз. Спробуйте пізніше.",
        geomagForecastBtn: "🧲 Прогноз магнітних бур",
        alert_airQuality: "Якість повітря",
        alertDisableAll: "🔕 Вимкнути всі сповіщення про зміни",
        alertEnableAll: "🔔 Увімкнути всі сповіщення про зміни",
        alertConfigureBtn: "⚙️ Налаштувати сповіщення",
        settingsChangeAlerts: "🔔 Сповіщення про зміни",
        settingsEveningForecastBtn: "🌆 Вечірній прогноз",
        settingsEveningForecast: "⚙️ Налашт. вечірній прогноз",
        settingsGeneral: "⚙️ Загальні налаштування",
        receiveEveningForecast: "Отримувати вечірній прогноз"
    },
    en: {

        welcome: "👋 Hello! My name is **Parasol**.\n\nI will monitor the weather in your city and send alerts about sudden changes.\n\nPlease type the name of your city:",
        select: "🔍 Choose the correct option from the list:",
        notFound: "❌ Cannot find this city. Please try to be more specific (e.g. add region/state).",
        errorSearch: "❌ Search error occurred. Please try again later.",
        citySet: "City {city} is set!",
        citySetFull: "✅ **City set:** {city}\n🌐 Coordinates: {lat}, {lon}\n🌡️ Current temperature: {temp}°C\n💧 Dew Point: {dewpt}°C",
        dashboard: "📊",
        settingsBtn: "Settings",
        helpBtn: "Help",
        helpSelect: "🔍 Choose a topic you are interested in:",
        help_uv: "☀️ What is UV index?",
        help_wind: "🌬️ Wind directions",
        help_press: "🧭 Pressure & Health",
        help_hum: "💧 Humidity & Visibility",
        help_precip: "🌧️ Precipitation chance",
        help_dew: "💧 Dew Point",
        help_feels: "🌡️ Feels Like",
        help_cloud: "☁️ Cloudiness",
        help_how: "ℹ️ How it works",
        help_uv_desc: "<h3>☀️ UV Index</h3><p>Ultraviolet intensity. Affects skin and plants.</p><table bordered striped compact><tr><th>Level</th><th>What to do</th></tr><tr><td>🟢 0–2 Low</td><td>Safe. SPF optional. No shading needed for plants</td></tr><tr><td>🟡 3–5 Moderate</td><td>SPF, hat, sunglasses. Harden seedlings gradually</td></tr><tr><td>🟠 6–7 High</td><td>Shade 11:00–16:00. Net 20–30% for sensitive crops</td></tr><tr><td>🔴 8–10 Very High</td><td>Minimize sun. Shade + water only morning/evening</td></tr><tr><td>🟣 11+ Extreme</td><td>Avoid outdoors by day. Maximum plant shading</td></tr></table>",
        help_wind_desc: "<h3>🌬️ Wind directions</h3><p>16-point compass — shows <b>where the wind comes from</b>.</p><ul><li><b>Cardinal:</b> N, S, E, W</li><li><b>Intercardinal:</b> NE, SW, etc.</li><li><b>Fine detail:</b> down to 22.5° (e.g. SSE)</li></ul><h3>🌡️ Impact on weather</h3><table bordered striped compact><tr><th>Direction</th><th>Effect</th></tr><tr><td>🔹 Northerly</td><td><b>“Arctic intrusion”</b><br/>Cooling, night frost, blizzards</td></tr><tr><td>🔸 Easterly</td><td><b>“Dry wind”</b><br/>Dries soil and air, dust, fast evaporation</td></tr><tr><td>🔹 Westerly</td><td><b>“Moist front”</b><br/>Rain, high humidity, fungal risk</td></tr><tr><td>🔸 Southerly</td><td><b>“Warm sector”</b><br/>Tropical air, rapid warming, overheating</td></tr></table><details open><summary>⚠️ Why fine detail matters?</summary><ol><li><b>Early warning:</b> ~20° vector shift can signal a front before pressure changes</li><li><b>Drift vector:</b> drones/aviation drift, coastal storm surge</li><li><b>Local effects:</b> transit wind vs wind funneling into bays</li></ol></details>",
        help_press_desc: "<h3>🧭 Atmospheric pressure</h3><p>Force of air on the Earth’s surface.</p><ul><li><b>Normal:</b> 760 mmHg (1013 hPa) at sea level</li><li><b>Fall (cyclone):</b> clouds, rain, wind. Plants: sap flow, higher fungal risk</li><li><b>Rise (anticyclone):</b> clear, dry, wind calms</li></ul><details open><summary>⚠️ Impact on plants</summary><p>High pressure + clear sky → radiation jumps. Leaf burn risk higher at midday. Shade greenhouses and seedlings.</p><p><i>Swings over 1–2 mmHg/h often mean headaches and plant stress.</i></p></details>",
        help_hum_desc: "<h3>💧 Humidity and visibility</h3><p><b>Humidity</b> — relative moisture. Comfort: <b>40–60%</b>.</p><ul><li><b>&gt;70%:</b> harder to cool; plants — mold risk</li><li><b>&lt;30%:</b> dry mucosa; leaf wilting</li></ul><p>Low humidity + high UV → faster moisture loss and burns. Shade sensitive crops.</p><h3>👁 Visibility</h3><ul><li><b>10+ km</b> — excellent</li><li><b>&lt;1 km</b> — dense fog, drive carefully</li></ul><details open><summary>⚠️ Fog and plants</summary><ul><li><b>Spring:</b> radiation frost even if air &gt;0°C — watch near-ground temp</li><li><b>Autumn:</b> stagnant moisture → pathogens and rot</li><li><b>Dew point ~0°C</b> with high humidity → possible ground frost</li><li><b>VPD:</b> humidity &lt;30% and t &gt;25°C → shading required</li><li>Fog 4–6+ h at +15…+20°C — good fungicide window</li></ul></details>",
        help_precip_desc: "<h3>🌧️ Precipitation chance and amount</h3><p>Check <b>both</b> metrics:</p><ul><li><b>Chance (%):</b> will rain arrive. 30–40% lottery; 80% nearly certain</li><li><b>Amount (mm):</b> water volume. 0 mm symbolic; &gt;2 mm real watering</li></ul><details open><summary>🌱 Garden tips</summary><ul><li><b>Burns:</b> sun after rain — droplets act as lenses. Shade or shake off</li><li><b>1–2 mm:</b> only top dust, not a real watering</li><li><b>Heavy mm + wind:</b> stake tall crops in advance</li></ul></details>",
        help_dew_desc: "<h3>💧 Dew point</h3><p>How “heavy” the air feels.</p><table bordered striped compact><tr><th>Dew point</th><th>Meaning</th></tr><tr><td>&lt;10°C</td><td>Comfortable, dry. Soil dries faster</td></tr><tr><td>12–15°C</td><td>Pleasant. Ideal for most crops</td></tr><tr><td>16–20°C</td><td>Humidity felt. Fungal risk, possible burns via droplets</td></tr><tr><td>&gt;21°C</td><td>Muggy. Plants struggle — shade with netting</td></tr></table>",
        help_feels_desc: "<h3>🌡️ Feels like</h3><p>Subjective temperature with humidity and wind.</p><ul><li><b>Summer:</b> high humidity → plants “suffocate”, heat stress</li><li><b>Winter:</b> wind speeds moisture loss and frostbite</li></ul><details open><summary>🌵 Impact on plants</summary><ul><li>If “feels like” is much higher than real t — peak sun, time to shade</li><li>High values → faster evaporation: check soil, no droplets on leaves in sun</li></ul></details>",
        help_cloud_desc: "<h3>☁️ Cloud cover</h3><p>Percentage of sky covered by clouds.</p><table bordered striped compact><tr><th>Cover</th><th>Advice</th></tr><tr><td>0–10% Clear</td><td><b>High burn risk</b> — shade at midday</td></tr><tr><td>11–30% Mostly clear</td><td>Harsh light; watch soil moisture</td></tr><tr><td>31–70% Partly cloudy</td><td>Best regime for most crops</td></tr><tr><td>71–90% Mostly cloudy</td><td>Diffuse light, no shading needed</td></tr><tr><td>91–100% Overcast</td><td>No burns; prolonged → leggy seedlings</td></tr></table>",
                help_soil0_desc: "<h3>🌱 Soil 0 cm (surface)</h3><p>Temperature of the ground “skin”.</p><ul><li>Defines <b>radiation frost</b> — surface &lt;0°C while air is still positive</li><li>Critical for flowers, seedlings, strawberries, young shoots</li><li>Forecast shows daily <b>min … max</b></li><li>Source: Open-Meteo</li></ul>",
        help_soil6_desc: "<h3>🌱 Soil 6 cm</h3><p>Root-zone temperature — more stable than the surface.</p><ul><li>Better for roots and soil biota</li><li>Less sensitive to brief night cool-downs</li><li>Useful for sowing and ground frost risk</li><li>Source: Open-Meteo</li></ul>",
help_how_desc: "<h3>ℹ️ How it works</h3><ol><li>Send a city name — the bot resolves coordinates and monitors weather.</li><li><b>Change alerts:</b> temp forecast shift, anomalous t, rain appear/cancel, AQI, magnetic storm.</li><li><b>Evening forecast</b> for several days — pick metrics and day count; the “Parasol highlights” block also shows official Hydrometcenter warnings for your location when available.</li><li>Alerts can be tuned individually or all turned off.</li><li>Also: agro analytics, history, dashboard.</li></ol><p>Everything is in <b>Settings</b>.</p><details open><summary>📡 Data sources</summary><ul><li>Weather — Weatherbit, Open-Meteo, Tomorrow.io</li><li>Air — WAQI, Open-Meteo</li><li>Magnetic field — NOAA SWPC</li><li>Official weather warnings (Ukraine) — Ukrainian Hydrometeorological Center via MeteoAlarm (CAP)</li><li>Geocoding — OpenStreetMap</li></ul></details>",
        saveError: "❌ Failed to save. Please check server configuration.",
        settings: "⚙️ *Settings*",
        settingsWind: "🌬️ Wind:",
        settingsPress: "🧭 Pressure:",
        settingsCity: "📍 Change city",
        settingsDeleteCity: "🗑 Delete city",
        settingsUnsubscribe: "🔕 Disable all notifications",
        settingsSubscribe: "🔔 Enable all notifications",
        cityDeleted: "🗑 City removed. The bot is no longer tracking weather. To restore — send a city name.",
        notifDisabled: "🔕 Notifications disabled. The bot keeps tracking weather but won't send alerts.",
        notifEnabled: "🔔 Notifications enabled!",
        settingsSaved: "✅ Settings saved!",
        unitMs: "m/s",
        unitKmh: "km/h",
        unitMmhg: "mmHg",
        unitHpa: "hPa",
        unitC: "°C",
        unitF: "°F",
        settingsTemp: "🌡️ Temp:",
        cropsBtn: "🌱 My Crops",
        cropsSelectCat: "📂 Choose a plant category:",
        cropsSelectItem: "✅ Mark what you grow in the {cat} category:",
        backBtn: "⬅️ Back",
        agroForecastBtn: "Agro-Forecast",
        agroArchiveBtn: "Archive",
        agroRecBtn: "📝 Recommendations for {date}",
        agroScheduleBtn: "🚜 Treatment Schedule",
        agroFiveDayBtn: "📅 5-Day Forecast",
        settingsForecastBtn: "⚙️ Configure Forecast",
        forecastSettingsTitle: "🛠 **Forecast Settings**\n\nChoose the number of days and metrics you want to see in your daily report:",
        daysCount: "📅 Number of days:",
        metricsTitle: "📊 Metrics:",
        metric_condition: "Sky condition",
        metric_temp: "Temperature",
        metric_precip: "Precipitation",
        metric_wind: "Wind",
        metric_pressure: "Pressure",
        metric_dew: "Dew Point",
        metric_uv: "UV Index",
        metric_visibility: "Visibility",
        metric_soil0: "🌱 Soil (surface)",
        metric_soil6: "🌱 Soil (6 cm)",
        metric_moon: "Moon",
        metric_sun: "Sunrise/Sunset",
        agroAnalyticsBtn: "📉 Agro-Analytics",
        metric_aqi_now: "🍃 Air now",
        metric_aqi_main: "🍃 Air main",
        metric_aqi_ext: "🍃 Air extended",
        metric_geomag: "🧲 Magnetic Storms",
        help_aqi: "🍃 Air Quality",
        help_geomag: "🧲 Magnetic Storms",
        help_soil0: "🌱 Soil 0 cm",
        help_soil6: "🌱 Soil 6 cm",
        help_aqi_desc: "<h3>🍃 Air quality</h3><p>Three <b>PM</b> fractions — microscopic particles in the air.</p><details open><summary>🔹 PM fractions</summary><ul><li><b>PM₁</b> — ultra-fine (soot, exhaust). Enters blood, harms vessels</li><li><b>PM₂.₅</b> — fine; norm 0–12 µg/m³. Smog, settles in lungs</li><li><b>PM₁₀</b> — coarse; norm 0–45 µg/m³. Sand, pollen, upper airways</li></ul></details><h3>📊 AQI levels</h3><table bordered striped compact><tr><th>AQI</th><th>Advice</th></tr><tr><td>🟢 0–50 Good</td><td>Walk, ventilate, outdoor sport OK</td></tr><tr><td>🟡 51–100 Moderate</td><td>Sensitive people: reduce outdoor exertion</td></tr><tr><td>🟠 101–150 Unhealthy</td><td>Kids/patients indoors, close windows</td></tr><tr><td>🔴 151+ Hazardous</td><td>No outdoor sport; respirator; wipe plants</td></tr></table>",
        help_geomag_desc: "<h3>🧲 Magnetic storms</h3><p>Disturbance of Earth’s magnetic field caused by solar activity (NOAA SWPC).</p><p>📡 <b>Kp-index</b> (0–9) and NOAA <b>G1–G5</b> scale:</p><table bordered striped compact><tr><th>Kp / G</th><th>Level</th><th>What to expect</th></tr><tr><td>🟢 0–3</td><td>Calm</td><td>Field normal, feeling stable</td></tr><tr><td>🟡 4</td><td>Unsettled</td><td>Mild discomfort for the very sensitive</td></tr><tr><td>🟠 5 · G1</td><td>Minor storm</td><td>Light headache, mood swings; minimal tech impact</td></tr><tr><td>🔴 6 · G2</td><td>Moderate storm</td><td>Fatigue, reduced focus; possible GPS issues at high latitudes</td></tr><tr><td>🔴 7 · G3</td><td>Strong storm</td><td>Noticeable health impact; navigation and radio disruptions</td></tr><tr><td>🟣 8 · G4</td><td>Severe storm</td><td>Serious discomfort; widespread system issues</td></tr><tr><td>⚫ 9 · G5</td><td>Extreme storm</td><td>Maximum impact; avoid exertion</td></tr></table><details open><summary>⚕️ Tips during a storm</summary><ul><li>More water, less stress and hard workouts</li><li>Keep meds nearby if weather-sensitive</li><li>Avoid repotting plants on these days</li></ul></details>",
        alertSettingsTitle: "🔔 Change Alerts",
        alertSettingsDesc: `<p>Here you enable or disable only <b>proactive alerts</b> about sudden changes during the day. The evening forecast is configured separately.</p>

<details><summary>🌡 Temperature</summary>
<ul>
  <li>Forecast change of ≥ 4 °C</li>
  <li>Current anomaly (deviation &gt; 5 °C from the expected range)</li>
</ul>
</details>

<details><summary>🌧 Precipitation</summary>
<ul>
  <li>Unexpected precipitation or its cancellation</li>
  <li>Significantly more precipitation (≥ 1.5 mm)</li>
  <li>Longer rain or shift in timing</li>
</ul>
</details>

<details><summary>💨 Air Quality</summary>
<ul>
  <li>AQI deterioration (&gt; 50 / 100 / 150) or sharp rise in PM2.5 / PM10</li>
  <li>Air quality returning to the safe zone</li>
</ul>
</details>

<details><summary>🧲 Magnetic Storms</summary>
<ul>
  <li><b>All storm changes</b> — active mode for weather-sensitive people. The bot will send messages about all rises and drops in the Kp level</li>
  <li><b>Quiet</b> — only if the storm is stronger than planned (in the evening forecast), plus when the field fully calms down</li>
  <li><b>No magnetic storm alerts</b> — storm notifications will not be sent</li>
</ul>
</details>`,
        alert_temperature: "Temperature",
        alert_precip: "Precipitation",
        alert_magneticStorm: "Magnetic storms",
                geomagMode_active: "🧲 All storm changes",
        geomagMode_quiet: "🧲 Quiet",
        geomagMode_off: "🧲 No storm alerts",
        geomagModeHint: "Quiet: alert only if stronger than evening plan.\nActive: all level rises and drops.",
        geomagForecastTitle: "🧲 Geomagnetic storm forecast",
        geomagForecastEmpty: "No NOAA data right now. Try again later.",
        geomagForecastBtn: "🧲 Geomagnetic storm forecast",
        alert_airQuality: "Air quality",
        alertDisableAll: "🔕 Disable all change alerts",
        alertEnableAll: "🔔 Enable all change alerts",
        alertConfigureBtn: "⚙️ Configure alerts",
        settingsChangeAlerts: "🔔 Change alerts",
        settingsEveningForecastBtn: "🌆 Evening forecast",
        settingsEveningForecast: "⚙️ Evening forecast settings",
        settingsGeneral: "⚙️ General settings",
        receiveEveningForecast: "Receive evening forecast"
    }
};

// Build Alert Triggers configuration keyboard
function resolveGeomagMode(user) {
    if (user?.geomagMode === 'active' || user?.geomagMode === 'quiet' || user?.geomagMode === 'off') {
        return user.geomagMode;
    }
    return (user?.alertTriggers?.magneticStorm === false) ? 'off' : 'quiet';
}

function buildAlertTriggersKeyboard(lang, triggers = {}, geomagMode = 'quiet') {
    const d = dict[lang];
    const keys = ['temperature', 'precip', 'airQuality'];
    const mode = geomagMode === 'active' || geomagMode === 'quiet' || geomagMode === 'off' ? geomagMode : 'quiet';
    const hasAnyActive = keys.some(k => triggers[k] !== false) || mode !== 'off';

    const masterBtn = hasAnyActive
        ? { text: d.alertDisableAll, callback_data: 'alert|toggle_all|off' }
        : { text: d.alertEnableAll, callback_data: 'alert|toggle_all|on' };

    const getCheck = (key) => (triggers[key] !== false ? '✅ ' : '⬜️ ');
    const modeMark = (m) => (mode === m ? '✅ ' : '⬜️ ');

    return {
        inline_keyboard: [
            [masterBtn],
            [
                { text: `${getCheck('temperature')}${d.alert_temperature}`, callback_data: 'alert|toggle|temperature' },
                { text: `${getCheck('precip')}${d.alert_precip}`, callback_data: 'alert|toggle|precip' }
            ],
            [
                { text: `${getCheck('airQuality')}${d.alert_airQuality}`, callback_data: 'alert|toggle|airQuality' },
                { text: `${modeMark('active')}${d.geomagMode_active}`, callback_data: 'geomag_mode|active' }
            ],
            [
                { text: `${modeMark('quiet')}${d.geomagMode_quiet}`, callback_data: 'geomag_mode|quiet' },
                { text: `${modeMark('off')}${d.geomagMode_off}`, callback_data: 'geomag_mode|off' }
            ],
            [{ text: d.settingsEveningForecast, callback_data: 'forecast_menu' }],
            [{ text: d.settingsGeneral, callback_data: 'open_settings' }]
        ]
    };
}

// Build settings keyboard based on current user preferences
function buildSettingsKeyboard(lang, units = {}, notificationsEnabled = true) {
    const d = dict[lang];
    const wind = units.wind || 'ms';
    const pressure = units.pressure || 'mmhg';
    return {
        inline_keyboard: [
            [
                { text: d.settingsChangeAlerts, callback_data: 'alert_settings' }
            ],
            [
                { text: d.settingsEveningForecastBtn, callback_data: 'forecast_menu' }
            ],
            [
                { text: notificationsEnabled ? d.settingsUnsubscribe : d.settingsSubscribe, callback_data: 'toggle_notifications' }
            ],
            [
                { text: `${d.settingsWind} ${wind === 'ms' ? '✅' : ''} ${d.unitMs}`, callback_data: 'unit|wind|ms' },
                { text: `${wind === 'kmh' ? '✅' : ''} ${d.unitKmh}`, callback_data: 'unit|wind|kmh' }
            ],
            [
                { text: `${d.settingsPress} ${pressure === 'mmhg' ? '✅' : ''} ${d.unitMmhg}`, callback_data: 'unit|pressure|mmhg' },
                { text: `${pressure === 'hpa' ? '✅' : ''} ${d.unitHpa}`, callback_data: 'unit|pressure|hpa' }
            ],
            [
                { text: `${d.settingsTemp} ${units.temp === 'f' ? '' : '✅'} ${d.unitC}`, callback_data: 'unit|temp|c' },
                { text: `${units.temp === 'f' ? '✅' : ''} ${d.unitF}`, callback_data: 'unit|temp|f' }
            ],
            [
                { text: d.helpBtn, callback_data: 'open_help' },
                { text: d.cropsBtn, callback_data: 'crops_main' }
            ],
            [
                { text: d.settingsCity, callback_data: 'change_city' },
                { text: d.settingsDeleteCity, callback_data: 'delete_city' }
            ]
        ]
    };
}

// Build Forecast configuration keyboard
function buildForecastSettingsKeyboard(lang, settings = {}, eveningForecastEnabled = true) {
    const d = dict[lang];
    const daysCount = settings.daysCount || 3;
    const metrics = settings.enabledMetrics || [];

    const eveningToggleBtn = {
        text: `${eveningForecastEnabled !== false ? '✅ ' : '⬜️ '}${d.receiveEveningForecast}`,
        callback_data: 'toggle_evening_forecast'
    };

    const daysRow = [1, 2, 3, 4, 5, 6].map(n => ({
        text: `${daysCount === n ? '✅ ' : ''}${n}`,
        callback_data: `forecast|days|${n}`
    }));

    const metricItems = [
        ['condition', 'temp'],
        ['precip', 'wind'],
        ['pressure', 'dew'],
        ['uv', 'visibility'],
        ['soil0', 'soil6'],
        ['moon', 'sun'],
        ['aqi_now', 'aqi_main'],
        ['aqi_ext', 'geomag']
    ];

    // legacy 'aqi' → вважаємо увімкненими всі три нові ключі
    const hasMetric = (m) => {
        if (metrics.includes(m)) return true;
        if (metrics.includes('aqi') && (m === 'aqi_now' || m === 'aqi_main' || m === 'aqi_ext')) return true;
        return false;
    };
    const metricButtons = metricItems.map(row =>
        row.map(m => ({
            text: `${hasMetric(m) ? '✅ ' : '⬜️ '}${d['metric_' + m]}`,
            callback_data: `forecast|toggle|${m}`
        }))
    );

    return {
        inline_keyboard: [
            [eveningToggleBtn],
            [{ text: d.daysCount, callback_data: 'noop' }],
            daysRow,
            [{ text: d.metricsTitle, callback_data: 'noop' }],
            ...metricButtons,
            [{ text: d.backBtn, callback_data: 'open_settings' }]
        ]
    };
}

// Build help keyboard with optional checkmark for the active topic
function buildHelpKeyboard(lang, activeTopic = null) {
    const d = dict[lang];
    const layout = [
        ['uv', 'wind'],
        ['press', 'hum'],
        ['precip', 'dew'],
        ['feels', 'cloud'],
        ['soil0', 'soil6'],
        ['aqi', 'geomag'],
        ['how']
    ];

    return {
        inline_keyboard: layout.map(row =>
            row.map(topic => ({
                text: `${activeTopic === topic ? '✅ ' : ''}${d['help_' + topic]}`,
                callback_data: `help|${topic}`
            }))
        )
    };
}
// Build crops main categories keyboard
function buildCropsCategoriesKeyboard(lang) {
    const d = dict[lang];
    const buttons = Object.keys(CROPS_DATA).map(key => ([{
        text: CROPS_DATA[key].label[lang],
        callback_data: `crops_cat|${key}`
    }]));
    return { inline_keyboard: buttons };
}

// Build crops sub-items keyboard with checkboxes
function buildCropsItemsKeyboard(lang, categoryKey, userCrops = []) {
    const d = dict[lang];
    const category = CROPS_DATA[categoryKey];
    const items = category.items;

    const buttons = Object.keys(items).map(id => ([{
        text: `${userCrops.includes(id) ? '✅ ' : ''}${items[id][lang]}`,
        callback_data: `crops_toggle|${categoryKey}|${id}`
    }]));

    // Add Back button
    buttons.push([{ text: d.backBtn, callback_data: 'crops_main' }]);

    return { inline_keyboard: buttons };
}

// Build archive selection keyboard
function buildArchiveKeyboard(lang) {
    const isUk = lang === 'uk';
    return {
        inline_keyboard: [
            [
                { text: isUk ? '7 днів' : '7 Days', callback_data: 'archive|7' },
                { text: isUk ? '30 днів' : '30 Days', callback_data: 'archive|30' }
            ],
            [
                { text: isUk ? '6 міс.' : '6 Months', callback_data: 'archive|180' },
                { text: isUk ? 'Рік' : 'Year', callback_data: 'archive|365' }
            ],
            [
                { text: isUk ? '🗓 Своя дата' : '🗓 Custom Date', callback_data: 'archive|custom' },
                { text: isUk ? '⬅️ Мин. рік' : '⬅️ Last Year', callback_data: 'archive|last_year' }
            ]
        ]
    };
}

// Build Agro-Forecast sub-menu keyboard
function buildAgroForecastKeyboard(lang, lastUpdateDate) {
    const d = dict[lang];
    const dateFormatted = lastUpdateDate
        ? new Date(lastUpdateDate).toLocaleDateString(lang === 'uk' ? 'uk-UA' : 'en-US', { day: '2-digit', month: '2-digit' })
        : '...';

    return {
        inline_keyboard: [
            [{ text: d.agroRecBtn.replace('{date}', dateFormatted), callback_data: 'agro_tomorrow' }],
            [{ text: d.agroScheduleBtn, callback_data: 'agro_schedule_only' }],
            [{ text: d.agroFiveDayBtn, callback_data: 'agro_5day' }]
        ]
    };
}

const getLang = (ctx) => (ctx.from?.language_code === 'uk' || ctx.from?.language_code === 'ru') ? 'uk' : 'en';


// Global command registration (runs once on startup/import)
if (process.env.TG_TOKEN) {
    bot.api.setMyCommands([
        { command: 'start', description: 'Запустити бота / Start' },
        { command: 'settings', description: 'Налаштування / Settings' },
        { command: 'help', description: 'Допомога / Help' }
    ]).catch(err => console.error('Error setting global commands:', err.message));
}

// Bot Logic (Webhook handler)
// grammY requires bot.init() before handleUpdate in serverless environments.
let botReady = false;
async function ensureBotReady() {
    if (!botReady) {
        await bot.init();
        botReady = true;
    }
}

module.exports = async (req, res) => {
    try {
        if (!process.env.TG_TOKEN) {
            return res.status(500).send('TG_TOKEN is missing');
        }

        await connectDB();
        await ensureBotReady();

        // Handle Webhook request
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            res.status(200).send('OK');
        } else {
            res.status(200).send('Parasol Sentinel Bot is active.');
        }
    } catch (e) {
        console.error('Handler Error:', e.message);
        console.error(e.stack);
        res.status(500).send(`Error: ${e.message}`);
    }
}

// /start command
bot.command("start", async (ctx) => {
    console.log('Start command from:', ctx.from.id);
    const lang = getLang(ctx);
    await connectDB();
    const user = await User.findOne({ telegramId: ctx.from.id });

    // Reply keyboard: compact, dismissable with swipe — without is_persistent to avoid UI bugs
    const keyboard = {
        keyboard: [
            [{ text: dict[lang].settingsBtn }, { text: dict[lang].agroAnalyticsBtn }]
        ],
        resize_keyboard: true
    };

    await ctx.reply(dict[lang].welcome, { parse_mode: 'Markdown', reply_markup: keyboard });

    // Register commands for the user
    try {
        await ctx.api.setMyCommands([
            { command: 'start', description: lang === 'uk' ? 'Запустити бота' : 'Start the bot' },
            { command: 'settings', description: lang === 'uk' ? 'Налаштування' : 'Settings' },
            { command: 'help', description: lang === 'uk' ? 'Допомога' : 'Help' }
        ]);

        // Set WebApp menu button (this will be on the left of the input field)
        await ctx.api.setChatMenuButton({ menu_button: {
            type: 'web_app',
            text: dict[lang].dashboard,
            web_app: { url: formatUrl(process.env.DOMAIN || 'localhost') }
        } });
    } catch (e) {
        console.error('Error setting commands/menu:', e.message);
    }
});

// /settings command
bot.command('settings', async (ctx) => {
    const lang = getLang(ctx);
    await connectDB();
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user) {
        return ctx.reply(lang === 'uk'
            ? '❌ Спочатку встановіть місто, надіславши його назву.'
            : '❌ Please set your city first by sending its name.', { parse_mode: 'Markdown' });
    }
    await ctx.reply(
        dict[lang].settings, { parse_mode: 'Markdown', reply_markup: buildSettingsKeyboard(lang, user.units, user.notificationsEnabled !== false) });
});

// Help menu logic
const sendHelpMenu = async (ctx) => {
    const lang = getLang(ctx);
    const d = dict[lang];
    await ctx.reply(d.helpSelect, {
        reply_markup: buildHelpKeyboard(lang)
    });
};

// /help command
bot.command('help', sendHelpMenu);

// Handle text messages (City search or Menu buttons)
bot.on("message:text", async (ctx) => {
    const query = ctx.message.text.trim();
    const lang = getLang(ctx);

    // Handle Menu Buttons
    const isSettings = query.includes(dict.uk.settingsBtn) || query.includes(dict.en.settingsBtn);
    if (isSettings) {
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (!user) {
            return ctx.reply(lang === 'uk' ? '📍 Спочатку встановіть місто.' : '📍 Please set a city first.');
        }
        return ctx.reply(dict[lang].settings, { parse_mode: 'Markdown', reply_markup: buildSettingsKeyboard(lang, user.units, user.notificationsEnabled !== false) });
    }

    const isHelp = query.includes(dict.uk.helpBtn) || query.includes(dict.en.helpBtn);
    if (isHelp) {
        return sendHelpMenu(ctx);
    }

    if (query === dict.uk.cropsBtn || query === dict.en.cropsBtn) {
        return ctx.reply(dict[lang].cropsSelectCat, {
            reply_markup: buildCropsCategoriesKeyboard(lang)
        });
    }

    const isAgroAnalytics = query.includes(dict.uk.agroAnalyticsBtn) || query.includes(dict.en.agroAnalyticsBtn);
    if (isAgroAnalytics) {
        return ctx.reply(lang === 'uk' ? '📉 Оберіть інструмент агро-аналітики:' : '📉 Select agro-analytics tool:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: dict[lang].agroForecastBtn, callback_data: 'agro_forecast_menu' }],
                    [{ text: dict[lang].agroArchiveBtn, callback_data: 'agro_archive_menu' }]
                ]
            }
        });
    }

    const isAgroForecast = query.includes(dict.uk.agroForecastBtn) || query.includes(dict.en.agroForecastBtn);
    if (isAgroForecast) {
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (!user || !user.lat) return ctx.reply(lang === 'uk' ? '📍 Спочатку встановіть місто.' : '📍 Please set a city first.');

        const cityKey = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
        const cityData = await City.findOne({ externalId: cityKey });

        return ctx.reply(lang === 'uk' ? '🔮 Оберіть тип прогнозу:' : '🔮 Select forecast type:', {
            reply_markup: buildAgroForecastKeyboard(lang, cityData?.eveningState?.updatedAt)
        });
    }

    if (query === dict.uk.agroScheduleBtn || query === dict.en.agroScheduleBtn) {
        // Keeping this for backward compatibility or if called directly
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (!user || !user.lat) return ctx.reply(lang === 'uk' ? '📍 Спочатку встановіть місто.' : '📍 Please set a city first.');

        const cityKey = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
        const cityData = await City.findOne({ externalId: cityKey });

        if (!cityData || !cityData.eveningState?.forecast) {
            return ctx.reply(lang === 'uk' ? '⚠️ Дані прогнозу ще не готові.' : '⚠️ Forecast data not ready.');
        }

        const history = await History.find({ externalId: cityKey }).sort({ date: -1 }).limit(7).lean();
        const report = analyzeSprayingWindow(cityData.eveningState.forecast, history, lang, user.crops || []);
        return ctx.reply(report, { parse_mode: 'HTML' });
    }

    const isArchive = query.includes(dict.uk.agroArchiveBtn) || query.includes(dict.en.agroArchiveBtn);
    if (isArchive) {
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (!user || !user.lat) return ctx.reply(lang === 'uk' ? '📍 Спочатку встановіть місто.' : '📍 Please set a city first.');

        return ctx.reply(lang === 'uk' ? '📊 Оберіть період для аналізу:' : '📊 Select period for analysis:', {
            reply_markup: buildArchiveKeyboard(lang)
        });
    }

    // Handle Custom Date Input (DD.MM.YYYY or DD.MM.YYYY-DD.MM.YYYY)
    const dateRegex = /(\d{2}\.\d{2}\.\d{4})(?:\s*-\s*(\d{2}\.\d{2}\.\d{4}))?/;
    const dateMatch = query.match(dateRegex);
    if (dateMatch) {
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (user && user.lat) {
            const cityKey = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
            const cityDoc = await City.findOne({ externalId: cityKey });

            let start = dateMatch[1].split('.').reverse().join('-');
            let end = dateMatch[2] ? dateMatch[2].split('.').reverse().join('-') : start;

            try {
                // Determine how many days back we need to fetch
                const dayDiff = Math.ceil((new Date() - new Date(start)) / (1000 * 60 * 60 * 24));
                if (cityDoc && dayDiff > 0) {
                    await fetchMissingHistory(cityDoc, Math.min(dayDiff + 1, 1095));
                }

                const history = await History.find({
                    externalId: cityKey,
                    date: { $gte: start, $lte: end }
                }).sort({ date: -1 }).lean();


                const report = await generateHistoricalReport(history, lang, user.crops || [], cityKey);

                return ctx.reply(report, {
                    parse_mode: 'HTML',
                    reply_markup: buildArchiveKeyboard(lang)
                });
            } catch (err) {
                console.error('Date range error:', err);
                return ctx.reply(lang === 'uk' ? '❌ Помилка обробки дат.' : '❌ Date processing error.');
            }
        }
    }


    if (query.startsWith('/')) return;

    try {
        console.log(`Searching for: ${query}`);
        // Using Nominatim for better search with multiple results
        // Added User-Agent (required by Nominatim) and explicit language
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1&accept-language=${lang}`;
        const response = await axios.get(nominatimUrl, {
            headers: { 'User-Agent': 'ParasolSentinelBot/1.1' }
        });

        if (response.data?.length > 0) {
            const buttons = response.data.map(item => {
                // Shorten name for the button text
                const name = item.display_name.split(',').slice(0, 3).join(',').trim();

                // Telegram callback_data limit is 64 bytes.
                // Format: set|lat|lon|city_name
                const lat = parseFloat(item.lat).toFixed(3);
                const lon = parseFloat(item.lon).toFixed(3);

                const callbackData = `set|${lat}|${lon}`;

                return [{ text: name, callback_data: callbackData }];
            });

            await ctx.reply(dict[lang].select, {
                reply_markup: { inline_keyboard: buttons }
            });
        } else {
            await ctx.reply(dict[lang].notFound, { parse_mode: 'Markdown' });
        }
    } catch (error) {
        console.error('Search Error:', error.message);
        await ctx.reply(dict[lang].errorSearch, { parse_mode: 'Markdown' });
    }
});

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data.split('|');
    const lang = getLang(ctx);

    if (data[0] === 'open_help') {
        await ctx.answerCallbackQuery().catch(() => { });
        return sendHelpMenu(ctx);
    }

    if (data[0] === 'agro_forecast_menu') {
        await ctx.answerCallbackQuery().catch(() => { });
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (!user || !user.lat) return ctx.reply(lang === 'uk' ? '📍 Спочатку встановіть місто.' : '📍 Please set a city first.');
        const cityKey = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
        const cityData = await City.findOne({ externalId: cityKey });
        return ctx.editMessageText(lang === 'uk' ? '🔮 Оберіть тип прогнозу:' : '🔮 Select forecast type:', {
            reply_markup: buildAgroForecastKeyboard(lang, cityData?.eveningState?.updatedAt)
        });
    }

    if (data[0] === 'agro_archive_menu') {
        await ctx.answerCallbackQuery().catch(() => { });
        return ctx.editMessageText(lang === 'uk' ? '📊 Оберіть період для аналізу:' : '📊 Select period for analysis:', {
            reply_markup: buildArchiveKeyboard(lang)
        });
    }

    // --- City selection callback ---
    if (data[0] === 'set') {
        const [_, lat, lon] = data;

        try {
            await connectDB();

            const weatherbitUrl = `https://api.weatherbit.io/v2.0/current?lat=${lat}&lon=${lon}&key=${process.env.WEATHERBIT_KEY}`;
            const weatherRes = await axios.get(weatherbitUrl);

            if (!weatherRes.data?.data?.[0]) throw new Error('No weather data received');
            const weather = weatherRes.data.data[0];

            await User.findOneAndUpdate(
                { telegramId: ctx.from.id },
                {
                    username: ctx.from.username,
                    city: weather.city_name,
                    lat: parseFloat(lat),
                    lon: parseFloat(lon),
                    timezone: weather.timezone,
                    language: lang,
                    lastState: {
                        temp: weather.temp,
                        weatherCode: weather.weather.code,
                        updatedAt: new Date()
                    }
                },
                { upsert: true, new: true }
            );

            // --- City Deduplication Logic ---
            const cityKey = `${parseFloat(lat).toFixed(2)},${parseFloat(lon).toFixed(2)}`;
            await City.findOneAndUpdate(
                { externalId: cityKey },
                {
                    name: weather.city_name,
                    lat: parseFloat(lat),
                    lon: parseFloat(lon),
                    externalId: cityKey
                },
                { upsert: true }
            );
            // ---------------------------------

            const sig = generateSignature(ctx.from.id, process.env.CRON_SECRET);
            const dashboardUrl = formatUrl(process.env.DOMAIN || 'localhost', `/?user=${ctx.from.id}&sig=${sig}`);

            await ctx.answerCallbackQuery(dict[lang].citySet.replace('{city}', weather.city_name));

            const messageText = dict[lang].citySetFull
                .replace('{city}', weather.city_name)
                .replace('{lat}', lat)
                .replace('{lon}', lon)
                .replace('{temp}', Math.round(weather.temp))
                .replace('{dewpt}', Math.round(weather.dewpt));

            await ctx.editMessageText(messageText, {
                parse_mode: 'Markdown'
            });

            // Re-show reply keyboard so bottom menu stays visible after city change
            await ctx.reply(
                lang === 'uk' ? '👇 Обери що тебе цікавить:' : '👇 Choose what you need:',
                {
                    reply_markup: {
                        keyboard: [[{ text: dict[lang].settingsBtn }, { text: dict[lang].agroAnalyticsBtn }]],
                        resize_keyboard: true
                    }
                }
            );

            // Set WebApp menu button after successful city selection
            await ctx.api.setChatMenuButton({ menu_button: {
                type: 'web_app',
                text: dict[lang].dashboard,
                web_app: { url: formatUrl(process.env.DOMAIN || 'localhost') }
            } }).catch(e => console.error('Menu button error:', e.message));

        } catch (error) {
            await ctx.reply(dict[lang].saveError, { parse_mode: 'Markdown' });
        }
    }

    // --- Detailed hourly forecast callback (supports date: forecast_hourly|YYYY-MM-DD or legacy forecast_tomorrow) ---
    else if (data[0] === 'forecast_hourly' || data[0] === 'forecast_tomorrow') {
        try {
            await ctx.answerCallbackQuery().catch(() => { });
            await connectDB();

            const user = await User.findOne({ telegramId: ctx.from.id });
            if (!user || !user.lat || !user.lon) {
                return ctx.reply(lang === 'uk' ? '❌ Помилка: дані користувача не знайдені' : '❌ Error: user data not found');
            }

            const timezone = user.timezone || 'Europe/Kyiv';
            // Do NOT use toLocaleString→new Date (UTC server shifts calendar day after ~21:00 Kyiv)
            const todayStr = new Intl.DateTimeFormat('en-CA', {
                timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
            }).format(new Date());
            const localNow = new Date(); // real now; date math uses todayStr / addDaysYmd

            // Determine target date:
            // 1) Explicit date from callback (forecast_hourly|YYYY-MM-DD)
            // 2) Legacy "forecast_tomorrow" → smart: if eveningState was updated yesterday (or earlier today before noon-ish),
            //    the "tomorrow" of that evening is actually today → show today; otherwise show tomorrow.
            let targetDateStr = data[1] && /^\d{4}-\d{2}-\d{2}$/.test(data[1]) ? data[1] : null;

            if (!targetDateStr) {
                const cityKey = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
                const cityDoc = await City.findOne({ externalId: cityKey }).lean();
                const eveningUpdated = cityDoc?.eveningState?.updatedAt
                    ? new Date(cityDoc.eveningState.updatedAt)
                    : null;

                if (eveningUpdated) {
                    const eveningLocal = new Date(eveningUpdated.toLocaleString('en-US', { timeZone: timezone }));
                    const eveningDateStr = eveningLocal.toLocaleDateString('en-CA', { timeZone: timezone });
                    // Evening forecast is sent for the *next* calendar day relative to its send date
                    const eveningTomorrow = new Date(eveningLocal);
                    eveningTomorrow.setDate(eveningTomorrow.getDate() + 1);
                    const eveningTargetStr = eveningTomorrow.toLocaleDateString('en-CA', { timeZone: timezone });

                    // If we are still on the same calendar day as the evening send → show that target (tomorrow)
                    // If we are already on the target day or later → show today (the original "tomorrow")
                    if (todayStr === eveningDateStr) {
                        targetDateStr = eveningTargetStr;
                    } else {
                        targetDateStr = todayStr;
                    }
                } else {
                    // No evening state → default to tomorrow
                    const tmr = new Date(localNow);
                    tmr.setDate(tmr.getDate() + 1);
                    targetDateStr = tmr.toLocaleDateString('en-CA', { timeZone: timezone });
                }
            }

            const targetDate = new Date(targetDateStr + 'T12:00:00');
            const formattedDate = targetDate.toLocaleDateString(lang === 'uk' ? 'uk-UA' : 'en-US', {
                weekday: 'short', day: 'numeric', month: 'short'
            });
            const shortDate = targetDate.toLocaleDateString(lang === 'uk' ? 'uk-UA' : 'en-US', {
                day: '2-digit', month: '2-digit'
            });

            // --- Hourly data: prefer Mongo snapshot (same as website), fallback to live Open-Meteo ---
            const OM_FRESH_MS = 90 * 60 * 1000; // 90 хв — як на сайті
            const cityKey = `${Number(user.lat).toFixed(2)},${Number(user.lon).toFixed(2)}`;
            const cityDocForSnap = await City.findOne({ externalId: cityKey }).lean();
            const snap = cityDocForSnap?.dashboardSnapshot;
            const omAge = snap?.updatedAtOm ? (Date.now() - new Date(snap.updatedAtOm).getTime()) : Infinity;
            const snapHourly = snap?.hourly;
            const snapHasDay = Array.isArray(snapHourly?.time) &&
                snapHourly.time.some(t => String(t).startsWith(targetDateStr));
            const snapHasCodes = Array.isArray(snapHourly?.weather_code) && snapHourly.weather_code.length > 0;
            const useSnapshot = snapHasDay && snapHasCodes && omAge < OM_FRESH_MS;

            let time, temperature_2m, precipitation, precipitation_probability, wind_speed_10m, weather_code;
            let soil_temperature_0cm = [];
            let soil_temperature_6cm = [];
            let dailyOm = null;
            let dataUpdatedAt = null;

            if (useSnapshot) {
                time = snapHourly.time || [];
                temperature_2m = snapHourly.temperature_2m || [];
                precipitation = snapHourly.precipitation || [];
                precipitation_probability = snapHourly.precipitation_probability || [];
                wind_speed_10m = snapHourly.wind_speed_10m || [];
                weather_code = snapHourly.weather_code || [];
                soil_temperature_0cm = snapHourly.soil_temperature_0cm || [];
                soil_temperature_6cm = snapHourly.soil_temperature_6cm || [];
                dailyOm = snap.dailyOm || null;
                dataUpdatedAt = snap.updatedAtOm ? new Date(snap.updatedAtOm) : null;
            } else {
                const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${user.lat}&longitude=${user.lon}` +
                    `&hourly=temperature_2m,precipitation,precipitation_probability,wind_speed_10m,weather_code,soil_temperature_0cm,soil_temperature_6cm` +
                    `&daily=temperature_2m_mean` +
                    `&timezone=${encodeURIComponent(timezone)}&forecast_days=3&past_days=1`;
                const omRes = await axios.get(omUrl);
                if (!omRes.data || !omRes.data.hourly) {
                    return ctx.reply(lang === 'uk' ? '❌ Помилка отримання даних погоди.' : '❌ Failed to fetch weather data.');
                }
                time = omRes.data.hourly.time;
                temperature_2m = omRes.data.hourly.temperature_2m;
                precipitation = omRes.data.hourly.precipitation;
                precipitation_probability = omRes.data.hourly.precipitation_probability;
                wind_speed_10m = omRes.data.hourly.wind_speed_10m;
                weather_code = omRes.data.hourly.weather_code;
                soil_temperature_0cm = omRes.data.hourly.soil_temperature_0cm || [];
                soil_temperature_6cm = omRes.data.hourly.soil_temperature_6cm || [];
                dailyOm = omRes.data.daily ? {
                    time: omRes.data.daily.time || [],
                    temperature_2m_mean: omRes.data.daily.temperature_2m_mean || []
                } : null;
                dataUpdatedAt = new Date();
            }

            // If snapshot is missing soil/dailyOm, fetch them once for frost check
            if ((!soil_temperature_0cm || soil_temperature_0cm.length === 0 || !dailyOm) && useSnapshot) {
                try {
                    const omFrostUrl = `https://api.open-meteo.com/v1/forecast?latitude=${user.lat}&longitude=${user.lon}` +
                        `&hourly=soil_temperature_0cm,soil_temperature_6cm` +
                        `&daily=temperature_2m_mean` +
                        `&timezone=${encodeURIComponent(timezone)}&forecast_days=3&past_days=1`;
                    const omFrostRes = await axios.get(omFrostUrl);
                    if (omFrostRes.data?.hourly) {
                        if (!soil_temperature_0cm?.length) soil_temperature_0cm = omFrostRes.data.hourly.soil_temperature_0cm || [];
                        if (!soil_temperature_6cm?.length) soil_temperature_6cm = omFrostRes.data.hourly.soil_temperature_6cm || [];
                        time = time?.length ? time : (omFrostRes.data.hourly.time || []);
                    }
                    if (!dailyOm && omFrostRes.data?.daily) {
                        dailyOm = {
                            time: omFrostRes.data.daily.time || [],
                            temperature_2m_mean: omFrostRes.data.daily.temperature_2m_mean || []
                        };
                    }
                } catch (e) {
                    console.error('Frost soil fetch error:', e.message);
                }
            }

            const getWeatherSymbol = (code) => {
                if (code === 0) return '☀️';
                if ([1, 2].includes(code)) return '⛅';
                if (code === 3) return '☁️';
                if ([45, 48].includes(code)) return '🌫';
                if ([51, 53, 55, 56, 57, 61, 63, 65].includes(code)) return '🌧';
                if ([80, 81, 82].includes(code)) return '🌦';
                if ([71, 73, 75, 77, 85, 86].includes(code)) return '❄️';
                if ([95, 96, 99].includes(code)) return '⛈';
                return '🌡';
            };

            const displayCity = user.city || (lang === 'uk' ? 'Ваше місто' : 'Your city');

            const dayIndices = [];
            for (let i = 0; i < time.length; i++) {
                if (String(time[i]).startsWith(targetDateStr)) {
                    dayIndices.push(i);
                }
            }

            if (dayIndices.length === 0) {
                return ctx.reply(lang === 'uk'
                    ? `⚠️ Прогноз на ${shortDate} ще недоступний.`
                    : `⚠️ Forecast for ${shortDate} is not yet available.`);
            }

            const temps = dayIndices.map(i => temperature_2m[i]);
            const precips = dayIndices.map(i => precipitation[i] || 0);
            const minTemp = Math.round(Math.min(...temps));
            const maxTemp = Math.round(Math.max(...temps));
            const totalPrecip = precips.reduce((a, b) => a + b, 0).toFixed(1);

            // Блоки годин з опадами (precip > 0), як у алертах: "04:00–06:00, 10:00–18:00"
            const wetHours = [];
            for (const idx of dayIndices) {
                if ((precipitation[idx] || 0) > 0) {
                    wetHours.push(parseInt(String(time[idx]).slice(11, 13), 10));
                }
            }
            const precipBlocks = [];
            for (const h of wetHours) {
                if (precipBlocks.length && h === precipBlocks[precipBlocks.length - 1][1] + 1) {
                    precipBlocks[precipBlocks.length - 1][1] = h;
                } else {
                    precipBlocks.push([h, h]);
                }
            }
            const fmtHourBlocks = (blocks) => blocks.map(([a, b]) => {
                const from = `${String(a).padStart(2, '0')}:00`;
                // кінець блоку = остання година з дощем (як у прикладі 04:00-06:00)
                const to = `${String(b).padStart(2, '0')}:00`;
                return a === b ? from : `${from}–${to}`;
            }).join(', ');
            const fmtPrecipBlocks = fmtHourBlocks(precipBlocks);

            // «Можливий дощ»: 0.0 мм, але ймовірність > 15% (підрядні години об'єднуються)
            const RAIN_PROB_THRESHOLD = 15;
            const possibleHours = [];
            for (const idx of dayIndices) {
                const mm = precipitation[idx] || 0;
                const pr = precipitation_probability?.[idx] != null
                    ? Number(precipitation_probability[idx])
                    : 0;
                if (mm <= 0 && pr > RAIN_PROB_THRESHOLD) {
                    possibleHours.push(parseInt(String(time[idx]).slice(11, 13), 10));
                }
            }
            const possibleBlocks = [];
            for (const h of possibleHours) {
                if (possibleBlocks.length && h === possibleBlocks[possibleBlocks.length - 1][1] + 1) {
                    possibleBlocks[possibleBlocks.length - 1][1] = h;
                } else {
                    possibleBlocks.push([h, h]);
                }
            }
            const fmtPossibleBlocks = fmtHourBlocks(possibleBlocks);

            const precipUnitStr = lang === 'uk' ? 'мм' : 'mm';
            const isToday = targetDateStr === todayStr;
            const dayRelUk = isToday ? 'сьогодні' : (targetDateStr < todayStr ? 'вчора' : 'завтра');
            const dayRelEn = isToday ? 'today' : (targetDateStr < todayStr ? 'yesterday' : 'tomorrow');

            // Soil frost: min soil_temperature_0cm for the day ≤ 0.5 AND temperature_2m_mean > 0
            let frostPlanned = false;
            let frostMinSoil = null;
            let frostMinHour = null;
            try {
                let dayMin = null;
                let dayMinHour = null;
                for (const i of dayIndices) {
                    const v = soil_temperature_0cm?.[i];
                    if (v == null || Number.isNaN(Number(v))) continue;
                    const n = Number(v);
                    const raw = time?.[i] != null ? String(time[i]) : '';
                    const h = parseInt(raw.slice(11, 13), 10);
                    if (dayMin == null || n < dayMin) {
                        dayMin = n;
                        dayMinHour = Number.isNaN(h) ? null : h;
                    }
                }
                let meanForDay = null;
                if (dailyOm?.time && dailyOm?.temperature_2m_mean) {
                    const dIdx = dailyOm.time.findIndex(t => String(t).startsWith(targetDateStr));
                    if (dIdx >= 0) meanForDay = dailyOm.temperature_2m_mean[dIdx];
                }
                const info = getSoilFrostInfo(dayMin != null ? [dayMin] : [], meanForDay);
                frostPlanned = info.frost;
                frostMinSoil = info.minSoil;
                frostMinHour = dayMinHour;

                // Prefer hour/min saved by evening forecast (same number user was warned about)
                const planned = cityDocForSnap?.eveningState?.plannedFrost;
                if (planned && planned.date === targetDateStr) {
                    if (planned.hour != null) frostMinHour = planned.hour;
                    if (planned.minSoil != null) frostMinSoil = planned.minSoil;
                    // If evening planned frost for this day, treat as planned even if live OM drifted
                    frostPlanned = true;
                }
            } catch (e) {
                console.error('Frost check error in hourly:', e.message);
            }

            // Local hour — to switch "planned" → "occurred" after frost hour has passed
            let localHourNow = 0;
            try {
                const hp = new Intl.DateTimeFormat('en-US', {
                    timeZone: timezone || 'Europe/Kyiv',
                    hour: 'numeric',
                    hour12: false
                }).formatToParts(new Date());
                localHourNow = parseInt(hp.find(p => p.type === 'hour')?.value || '0', 10) % 24;
            } catch { /* keep 0 */ }

            // Rich HTML: use <p>/<br/> — plain \n does not create line breaks in sendRichMessage
            let msg = lang === 'uk'
                ? `<h3>🌤 Погодинний прогноз на ${dayRelUk} (${formattedDate})</h3>` +
                  `<p>📍 <b>${displayCity}</b></p>`
                : `<h3>🌤 Hourly forecast for ${dayRelEn} (${formattedDate})</h3>` +
                  `<p>📍 <b>${displayCity}</b></p>`;

            if (frostPlanned && isFrostSeason(new Date(), timezone || 'Europe/Kyiv')) {
                const frostDone = isToday && frostMinHour != null && localHourNow > frostMinHour;
                const frostLine = frostDone
                    ? frostOccurredText(lang, frostMinSoil, frostMinHour)
                    : frostWarningText(lang, frostMinSoil);
                msg += `<p><b>${frostLine}</b></p>`;
            }

            msg += lang === 'uk'
                ? `<p>🌡 Температура: <b>${minTemp}°C … ${maxTemp}°C</b></p>`
                : `<p>🌡 Temperature: <b>${minTemp}°C … ${maxTemp}°C</b></p>`;

            if (Number(totalPrecip) > 0 && fmtPrecipBlocks) {
                msg += lang === 'uk'
                    ? `<p>💧 Дощитиме: <b>${fmtPrecipBlocks}</b><br/>Загалом опадів на день: <b>${totalPrecip} ${precipUnitStr}</b></p>`
                    : `<p>💧 Rain: <b>${fmtPrecipBlocks}</b><br/>Total precip for the day: <b>${totalPrecip} ${precipUnitStr}</b></p>`;
            } else {
                msg += lang === 'uk'
                    ? `<p>💧 Опадів не очікується</p>`
                    : `<p>💧 No precipitation expected</p>`;
            }

            if (fmtPossibleBlocks) {
                msg += lang === 'uk'
                    ? `<p>👀 Можливий дощ: <b>${fmtPossibleBlocks}</b></p>`
                    : `<p>👀 Possible rain: <b>${fmtPossibleBlocks}</b></p>`;
            }

            const windUnit = user.units?.wind || 'ms';
            const windUnitStr = windUnit === 'kmh' ? (lang === 'uk' ? 'км/г' : 'km/h') : (lang === 'uk' ? 'м/с' : 'm/s');

            // Native Rich Message table (Bot API 10.1+ / grammY sendRichMessage)
            const fmtSoilCell = (v) => {
                if (v == null || Number.isNaN(Number(v))) return '—';
                return Number(v).toFixed(1);
            };

            const th = (text) => `<th align="center">${text}</th>`;
            const td = (text, align = 'center') => `<td align="${align}">${text}</td>`;

            let tableHtml = `<table bordered striped compact>\n<tr>`;
            tableHtml += th(lang === 'uk' ? 'Час' : 'Time');
            tableHtml += th(lang === 'uk' ? 'Ст' : 'Cd');
            tableHtml += th(lang === 'uk' ? 'Темп' : 'Temp');
            tableHtml += th('0cm');
            tableHtml += th('6cm');
            tableHtml += th(lang === 'uk' ? 'Опади' : 'Prec');
            tableHtml += th('%');
            tableHtml += th(lang === 'uk' ? 'Вітер' : 'Wind');
            tableHtml += `</tr>\n`;

            for (const idx of dayIndices) {
                const hStr = `${String(time[idx]).slice(11, 13)}:00`;
                const icon = getWeatherSymbol(weather_code?.[idx]);
                const tVal = `${Math.round(temperature_2m[idx])}°`;
                const s0 = fmtSoilCell(soil_temperature_0cm?.[idx]);
                const s6 = fmtSoilCell(soil_temperature_6cm?.[idx]);
                const pVal = (precipitation[idx] || 0) > 0
                    ? Number(precipitation[idx]).toFixed(1)
                    : '0';
                const prob = precipitation_probability?.[idx] != null
                    ? String(Math.round(precipitation_probability[idx]))
                    : '—';
                const wSpd = windUnit === 'kmh'
                    ? Math.round((wind_speed_10m[idx] || 0) * 3.6)
                    : Math.round(wind_speed_10m[idx] || 0);
                const wStr = `${wSpd}${windUnitStr}`;

                tableHtml += `<tr>`;
                tableHtml += td(hStr);
                tableHtml += td(icon);
                tableHtml += td(tVal);
                tableHtml += td(s0);
                tableHtml += td(s6);
                tableHtml += td(pVal);
                tableHtml += td(prob);
                tableHtml += td(wStr);
                tableHtml += `</tr>\n`;
            }
            tableHtml += `</table>`;

            msg += tableHtml;

            // Collapsible legend with proper list markup
            const asOfStr = formatLocalDateTime(dataUpdatedAt, timezone, lang);
            const sourceLine = lang === 'uk'
                ? (asOfStr
                    ? `ℹ️ Джерело: Open-Meteo, оновлено ${asOfStr}.`
                    : `ℹ️ Джерело: Open-Meteo.`)
                : (asOfStr
                    ? `ℹ️ Source: Open-Meteo, updated ${asOfStr}.`
                    : `ℹ️ Source: Open-Meteo.`);

            const legendList = lang === 'uk'
                ? `<ul>` +
                  `<li><b>Час</b> — година доби</li>` +
                  `<li><b>Ст</b> — стан погоди (іконка)</li>` +
                  `<li><b>Темп</b> — температура повітря на висоті 2 м</li>` +
                  `<li><b>0cm</b> — температура ґрунту на поверхні (0 см)</li>` +
                  `<li><b>6cm</b> — температура ґрунту на глибині 6 см</li>` +
                  `<li><b>Опади</b> — кількість опадів, мм</li>` +
                  `<li><b>%</b> — ймовірність опадів</li>` +
                  `<li><b>Вітер</b> — швидкість вітру</li>` +
                  `</ul>`
                : `<ul>` +
                  `<li><b>Time</b> — hour of day</li>` +
                  `<li><b>Cd</b> — weather condition (icon)</li>` +
                  `<li><b>Temp</b> — air temperature at 2 m</li>` +
                  `<li><b>0cm</b> — soil temperature at the surface (0 cm)</li>` +
                  `<li><b>6cm</b> — soil temperature at 6 cm depth</li>` +
                  `<li><b>Prec</b> — precipitation amount, mm</li>` +
                  `<li><b>%</b> — precipitation probability</li>` +
                  `<li><b>Wind</b> — wind speed</li>` +
                  `</ul>`;

            // Source always visible; only the column legend is collapsible
            msg += `<footer>${sourceLine}</footer>`;
            msg += `<details>` +
                `<summary>${lang === 'uk' ? '📖 Легенда заголовків' : '📖 Column legend'}</summary>` +
                legendList +
                `</details>`;

            // Day nav: yesterday / today / tomorrow (dates), hide open day — one row
            const addDaysYmd = (ymd, days) => {
                const [y, m, d] = ymd.split('-').map(Number);
                const dt = new Date(Date.UTC(y, m - 1, d + days));
                return dt.toISOString().slice(0, 10);
            };
            const shortFromYmd = (ymd) => {
                const [, m, d] = ymd.split('-');
                return `${d}.${m}`;
            };
            const navRow = [-1, 0, 1]
                .map((off) => addDaysYmd(todayStr, off))
                .filter((ymd) => ymd !== targetDateStr)
                .map((ymd) => ({ text: shortFromYmd(ymd), callback_data: `forecast_hourly|${ymd}` }));
            navRow.push({ text: 'Tomorrow.io', callback_data: `forecast_verify|${targetDateStr}` });

            // sendRichMessage: native table via rich_message.html (Bot API 10.1+)
            await ctx.api.sendRichMessage(ctx.chat.id, {
                html: msg,
                skip_entity_detection: true
            }, {
                reply_markup: {
                    inline_keyboard: [navRow]
                }
            });
        } catch (error) {
            console.error('Hourly forecast error:', error);
            await ctx.reply(`❌ <b>Error:</b>\n<code>${error.message}</code>`, { parse_mode: 'HTML' }).catch(() => { });
        }
    }

    
    // --- Verify hourly forecast via Tomorrow.io (cached by cron-check) ---
    else if (data[0] === 'forecast_verify') {
        try {
            await ctx.answerCallbackQuery().catch(() => { });
            await connectDB();

            const user = await User.findOne({ telegramId: ctx.from.id });
            if (!user || !user.lat || !user.lon) {
                return ctx.reply(lang === 'uk' ? '❌ Помилка: дані користувача не знайдені' : '❌ Error: user data not found');
            }

            const timezone = user.timezone || 'Europe/Kyiv';
            const todayStr = new Intl.DateTimeFormat('en-CA', {
                timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
            }).format(new Date());
            const localNow = new Date();

            let targetDateStr = data[1] && /^\d{4}-\d{2}-\d{2}$/.test(data[1]) ? data[1] : todayStr;

            const cityKey = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
            let cityDoc = await City.findOne({ externalId: cityKey });
            let hours = cityDoc?.eveningState?.hourlyTmr || [];
            let tmrUpdated = cityDoc?.eveningState?.hourlyTmrUpdatedAt || null;

            // Refresh if empty, stale, today misses morning, or target day incomplete (e.g. only 23:00 of yesterday)
            const ageMin = tmrUpdated ? (Date.now() - new Date(tmrUpdated).getTime()) / 60000 : 999;
            const todayCached = (hours || []).filter(h => (h.timeLocal || '').startsWith(todayStr));
            const minCachedHour = todayCached.length
                ? Math.min(...todayCached.map(h => {
                    const hr = h.hour != null ? h.hour : parseInt(String(h.timeLocal || '').slice(11, 13), 10);
                    return Number.isNaN(hr) ? 99 : hr;
                }))
                : 99;
            const missingMorning = targetDateStr === todayStr && minCachedHour > 0;
            const targetCached = (hours || []).filter(h => (h.timeLocal || '').startsWith(targetDateStr));
            const incompleteTarget = targetCached.length > 0 && targetCached.length < 20;
            const needRefresh = !hours.length || ageMin > 90 || missingMorning || incompleteTarget;
            if (needRefresh && process.env.TOMORROW_IO_KEY) {
                try {
                    const { fetchTomorrowHourly } = require('../utils/tomorrow');
                    const { hours: fresh, fetchedAt } = await fetchTomorrowHourly(
                        user.lat, user.lon, timezone, { endTime: 'nowPlus48h' }
                    );
                    if (fresh.length) {
                        hours = fresh.map(h => ({
                            timeLocal: h.timeLocal,
                            temperature: h.temperature,
                            precip: h.precip,
                            precipProb: h.precipProb,
                            windMs: h.windMs,
                            weatherCode: h.weatherCode
                        }));
                        tmrUpdated = fetchedAt;
                        await City.findOneAndUpdate(
                            { externalId: cityKey },
                            {
                                $set: {
                                    'eveningState.hourlyTmr': hours,
                                    'eveningState.hourlyTmrUpdatedAt': fetchedAt
                                }
                            },
                            { upsert: true }
                        );
                    }
                } catch (e) {
                    const status = e.response?.status;
                    console.error('forecast_verify live fetch:', status || '', e.message);
                    // 403 = plan/limit (e.g. historical range); keep existing cache
                }
            }

            const dayHours = (hours || []).filter(h => {
                const d = (h.timeLocal || '').slice(0, 10);
                return d === targetDateStr;
            }).sort((a, b) => (a.timeLocal || '').localeCompare(b.timeLocal || ''));

            const targetDate = new Date(targetDateStr + 'T12:00:00');
            const shortDate = targetDate.toLocaleDateString(lang === 'uk' ? 'uk-UA' : 'en-US', {
                day: '2-digit', month: '2-digit'
            });
            const isToday = targetDateStr === todayStr;
            const dayRelUk = isToday ? 'сьогодні' : (targetDateStr < todayStr ? 'вчора' : 'завтра');
            const dayRelEn = isToday ? 'today' : (targetDateStr < todayStr ? 'yesterday' : 'tomorrow');

            if (!dayHours.length) {
                return ctx.reply(lang === 'uk'
                    ? `⚠️ Немає даних Tomorrow.io на ${shortDate}. Спробуйте пізніше.`
                    : `⚠️ No Tomorrow.io data for ${shortDate}. Try again later.`);
            }

            const { tioWeatherEmoji, summarizeDayHours } = require('../utils/tomorrow');
            const daySum = summarizeDayHours(dayHours);
            const windUnit = user.units?.wind || 'ms';
            const tempUnit = user.units?.temp || 'c';
            const windUnitStr = windUnit === 'kmh'
                ? (lang === 'uk' ? 'км/г' : 'km/h')
                : (lang === 'uk' ? 'м/с' : 'm/s');
            const precipUnitStr = lang === 'uk' ? 'мм' : 'mm';
            const displayCity = user.city || (lang === 'uk' ? 'Ваше місто' : 'Your city');
            const formattedDate = targetDate.toLocaleDateString(lang === 'uk' ? 'uk-UA' : 'en-US', {
                weekday: 'short', day: 'numeric', month: 'short'
            });

            const toTemp = (c) => {
                if (c == null) return '—';
                const v = tempUnit === 'f' ? (c * 9 / 5 + 32) : c;
                return `${Math.round(v)}°`;
            };
            // Units only in table cells — not in footer
            const toWind = (ms) => {
                if (ms == null) return '—';
                const v = windUnit === 'kmh' ? Math.round(ms * 3.6) : Math.round(ms * 10) / 10;
                return `${v}${windUnitStr}`;
            };

            // Header mirrors Open-Meteo hourly layout + «від Tomorrow.io»
            let msg = lang === 'uk'
                ? `<h3>🌤 Погодинний прогноз на ${dayRelUk} (${formattedDate}) від Tomorrow.io</h3>` +
                  `<p>📍 <b>${displayCity}</b></p>`
                : `<h3>🌤 Hourly forecast for ${dayRelEn} (${formattedDate}) from Tomorrow.io</h3>` +
                  `<p>📍 <b>${displayCity}</b></p>`;

            const tMin = daySum.minTemp != null ? Math.round(daySum.minTemp) : '—';
            const tMax = daySum.maxTemp != null ? Math.round(daySum.maxTemp) : '—';
            const sumMm = Number(daySum.totalPrecip || 0).toFixed(1);

            msg += lang === 'uk'
                ? `<p>🌡 Температура: <b>${tMin}°C … ${tMax}°C</b></p>`
                : `<p>🌡 Temperature: <b>${tMin}°C … ${tMax}°C</b></p>`;

            if (Number(daySum.totalPrecip) > 0 && daySum.precipBlocks) {
                msg += lang === 'uk'
                    ? `<p>💧 Дощитиме: <b>${daySum.precipBlocks}</b><br/>Загалом опадів на день: <b>${sumMm} ${precipUnitStr}</b></p>`
                    : `<p>💧 Rain: <b>${daySum.precipBlocks}</b><br/>Total precip for the day: <b>${sumMm} ${precipUnitStr}</b></p>`;
            } else {
                msg += lang === 'uk'
                    ? `<p>💧 Опадів не очікується</p>`
                    : `<p>💧 No precipitation expected</p>`;
            }

            if (daySum.possibleBlocks) {
                msg += lang === 'uk'
                    ? `<p>👀 Можливий дощ: <b>${daySum.possibleBlocks}</b></p>`
                    : `<p>👀 Possible rain: <b>${daySum.possibleBlocks}</b></p>`;
            }

            msg += `<table bordered striped compact>` +
                `<tr>` +
                `<th>${lang === 'uk' ? 'Час' : 'Time'}</th>` +
                `<th>${lang === 'uk' ? 'Ст' : 'Cd'}</th>` +
                `<th>${lang === 'uk' ? 'Темп' : 'Temp'}</th>` +
                `<th>${lang === 'uk' ? 'Опади' : 'Prec'}</th>` +
                `<th>%</th>` +
                `<th>${lang === 'uk' ? 'Вітер' : 'Wind'}</th>` +
                `</tr>`;

            for (const h of dayHours) {
                const hh = (h.timeLocal || '').slice(11, 13) || String(h.hour ?? '').padStart(2, '0');
                const emoji = tioWeatherEmoji(h.weatherCode);
                const temp = toTemp(h.temperature);
                const prec = h.precip != null ? Number(h.precip).toFixed(1) : '0.0';
                const prob = h.precipProb != null ? String(Math.round(h.precipProb)) : '—';
                const wind = toWind(h.windMs);
                msg += `<tr>` +
                    `<td>${hh}:00</td>` +
                    `<td>${emoji}</td>` +
                    `<td>${temp}</td>` +
                    `<td>${prec}</td>` +
                    `<td>${prob}</td>` +
                    `<td>${wind}</td>` +
                    `</tr>`;
            }
            msg += `</table>`;

            const asOfStr = tmrUpdated
                ? new Date(tmrUpdated).toLocaleString(lang === 'uk' ? 'uk-UA' : 'en-US', {
                    timeZone: timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
                })
                : '—';

            const sourceLine = lang === 'uk'
                ? `📡 Джерело: <b>Tomorrow.io</b> · оновлено ${asOfStr}`
                : `📡 Source: <b>Tomorrow.io</b> · updated ${asOfStr}`;

            const legendList = lang === 'uk'
                ? `<ul>` +
                  `<li><b>Час</b> — година доби</li>` +
                  `<li><b>Ст</b> — стан погоди (іконка)</li>` +
                  `<li><b>Темп</b> — температура повітря на висоті 2 м</li>` +
                  `<li><b>Опади</b> — кількість опадів, мм</li>` +
                  `<li><b>%</b> — ймовірність опадів</li>` +
                  `<li><b>Вітер</b> — швидкість вітру</li>` +
                  `</ul>`
                : `<ul>` +
                  `<li><b>Time</b> — hour of day</li>` +
                  `<li><b>Cd</b> — weather condition (icon)</li>` +
                  `<li><b>Temp</b> — air temperature at 2 m</li>` +
                  `<li><b>Prec</b> — precipitation amount, mm</li>` +
                  `<li><b>%</b> — precipitation probability</li>` +
                  `<li><b>Wind</b> — wind speed</li>` +
                  `</ul>`;

            msg += `<footer>${sourceLine}</footer>`;
            msg += `<details>` +
                `<summary>${lang === 'uk' ? '📖 Легенда заголовків' : '📖 Column legend'}</summary>` +
                legendList +
                `</details>`;

            // Day nav: yesterday / today / tomorrow (dates), hide open day — one row
            const addDaysYmd = (ymd, days) => {
                const [y, m, d] = ymd.split('-').map(Number);
                const dt = new Date(Date.UTC(y, m - 1, d + days));
                return dt.toISOString().slice(0, 10);
            };
            const shortFromYmd = (ymd) => {
                const [, m, d] = ymd.split('-');
                return `${d}.${m}`;
            };
            const navRow = [-1, 0, 1]
                .map((off) => addDaysYmd(todayStr, off))
                .filter((ymd) => ymd !== targetDateStr)
                .map((ymd) => ({ text: shortFromYmd(ymd), callback_data: `forecast_verify|${ymd}` }));
            navRow.push({ text: '🌤 Open-Meteo', callback_data: `forecast_hourly|${targetDateStr}` });

            await ctx.api.sendRichMessage(ctx.chat.id, {
                html: msg,
                skip_entity_detection: true
            }, {
                reply_markup: {
                    inline_keyboard: [navRow]
                }
            });
        } catch (error) {
            console.error('forecast_verify error:', error);
            await ctx.reply(`❌ <b>Error:</b>\n<code>${error.message}</code>`, { parse_mode: 'HTML' }).catch(() => { });
        }
    }


    // --- Agro recommendations callback ---
    else if (data[0] === 'agro_tomorrow') {
        try {
            await ctx.answerCallbackQuery().catch(() => { });
            await connectDB();

            const user = await User.findOne({ telegramId: ctx.from.id });
            if (!user || !user.lat || !user.lon) {
                return ctx.reply(lang === 'uk' ? '❌ Помилка: дані користувача не знайдені' : '❌ Error: user data not found');
            }

            const cityKey = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
            const cityDoc = await City.findOne({ externalId: cityKey });

            if (!cityDoc || !cityDoc.eveningState?.forecast?.[1]) {
                return ctx.reply(lang === 'uk'
                    ? '⚠️ Дані ще не оновлені. Зачекайте вечірнього прогнозу (зазвичай після 18:00).'
                    : '⚠️ Data not yet updated. Wait for the evening forecast (usually after 18:00).');
            }

            const tomorrowForecast = cityDoc.eveningState.forecast[1];

            // --- ON-DEMAND FETCH ---
            // Check if we have at least 7 days of history for risks calculation
            await fetchMissingHistory(cityDoc, 7);

        let extraMetrics = null;

            // Fetch last 7 days of history for this city
            const history = await History.find({
                externalId: cityKey
            }).sort({ date: -1 }).limit(7).lean();

            const risks = analyzeAgroRisks(tomorrowForecast, history, user.crops || []);
            const displayCity = (user.city && user.city !== '..') ? user.city : (cityDoc?.name || '..');
            const report = formatAgroReport(displayCity, risks, lang, tomorrowForecast.valid_date || tomorrowForecast.datetime, extraMetrics);

            await ctx.reply(report, { parse_mode: 'HTML' });
        } catch (error) {
            console.error('Agro report error:', error);
            await ctx.reply(`❌ <b>Error:</b>\n<code>${error.message}</code>`, { parse_mode: 'HTML' }).catch(() => { });
        }
    }

    // --- Crops main categories callback ---
    else if (data[0] === 'crops_main') {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(dict[lang].cropsSelectCat, {
            reply_markup: buildCropsCategoriesKeyboard(lang)
        });
    }

    // --- Crops category selection callback ---
    else if (data[0] === 'crops_cat') {
        const categoryKey = data[1];
        const user = await User.findOne({ telegramId: ctx.from.id });
        const label = CROPS_DATA[categoryKey].label[lang];

        await ctx.answerCallbackQuery();
        await ctx.editMessageText(dict[lang].cropsSelectItem.replace('{cat}', label), {
            reply_markup: buildCropsItemsKeyboard(lang, categoryKey, user?.crops || [])
        });
    }

    // --- Crops toggle callback ---
    else if (data[0] === 'crops_toggle') {
        const [_, categoryKey, plantId] = data;
        try {
            await connectDB();
            const user = await User.findOne({ telegramId: ctx.from.id });
            if (!user) return ctx.answerCallbackQuery('❌ Error');

            const hasCrop = user.crops.includes(plantId);
            const update = hasCrop
                ? { $pull: { crops: plantId } }
                : { $addToSet: { crops: plantId } };

            const updatedUser = await User.findOneAndUpdate(
                { telegramId: ctx.from.id },
                update,
                { new: true }
            );

            await ctx.answerCallbackQuery(hasCrop ? '❌ Видалено' : '✅ Додано');

            // Update the sub-items keyboard to reflect the change
            const label = CROPS_DATA[categoryKey].label[lang];
            await ctx.editMessageReplyMarkup({ reply_markup: buildCropsItemsKeyboard(lang, categoryKey, updatedUser.crops) });
        } catch (error) {
            await ctx.answerCallbackQuery('❌ Error');
        }
    }

    // --- Agro schedule only callback ---
    else if (data[0] === 'agro_schedule_only') {
        try {
            await ctx.answerCallbackQuery();
            await connectDB();
            const user = await User.findOne({ telegramId: ctx.from.id });
            const cityKey = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
            const cityData = await City.findOne({ externalId: cityKey });

            if (!cityData || !cityData.eveningState?.forecast) {
                return ctx.reply(lang === 'uk' ? '⚠️ Дані ще не готові.' : '⚠️ Data not ready.');
            }

            const history = await History.find({ externalId: cityKey }).sort({ date: -1 }).limit(7).lean();
            const report = analyzeSprayingWindow(cityData.eveningState.forecast, history, lang, user.crops || []);
            await ctx.reply(report, { parse_mode: 'HTML' });
        } catch (e) {
            console.error('Agro schedule error:', e);
        }
    }

    // --- Agro 5-day forecast callback ---
    else if (data[0] === 'agro_5day') {
        try {
            await ctx.answerCallbackQuery();
            await connectDB();
            const user = await User.findOne({ telegramId: ctx.from.id });
            const cityKey = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
            const cityData = await City.findOne({ externalId: cityKey });

            if (!cityData || !cityData.eveningState?.forecast) {
                return ctx.reply(lang === 'uk' ? '⚠️ Дані ще не готові.' : '⚠️ Data not ready.');
            }

            const report = await generateAgroForecastReport(cityData.eveningState.forecast.slice(0, 7), lang, user.crops || [], cityKey);
            await ctx.reply(report, { parse_mode: 'HTML' });
        } catch (e) {
            console.error('Agro 5-day error:', e);
            await ctx.reply(`❌ Error: ${e.message}`);
        }
    }

    // --- Help topic callback (Rich Message, edit in place) ---
    else if (data[0] === 'help') {
        const topic = data[1];
        const html = dict[lang][`help_${topic}_desc`];
        if (!html) {
            await ctx.answerCallbackQuery({ text: '❌' }).catch(() => { });
            return;
        }

        try {
            await ctx.answerCallbackQuery().catch(() => { });
            // editMessageText + rich_message: updates the same message (Bot API 10.1+)
            await ctx.api.raw.editMessageText({
                chat_id: ctx.chat.id,
                message_id: ctx.callbackQuery.message.message_id,
                rich_message: {
                    html,
                    skip_entity_detection: true
                },
                reply_markup: buildHelpKeyboard(lang, topic)
            });
        } catch (e) {
            // Same topic twice → "message is not modified"
            if (e.message && e.message.includes('message is not modified')) {
                return;
            }
            console.error('Help Rich Edit Error:', e.message);
            // Fallback: send new rich message if edit fails (e.g. old plain message edge case)
            try {
                await ctx.api.sendRichMessage(ctx.chat.id, {
                    html,
                    skip_entity_detection: true
                }, {
                    reply_markup: buildHelpKeyboard(lang, topic)
                });
            } catch (e2) {
                console.error('Help fallback error:', e2.message);
            }
        }
    }

    // --- Alert settings screen callback ---
    else if (data[0] === 'alert_settings') {
        // Answer immediately — Telegram callback queries expire in a few seconds;
        // DB/cold-start latency on Vercel otherwise causes "query is too old".
        await ctx.answerCallbackQuery().catch(() => { });

        try {
            await connectDB();
            let user = await User.findOne({ telegramId: ctx.from.id });
            if (!user) return;

            // Lazy migrate geomagMode from legacy magneticStorm flag
            let mode = resolveGeomagMode(user);
            if (user.geomagMode !== mode) {
                user = await User.findOneAndUpdate(
                    { telegramId: ctx.from.id },
                    { $set: { geomagMode: mode, 'alertTriggers.magneticStorm': mode !== 'off' } },
                    { new: true }
                );
            }

            const html = `<h1>${dict[lang].alertSettingsTitle}</h1>\n${dict[lang].alertSettingsDesc}`;
            const markup = buildAlertTriggersKeyboard(lang, user.alertTriggers, mode);

            // From an alert message: always send a NEW message so the alert stays in history.
            // Explicit flag from cron (alert_settings|new), or detect by message content /
            // inline keyboard (covers alerts already sent before deploy, and rich messages
            // where message.text is empty). From settings menus: edit in place.
            const msgText = ctx.callbackQuery.message?.text || ctx.callbackQuery.message?.caption || '';
            const looksLikeSettingsMenu =
                msgText.includes('Сповіщення про зміни') ||
                msgText.includes('Change Alerts') ||
                msgText.includes('Налаштування') ||
                msgText.includes('Settings') ||
                msgText.includes('Вечірній прогноз') ||
                msgText.includes('Evening forecast');
            // Keyboard coming from an alert (forecast / geomag / settings|new)
            const kb = ctx.callbackQuery.message?.reply_markup?.inline_keyboard || [];
            const flatCb = kb.flat().map(b => b?.callback_data || '').join(' ');
            const looksLikeAlertKeyboard =
                flatCb.includes('forecast_hourly') ||
                flatCb.includes('geomag_fc') ||
                flatCb.includes('alert_settings|new');
            const openAsNew = data[1] === 'new' || looksLikeAlertKeyboard || !looksLikeSettingsMenu;

            if (openAsNew) {
                try {
                    await ctx.api.sendRichMessage(ctx.chat.id, {
                        html,
                        skip_entity_detection: true
                    }, { reply_markup: markup });
                } catch (e2) {
                    console.error('Alert settings new-message error:', e2.message);
                    await ctx.reply(
                        `${dict[lang].alertSettingsTitle}\n${dict[lang].alertSettingsDesc}`,
                        { parse_mode: 'Markdown', reply_markup: markup }
                    ).catch(() => {});
                }
            } else {
                try {
                    // Same rich-message path as Help — supports <h1>/<h2>/<ul>/<li>/<p>
                    await ctx.api.raw.editMessageText({
                        chat_id: ctx.chat.id,
                        message_id: ctx.callbackQuery.message.message_id,
                        rich_message: {
                            html,
                            skip_entity_detection: true
                        },
                        reply_markup: markup
                    });
                } catch (e) {
                    if (e.message && e.message.includes('message is not modified')) return;
                    console.error('Alert settings rich edit error:', e.message);
                    try {
                        await ctx.api.sendRichMessage(ctx.chat.id, {
                            html,
                            skip_entity_detection: true
                        }, { reply_markup: markup });
                    } catch (e2) {
                        console.error('Alert settings fallback error:', e2.message);
                    }
                }
            }
        } catch (err) {
            console.error('Alert settings handler error:', err.message);
        }
    }

    // --- Alert triggers toggle callback ---
    else if (data[0] === 'alert' && data[1] === 'toggle') {
        const key = data[2];
        try {
            await connectDB();
            const user = await User.findOne({ telegramId: ctx.from.id });
            if (!user) {
                await ctx.answerCallbackQuery('❌ Error').catch(() => {});
                return;
            }

            const currentTriggers = user.alertTriggers || {};
            const currentValue = currentTriggers[key] !== false;
            const newValue = !currentValue;

            const updatedUser = await User.findOneAndUpdate(
                { telegramId: ctx.from.id },
                { $set: { [`alertTriggers.${key}`]: newValue } },
                { new: true }
            );

            await ctx.answerCallbackQuery(dict[lang].settingsSaved).catch(() => {});
            await ctx.editMessageReplyMarkup({ reply_markup: buildAlertTriggersKeyboard(lang, updatedUser.alertTriggers, resolveGeomagMode(updatedUser)) });
        } catch (error) {
            await ctx.answerCallbackQuery('❌ Error').catch(() => {});
        }
    }

    // --- Master toggle for all change alerts ---
    else if (data[0] === 'alert' && data[1] === 'toggle_all') {
        const targetState = data[2] === 'on';
        try {
            await connectDB();
            const updatedUser = await User.findOneAndUpdate(
                { telegramId: ctx.from.id },
                {
                    $set: {
                        'alertTriggers.temperature': targetState,
                        'alertTriggers.precip': targetState,
                        'alertTriggers.magneticStorm': targetState,
                        'alertTriggers.airQuality': targetState,
                        geomagMode: targetState ? 'quiet' : 'off'
                    }
                },
                { new: true }
            );
            await ctx.answerCallbackQuery(dict[lang].settingsSaved).catch(() => {});
            await ctx.editMessageReplyMarkup({ reply_markup: buildAlertTriggersKeyboard(lang, updatedUser.alertTriggers, resolveGeomagMode(updatedUser)) });
        } catch (error) {
            await ctx.answerCallbackQuery('❌ Error').catch(() => {});
        }
    }


    // --- Geomag mode: active | quiet | off ---
    else if (data[0] === 'geomag_mode') {
        const mode = data[1];
        if (!['active', 'quiet', 'off'].includes(mode)) {
            return ctx.answerCallbackQuery('❌').catch(() => {});
        }
        try {
            await connectDB();
            const updatedUser = await User.findOneAndUpdate(
                { telegramId: ctx.from.id },
                {
                    $set: {
                        geomagMode: mode,
                        'alertTriggers.magneticStorm': mode !== 'off'
                    }
                },
                { new: true }
            );
            await ctx.answerCallbackQuery(dict[lang].settingsSaved).catch(() => {});
            await ctx.editMessageReplyMarkup({
                reply_markup: buildAlertTriggersKeyboard(lang, updatedUser.alertTriggers, mode)
            });
        } catch (e) {
            await ctx.answerCallbackQuery('❌ Error').catch(() => {});
        }
    }

    // --- Geomag forecast table (from alert button) — rich HTML ---
    else if (data[0] === 'geomag_fc') {
        try {
            await ctx.answerCallbackQuery().catch(() => {});
            await connectDB();
            const user = await User.findOne({ telegramId: ctx.from.id });
            const userLang = user?.language || lang || 'uk';
            const tz = user?.timezone || 'Europe/Kyiv';
            const isUk = userLang === 'uk';

            // 3h forecast/history + 1-min live Kp (for the in-progress bin)
            const [noaaRes, liveRes] = await Promise.all([
                axios.get(
                    'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
                    { timeout: 10000 }
                ),
                axios.get(
                    'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',
                    { timeout: 10000 }
                ).catch(() => null)
            ]);
            const rows = Array.isArray(noaaRes.data) ? noaaRes.data : [];
            if (!rows.length) {
                return ctx.reply(dict[userLang].geomagForecastEmpty);
            }
            const liveRows = (liveRes && Array.isArray(liveRes.data)) ? liveRes.data : [];

            // Local YYYY-MM-DD
            const fmtLocal = (d) => {
                try {
                    return new Intl.DateTimeFormat('en-CA', {
                        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
                    }).format(d);
                } catch {
                    return d.toISOString().slice(0, 10);
                }
            };

            const parseNoaaTime = (timeTag) => {
                if (!timeTag) return null;
                const s = String(timeTag).trim();
                const normalized = s.includes('T') ? s : s.replace(' ', 'T');
                const withZ = /[zZ]$/.test(normalized) || /[+-]\d{2}:?\d{2}$/.test(normalized)
                    ? normalized
                    : normalized + 'Z';
                const t = new Date(withZ);
                return isNaN(t.getTime()) ? null : t;
            };

            // Build day keys: today + next 2 days
            const now = new Date();
            const dayKeys = [0, 1, 2].map(offset => {
                const d = new Date(now.getTime() + offset * 86400000);
                return fmtLocal(d);
            });

            // Short weekday labels (uk / en) — dateStr is already local YYYY-MM-DD
            const weekdayShort = (dateStr) => {
                // Treat as noon UTC so formatting with target tz still lands on the same calendar day
                const d = new Date(dateStr + 'T12:00:00Z');
                try {
                    const parts = new Intl.DateTimeFormat(isUk ? 'uk-UA' : 'en-US', {
                        timeZone: tz,
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short'
                    }).formatToParts(d);
                    const wd = parts.find(p => p.type === 'weekday')?.value || '';
                    const day = parts.find(p => p.type === 'day')?.value || '';
                    const mon = parts.find(p => p.type === 'month')?.value || '';
                    // e.g. "Нд, 11 жов" or "Sun, 11 Oct"
                    return `${wd}, ${day} ${mon}`;
                } catch {
                    return dateStr.slice(5);
                }
            };

            // Collect slots: { dateStr -> { hour -> { kp, level, observed } } }
            // Rules for "honest" table:
            // - observed  → official closed 3h Kp
            // - current bin still estimated → replace with max 1-min Kp in that window (live)
            // - future estimated/predicted → keep as forecast (not "now")
            const slots = {};
            for (const key of dayKeys) slots[key] = {};
            const nowMs = now.getTime();

            const liveKpInWindow = (startMs, endMs) => {
                if (!liveRows.length) return null;
                let maxK = null;
                let lastK = null;
                for (const lr of liveRows) {
                    const lt = parseNoaaTime(lr.time_tag);
                    if (!lt) continue;
                    const ms = lt.getTime();
                    if (ms < startMs || ms >= endMs) continue;
                    const v = parseFloat(
                        lr.estimated_kp != null ? lr.estimated_kp
                            : (lr.kp_index != null ? lr.kp_index : lr.kp)
                    );
                    if (isNaN(v)) continue;
                    lastK = v;
                    if (maxK == null || v > maxK) maxK = v;
                }
                // Prefer peak in the open window; fallback to latest sample
                return maxK != null ? maxK : lastK;
            };

            for (const r of rows) {
                const t = parseNoaaTime(r.time_tag);
                if (!t) continue;
                const localDate = fmtLocal(t);
                if (!slots[localDate]) continue;

                let hour;
                try {
                    hour = parseInt(new Intl.DateTimeFormat('en-US', {
                        timeZone: tz, hour: 'numeric', hour12: false
                    }).format(t), 10);
                } catch {
                    hour = t.getUTCHours();
                }
                const bin = Math.floor(hour / 3) * 3;
                if (![0, 3, 6, 9, 12, 15, 18, 21].includes(bin)) continue;

                let kp = parseFloat(r.kp != null ? r.kp : r.Kp);
                if (isNaN(kp)) continue;
                let obsFlag = r.observed || '';

                const tMs = t.getTime();
                const inProgress = tMs <= nowMs && nowMs < tMs + 3 * 3600 * 1000;
                // Don't scare with inflated 3h "estimated" while the bin is still open
                if (inProgress && obsFlag !== 'observed') {
                    const liveK = liveKpInWindow(tMs, tMs + 3 * 3600 * 1000);
                    if (liveK != null && !isNaN(liveK)) {
                        kp = liveK;
                        obsFlag = 'live';
                    }
                }

                const level = getGeomagLevel(Math.round(kp));
                slots[localDate][bin] = {
                    kp,
                    kpRounded: level ? level.kpRounded : Math.round(kp),
                    level,
                    observed: obsFlag
                };
            }

            // Cell formatter: badge + bold Kp if elevated
            const cellHtml = (slot) => {
                if (!slot || !slot.level) return '—';
                const { badge, kpRounded, rank } = slot.level;
                if (rank >= 2) return `${badge} <b>${kpRounded}</b>`;
                if (rank === 1) return `${badge} <b>${kpRounded}</b>`;
                return `${badge} ${kpRounded}`;
            };

            // Build summary (ГОЛОВНЕ)
            const daySummary = (dateStr, label) => {
                const daySlots = slots[dateStr] || {};
                const entries = Object.entries(daySlots)
                    .map(([h, s]) => ({ hour: +h, ...s }))
                    .filter(e => e.level)
                    .sort((a, b) => a.hour - b.hour);
                if (!entries.length) return null;

                const maxEntry = entries.reduce((best, e) =>
                    (e.level.rank > (best?.level?.rank ?? -1) ||
                     (e.level.rank === (best?.level?.rank ?? -1) && e.kpRounded > (best?.kpRounded ?? -1)))
                        ? e : best, null);

                if (!maxEntry || maxEntry.level.rank === 0) {
                    return isUk
                        ? `• <b>${label}:</b> Спокійно (Kp ≤ 3)`
                        : `• <b>${label}:</b> Calm (Kp ≤ 3)`;
                }

                const timeStr = `${String(maxEntry.hour).padStart(2, '0')}:00`;
                const lvl = maxEntry.level;
                const h = maxEntry.hour;

                // Human-friendly period
                let periodUk = '';
                let periodEn = '';
                if (h >= 0 && h < 6) { periodUk = 'вночі'; periodEn = 'at night'; }
                else if (h >= 6 && h < 12) { periodUk = 'вранці'; periodEn = 'in the morning'; }
                else if (h >= 12 && h < 18) { periodUk = 'вдень'; periodEn = 'in the afternoon'; }
                else { periodUk = 'ввечері'; periodEn = 'in the evening'; }

                if (lvl.isStorm) {
                    const gName = {
                        1: isUk ? 'Слабка буря' : 'Minor storm',
                        2: isUk ? 'Помірна буря' : 'Moderate storm',
                        3: isUk ? 'Сильна буря' : 'Strong storm',
                        4: isUk ? 'Дуже сильна буря' : 'Severe storm',
                        5: isUk ? 'Екстремальний шторм' : 'Extreme storm'
                    }[lvl.gScale] || (isUk ? 'Буря' : 'Storm');

                    if (isUk) {
                        return `• <b>${label}:</b> ⚠️ Пік о ${timeStr} — ${lvl.badge} <b>G${lvl.gScale} (Kp ${lvl.kpRounded})</b>`;
                    }
                    return `• <b>${label}:</b> ⚠️ Peak at ${timeStr} — ${lvl.badge} <b>G${lvl.gScale} (Kp ${lvl.kpRounded})</b>`;
                }

                // Unsettled (Kp 4)
                if (isUk) {
                    return `• <b>${label}:</b> Збурення ${periodUk} (Kp ${lvl.kpRounded})`;
                }
                return `• <b>${label}:</b> Unsettled ${periodEn} (Kp ${lvl.kpRounded})`;
            };

            // Short date from local YYYY-MM-DD → "13.10"
            const shortDate = (dateStr) => {
                const parts = String(dateStr).split('-');
                if (parts.length < 3) return dateStr;
                return `${parts[2]}.${parts[1]}`;
            };
            const todayLabel = isUk
                ? `Сьогодні (${shortDate(dayKeys[0])})`
                : `Today (${shortDate(dayKeys[0])})`;
            const tomLabel = isUk
                ? `Завтра (${shortDate(dayKeys[1])})`
                : `Tomorrow (${shortDate(dayKeys[1])})`;
            const day3Label = isUk
                ? `Післязавтра (${shortDate(dayKeys[2])})`
                : `Day after (${shortDate(dayKeys[2])})`;

            const summaries = [
                daySummary(dayKeys[0], todayLabel),
                daySummary(dayKeys[1], tomLabel),
                daySummary(dayKeys[2], day3Label)
            ].filter(Boolean);

            // Table header (native Rich Message table)
            const headers = dayKeys.map(k => weekdayShort(k));
            let table = `<table bordered striped compact><tr><th>${isUk ? 'Час' : 'Time'}</th>`;
            for (const h of headers) {
                table += `<th>${h}</th>`;
            }
            table += `</tr>`;

            const hours = [0, 3, 6, 9, 12, 15, 18, 21];
            for (const h of hours) {
                table += `<tr><td><b>${String(h).padStart(2, '0')}:00</b></td>`;
                for (const dk of dayKeys) {
                    const slot = (slots[dk] || {})[h];
                    table += `<td align="center">${cellHtml(slot)}</td>`;
                }
                table += `</tr>`;
            }
            table += `</table>`;

            // Update timestamp
            const nowLocal = (() => {
                try {
                    return new Intl.DateTimeFormat(isUk ? 'uk-UA' : 'en-GB', {
                        timeZone: tz, day: '2-digit', month: '2-digit',
                        hour: '2-digit', minute: '2-digit', hour12: false
                    }).format(new Date());
                } catch {
                    return new Date().toISOString().slice(0, 16).replace('T', ' ');
                }
            })();

            const sourceLine = isUk
                ? `ℹ️ Джерело: NOAA SWPC (3h + live 1-хв для поточного слоту), оновлено ${nowLocal}.`
                : `ℹ️ Source: NOAA SWPC (3h + live 1-min for current bin), updated ${nowLocal}.`;

            let body = `<h1>${dict[userLang].geomagForecastTitle}</h1>`;
            if (summaries.length) {
                body += `<blockquote><b>${isUk ? 'ГОЛОВНЕ' : 'SUMMARY'}:</b><br>`;
                body += summaries.join('<br>');
                body += `</blockquote>`;
            }
            body += table;
            body += `<footer>${sourceLine}</footer>`;

            await ctx.api.sendRichMessage(ctx.chat.id, {
                html: body,
                skip_entity_detection: true
            });
        } catch (e) {
            console.error('geomag_fc error:', e.message, e.stack);
            await ctx.reply(dict[lang].geomagForecastEmpty).catch(() => {});
        }
    }

    // noop (section headers in keyboards)
    else if (data[0] === 'noop') {
        await ctx.answerCallbackQuery().catch(() => {});
    }

    // --- Toggle evening forecast callback ---
    else if (data[0] === 'toggle_evening_forecast') {
        try {
            await connectDB();
            const user = await User.findOne({ telegramId: ctx.from.id });
            if (!user) return ctx.answerCallbackQuery('❌ Error');

            const currentVal = user.eveningForecastEnabled !== false;
            const updatedUser = await User.findOneAndUpdate(
                { telegramId: ctx.from.id },
                { $set: { eveningForecastEnabled: !currentVal } },
                { new: true }
            );

            await ctx.answerCallbackQuery(dict[lang].settingsSaved);
            await ctx.editMessageReplyMarkup({ reply_markup: buildForecastSettingsKeyboard(lang, updatedUser.forecastSettings, updatedUser.eveningForecastEnabled !== false) });
        } catch (error) {
            await ctx.answerCallbackQuery('❌ Error');
        }
    }

    // --- Forecast settings menu callback ---
    else if (data[0] === 'forecast_menu') {
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (!user) return ctx.answerCallbackQuery('❌ Error');
        await ctx.answerCallbackQuery();

        const text = dict[lang].forecastSettingsTitle;
        const markup = buildForecastSettingsKeyboard(lang, user.forecastSettings, user.eveningForecastEnabled !== false);

        // If the button was clicked from a forecast message, send a NEW message
        // so the forecast (especially Rich Message) remains visible.
        // Rich Messages have no .text — they expose .rich_message instead.
        const cbMsg = ctx.callbackQuery.message;
        const msgText = cbMsg?.text || '';
        const isRichMessage = !!(cbMsg?.rich_message);
        const isFromForecast = isRichMessage ||
                               msgText.includes('🌆') ||
                               msgText.includes('🧪') ||
                               msgText.includes('Прогноз') ||
                               msgText.includes('прогноз') ||
                               msgText.includes('forecast') ||
                               msgText.includes('Forecast') ||
                               msgText.includes('Якість повітря') ||
                               msgText.includes('Air Quality');

        if (isFromForecast) {
            // Always a separate message — never overwrite the forecast
            await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: markup });
        } else {
            try {
                await ctx.editMessageText(text, {
                    parse_mode: 'Markdown',
                    reply_markup: markup
                });
            } catch (e) {
                await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: markup });
            }
        }
    }

    // --- Forecast days/metrics toggle callback ---
    else if (data[0] === 'forecast') {
        const [_, subType, value] = data;
        try {
            await connectDB();
            let update;
            if (subType === 'days') {
                update = { $set: { 'forecastSettings.daysCount': parseInt(value) } };
            } else if (subType === 'toggle') {
                const user = await User.findOne({ telegramId: ctx.from.id });
                let currentMetrics = user.forecastSettings?.enabledMetrics || [];
                // Міграція legacy 'aqi' → три окремі ключі при першому кліку по новим
                if (currentMetrics.includes('aqi') && ['aqi_now', 'aqi_main', 'aqi_ext'].includes(value)) {
                    currentMetrics = currentMetrics.filter(m => m !== 'aqi');
                    for (const k of ['aqi_now', 'aqi_main', 'aqi_ext']) {
                        if (!currentMetrics.includes(k)) currentMetrics.push(k);
                    }
                }
                const newMetrics = currentMetrics.includes(value)
                    ? currentMetrics.filter(m => m !== value)
                    : [...currentMetrics, value];
                update = { $set: { 'forecastSettings.enabledMetrics': newMetrics } };
            }

            const updatedUser = await User.findOneAndUpdate(
                { telegramId: ctx.from.id },
                update,
                { new: true }
            );

            await ctx.answerCallbackQuery(dict[lang].settingsSaved);
            await ctx.editMessageReplyMarkup({ reply_markup: buildForecastSettingsKeyboard(lang, updatedUser.forecastSettings, updatedUser.eveningForecastEnabled !== false) });
        } catch (error) {
            await ctx.answerCallbackQuery('❌ Error');
        }
    }

    // --- Open Settings manual callback ---
    else if (data[0] === 'open_settings') {
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (!user) return ctx.answerCallbackQuery('❌ Error');
        await ctx.answerCallbackQuery();

        // Use editMessageText if coming from another menu, or reply if new
        const text = dict[lang].settings;
        const markup = buildSettingsKeyboard(lang, user.units, user.notificationsEnabled !== false);

        try {
            await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: markup });
        } catch (e) {
            await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: markup });
        }
    }

    // --- Units change callback (wind or pressure) ---
    else if (data[0] === 'unit') {
        const [_, type, value] = data; // e.g. unit|wind|kmh
        try {
            await connectDB();
            const updateField = `units.${type}`;
            const user = await User.findOneAndUpdate(
                { telegramId: ctx.from.id },
                { $set: { [updateField]: value } },
                { new: true }
            );
            await ctx.answerCallbackQuery(dict[lang].settingsSaved);
            // Refresh the settings keyboard to show the new checkmark
            await ctx.editMessageReplyMarkup({ reply_markup: buildSettingsKeyboard(lang, user?.units, user?.notificationsEnabled !== false) });
        } catch (error) {
            await ctx.answerCallbackQuery('❌ Error saving');
        }
    }

    // --- Change city callback ---
    else if (data[0] === 'change_city') {
        await ctx.answerCallbackQuery();
        await ctx.reply(lang === 'uk'
            ? '📍 Надішліть назву нового міста:'
            : '📍 Send the name of the new city:');
    }

    // --- Delete city callback ---
    else if (data[0] === 'delete_city') {
        try {
            await connectDB();
            await User.findOneAndUpdate(
                { telegramId: ctx.from.id },
                { $unset: { city: '', lat: '', lon: '', timezone: '', lastState: '' } }
            );
            await ctx.answerCallbackQuery();
            await ctx.reply(dict[lang].cityDeleted);
        } catch (error) {
            await ctx.answerCallbackQuery('❌ Error');
        }
    }

    // --- Toggle notifications callback ---
    else if (data[0] === 'toggle_notifications') {
        try {
            await connectDB();
            const user = await User.findOne({ telegramId: ctx.from.id });
            if (!user) return ctx.answerCallbackQuery('❌ Error');

            const newValue = user.notificationsEnabled === false ? true : false;
            await User.findOneAndUpdate(
                { telegramId: ctx.from.id },
                { $set: { notificationsEnabled: newValue } }
            );

            await ctx.answerCallbackQuery(newValue ? dict[lang].notifEnabled : dict[lang].notifDisabled);
            // Refresh keyboard to toggle button label
            await ctx.editMessageReplyMarkup({ reply_markup: buildSettingsKeyboard(lang, user.units, newValue) });
        } catch (error) {
            await ctx.answerCallbackQuery('❌ Error');
        }
    }

    // --- Archive selection callback ---
    else if (data[0] === 'archive') {
        const mode = data[1];
        try {
            await connectDB();
            const user = await User.findOne({ telegramId: ctx.from.id });
            if (!user || !user.lat) {
                return ctx.answerCallbackQuery(lang === 'uk' ? '❌ Спочатку встановіть місто' : '❌ Please set city first');
            }

            if (mode === 'custom') {
                await ctx.answerCallbackQuery().catch(() => { });
                return ctx.reply(lang === 'uk'
                    ? '🗓 Введіть дату або період у форматі:\n`01.05.2024` або `01.05.2024-10.05.2024`'
                    : '🗓 Enter date or period in format:\n`01.05.2024` or `01.05.2024-10.05.2024`', { parse_mode: 'Markdown' });
            }

            const cityKey = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
            const cityDoc = await City.findOne({ externalId: cityKey });

            let historyQuery = { externalId: cityKey };
            let fetchDays = 30;

            if (mode === 'last_year') {
                const today = new Date();
                const lastYearStart = new Date(today.getFullYear() - 1, 0, 1).toISOString().split('T')[0];
                const lastYearEnd = new Date(today.getFullYear() - 1, 11, 31).toISOString().split('T')[0];
                historyQuery.date = { $gte: lastYearStart, $lte: lastYearEnd };
                fetchDays = 365 + Math.ceil((today - new Date(lastYearStart)) / (1000 * 60 * 60 * 24));
            } else {
                fetchDays = parseInt(mode);
            }

            // --- ON-DEMAND FETCH ---
            if (cityDoc) {
                try {
                    await fetchMissingHistory(cityDoc, fetchDays);
                } catch (fetchErr) {
                    console.error('[Bot] fetchMissingHistory failed:', fetchErr.message);
                }
            }

            let history;
            if (mode === 'last_year') {
                history = await History.find(historyQuery).sort({ date: -1 }).lean();
            } else {
                history = await History.find(historyQuery).sort({ date: -1 }).limit(fetchDays).lean();
            }


            const report = await generateHistoricalReport(history, lang, user.crops || [], cityKey);

            await ctx.answerCallbackQuery().catch(() => { });
            // Send as a new message as requested by the user
            await ctx.reply(report, {
                parse_mode: 'HTML',
                reply_markup: buildArchiveKeyboard(lang)
            });
        } catch (error) {
            console.error('Archive error:', error);
            await ctx.answerCallbackQuery('❌ Помилка').catch(() => { });
            await ctx.reply(`❌ <b>Error:</b>\n<code>${error.message}</code>`, { parse_mode: 'HTML' }).catch(() => { });
        }
    }
});


// --- Local Development Support (Polling Mode) ---
// If the script is run directly (not via a serverless require), launch in polling mode.
if (require.main === module) {
    (async () => {
        try {
            console.log('🚀 Launching Parasol Sentinel in POLLING mode (Local Dev)...');
            await connectDB();
            await bot.start();
            console.log('✅ Bot is active and polling.');
        } catch (e) {
            console.error('❌ Failed to launch bot locally:', e.message);
        }
    })();
}
