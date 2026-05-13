// ============================================
// 基礎ステータス
// ============================================
export const MAX_HP = 200;
export const INITIAL_ATTACK = 20;
export const INITIAL_DEFENSE = 10;

// ============================================
// 職業テンプレート
// ============================================
export const JOB_TEMPLATE = {
  1: { name: "戦士", coin: 10, atk_bonus: 3, def_bonus: 0, heal_bonus: 0, coin_per_turn_bonus: 0, skill_bonus: 0 },
  2: { name: "騎士", coin: 10, atk_bonus: 0, def_bonus: 3, heal_bonus: 0, coin_per_turn_bonus: 0, skill_bonus: 0 },
  3: { name: "僧侶", coin: 10,  atk_bonus: 0, def_bonus: 0, heal_bonus: 0, coin_per_turn_bonus: 0, skill_bonus: 0 },
  4: { name: "盗賊", coin: 15, atk_bonus: 0, def_bonus: 0, heal_bonus: 0, coin_per_turn_bonus: 3, skill_bonus: 0 },
  5: { name: "魔導士", coin: 10, atk_bonus: 0, def_bonus: 0, heal_bonus: 0, coin_per_turn_bonus: 0, skill_bonus: 5 },
  6: { name: "陰陽師", coin: 10, atk_bonus: 0, def_bonus: 0, heal_bonus: 0, coin_per_turn_bonus: 0, skill_bonus: 0 },
  7: { name: "錬金術師", coin: 10, atk_bonus: 0, def_bonus: 0, heal_bonus: 0, coin_per_turn_bonus: 0, skill_bonus: 0 },
  8: { name: "弓兵", coin: 10, atk_bonus: -7, def_bonus: 0, heal_bonus: 0, coin_per_turn_bonus: 0, skill_bonus: 0 },
  9: { name: "人形使い", coin: 10, atk_bonus: -19, def_bonus: 0, heal_bonus: 0, coin_per_turn_bonus: 0, skill_bonus: 0 },
  10:{ name: "狂人", coin: 10, atk_bonus: 0, def_bonus: 0, heal_bonus: 0, coin_per_turn_bonus: 0, skill_bonus: 0 }

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
      effect: "攻撃力+3（3T）",
      description: "防御無視30ダメージを与え、攻撃力が3上昇（3T）。",
    },
    {
      type: "warrior_3",
      name: "バーサーカースマッシュ",
      min_level: 3,
      power: "20 + 現在攻撃力",
      effect: "防御無視",
      description: "基礎20＋自身の攻撃力分の防御無視ダメージを与える。",
    },
    {
      type: "warrior_4",
      name: "剛勇覚醒",
      min_level: 3,
      power: "攻撃力+20（5T）＋通常攻撃",
      effect: "自己強化後に攻撃",
      description: "5Tの間、攻撃力を20上昇。その後、通常攻撃を行う。",
    },
    {
      type: "warrior_5",
      name: "覇断一閃",
      min_level: 3,
      power: "現在攻撃力＋攻撃力アップバフ種類×10",
      effect: "防御無視",
      description: "防御無視の通常攻撃を行う。攻撃力アップバフ1種類につき威力が10上昇する。",
    },
  ],

  "騎士": [
    {
      type: "knight_1",
      name: "ガードストライク",
      min_level: 1,
      power: 20,
      effect: "自身に防御力+2（4T）",
      description: "20ダメージを与え、自身の防御力を2上昇（4T）。",
    },
    {
      type: "knight_2",
      name: "フォートレスブレイク",
      min_level: 2,
      power: "15 + 自身の防御力",
      effect: "防御力+4（3T）",
      description: "防御依存ダメージ（15＋DEF）を与え、防御力+4（3T）。",
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
      name: "リジェネ",
      min_level: 1,
      power: 2,
      effect: "継続回復10T",
      description: "10Tの間、自分のターン開始時にHPを2回復する。",
    },
    {
      type: "priest_2",
      name: "ディスペルリジェネ",
      min_level: 2,
      power: 2,
      effect: "デバフ解除＋継続回復12T",
      description: "デバフを解除し、12Tの間、自分のターン開始時にHPを2回復する。",
    },
    {
      type: "priest_3",
      name: "ホーリースマイト",
      min_level: 3,
      power: "現在HPの1/10＋祝福全消費",
      effect: "防御無視ダメージ",
      description: "祝福をすべて消費し、自身の現在HPの1/10＋消費した祝福の数だけ、防御無視ダメージを与える。",
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
      effect: "所持アイテム全発動（消費なし）＋通常攻撃",
      description: "所持アイテムをすべて即時発動（消費なし）し、その後通常攻撃を行う。",
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
      effect: "追撃+1（3T）＋通常攻撃",
      description: "3Tの間、追撃が+1回される。その後、通常攻撃を行う。",
    },
    {
      type: "archer_2",
      name: "矢筒拡張",
      min_level: 2,
      power: null,
      effect: "矢スロット+1＆追撃+1（3T）＋通常攻撃",
      description: "矢スロットが1つ増え、3T追撃+1。その後、通常攻撃を行う。",
    },
    {
      type: "archer_3",
      name: "無尽射撃",
      min_level: 3,
      power: null,
      effect: "矢を消費しない（永続）",
      description: "以後、矢を消費せずに攻撃できる。",
    },
  ],

  "人形使い": [
    {
      type: "doll_1",
      name: "修理キット調達",
      min_level: 1,
      power: null,
      effect: "修理キット入手",
      description: "修理キットを1つ入手する。",
    },
    {
      type: "doll_2",
      name: "総仕立て直し",
      min_level: 2,
      power: null,
      effect: "装備中衣装の星+1",
      description: "装備しているすべての部位の衣装の★を1上げる（最大★8）。",
    },
    {
      type: "doll_3",
      name: "暴走",
      min_level: 3,
      power: null,
      effect: "人形暴走",
      description: "一定ターンの間、人形を暴走状態にする。",
    },
  ],

  "狂人": [
    {
      type: "mad_1",
      name: "自傷の狂気",
      min_level: 1,
      power: 30,
      effect: "自傷 / 相手ダメージ",
      description: "自分に30ダメージ。累積被ダメ120超なら代わりに相手に30ダメージを与える。"
    },
    {
      type: "mad_2",
      name: "痛みへの執着",
      min_level: 2,
      power: null,
      effect: "攻撃力+3 (条件付き追加バフ)",
      description: "自分の攻撃力を+3（3T）。狂化状態なら追加で2T攻撃力+10、防御力+5。"
    },
    {
      type: "mad_3",
      name: "破滅の微笑",
      min_level: 3,
      power: null,
      effect: "我慢 / HP同調",
      description: "自分に我慢を付与する。狂化状態なら我慢に加え、相手のHPを自分のHPと同じにする。"
    }
  ],
};

