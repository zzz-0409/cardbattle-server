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
  9: { name: "召喚士", coin: 10, atk_bonus: -3, def_bonus: 0, heal_bonus: 0, coin_per_turn_bonus: 0, skill_bonus: 0 },
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
      name: "パワースラッシュ",
      min_level: 1,
      power: 20,
      effect: "防御無視",
      description: "防御力を無視して20ダメージを与える。",
    },
    {
      type: "warrior_2",
      name: "ブレイブチャージ",
      min_level: 2,
      power: 30,
      effect: "攻撃力+3（3T）",
      description: "防御無視30ダメージを与え、攻撃力が3上昇（3T）。",
    },
    {
      type: "warrior_3",
      name: "ラストブレード",
      min_level: 3,
      power: "10 + 現在攻撃力",
      effect: "防御無視",
      description: "基礎10＋自身の攻撃力分の防御無視ダメージを与える。",
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
      name: "シールドブレイク",
      min_level: 1,
      power: 20,
      effect: "自身に防御力+2（4T）",
      description: "20ダメージを与え、自身の防御力を2上昇（4T）。",
    },
    {
      type: "knight_2",
      name: "アイアンチャージ",
      min_level: 2,
      power: "15 + 自身の防御力",
      effect: "防御力+4（3T）",
      description: "防御依存ダメージ（15＋DEF）を与え、防御力+4（3T）。",
    },
    {
      type: "knight_3",
      name: "ジャスティスブレード",
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
      name: "スラッシュ＆スティール",
      min_level: 1,
      power: 25,
      effect: "アイテム/装備を1つ奪う",
      description: "25ダメージ＋相手のアイテムか装備を1つ奪う。",
    },
    {
      type: "thief_2",
      name: "ダガーレイド",
      min_level: 2,
      power: "25 + 所持アイテム×2",
      effect: "奪う",
      description: "所持アイテム数で強化されたダメージ＋奪う。",
    },
    {
      type: "thief_3",
      name: "シャドウバースト",
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
      name: "式神召喚・上級",
      min_level: 2,
      effect: "ランダム式神（全種）",
      power: null,
      description: "全種類からランダムで式神を召喚する。",
    },
    {
      type: "onmyoji_3",
      name: "二重召喚",
      min_level: 3,
      effect: "式神2体同時召喚",
      power: null,
      description: "式神を2種類召喚する。",
    },
  ],

  "錬金術師": [
    {
      type: "alchemist_1",
      name: "錬成",
      min_level: 1,
      effect: "装備2つ生成",
      power: null,
      description: "ランダム装備を2つ生成し入手する。",
    },
    {
      type: "alchemist_2",
      name: "精錬",
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
      name: "集中射撃",
      min_level: 1,
      power: null,
      effect: "追撃+1（3T）＋通常攻撃",
      description: "3Tの間、追撃が+1回される。その後、通常攻撃を行う。",
    },
    {
      type: "archer_2",
      name: "狙い撃ち＋矢拡張",
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

  "召喚士": [
    {
      type: "summoner_1",
      name: "竜卵契約",
      min_level: 1,
      power: null,
      effect: "竜の卵を1つ入手",
      description: "未契約の竜の卵を1つ選び、手元に加える。",
    },
    {
      type: "summoner_2",
      name: "成長促進",
      min_level: 2,
      power: null,
      effect: "卵/竜の成長段階+1",
      description: "卵なら幼体へ、幼体なら成体へ成長させる。成体には使用できない。",
    },
    {
      type: "summoner_3",
      name: "竜脈解放",
      min_level: 3,
      power: null,
      effect: "2T全竜前衛効果＋通常攻撃",
      description: "2Tの間、すべての竜が前衛効果を発揮する。その後、通常攻撃を行う。",
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

// =========================================================
// 召喚士：竜・卵・餌定義
// =========================================================
export const SUMMONER_HATCH_TURNS = 3;
export const SUMMONER_GROWTH_MAX = 10;
export const SUMMONER_EGG_PRICE = 30;
export const SUMMONER_FEED_PRICE = 10;
export const SUMMONER_FEED_GROWTH = 1;

export const SUMMONER_DRAGON_DATA = {
  tiamat: {
    type: "tiamat",
    name: "ティアマト",
    egg_color: "赤",
    icon_src: "Assets/summoner/icon-tiamat.png",
    egg_icon_src: "Assets/summoner/egg-tiamat.png",
    juvenile_src: "Assets/summoner/dragon-tiamat-juvenile.png",
    adult_src: "Assets/summoner/dragon-tiamat-adult.png",
    effect_text: "召喚士行動後、防御無視ダメージを与える",
  },
  nidhogg: {
    type: "nidhogg",
    name: "ニーズヘッグ",
    egg_color: "青",
    icon_src: "Assets/summoner/icon-nidhogg.png",
    egg_icon_src: "Assets/summoner/egg-nidhogg.png",
    juvenile_src: "Assets/summoner/dragon-nidhogg-juvenile-clean.png",
    adult_src: "Assets/summoner/dragon-nidhogg-adult-clean.png",
    effect_text: "召喚士行動後、毒や攻撃低下を与える",
  },
  fafnir: {
    type: "fafnir",
    name: "ファフニール",
    egg_color: "黄",
    icon_src: "Assets/summoner/icon-fafnir.png",
    egg_icon_src: "Assets/summoner/egg-fafnir.png",
    juvenile_src: "Assets/summoner/dragon-fafnir-juvenile.png",
    adult_src: "Assets/summoner/dragon-fafnir-adult.png",
    effect_text: "召喚士の防御を高め、成体前衛時は受けたダメージを反射する",
  },
};

export const SUMMONER_DRAGON_TYPES = Object.keys(SUMMONER_DRAGON_DATA);

export function createSummonerEggItem(type) {
  const data = SUMMONER_DRAGON_DATA[type];
  if (!data) return null;
  return {
    uid: crypto.randomUUID(),
    name: `竜の卵（${data.egg_color}）`,
    price: SUMMONER_EGG_PRICE,
    is_summoner_egg: true,
    summoner_dragon_type: type,
    icon_src: data.egg_icon_src,
    effect_text: `${data.name}の卵。所持して3T経過すると幼体になる。`,
    is_equip: false,
  };
}

export function createSummonerFeedItem() {
  return {
    uid: crypto.randomUUID(),
    name: "竜の餌",
    price: SUMMONER_FEED_PRICE,
    is_summoner_feed: true,
    icon_src: "Assets/summoner/feed.png",
    effect_text: `幼体の成長値+${SUMMONER_FEED_GROWTH}。`,
    is_equip: false,
  };
}

export const ARROW_DATA = {
  normal: {
    name: "普通の矢",
    power: 0,
    effect: "normal",
    equip_type: "arrow",
    price: 15,
    arrow_count: 3,
    arrows_remaining: 3,
    effect_text: "攻撃力依存の通常矢",
  },

  poison: {
    name: "毒の矢",
    power: 15,
    effect: "poison",
    equip_type: "arrow",
    price: 20,
    arrow_count: 3,
    arrows_remaining: 3,
    effect_text: "15ダメ+毒付与（各ターン終了時2ダメ×2T）",
  },

  freeze: {
    name: "氷結の矢",
    power: 15,
    effect: "freeze",
    equip_type: "arrow",
    price: 20,
    arrow_count: 3,
    arrows_remaining: 3,
    effect_text: "15ダメ+氷結付与（攻撃力-2累積）",
  },

  counter: {
    name: "反撃の矢",
    power: 10,
    effect: "counter",
    equip_type: "arrow",
    price: 15,
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
    price: 20,
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
