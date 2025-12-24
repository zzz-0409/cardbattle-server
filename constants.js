// ============================================
// 基礎ステータス
// ============================================
export const MAX_HP = 200;
export const INITIAL_ATTACK = 20;
export const INITIAL_DEFENSE = 10;

export const INITIAL_COINS_DEFAULT = 10;
export const COIN_PER_TURN_BASE = 10; // 内部名はそのまま
export const SHOP_SIZE = 5;
export const MAX_ITEM_USES_PER_TURN = 2;

export const BASE_ATKDEF_BASE = 6;
export const HP_RECOVERY_BASE = 10;

export const PRICE_BUFF = {
  1: 8,
  2: 12,
  3: 16,
};

export const PRICE_RECOVER = {
  1: 15,
  2: 20,
  3: 25,
};

export const EFFECT_TYPES = ["攻撃力", "防御力", "HP"];

// ============================================
// 職業ID
// ============================================
export const JOBS = {
  1: { id: 1, name: "戦士" },
  2: { id: 2, name: "騎士" },
  3: { id: 3, name: "僧侶" },
  4: { id: 4, name: "盗賊" },
  5: { id: 5, name: "魔導士" },
  6: { id: 6, name: "陰陽師" },
  7: { id: 7, name: "錬金術師" },
  8: { id: 8, name: "弓兵" },
};

// ============================================
// 職業テンプレート
// ============================================
export const JOB_TEMPLATE = {
  1: { name: "戦士", coin: 10, atk_bonus: 3, def_bonus: 0, heal_bonus: 0, coin_per_turn_bonus: 0, skill_bonus: 0 },
  2: { name: "騎士", coin: 10, atk_bonus: 0, def_bonus: 3, heal_bonus: 0, coin_per_turn_bonus: 0, skill_bonus: 0 },
  3: { name: "僧侶", coin: 10,  atk_bonus: 0, def_bonus: 0, heal_bonus: 3, coin_per_turn_bonus: 0, skill_bonus: 0 },
  4: { name: "盗賊", coin: 15, atk_bonus: 0, def_bonus: 0, heal_bonus: 0, coin_per_turn_bonus: 3, skill_bonus: 0 },
  5: { name: "魔導士", coin: 10, atk_bonus: 0, def_bonus: 0, heal_bonus: 0, coin_per_turn_bonus: 0, skill_bonus: 5 },
  6: { name: "陰陽師", coin: 10, atk_bonus: 0, def_bonus: 0, heal_bonus: 0, coin_per_turn_bonus: 0, skill_bonus: 0 },
  7: { name: "錬金術師", coin: 10, atk_bonus: 0, def_bonus: 0, heal_bonus: 0, coin_per_turn_bonus: 0, skill_bonus: 0 },
  8: { name: "弓兵", coin: 10, atk_bonus: -5, def_bonus: 0, heal_bonus: 0, coin_per_turn_bonus: 0, skill_bonus: 0 },
  9: {
    name: "人形使い",
    coin: 10,
    atk_bonus: -19,
    def_bonus: 0,
    heal_bonus: 0,
    coin_per_turn_bonus: 0,
    skill_bonus: 0,
  },

};

// ============================================
// レベル関連
// ============================================
export const LEVEL_REQUIREMENTS = {
  1: 30,
  2: 40,
};

export const LEVEL_ATTACK_INCREASE = {
  2: 3,
  3: 5,
};

// ============================================
// 装備
// ============================================
export const EQUIP_PRICE_BY_STAR = {
  1: 10,
  2: 20,
  3: 30,
};

export const EQUIP_CATEGORIES = {
  coin: "コイン装備",
  "攻撃力": "攻撃力装備",
  "防御力": "防御力装備",
};

