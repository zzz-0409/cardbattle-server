// ============================================
// mage_items.js
// 魔導士専用：魔力回復アイテム（盗賊に奪われない）
// ============================================

export const MAGE_MANA_ITEMS = [
    {
        name: "魔力水（小）",
        price: 10,
        effect_type: "MANA",
        power: 10,
        duration: 0,
        is_equip: false,
        is_mage_item: true,
        effect_text: "魔力+10",
    },
    {
        name: "魔力水（中）",
        price: 15,
        effect_type: "MANA",
        power: 20,
        duration: 0,
        is_equip: false,
        is_mage_item: true,
        effect_text: "魔力+20",
    },
    {
        name: "魔力水（大）",
        price: 20,
        effect_type: "MANA",
        power: 30,
        duration: 0,
        is_equip: false,
        is_mage_item: true,
        effect_text: "魔力+30",
    },
];
