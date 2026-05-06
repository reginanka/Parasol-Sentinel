/**
 * Енциклопедія культур та структура меню
 */

const CROPS_DATA = {
    vegetables: {
        label: { uk: '🥕 Овочі', en: '🥕 Vegetables' },
        items: {
            tomato: { uk: 'Помідори', en: 'Tomatoes' },
            cucumber: { uk: 'Огірки', en: 'Cucumbers' },
            potato: { uk: 'Картопля', en: 'Potatoes' },
            pepper: { uk: 'Перець', en: 'Peppers' },
            cabbage: { uk: 'Капуста', en: 'Cabbage' },
            zucchini: { uk: 'Кабачки', en: 'Zucchini' }
        }
    },
    berries: {
        label: { uk: '🍓 Ягоди', en: '🍓 Berries' },
        items: {
            strawberry: { uk: 'Полуниця', en: 'Strawberries' },
            raspberry: { uk: 'Малина', en: 'Raspberries' },
            grape: { uk: 'Виноград', en: 'Grapes' },
            currant: { uk: 'Смородина', en: 'Currants' },
            blueberry: { uk: 'Лохина', en: 'Blueberries' }
        }
    },
    orchard: {
        label: { uk: '🍎 Сад', en: '🍎 Orchard' },
        items: {
            apple: { uk: 'Яблуні', en: 'Apple trees' },
            pear: { uk: 'Груші', en: 'Pear trees' },
            peach: { uk: 'Персик/Абрикос', en: 'Peach/Apricot' },
            cherry: { uk: 'Черешня/Вишня', en: 'Cherries' },
            nut: { uk: 'Горіх Волоський/Фундук', en: 'Nut trees' }
        }
    },
    lawn: {
        label: { uk: '🌿 Газон та ландшафт', en: '🌿 Lawn & Landscape' },
        items: {
            lawn_grass: { uk: 'Газонна трава', en: 'Lawn grass' },
            conifers: { uk: 'Хвойні', en: 'Conifers' },
            boxwood: { uk: 'Самшит', en: 'Boxwood' }
        }
    },
    flowers: {
        label: { uk: '🌸 Квіти', en: '🌸 Flowers' },
        items: {
            rose: { uk: 'Троянди', en: 'Roses' },
            peony: { uk: 'Піони', en: 'Peonies' },
            alpine: { uk: 'Альпійські гірки', en: 'Alpine plants' },
            hydrangea: { uk: 'Гортензії', en: 'Hydrangeas' }
        }
    }
};

module.exports = { CROPS_DATA };