// ============================================
// 職業スキル定義（表記のみ修正）
// ============================================
export const JOB_SKILLS = {
  "戦士": [
    {
      type: "warrior_1",
      name: "ブレイクヒット",
      min_level: 1,
      power: 20,
      effect: "防御無視",
      description: "防御力を無視して20ダメージを与える。",
    },
    {
      type: "warrior_2",
      name: "バーストアップ",
      min_level: 2,
      power: 30,
      effect: "攻撃力+3（3ラウンド）",
      description: "防御無視30ダメージを与え、攻撃力が3上昇（3ラウンド）。",
    },
    {
      type: "warrior_3",
      name: "バーサーカースマッシュ",
      min_level: 3,
      power: "20 + 現在攻撃力",
      effect: "防御無視",
      description: "基礎20＋自身の攻撃力分の防御無視ダメージを与える。",
    },
  ],

  "騎士": [
    {
      type: "knight_1",
      name: "ガードストライク",
      min_level: 1,
      power: 20,
      effect: "自身に防御力+2（4ラウンド）",
      description: "20ダメージを与え、自身の防御力を2上昇（4ラウンド）。",
    },
    {
      type: "knight_2",
      name: "フォートレスブレイク",
      min_level: 2,
      power: "15 + 自身の防御力",
      effect: "防御力+4（3ラウンド）",
      description: "防御依存ダメージ（15＋DEF）を与え、防御力+4（3ラウンド）。",
    },
    {
      type: "knight_3",
      name: "パラディンスマッシュ",
      min_level: 3,
      power: "25 + 自身の防御力",
      effect: null,
      description: "防御依存ダメージ（25＋DEF）を与える。",
    },
  ],


  "僧侶": [
    {
      type: "priest_1",
      name: "ヒール",
      min_level: 1,
      power: "30 + 回復ボーナス",
      effect: null,
      description: "HPを30回復（回復ボーナス適用）。",
    },
    {
      type: "priest_2",
      name: "ディスペルヒール",
      min_level: 2,
      power: "35 + 回復ボーナス",
      effect: "デバフ解除",
      description: "HP35回復＋デバフを解除する。",
    },
    {
      type: "priest_3",
      name: "ホーリーヒール",
      min_level: 3,
      power: "40 + 回復ボーナス",
      effect: "デバフ解除",
      description: "HP40回復＋デバフを解除する。",
    },
  ],

  "盗賊": [
    {
      type: "thief_1",
      name: "スティールアタック",
      min_level: 1,
      power: 25,
      effect: "アイテム/装備を1つ奪う",
      description: "25ダメージ＋相手のアイテムか装備を1つ奪う。",
    },
    {
      type: "thief_2",
      name: "グリードブロー",
      min_level: 2,
      power: "25 + 所持アイテム×2",
      effect: "奪う",
      description: "所持アイテム数で強化されたダメージ＋奪う。",
    },
    {
      type: "thief_3",
      name: "ダークアルケミー",
      min_level: 3,
      power: null,
      effect: "所持アイテム全発動（消費なし）",
      description: "所持アイテムをすべて即時発動（消費なし）。",
    },
  ],

  "魔導士": [
    {
      type: "mage_1",
      name: "魔力チャージ",
      min_level: 1,
      power: "+20魔力（1回のみ）",
      effect: null,
      description: "魔力を20回復（バトル中1回のみ）。",
    },
    {
      type: "mage_2",
      name: "エレメントバースト",
      min_level: 2,
      power: 30,
      effect: "防御無視（魔導書で貫通）",
      description: "魔力30消費して30ダメージ（装備により防御貫通）。",
    },
    {
      type: "mage_3",
      name: "メテオインパクト",
      min_level: 3,
      power: "消費魔力-30",
      effect: "防御無視（魔導書で貫通）",
      description: "魔力全消費→(消費魔力−30)の防御無視ダメージ。",
    },
  ],

  "陰陽師": [
    {
      type: "onmyoji_1",
      name: "式神召喚・初級",
      min_level: 1,
      effect: "ランダム式神（鬼火/猫又/玄武/烏天狗）",
      power: null,
      description: "初級式神を1体召喚する。",
    },
    {
      type: "onmyoji_2",
      name: "式神召喚・中級",
      min_level: 2,
      effect: "ランダム式神（全種）",
      power: null,
      description: "全種類からランダムで式神を召喚する。",
    },
    {
      type: "onmyoji_3",
      name: "式神召喚・極",
      min_level: 3,
      effect: "式神2体同時召喚",
      power: null,
      description: "式神を2種類召喚する。",
    },
  ],

  "錬金術師": [
    {
      type: "alchemist_1",
      name: "錬成（ランダム装備2つ生成）",
      min_level: 1,
      effect: "装備2つ生成",
      power: null,
      description: "ランダム装備を2つ生成し入手する。",
    },
    {
      type: "alchemist_2",
      name: "精錬（全装備の星+1）",
      min_level: 2,
      effect: "全装備の星+1",
      power: null,
      description: "手持ちと装備中の全装備の★を1上げる。",
    },
    {
      type: "alchemist_3",
      name: "三重合成",
      min_level: 3,
      effect: "装備3つ合成",
      power: null,
      description: "装備を3つ合成し、より高ランクの装備を生成する。",
    },
  ],

  "弓兵": [
    {
      type: "archer_1",
      name: "追撃構え",
      min_level: 1,
      power: null,
      effect: "追撃+1（3ラウンド）",
      description: "3ラウンドの間、追撃が+1回される。",
    },
    {
      type: "archer_2",
      name: "矢筒拡張",
      min_level: 2,
      power: null,
      effect: "矢スロット+1＆追撃+1（3ラウンド）",
      description: "矢スロットが1つ増え、3ラウンド追撃+1。",
    },
    {
      type: "archer_3",
      name: "会心装填",
      min_level: 3,
      power: null,
      effect: "全矢に防御貫通付与",
      description: "装備中のすべての矢が防御貫通になる。",
    },
  ],

  "人形使い": [
    {
      type: "doll_1",
      name: "人形召喚",
      min_level: 1,
      power: null,
      effect: "人形を召喚",
      description: "人形を召喚し、戦闘に参加させる。",
    },
    {
      type: "doll_2",
      name: "人形修復",
      min_level: 2,
      power: null,
      effect: "HP→耐久変換",
      description: "HPを消費して人形の耐久を回復する（10刻み、上限100）。",
    },
    {
      type: "doll_3",
      name: "暴走",
      min_level: 3,
      power: null,
      effect: "人形暴走",
      description: "一定ラウンドの間、人形を暴走状態にする。",
    },
  ],

};

