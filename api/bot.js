const getBot = require('../utils/bot');
const bot = getBot();
const axios = require('axios');
require('dotenv').config();

const User = require('../models/User');
const City = require('../models/City');
const History = require('../models/History');
const connectDB = require('../utils/db');
const { formatUrl, generateSignature } = require('../utils/helpers');
const { analyzeAgroRisks, formatAgroReport } = require('../utils/agro');
const { CROPS_DATA } = require('../utils/crops');

/**
 * Parasol Sentinel Bot - Core logic handler.
 * Design Choice: Using a hybrid approach (Serverless Webhook + Polling for Local Dev).
 */

const dict = {
    uk: {
        welcome: "👋 Вітаю! Мене звати **Parasol**.\n\nЯ буду стежити за погодою у вашому місті та надсилати сповіщення про різкі зміни.\n\nБудь ласка, введіть назву вашого міста (українською або англійською):",
        select: "🔍 Оберіть правильний варіант зі списку:",
        notFound: "❌ Не вдалося знайти це місто. Спробуйте уточнити запит (наприклад, додайте область).",
        errorSearch: "❌ Сталася помилка пошуку. Спробуйте пізніше.",
        citySet: "Місто {city} успішно встановлено!",
        citySetFull: "✅ **Місто встановлено:** {city}\n🌐 Координати: {lat}, {lon}\n🌡️ Поточна температура: {temp}°C\n💧 Точка роси: {dewpt}°C",
        dashboard: "📊 Мій Дашборд",
        settingsBtn: "⚙️ Налаштування",
        helpBtn: "❓ Допомога",
        helpSelect: "🔍 Оберіть тему, яка вас цікавить:",
        help_uv: "☀️ Що таке УФ-індекс?",
        help_wind: "🌬️ Напрямки вітру",
        help_press: "🌡️ Тиск та здоров'я",
        help_hum: "💧 Вологість та видимість",
        help_precip: "🌧️ Шанс опадів",
        help_dew: "💧 Точка роси",
        help_feels: "🌡️ Відчувається як",
        help_cloud: "☁️ Хмарність",
        help_how: "ℹ️ Як це працює",
        help_uv_desc: "☀️ **УФ-індекс** — рівень інтенсивності ультрафіолету:\n\n• **0-2: Низький.** Безпечно для більшості людей. Сонцезахисні засоби не обов'язкові. Рослини почуваються комфортно, додатковий полив чи затінення не потрібні.\n• **3-5: Помірний.** Рекомендується використовувати SPF-крем, капелюх та сонцезахисні окуляри. Для рослин це ідеальний час для фотосинтезу, проте молоду розсаду вже варто привчати до сонця поступово.\n• **6-7: Високий.** Намагайтеся бути в тіні в період з 11:00 до 16:00. Обов'язково захищайте шкіру. **Увага:** можливі опіки листя у вологолюбних рослин. Чутливі культури та теплиці бажано притіняти сіткою (20-30%).\n• **8-10: Дуже високий.** Ризик швидкого сонячного опіку шкіри. Мінімально перебувайте на відкритому сонці. Рослини перебувають у стресі, ріст уповільнюється. Обов'язкове затінення та полив тільки рано-вранці або ввечері.\n• **11+: Екстремальний.** Категорично уникайте перебування на вулиці вдень. Небезпечно для здоров'я. Небезпечно для всього живого. Високий ризик термічних опіків листя та плодів (особливо томатів/перцю). Максимальне затінення обов'язкове.",
        help_wind_desc: "🌬️ **Напрямки вітру** базуються на 16-румбовій системі, де вказано, звідки дме вітер:\n\n• **Основні**: Північний (N), Південний (S), Східний (E), Західний (W).\n• **Проміжні**: Пн-Сх (NE), Пд-Зх (SW) тощо\n• Третє коліно: Деталізація до 22.5° (напр. Пд-Пд-Сх, Пн-Пн-Зх)\n\n--- \n\n🌡️ Вплив на метеоумови:\n\n🔹 Північні (Пн, Пн-Пн-Сх, Пн-Пн-Зх): «Арктичне втручання»\nРізке похолодання, загроза нічних заморозків, при високій вологості — хуртовини та завірюхи.\n\n🔸 Східні (Сх, Сх-Пд-Сх, Сх-Пн-Сх): «Суховій»\nМаксимально висушує ґрунт та повітря. Приносить пилові домішки, створює умови для швидкого випаровування вологи.\n\n🔹 Західні (Зх, Зх-Пд-Зх, Зх-Пн-Зх): «Вологий фронт»\nОсновне джерело опадів та високої вологості. Сприятливе середовище для розвитку грибків та фітофтори.\n\n🔸 Південні (Пд, Пд-Пд-Зх, Пд-Пд-Сх): «Теплий сектор»\nПриплив тропічного повітря, різке підвищення температури, можливий сильний термічний перегрів поверхні.\n\n--- \n\n⚠️ Чому важлива деталізація (напр. Пд-Пд-Сх замість Пд)?\n\n1. Раннє попередження: Зміна вектора на 20° — перша ознака проходження атмосферного фронту (грози або похолодання) ще до зміни тиску.\n2. Вектор руху: Дозволяє точно розрахувати знос для дронів/авіації та передбачити штормовий нагін води у прибережних зонах.\n3. Локальні ефекти: Відрізняє транзитний вітер від того, що заходить у конкретні бухти чи ущелини.",
        help_press_desc: "🌡️ **Атмосферний тиск** — це сила, з якою повітря тисне на поверхню Землі:\n\n• **Норма**: 760 мм рт. ст. (1013 гПа) на рівні моря.\n• **Падіння (Циклон)**: Віщує погіршення погоди — хмари, опади, посилення вітру та шторми. \n\nДля рослин це період активного сокоруху, але висока вологість може сприяти розвитку грибків.\n• **Ріст (Антициклон)**: Ознака стабілізації погоди — стає ясно, сухо, вітер вщухає.\n\n⚠️ Вплив на рослини та затінення:\nПід час стійкого високого тиску (антициклону) небо стає безхмарним, що різко посилює сонячну радіацію. У такі дні ризик опіків листя зростає вдвічі, особливо в обідні часи. Якщо тиск високий і небо чисте — варто затіняти теплиці та молоду розсаду.\n\n*Різкі перепади (понад 1-2 мм за годину) часто провокують головний біль, сонливість та зміну артеріального тиску у метеозалежних людей та стрес у рослин, що сповільнює їх ріст.*",
        help_hum_desc: "💧 **Вологість та Видимість**:\n\n• **Вологість**: Відносна кількість вологи в повітрі. Комфорт: 40-60%. \n   — Висока (>70%): Влітку заважає тілу охолоджуватися, а для рослин створює ризик появи грибка та плісняви.\n   — Низька (<30%): Пересушує слизові оболонки та шкіру. Призводить до в’янення листя.\n• **Рослини та Сонце**: При низькій вологості та яскравому сонці рослини швидше втрачають вологу, що призводить до сонячних опіків.\n   — Якщо вологість низька, а індекс UV високий — варто затіняти чутливі культури.\n• **Видимість**: Максимальна відстань, на якій можна побачити об'єкт.\n   — 10+ км: **Відмінна видимість**.\n   — Менше 1 км (**Густий туман**): Будьте обережні за кермом. \n\n⚠️ **Вплив туману на рослини**:\n   — **Навесні**: Ризик радіаційних заморозків (вимерзання цвіту при нічному проясненні), навіть якщо температура повітря >0°C. Стежте за температурою саме біля землі.\n   — **Восени**: Створює середовище для патогенів та гнилі через застій вологого повітря.\n\n• На що звертати увагу:\n   — **Точка роси (Dew Point)**: Якщо наближається до 0°C або нижче при високій вологості — вночі буде заморозок на ґрунті.\n   — **Дефіцит вологості (VPD)**: При вологості <30% та температурі >25°C рослина не встигає «пити», тому затінення обов'язкове.\n   — **Зволоження листя**: Якщо туман тримається понад 4-6 годин при +15..+20°C — це ідеальний момент для обробки від грибків.",
        help_precip_desc: "🌧️ **Ймовірність та кількість опадів**:\n\nДля точного планування варто дивитися на обидва показники:\n\n• **Шанс опадів** (%): Це ймовірність того, що дощ взагалі дійде до вашої локації. 30-40% — це лотерея, 80% — майже гарантовані опади.\n• **Кількість (мм)**: Показує об'єм води. Якщо шанс 40%, а кількість 0 мм — дощ буде символічним або пройде поруч. Якщо ж стоїть >2 мм — це вже повноцінний полив.\n\n🌱 **Поради для саду та городу**:\n\n• **Ризик опіків**: Якщо після дощу різко виходить сонце, краплі на листі діють як лінзи. У таку погоду рослини краще затінити або струсити воду з листя, щоб уникнути сонячних опіків.\n• **Ефект лійки**: При невеликих опадах (до 1-2 мм) змочується лише верхній шар пилу. Це не замінює полив! Рослини під густим листям можуть залишитися абсолютно сухими.\n• **Захист**: Якщо прогнозується велика кількість (мм) при сильному вітрі, варто заздалегідь підв'язати високі культури.",
        help_dew_desc: "💧 **Точка роси** — це найкращий показник того, наскільки «важким» відчувається повітря та як воно впливає на рослини:\n\n• **Нижче 10°C**: Дуже комфортно, повітря сухе. Оптимально для загартовування, але стежте за поливом — ґрунт сохне швидше.\n• **12-15°C**: Приємно, стандартне літнє повітря. Ідеальний баланс для більшості культур.\n• **16-20°C**: Відчувається вологість. Ризик грибкових хвороб зростає. Сонце стає «важким» — при прямому впливі можливі опіки листя через ефект лінзи на краплях.\n• **Понад 21°C**: Дуже душно, важко дихати, «тропіки». Рослини майже не випаровують вологу, що веде до перегріву. **Рекомендовано затіняти** теплиці та грядки сіткою.\n\nТочка роси дозволяє вчасно виявити задуху, коли рослина перестає «дихати» і потребує захисту від прямого сонця.",
        help_feels_desc: "🌡️ **Відчувається як (Apparent Temperature)**:\n\nЦе суб'єктивне сприйняття температури, яке враховує вологість та вітер. Воно важливе не лише для людей, а й для стану ваших рослин:\n\n• **Влітку (Індекс спеки)**: Висока вологість уповільнює випаровування вологи з листя. При високих показниках рослини «задихаються», що призводить до теплового стресу.\n• **Взимку (Wind Chill)**: Сильний вітер прискорює втрату вологи та обмороження тканин, навіть якщо мороз не критичний.\n\n🌵 **Вплив на рослини**:\n\n• **Ризик опіків**: Якщо «відчувається як» значно вище реальної температури, сонячна активність зазвичай пікова. Це прямий сигнал до затінення, інакше на листі з'являться незворотні білі або коричневі плями (опіки).\n• **Полив**: При високих показниках випаровування йде швидше — перевіряйте ґрунт частіше, але уникайте крапель води на листі під сонцем (ефект лінзи).",
        help_cloud_desc: "☁️ **Хмарність** — це відсоток неба, закритого хмарами. Впливає на інтенсивність світла та ризик опіків:\n\n• **0-10%**: Ясно. Максимальне випромінювання. **Ризик опіків високий!** Чутливі рослини варто затіняти в обідні години.\n• **11-30%**: Майже ясно. Світло пряме та жорстке. Слідкуйте за вологістю ґрунту, бо випаровування дуже інтенсивне.\n• **31-70%**: Мінлива хмарність. Найкращий режим для більшого числа культур. Сонце чергується з тінню, що дає рослинам «відпочити».\n• **71-90%**: Хмарно з проясненнями. Світло розсіяне. Затінення не потрібне, але фотосинтез уповільнюється.\n• **91-100%**: Похмуро. Сонця не видно. Ризик опіків відсутній, проте тривала така погода може призвести до витягування розсади.",
        help_how_desc: "ℹ️ **Як це працює**:\n\n1. Напишіть назву свого міста.\n2. Бот запам'ятає ваші координати.\n3. Щогодини бот перевіряє погоду. Якщо температура різко впаде або підніметься (більше ніж на 5 градуси), або хмарність зміниться, ви отримаєте сповіщення.\n4. Ви також можете налаштувати одиниці вимірювання в меню 'Налаштування'.",
        saveError: "❌ Не вдалося зберегти вибір. Перевірте конфігурацію сервера.",
        settings: "⚙️ *Налаштування*",
        settingsWind: "🌬️ Вітер:",
        settingsPress: "🌡️ Тиск:",
        settingsCity: "📍 Змінити місто",
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
        agroScheduleBtn: "🚜 Графік обробок",
        agroArchiveBtn: "📈 Архів"
    },
    en: {

        welcome: "👋 Hello! My name is **Parasol**.\n\nI will monitor the weather in your city and send alerts about sudden changes.\n\nPlease type the name of your city:",
        select: "🔍 Choose the correct option from the list:",
        notFound: "❌ Cannot find this city. Please try to be more specific (e.g. add region/state).",
        errorSearch: "❌ Search error occurred. Please try again later.",
        citySet: "City {city} is set!",
        citySetFull: "✅ **City set:** {city}\n🌐 Coordinates: {lat}, {lon}\n🌡️ Current temperature: {temp}°C\n💧 Dew Point: {dewpt}°C",
        dashboard: "📊 My Dashboard",
        settingsBtn: "⚙️ Settings",
        helpBtn: "❓ Help",
        helpSelect: "🔍 Choose a topic you are interested in:",
        help_uv: "☀️ What is UV index?",
        help_wind: "🌬️ Wind directions",
        help_press: "🌡️ Pressure & Health",
        help_hum: "💧 Humidity & Visibility",
        help_precip: "🌧️ Precipitation chance",
        help_dew: "💧 Dew Point",
        help_feels: "🌡️ Feels Like",
        help_cloud: "☁️ Cloudiness",
        help_how: "ℹ️ How it works",
        help_uv_desc: "☀️ UV Index — level of ultraviolet intensity:\n\n• 0-2: Low. Safe for most people. Sunscreen is not required. Plants feel comfortable; additional watering or shading is not needed.\n• 3-5: Moderate. Recommended to use SPF cream, a hat, and sunglasses. For plants, this is an ideal time for photosynthesis, but young seedlings should be gradually accustomed to the sun.\n• 6-7: High. Try to stay in the shade between 11:00 and 16:00. Be sure to protect your skin. Warning: leaf burns are possible in moisture-loving plants. Sensitive crops and greenhouses should be shaded with a net (20-30%).\n• 8-10: Very High. Risk of rapid sunburn. Minimize time in direct sun. Plants are under stress, growth slows down. Shading and watering only in the early morning or evening is mandatory.\n• 11+: Extreme. Categorically avoid being outside during the day. Dangerous for health. Dangerous for all living things. High risk of thermal burns to leaves and fruits (especially tomatoes/peppers). Maximum shading is mandatory.",
        help_wind_desc: "🌬️ Wind Directions are based on a 16-point compass system, indicating where the wind is blowing from:\n\n• Main: North (N), South (S), East (E), West (W).\n• Intermediate: North-East (NE), South-West (SW), etc.\n• Third tier: Detail down to 22.5° (e.g., SSE, NNW)\n\n--- \n\n🌡️ Impact on weather conditions:\n\n🔹 Northerly (N, NNE, NNW): 'Arctic Intervention'\nSharp cooling, threat of night frosts; with high humidity — blizzards and snowstorms.\n\n🔸 Easterly (E, ESE, ENE): 'Dry Wind'\nMaximally dries out soil and air. Brings dust particles, creates conditions for rapid moisture evaporation.\n\n🔹 Westerly (W, WSW, WNW): 'Moist Front'\nThe primary source of precipitation and high humidity. Favorable environment for fungi and late blight (phytophthora) development.\n\n🔸 Southerly (S, SSW, SSE): 'Warm Sector'\nInflow of tropical air, sharp temperature rise, possible severe thermal overheating of the surface.\n\n--- \n\n⚠️ Why is detail important (e.g., SSE instead of S)?\n\n1. Early Warning: A 20° vector change is the first sign of an atmospheric front passing (storms or cooling) even before pressure changes.\n2. Movement Vector: Allows for precise drift calculation for drones/aviation and predicts storm surges in coastal areas.\n3. Local Effects: Distinguishes transit wind from wind entering specific bays or gorges.",
        help_press_desc: "🌡️ Atmospheric Pressure — the force with which air presses on the Earth's surface:\n\n• Normal: 760 mmHg (1013 hPa) at sea level.\n• Falling (Cyclone): Predicts deteriorating weather — clouds, precipitation, increased wind, and storms.\n\nFor plants, this is a period of active sap flow, but high humidity can promote fungal growth.\n• Rising (Anticyclone): A sign of weather stabilization — it becomes clear, dry, and wind subsides.\n\n⚠️ Impact on plants and shading:\nDuring sustained high pressure (anticyclone), the sky becomes cloudless, which sharply increases solar radiation. On such days, the risk of leaf burn doubles, especially during midday hours. If pressure is high and the sky is clear — greenhouses and young seedlings should be shaded.\n\nSharp drops (more than 1-2 mm per hour) often provoke headaches, drowsiness, and changes in blood pressure in weather-sensitive people, as well as stress in plants, slowing their growth.",
        help_hum_desc: "💧 Humidity and Visibility:\n\n• Humidity: The relative amount of moisture in the air. Comfort range: 40-60%.\n   — High (>70%): In summer, prevents the body from cooling down; for plants, creates a risk of fungi and mold.\n   — Low (<30%): Dries out mucous membranes and skin. Leads to leaf wilting.\n• Plants and Sun: In low humidity and bright sun, plants lose moisture faster, leading to sunburns.\n   — If humidity is low and the UV index is high, sensitive crops should be shaded.\n• Visibility: The maximum distance at which an object can be seen.\n   — 10+ km: Excellent visibility.\n   — Less than 1 km (Dense fog): Be careful while driving.\n\n⚠️ Impact of fog on plants:\n   — In Spring: Risk of radiation frosts (freezing of blossoms during night clearing), even if air temperature is >0°C. Monitor the temperature specifically near the ground.\n   — In Autumn: Creates an environment for pathogens and rot due to stagnant moist air.\n\n• What to watch for:\n   — Dew Point: If it approaches 0°C or lower with high humidity, there will be ground frost at night.\n   — Vapor Pressure Deficit (VPD): At humidity <30% and temperature >25°C, the plant cannot 'drink' fast enough, so shading is mandatory.\n   — Leaf Wetness: If fog persists for more than 4-6 hours at +15..+20°C, it's an ideal time for anti-fungal treatment.",
        help_precip_desc: "🌧️ Precipitation Probability and Amount:\n\nFor accurate planning, look at both indicators:\n\n• Precipitation Chance (%): The probability that rain will reach your location at all. 30-40% is a lottery; 80% is almost guaranteed precipitation.\n• Amount (mm): Shows the volume of water. If the chance is 40% but the amount is 0 mm, the rain will be symbolic or pass nearby. If it's >2 mm, it's a full-scale watering.\n\n🌱 Tips for Garden and Orchard:\n\n• Burn Risk: If the sun comes out sharply after rain, droplets on the leaves act like lenses. In such weather, it's better to shade plants or shake water off the leaves to avoid sunburn.\n• Watering Can Effect: With light precipitation (up to 1-2 mm), only the top layer of dust gets wet. This does not replace watering! Plants under dense foliage may remain completely dry.\n• Protection: If a large amount (mm) is forecast with strong winds, tall crops should be tied up in advance.",
        help_dew_desc: "💧 Dew Point — the best indicator of how 'heavy' the air feels and how it affects plants:\n\n• Below 10°C: Very comfortable, air is dry. Optimal for hardening off, but monitor watering — soil dries faster.\n• 12-15°C: Pleasant, standard summer air. Ideal balance for most crops.\n• 16-20°C: Humidity is felt. Risk of fungal diseases increases. The sun becomes 'heavy' — direct exposure may cause leaf burns due to the lens effect on droplets.\n• Above 21°C: Very muggy, hard to breathe, 'tropics'. Plants barely evaporate moisture, leading to overheating. Recommended to shade greenhouses and beds with netting.\n\nThe dew point allows for timely detection of stifling conditions when a plant stops 'breathing' and needs protection from direct sun.",
        help_feels_desc: "🌡️ Feels Like (Apparent Temperature):\n\nThis is the subjective perception of temperature, accounting for humidity and wind. It's important not only for people but also for the state of your plants:\n\n• In Summer (Heat Index): High humidity slows down moisture evaporation from leaves. At high levels, plants 'suffocate', leading to heat stress.\n• In Winter (Wind Chill): Strong wind accelerates moisture loss and tissue frostbite, even if the frost isn't critical.\n\n🌵 Impact on plants:\n\n• Burn Risk: If 'feels like' is significantly higher than the real temperature, solar activity is usually peaking. This is a direct signal for shading; otherwise, irreversible white or brown spots (burns) will appear on the leaves.\n• Watering: At high readings, evaporation happens faster — check the soil more often, but avoid water droplets on leaves under the sun (lens effect).",
        help_cloud_desc: "☁️ Cloud Cover — the percentage of the sky covered by clouds. Affects light intensity and burn risk:\n\n• 0-10%: Clear. Maximum radiation. Burn risk is high! Sensitive plants should be shaded during midday hours.\n• 11-30%: Mostly clear. Light is direct and harsh. Monitor soil moisture, as evaporation is very intense.\n• 31-70%: Partly cloudy. The best mode for most crops. Sun alternates with shade, giving plants a 'rest.'\n• 71-90%: Mostly cloudy. Light is diffused. Shading is not needed, but photosynthesis slows down.\n• 91-100%: Overcast. Sun is not visible. No burn risk, but prolonged weather like this can lead to leggy seedlings.",
        help_how_desc: "ℹ️ How it works:\n\n1. Write the name of your city.\n2. The bot will remember your coordinates.\n3. Every hour, the bot checks the weather. If the temperature drops or rises sharply (by more than 5 degrees), or if the cloud cover changes, you will receive a notification.\n4. You can also configure the units of measurement in the 'Settings' menu.",
        saveError: "❌ Failed to save. Please check server configuration.",
        settings: "⚙️ *Settings*",
        settingsWind: "🌬️ Wind:",
        settingsPress: "🌡️ Pressure:",
        settingsCity: "📍 Change city",
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
        agroScheduleBtn: "🚜 Schedule",
        agroArchiveBtn: "📈 Archive"
    }
};