export const ARROW_DATA = {
  normal: {
    name: "普通の矢",
    power: 0,
    effect: "normal",
    equip_type: "arrow",
    price: 10,
    arrow_count: 3,
    arrows_remaining: 3,
    effect_text: "攻撃力依存の通常矢",
  },

  poison: {
    name: "毒の矢",
    power: 15,
    effect: "poison",
    equip_type: "arrow",
    price: 15,
    arrow_count: 3,
    arrows_remaining: 3,
    effect_text: "15ダメ+毒付与（各ターン終了時3ダメ×2T）",
  },

  freeze: {
    name: "氷結の矢",
    power: 15,
    effect: "freeze",
    equip_type: "arrow",
    price: 15,
    arrow_count: 3,
    arrows_remaining: 3,
    effect_text: "15ダメ+氷結付与（攻撃力-2累積）",
  },

  counter: {
    name: "反撃の矢",
    power: 10,
    effect: "counter",
    equip_type: "arrow",
    price: 10,
    arrow_count: 3,
    arrows_remaining: 3,
    effect_text: "10ダメ+前のターンの被ダメの半分で反撃",
  },

  def_down: {
    name: "防御低下の矢",
    power: 10,
    effect: "def_down",
    equip_type: "arrow",
    icon_src: "Assets/item_icons/arrow_def_down.png",
    price: 15,
    arrow_count: 3,
    arrows_remaining: 3,
    effect_text: "10ダメ+相手の防御力-1（3T・重複あり）",
  },
};


// =========================================================
// 人形使い：衣装アイテム定義
// =========================================================
export const DOLL_COSTUME_PARTS = ["head", "body", "leg", "foot"];
export const DOLL_COSTUME_TYPES = ["ATK", "DEF", "CHARGE"];

// ★ 衣装生成用ヘルパー
export function createDollCostume({ part, effect_type, star }) {

  // 効果量計算
  const value =
    effect_type === "CHARGE"
      ? 1 + star
      : 1 + star * 2;

  // 効果説明文
  let effect_text = "";
  if (effect_type === "ATK") {
    effect_text = `人形の攻撃力 +${value}`;
  } else if (effect_type === "DEF") {
    effect_text = `人形の防御力 +${value}`;
  } else if (effect_type === "CHARGE") {
    effect_text = `毎ターンチャージ +${value}`;
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

    price: (10 + star * 5) - (effect_type === "CHARGE" ? 5 : 10)
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
  DUR: "耐久",
  CHARGE: "チャージ"
};