export const ARROW_DATA = {
  normal: {
    name: "普通の矢",
    power: 15,
    effect: "normal",
    equip_type: "arrow",
    price: 20,
    effect_text: "15ダメージの通常矢",
  },

  poison: {
    name: "毒の矢",
    power: 15,
    effect: "poison",
    equip_type: "arrow",
    price: 25,
    effect_text: "15ダメ+毒付与（3ダメ×2ラウンド）",
  },

  freeze: {
    name: "氷結の矢",
    power: 15,
    effect: "freeze",
    equip_type: "arrow",
    price: 25,
    effect_text: "15ダメ+氷結付与（攻撃力-2累積）",
  },

  counter: {
    name: "反撃の矢",
    power: 10,
    effect: "counter",
    equip_type: "arrow",
    price: 30,
    effect_text: "10ダメ+前のラウンドの被ダメの半分で反撃",
  },

  critical: {
    name: "会心の矢",
    power: 20,
    effect: "critical",
    equip_type: "arrow",
    crit_chance: 0.25,
    crit_multiplier: 1.5,
    price: 30,
    effect_text: "装備している全ての矢に会心率50% 会心ダメ+50%",
  },
};


// 魔導士専用：魔力回復アイテム
export const MAGE_MANA_ITEMS = [
  {
    name: "魔力水（小）", price: 10, effect_type: "MANA",
    power: 10, duration: 0, is_equip: false, effect_text: "魔力+10"
  },
  {
    name: "魔力水（中）", price: 15, effect_type: "MANA",
    power: 20, duration: 0, is_equip: false, effect_text: "魔力+20"
  },
  {
    name: "魔力水（大）", price: 20, effect_type: "MANA",
    power: 30, duration: 0, is_equip: false, effect_text: "魔力+30"
  }
];

// 魔導士専用装備（4種）
export const MAGE_EQUIPS = [
  { name: "魔導士の杖", price: 15, is_equip: true, equip_type: "mage_equip", mana_gain: 2, coin_per_turn: 3, effect_text: "毎ラウンド魔力+2,コイン+3" },
  { name: "魔力の指輪", price: 10, is_equip: true, equip_type: "mage_equip", mana_gain: 3, regen_hp: 2, effect_text: "毎ラウンド魔力+3 / HP+2" },
  { name: "魔導士のローブ", price: 10, is_equip: true, equip_type: "mage_equip", mana_gain: 3, def_bonus: 2, effect_text: "毎ラウンド魔力+3 / 防御+2" },
  { name: "古代魔導書", price: 25, is_equip: true, equip_type: "mage_equip", mana_gain: 5, magic_pierce: true, effect_text: "毎ラウンド魔力+5 / 魔法防御貫通" }
];

// ================================
// 人形使い専用：修理キット
// ================================
export const DOLL_REPAIR_KIT = {
  name: "修理キット",
  price: 20,
  category: "item",
  is_doll_item: true,
  effect_text: "人形の耐久を回復／破壊時は復活（1T無敵）",
};

// =========================================================
// 人形使い：衣装アイテム定義
// =========================================================
export const DOLL_COSTUME_PARTS = ["head", "body", "leg", "foot"];
export const DOLL_COSTUME_TYPES = ["ATK", "DEF", "DUR"];

// ★ 衣装生成用ヘルパー
export function createDollCostume({ part, effect_type, star }) {

  // 効果量計算
  const value =
    effect_type === "DUR"
      ? 1 + star
      : 1 + star * 2;

  // 効果説明文
  let effect_text = "";
  if (effect_type === "ATK") {
    effect_text = `人形の攻撃力 +${value}`;
  } else if (effect_type === "DEF") {
    effect_text = `人形の防御力 +${value}`;
  } else if (effect_type === "DUR") {
    effect_text = `人形の耐久力 毎R +${value}`;
  }

  return {
    uid: crypto.randomUUID(),

    // ★ 表示名（一覧用）
    name: `★${star}${DOLL_EFFECT_LABEL[effect_type]}${DOLL_PART_LABEL[part]}`,

    // ★ 効果表示（詳細用）
    effect_text,

    is_doll_costume: true,
    part,
    effect_type,
    star,

    price: 10 + star * 5
  };
}



// 人形衣装：表示用ラベル
export const DOLL_PART_LABEL = {
  head: "帽子",
  body: "服",
  leg:  "ズボン",
  foot: "靴"
};

export const DOLL_EFFECT_LABEL = {
  ATK: "攻撃",
  DEF: "防御",
  DUR: "耐久"
};
