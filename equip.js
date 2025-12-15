// equip.js  — 装備生成ロジック（Python版準拠）

import { EQUIP_PRICE_BY_STAR, EQUIP_CATEGORIES } from "./constants.js";

// =========================================
// 魔導士専用装備（4種）
//  - 杖：コイン増加 + 魔力
//  - 指輪：HP再生 + 魔力
//  - ローブ：防御ボーナス + 魔力
//  - 本：魔法防御貫通 + 魔力
// =========================================
export const MAGE_EQUIPS = [
  {
    name: "魔導士の杖",
    price: 15,
    is_equip: true,
    equip_type: "mage_equip",
    mana_gain: 2,
    coin_per_turn: 3,
    effect_text: "毎ラウンド魔力+2 / コイン+3",
    // ★（星）はランダム装備専用なので付けない
  },
  {
    name: "魔力の指輪",
    price: 10,
    is_equip: true,
    equip_type: "mage_equip",
    mana_gain: 3,
    regen_hp: 2,
    effect_text: "毎ラウンド魔力+3 / HP+2",
  },
  {
    name: "魔導士のローブ",
    price: 10,
    is_equip: true,
    equip_type: "mage_equip",
    mana_gain: 3,
    def_bonus: 2,
    effect_text: "毎ラウンド魔力+3 / 防御+2",
  },
  {
    name: "古代魔導書",
    price: 25,
    is_equip: true,
    equip_type: "mage_equip",
    mana_gain: 5,
    magic_pierce: true,
    effect_text: "毎ラウンド魔力+5 / 魔法防御貫通",
  },
];

// ------------------------------------------
// レベル別の装備生成（ショップ用：通常装備）
// ------------------------------------------
export function generateEquipmentForLevel(level) {
  const roll = Math.floor(Math.random() * 100) + 1;
  let star;

  if (level === 1) {
    if (roll <= 70) star = 1;
    else if (roll <= 95) star = 2;
    else star = 3;
  } else if (level === 2) {
    if (roll <= 40) star = 1;
    else if (roll <= 90) star = 2;
    else star = 3;
  } else {
    if (roll <= 20) star = 1;
    else if (roll <= 70) star = 2;
    else star = 3;
  }

  // カテゴリキーは Pythonと同じ3種
  const categories = ["coin", "攻撃力", "防御力"];
  const cat = categories[Math.floor(Math.random() * categories.length)];

  let power;
  let effect_text;

  if (cat === "coin") {
    power = star * 2;
    effect_text = `毎ラウンドコイン+${power}`;
  } else if (cat === "攻撃力") {
    const map = { 1: 2, 2: 3, 3: 4 };
    power = map[star];
    effect_text = `攻撃力+${power}`;
  } else {
    const map = { 1: 2, 2: 3, 3: 4 };
    power = map[star];
    effect_text = `防御力+${power}`;
  }

  const name = `★${star} ${EQUIP_CATEGORIES[cat]}`;
  const price = EQUIP_PRICE_BY_STAR[star];

  return {
    name,
    star,
    is_equip: true,
    equip_type: "normal",
    equip_category: cat,
    effect_type: cat === "coin" ? "coin_per_turn" : cat,
    power,
    price,
    effect_text,
    is_arrow: false,
  };
}

// ------------------------------------------
// 錬金術師スキル1用：ランダム装備生成
// ------------------------------------------
export function generateRandomEquip() {
  const stars = [1, 2, 3];
  const star = stars[Math.floor(Math.random() * stars.length)];
  const categories = ["coin", "攻撃力", "防御力"];
  const cat = categories[Math.floor(Math.random() * categories.length)];

  let power;
  let effect_text;

  if (cat === "coin") {
    power = star * 2;
    effect_text = `毎ラウンドコイン+${power}`;
  } else if (cat === "攻撃力") {
    const map = { 1: 2, 2: 3, 3: 4 };
    power = map[star];
    effect_text = `攻撃力+${power}`;
  } else {
    const map = { 1: 2, 2: 3, 3: 4 };
    power = map[star];
    effect_text = `防御力+${power}`;
  }

  const name = `★${star} ${EQUIP_CATEGORIES[cat]}`;

  return {
    name,
    is_equip: true,
    equip_type: "normal",
    equip_category: cat,
    effect_type: cat === "coin" ? "coin_per_turn" : cat,
    power,
    star,
    effect_text,
    is_arrow: false,
  };
}

// ------------------------------------------
// 星+1（錬金術師スキル2）
// ------------------------------------------
export function upgradeEquipStar(equip) {
  let oldStar = equip.star ?? 1;
  const newStar = oldStar + 1;

  equip.star = newStar;

  if (equip.effect_type === "coin_per_turn") {
    equip.power = newStar * 2;
    equip.effect_text = `毎ラウンドコイン+${equip.power}`;
  } else if (equip.effect_type === "攻撃力") {
    const map = { 1: 2, 2: 3, 3: 4, 4: 5 };
    equip.power = map[newStar] ?? equip.power;
    equip.effect_text = `攻撃力+${equip.power}`;
  } else if (equip.effect_type === "防御力") {
    const map = { 1: 2, 2: 3, 3: 4, 4: 5 };
    equip.power = map[newStar] ?? equip.power;
    equip.effect_text = `防御力+${equip.power}`;
  }

  return equip;
}

// ------------------------------------------
// 錬金術師スキル3：三重合成で特殊武器生成
// ------------------------------------------
export function createAlchemistUniqueEquip({
  atk = 0,
  defense = 0,
  coin = 0,
  star = 1
}) {
  const name = `錬金術師の合成武器★${star}`;

  const effects = [];
  if (atk > 0) effects.push(`攻撃力+${atk}`);
  if (defense > 0) effects.push(`防御力+${defense}`);
  if (coin > 0) effects.push(`毎ラウンドコイン+${coin}`);

  const effect_text =
    effects.length > 0 ? effects.join(" / ") : "効果なし";

  return {
    name,
    equip_type: "alchemist_unique",
    is_equip: true,

    // ★ 単一効果は使わない
    atk,
    def: defense,
    coin,

    star: Math.min(star, 5),
    price: 0,

    effect_text,
    is_arrow: false,
  };
}