// Build settings keyboard based on current user preferences
function buildSettingsKeyboard(lang, units = {}) {
    const d = dict[lang];
    const wind = units.wind || 'ms';
    const pressure = units.pressure || 'mmhg';
    return {
        inline_keyboard: [
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
                { text: d.settingsCity, callback_data: 'change_city' }
            ]
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

const getLang = (ctx) => (ctx.from?.language_code === 'uk' || ctx.from?.language_code === 'ru') ? 'uk' : 'en';


// Global command registration (runs once on startup/import)
if (process.env.TG_TOKEN) {
    bot.telegram.setMyCommands([
        { command: 'start', description: 'Запустити бота / Start' },
        { command: 'settings', description: 'Налаштування / Settings' },
        { command: 'help', description: 'Допомога / Help' }
    ]).catch(err => console.error('Error setting global commands:', err.message));
}

// Bot Logic (Webhook handler)
module.exports = async (req, res) => {
    try {
        if (!process.env.TG_TOKEN) {
            return res.status(500).send('TG_TOKEN is missing');
        }

        await connectDB();

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
bot.start(async (ctx) => {
    console.log('Start command from:', ctx.from.id);
    const lang = getLang(ctx);
    await connectDB();
    const user = await User.findOne({ telegramId: ctx.from.id });

    const keyboard = {
        keyboard: [
            [{ text: dict[lang].settingsBtn }, { text: dict[lang].helpBtn }],
            [{ text: dict[lang].cropsBtn }],
            [{ text: dict[lang].agroScheduleBtn }, { text: dict[lang].agroArchiveBtn }]
        ],
        resize_keyboard: true,

        is_persistent: true
    };

    if (user) {
        const sig = generateSignature(ctx.from.id, process.env.CRON_SECRET);
        const dashboardUrl = formatUrl(process.env.DOMAIN || 'localhost', `/?user=${ctx.from.id}&sig=${sig}`);
        await ctx.replyWithMarkdown(dict[lang].welcome, {
            reply_markup: {
                ...keyboard,
                //inline_keyboard: [
                //[{ text: dict[lang].dashboard, url: dashboardUrl }]
                //]
            }
        });
    } else {
        await ctx.replyWithMarkdown(dict[lang].welcome, {
            reply_markup: keyboard
        });
    }

    // Register commands for the user
    try {
        await ctx.setMyCommands([
            { command: 'start', description: lang === 'uk' ? 'Запустити бота' : 'Start the bot' },
            { command: 'settings', description: lang === 'uk' ? 'Налаштування' : 'Settings' },
            { command: 'help', description: lang === 'uk' ? 'Допомога' : 'Help' }
        ]);

        // Set WebApp menu button (this will be on the left of the input field)
        await ctx.setChatMenuButton({
            type: 'web_app',
            text: dict[lang].dashboard,
            web_app: { url: formatUrl(process.env.DOMAIN || 'localhost') }
        });
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
        return ctx.replyWithMarkdown(lang === 'uk'
            ? '❌ Спочатку встановіть місто, надіславши його назву.'
            : '❌ Please set your city first by sending its name.');
    }
    await ctx.replyWithMarkdown(
        dict[lang].settings,
        { reply_markup: buildSettingsKeyboard(lang, user.units) }
    );
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
bot.on('text', async (ctx) => {
    const query = ctx.message.text.trim();
    const lang = getLang(ctx);

    // Handle Menu Buttons
    if (query === dict.uk.settingsBtn || query === dict.en.settingsBtn) {
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (!user) {
            return ctx.reply(lang === 'uk' ? '📍 Спочатку встановіть місто.' : '📍 Please set a city first.');
        }
        return ctx.replyWithMarkdown(dict[lang].settings, {
            reply_markup: buildSettingsKeyboard(lang, user.units)
        });
    }

    if (query === dict.uk.helpBtn || query === dict.en.helpBtn) {
        return sendHelpMenu(ctx);
    }

    if (query === dict.uk.cropsBtn || query === dict.en.cropsBtn) {
        return ctx.reply(dict[lang].cropsSelectCat, {
            reply_markup: buildCropsCategoriesKeyboard(lang)
        });
    }

    if (query === dict.uk.agroScheduleBtn || query === dict.en.agroScheduleBtn) {
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (!user || !user.lat) return ctx.reply(lang === 'uk' ? '📍 Спочатку встановіть місто.' : '📍 Please set a city first.');
        
        const { analyzeSprayingWindow } = require('../utils/agro');
        const cityKey = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
        const cityData = await City.findOne({ externalId: cityKey });
        
        if (!cityData || !cityData.eveningState?.forecast) {
            return ctx.reply(lang === 'uk' ? '⚠️ Дані прогнозу ще не готові.' : '⚠️ Forecast data not ready.');
        }
        
        const report = analyzeSprayingWindow(cityData.eveningState.forecast, lang);
        return ctx.replyWithMarkdown(report);
    }

    if (query === dict.uk.agroArchiveBtn || query === dict.en.agroArchiveBtn) {
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (!user || !user.lat) return ctx.reply(lang === 'uk' ? '📍 Спочатку встановіть місто.' : '📍 Please set a city first.');
        
        // Show inline keyboard to select period
        const archiveKeyboard = {
            inline_keyboard: [
                [{ text: lang === 'uk' ? 'Тиждень' : 'Week', callback_data: 'archive|7' }],
                [{ text: lang === 'uk' ? 'Місяць' : 'Month', callback_data: 'archive|30' }],
                [{ text: lang === 'uk' ? 'Пів року' : '6 Months', callback_data: 'archive|180' }]
            ]
        };
        
        return ctx.reply(lang === 'uk' ? '📊 Оберіть період для аналізу:' : '📊 Select period for analysis:', {
            reply_markup: archiveKeyboard
        });
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
            await ctx.replyWithMarkdown(dict[lang].notFound);
        }
    } catch (error) {
        console.error('Search Error:', error.message);
        await ctx.replyWithMarkdown(dict[lang].errorSearch);
    }
});

// Handle button clicks
bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data.split('|');
    const lang = getLang(ctx);

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

            await ctx.answerCbQuery(dict[lang].citySet.replace('{city}', weather.city_name));

            const messageText = dict[lang].citySetFull
                .replace('{city}', weather.city_name)
                .replace('{lat}', lat)
                .replace('{lon}', lon)
                .replace('{temp}', Math.round(weather.temp))
                .replace('{dewpt}', Math.round(weather.dewpt));

            await ctx.editMessageText(messageText, {
                parse_mode: 'Markdown',
                //reply_markup: {
                //inline_keyboard: [
                //  [{ text: dict[lang].dashboard, url: dashboardUrl }]
                // ]
                //}
            });

            // Set WebApp menu button after successful city selection
            await ctx.setChatMenuButton({
                type: 'web_app',
                text: dict[lang].dashboard,
                web_app: { url: formatUrl(process.env.DOMAIN || 'localhost') }
            }).catch(e => console.error('Menu button error:', e.message));

        } catch (error) {
            await ctx.replyWithMarkdown(dict[lang].saveError);
        }
    }

    // --- Agro recommendations callback ---
    else if (data[0] === 'agro_tomorrow') {
        try {
            await connectDB();
            const user = await User.findOne({ telegramId: ctx.from.id });
            if (!user || !user.lat || !user.lon) {
                return ctx.answerCbQuery('❌ Помилка: дані користувача не знайдені');
            }

            const cityKey = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
            const cityData = await City.findOne({ externalId: cityKey });

            if (!cityData || !cityData.eveningState?.forecast?.[1]) {
                return ctx.answerCbQuery(lang === 'uk'
                    ? '⚠️ Дані ще не оновлені. Зачекайте вечірнього прогнозу.'
                    : '⚠️ Data not yet updated. Wait for the evening forecast.');
            }

            const tomorrowForecast = cityData.eveningState.forecast[1];

            // Fetch last 7 days of history for this city
            const history = await History.find({
                externalId: cityKey
            }).sort({ date: -1 }).limit(7);

            const risks = analyzeAgroRisks(tomorrowForecast, history, user.crops || []);

            const report = formatAgroReport(user.city, risks, lang);


            await ctx.answerCbQuery();
            await ctx.replyWithMarkdown(report);
        } catch (error) {
            console.error('Agro report error:', error.message);
            await ctx.answerCbQuery('❌ Помилка при формуванні звіту');
        }
    }

    // --- Crops main categories callback ---
    else if (data[0] === 'crops_main') {
        await ctx.answerCbQuery();
        await ctx.editMessageText(dict[lang].cropsSelectCat, {
            reply_markup: buildCropsCategoriesKeyboard(lang)
        });
    }

    // --- Crops category selection callback ---
    else if (data[0] === 'crops_cat') {
        const categoryKey = data[1];
        const user = await User.findOne({ telegramId: ctx.from.id });
        const label = CROPS_DATA[categoryKey].label[lang];

        await ctx.answerCbQuery();
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
            if (!user) return ctx.answerCbQuery('❌ Error');

            const hasCrop = user.crops.includes(plantId);
            const update = hasCrop
                ? { $pull: { crops: plantId } }
                : { $addToSet: { crops: plantId } };

            const updatedUser = await User.findOneAndUpdate(
                { telegramId: ctx.from.id },
                update,
                { new: true }
            );

            await ctx.answerCbQuery(hasCrop ? '❌ Видалено' : '✅ Додано');

            // Update the sub-items keyboard to reflect the change
            const label = CROPS_DATA[categoryKey].label[lang];
            await ctx.editMessageReplyMarkup(
                buildCropsItemsKeyboard(lang, categoryKey, updatedUser.crops)
            );
        } catch (error) {
            await ctx.answerCbQuery('❌ Error');
        }
    }

    // --- Help topic callback ---
    else if (data[0] === 'help') {
        const topic = data[1];
        let text = dict[lang][`help_${topic}_desc`];

        // Escape HTML special characters to prevent parsing errors (e.g. from '<' or '>')
        text = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // Convert Markdown bold (**) to HTML bold (<b>)
        // We do this AFTER escaping so our <b> tags remain valid
        text = text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');

        try {
            await ctx.answerCbQuery();
            await ctx.editMessageText(text, {
                parse_mode: 'HTML',
                reply_markup: buildHelpKeyboard(lang, topic)
            });
        } catch (e) {
            // If the user clicks the same button twice, Telegram returns an error 
            // "message is not modified". We ignore it.
            if (!e.message.includes('message is not modified')) {
                console.error('Help Update Error:', e.message);
            }
        }
    }

    // --- Open Settings manual callback ---
    else if (data[0] === 'open_settings') {
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (!user) return ctx.answerCbQuery('❌ Error');
        await ctx.answerCbQuery();
        await ctx.replyWithMarkdown(
            dict[lang].settings,
            { reply_markup: buildSettingsKeyboard(lang, user.units) }
        );
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
            await ctx.answerCbQuery(dict[lang].settingsSaved);
            // Refresh the settings keyboard to show the new checkmark
            await ctx.editMessageReplyMarkup(
                buildSettingsKeyboard(lang, user?.units)
            );
        } catch (error) {
            await ctx.answerCbQuery('❌ Error saving');
        }
    }

    // --- Change city callback ---
    else if (data[0] === 'change_city') {
        await ctx.answerCbQuery();
        await ctx.reply(lang === 'uk'
            ? '📍 Надішліть назву нового міста:'
            : '📍 Send the name of the new city:');
    }

    // --- Archive selection callback ---
    else if (data[0] === 'archive') {
        const days = parseInt(data[1]);
        try {
            await connectDB();
            const user = await User.findOne({ telegramId: ctx.from.id });
            const cityKey = `${user.lat.toFixed(2)},${user.lon.toFixed(2)}`;
            
            const history = await History.find({ externalId: cityKey })
                .sort({ date: -1 })
                .limit(days);
            
            const { generateHistoricalReport } = require('../utils/agro');
            const report = await generateHistoricalReport(history, lang);
            
            await ctx.answerCbQuery();
            await ctx.editMessageText(report, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Archive error:', error.message);
            await ctx.answerCbQuery('❌ Помилка');
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
            await bot.launch();
            console.log('✅ Bot is active and polling.');
        } catch (e) {
            console.error('❌ Failed to launch bot locally:', e.message);
        }
    })();
}
// If the script is run directly (not via a serverless require), launch in polling mode.
if (require.main === module) {
    (async () => {
        try {
            console.log('🚀 Launching Parasol Sentinel in POLLING mode (Local Dev)...');
            await connectDB();
            await bot.launch();
            console.log('✅ Bot is active and polling.');
        } catch (e) {
            console.error('❌ Failed to launch bot locally:', e.message);
        }
    })();
}
