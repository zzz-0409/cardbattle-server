// （import 群は変更なし）
import WebSocket, { WebSocketServer } from "ws";
import { Player } from "./player.js";
import { LEVEL_REQUIREMENTS, JOB_TEMPLATE, ARROW_DATA, createDollCostume, DOLL_COSTUME_PARTS, DOLL_COSTUME_TYPES, JOB_SKILLS } from "./constants.js";
// ★ dev/simulate 用：職業データを外部から参照可能にする（本番影響なし）
export const JOB_DATA = JOB_TEMPLATE;

import crypto from "crypto";
import { generateOneShopItem } from "./item.js";
import { generateEquipmentForLevel, upgradeEquipStar } from "./equip.js";
import { MAGE_EQUIPS } from "./equip.js";
import { getMageSlot } from "./player.js";
import { MAGE_MANA_ITEMS } from "./mage_items.js";
import { ONMYOJI_TALISMAN_ITEMS } from "./onmyoji_items.js";
import http from "http";
import {
  getOrCreateAccount,
  registerAccount,
  changeAccountName,
  getAccountSummary,
  getJobTopRankings,
  getAccountStoreInfo,
  recordMatchResult,
  recordMatchResultNoRating,
  recordCpuMatchResult,
  recordDojoProgress,
  getDojoTrailState,
  addDojoPrestige,
  addDojoTrailAttackGrowth,
  unlockDojoTrailNode,
  getSavedDojoRun,
  saveDojoRun,
  clearSavedDojoRun,
  importJobRecordBackup
} from "./account_store.js";

// =========================================================
// ★ dev / simulate 判定（本番影響なし）
// =========================================================
export const DEV_MODE = process.argv.includes("--dev-ai");



// デバッグログ ON/OFF
const DEBUG = true;
const SHOP_SLOT_COUNT = 5;

const clients = new Set();

function safeSend(ws, payload) {
  if (!ws) return;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function normalizePlayerProfile(profile = {}) {
  const iconJobId = profile?.iconJobId != null ? String(profile.iconJobId).slice(0, 32) : "";
  const titleJobId = profile?.titleJobId != null ? String(profile.titleJobId).slice(0, 32) : "";
  const titleText = profile?.titleText != null ? String(profile.titleText).slice(0, 32) : "";
  const iconSrc = profile?.iconSrc != null ? String(profile.iconSrc).slice(0, 240) : "";
  return { iconJobId, titleJobId, titleText, iconSrc };
}

function attachPlayerProfile(player, profile = {}) {
  if (!player) return player;
  player.profile = normalizePlayerProfile(profile);
  return player;
}



// ============================
// ★ 特殊装備定義生成
// ============================
function buildSpecialEquip(player) {

  switch (player.job) {

    // ----------------------------
    // 弓兵：矢スロット
    // ----------------------------
    case "弓兵": {
      // player.js の実データは arrow / arrow2 なので、それに合わせる
      const unlocked2 = (player.arrow_slots ?? 1) >= 2;

      return {
        position: "under_normal",
        slots: [
          { key: "arrow1", label: "矢1", unlocked: true,      item: player.arrow  ?? null },
          { key: "arrow2", label: "矢2", unlocked: unlocked2, item: player.arrow2 ?? null },
        ],
      };
    }

    // ----------------------------
    // 人形使い：人形装備
    // ----------------------------
    case "人形使い": {
      return {
        position: "under_doll",
        slots: [
          // player.js の実データは doll.costumes (head/body/leg/foot)
          { key: "head", label: "帽子",   unlocked: true, item: player.doll?.costumes?.head ?? null },
          { key: "body", label: "服",     unlocked: true, item: player.doll?.costumes?.body ?? null },
          { key: "leg",  label: "ズボン", unlocked: true, item: player.doll?.costumes?.leg  ?? null },
          { key: "foot", label: "靴",     unlocked: true, item: player.doll?.costumes?.foot ?? null },
        ],
      };
    }

    // ----------------------------
    // 魔導士：魔法装備
    // ----------------------------
    case "魔導士": {
      return {
        position: "under_normal",
        slots: [
          // player.js の実データは mage_equips (staff/ring/robe/book)
          { key: "staff", label: "杖",     unlocked: true, item: player.mage_equips?.staff ?? null },
          { key: "robe",  label: "ローブ", unlocked: true, item: player.mage_equips?.robe  ?? null },
          { key: "ring",  label: "指輪",   unlocked: true, item: player.mage_equips?.ring  ?? null },
          { key: "book",  label: "魔導書", unlocked: true, item: player.mage_equips?.book  ?? null },
        ],
      };
    }

    // ----------------------------
    // 錬金術師：触媒枠
    // ----------------------------
    case "錬金術師": {
      return {
        position: "under_normal",
        slots: [
          // 実データは alchemist_equip
          { key: "alchemy", label: "触媒", unlocked: true, item: player.alchemist_equip ?? null },
        ],
      };
    }

    default: {
      const dojoSpecialSlots = Math.max(1, Number(player.dojoEquipSlots?.special ?? 1));
      const equipped = [
        player.special_equipment ?? null,
        ...(player.extra_special_equipments ?? [])
      ];
      return {
        position: "under_normal",
        slots: Array.from({ length: dojoSpecialSlots }, (_, i) => ({
          key: `dojo_special_${i + 1}`,
          label: i === 0 ? "特殊" : `特殊${i + 1}`,
          unlocked: true,
          item: equipped[i] ?? null
        }))
      };
    }
  }
}

// ============================
// ★ スキル残り回数（UI用）
//   - 基本は「未使用=1 / 使用済み=0」
//   - 魔導士は mage_2 / mage_3 は使用回数制限なし（=常に1）
// ============================
function buildSkillRemaining(player) {
  const list = JOB_SKILLS?.[player.job] ?? [];
  const used = player.used_skill_set ?? new Set();
  const out = { 1: 0, 2: 0, 3: 0 };

  for (let i = 0; i < 3; i++) {
    const stype = list[i]?.type;
    const num = i + 1;
    if (!stype) {
      out[num] = 0;
      continue;
    }

    // 魔導士：スキル2/3は魔力で制御（使用済み概念なし）
    if (player.job === "魔導士" && (stype === "mage_2" || stype === "mage_3")) {
      out[num] = 1;
      continue;
    }

    out[num] = used.has(stype) ? 0 : 1;
  }

  return out;
}


// ============================
// ★ バフ表示用データ（UI用）
//   - active_buffs / freeze_debuffs をUI向けに整形
//   - 将来の拡張に対応できるよう kind ベースで返す
// ============================
function buildBuffUIData(player) {
  const out = [];

  if (player.job === "戦士") {
    out.push({
      kind: "passive_atk",
      power: 3,
      remain: null,
      source: "戦士パッシブ",
      text: "戦士パッシブ：基礎攻撃力 +3（解除不可）",
      unremovable: true,
      passive: true,
    });
  } else if (player.job === "騎士") {
    out.push({
      kind: "passive_def",
      power: 3,
      remain: null,
      source: "騎士パッシブ",
      text: "騎士パッシブ：基礎防御力 +3（解除不可）",
      unremovable: true,
      passive: true,
    });
  } else if (player.job === "僧侶") {
    out.push({
      kind: "passive_regen",
      power: 1,
      remain: null,
      source: "僧侶パッシブ",
      text: "僧侶パッシブ：自分のターン開始時、現在HPの1/40を回復（最低1 / 最大HP400 / 解除不可）",
      unremovable: true,
      passive: true,
    });
  } else if (player.job === "盗賊") {
    const coinBonus = Number(player.job_data?.coin_per_turn_bonus ?? 3);
    out.push({
      kind: "passive_coin",
      power: coinBonus,
      remain: null,
      source: "盗賊パッシブ",
      text: `盗賊パッシブ：初期コイン+5、毎ターンコイン+${coinBonus}（解除不可）`,
      unremovable: true,
      passive: true,
    });
  } else if (player.job === "錬金術師") {
    out.push({
      kind: "passive_discount",
      power: 20,
      remain: null,
      source: "錬金術師パッシブ",
      text: "錬金術師パッシブ：通常装備の購入価格20%引き（解除不可）",
      unremovable: true,
      passive: true,
    });
  }

  out.push(...buildDojoTrailBuffUIEntries(player));

  // アイテム由来（攻撃/防御バフ・デバフなど）
  if (Array.isArray(player.active_buffs)) {
    for (const b of player.active_buffs) {
      const dur = b.duration ?? b.rounds ?? 0;
      const power = Number(b.power ?? 0);
      const source = b.source ?? b.name ?? "";

      let kind = "other";
      if (b.type === "攻撃力") kind = "atk_up";
      else if (b.type === "防御力") kind = "def_up";
      else if (b.type === "攻撃力低下") kind = "atk_down";
      else if (b.type === "防御力低下") kind = "def_down";
      else if (b.type === "継続回復") kind = "regen";

      const sign = (kind.endsWith("_down") || String(b.type ?? "").includes("低下")) ? "-" : "+";
      const remain = Number(dur ?? 0);

      // ホバー説明（短く・わかりやすく）
      const text = b.permanent
        ? `${b.type ?? "効果"} ${sign}${Math.abs(power)}`
        : `${b.type ?? "効果"} ${sign}${Math.abs(power)}（あと${remain}R）`;

      out.push({
        kind,
        power,
        remain: b.permanent ? null : remain,
        source,
        text,
      });
    }
  }

  // 凍結デバフ
  if (Array.isArray(player.freeze_debuffs)) {
    for (const f of player.freeze_debuffs) {
      const remain = Number(f.rounds ?? f.duration ?? 0);
      const atkDown = Number(f.atkDown ?? 0);
      out.push({
        kind: "freeze",
        power: atkDown,
        remain,
        source: "凍結",
        text: `凍結：攻撃 -${atkDown}（あと${remain}R）`,
      });
    }
  }

  if (Array.isArray(player.dot_effects)) {
    for (const dot of player.dot_effects) {
      if (!dot) continue;
      const name = dot.name ?? "継続ダメージ";
      const remain = Number(dot.turns ?? dot.rounds ?? dot.duration ?? 0);
      const power = Number(dot.power ?? 0);
      out.push({
        kind: name === "毒" ? "poison" : name === "鬼火" ? "onibi" : "dot",
        power,
        remain,
        source: name,
        text: `${name}：${power} ダメージ（あと${remain}R）`,
      });
    }
  }

  if (player.sudden_death_debuff) {
    const power = Number(player.sudden_death_debuff.power ?? 0);
    out.push({
      kind: "sudden_death",
      power,
      remain: null,
      source: "サドンデス",
      text: `サドンデス：自分のターン開始時に防御無視${power}ダメージ（解除不可）`,
    });
  }

  if (player.isDojoEnemy && player.dojoAwakened) {
    out.push({
      kind: "mad",
      power: 1,
      remain: null,
      source: "覚醒",
      text: player.dojoEnemyId === "ashura"
        ? "覚醒：攻撃するたび攻撃力が1上昇"
        : "覚醒：特殊行動が強化され、行動確率が変化",
      unremovable: true,
    });
  }

  if (Number(player.barrier ?? 0) > 0) {
    out.push({
      kind: "barrier",
      power: Number(player.barrier ?? 0),
      remain: Number(player.barrier ?? 0),
      source: "玄武",
      text: `玄武バリア：次に受けるダメージを ${Number(player.barrier ?? 0)} 回無効化`,
    });
  }

  if (player.job === "人形使い" && Number(player.doll?.revive_guard_rounds ?? 0) > 0) {
    out.push({
      kind: "repair_guard",
      power: Number(player.doll?.revive_guard_rounds ?? 0),
      remain: Number(player.doll?.revive_guard_rounds ?? 0),
      source: "修理キット",
      text: "修理キット無敵：次に人形が受けるダメージを1回無効化",
    });
  }


  if (player.job === "弓兵" && player.archer_buff && Number(player.archer_buff.rounds ?? 0) > 0) {
    const extra = Math.max(1, Number(player.archer_buff.extra ?? 1));
    const rounds = Number(player.archer_buff.rounds ?? 0);
    out.push({
      kind: "archer_extra_attack",
      power: extra,
      remain: rounds,
      source: "追撃強化",
      text: `追撃強化：追加攻撃 +${extra}（あと${rounds}R）`,
    });
  }
  if (player.job === "弓兵" && Number(player.archer_pierce_rounds ?? (player.archer_next_pierce ? 1 : 0)) > 0) {
    const rounds = Number(player.archer_pierce_rounds ?? 1);
    out.push({
      kind: "archer_pierce",
      power: 0,
      remain: rounds,
      source: "防御貫通の矢",
      text: `矢防御貫通：追撃が防御貫通（あと${rounds}R）`,
    });
  }

  if (player.job === "人形使い" && player.doll) {
    const permanentAtkUp = Math.max(0, Number(player.doll.base_atk ?? 13) - 13);
    if (permanentAtkUp > 0) {
      out.push({
        kind: "doll_atk_up",
        power: permanentAtkUp,
        remain: null,
        source: "人形強化",
        text: `人形強化：人形の基礎攻撃力が永続で +${permanentAtkUp}`,
      });
    }

    const extraAttackCount = Number(player.doll.extra_attacks_this_turn ?? 0);
    const extraAttackRounds = Number(player.doll.extra_attack_buff?.rounds ?? 0);
    const extraAttackIgnoreDef = !!player.doll.extra_attack_ignore_def_permanent;
    const hasExtraAttackBuff =
      extraAttackCount > 0 ||
      extraAttackRounds > 0 ||
      extraAttackIgnoreDef;

    if (hasExtraAttackBuff) {
      let text = "";
      if (extraAttackIgnoreDef) {
        text = extraAttackRounds > 0
          ? `追加攻撃：防御無視が永続。あと${extraAttackRounds}R、毎回 ${Math.max(1, extraAttackCount)} 回追加攻撃`
          : "追加攻撃：防御無視が永続";
      } else {
        text = `追加攻撃：あと${extraAttackRounds}R、毎回 ${Math.max(1, extraAttackCount)} 回追加攻撃`;
      }

      out.push({
        kind: "doll_extra_attack",
        power: Math.max(1, extraAttackCount),
        remain: extraAttackRounds > 0 ? extraAttackRounds : null,
        source: "追加攻撃",
        text,
      });
    }
  }

  if (Number(player.karasu_tengu_triggers ?? 0) > 0) {
    out.push({
      kind: "karasu",
      power: Number(player.karasu_tengu_triggers ?? 0),
      remain: Number(player.karasu_tengu_triggers ?? 0),
      source: "烏天狗",
      text: `烏天狗：攻撃/スキル後に追撃（残り${Number(player.karasu_tengu_triggers ?? 0)}回）`,
    });
  }

  if (player.job === "狂人" && (player.total_damage_received ?? 0) >= 120) {
    out.push({
      kind: "mad",
      power: Math.floor(Number(player.total_damage_received ?? 0) / 5),
      remain: null,
      source: "狂化",
      text: "狂化状態\n被ダメージ後にその 1/5 回復",
    });
  }

  if (player.job === "狂人" && player.madman_rage_active) {
    out.push({
      kind: "atk_up",
      power: Math.floor(Number(player.total_damage_received ?? 0) / 20),
      remain: null,
      source: "破滅の微笑",
      text: `破滅の微笑：累積被ダメージの 1/20 だけ攻撃力上昇（現在 +${Math.floor(Number(player.total_damage_received ?? 0) / 20)}）`,
    });
  }

  if (player.job === "狂人" && player.madman_guts) {
    out.push({
      kind: "guts",
      power: 1,
      remain: 1,
      source: "我慢",
      text: "我慢\n致死ダメージを1回だけHP10で耐える",
    });
  }

  return out;
}

function buildDojoTrailBuffUIEntries(player) {
  if (!player || !Array.isArray(player.dojoTrailNodes)) return [];
  const nodes = new Set((player.dojoTrailNodes || []).map(Number));
  const out = [];
  const attackBonus = Math.max(0, Number(player._dojoTrailAttackBonusApplied ?? 0));
  const defenseBonus = Math.max(0, Number(player._dojoTrailDefenseBonusApplied ?? 0));
  const maxHpBonus = Math.max(0, Number(player._dojoTrailMaxHpBonusApplied ?? 0));
  const regen = Math.max(0, Number(player._dojoTrailRoundRegen ?? 0));
  const coinGain = Math.max(0, Number(player._dojoTrailCoinGainPercent ?? 0));
  const itemAttackGrowth = Math.max(0, Number(player.dojoItemAttackBuff ?? 0));

  if (attackBonus > 0) {
    out.push({
      kind: "passive_atk",
      power: attackBonus,
      remain: null,
      source: "軌跡",
      text: `軌跡：基礎攻撃力 +${attackBonus}（解除不可）`,
      unremovable: true,
      passive: true,
    });
  }
  if (defenseBonus > 0) {
    out.push({
      kind: "passive_def",
      power: defenseBonus,
      remain: null,
      source: "軌跡",
      text: `軌跡：基礎防御力 +${defenseBonus}（解除不可）`,
      unremovable: true,
      passive: true,
    });
  }
  if (maxHpBonus > 0) {
    out.push({
      kind: "passive_regen",
      power: maxHpBonus,
      remain: null,
      source: "軌跡",
      text: `軌跡：最大HP +${maxHpBonus}（解除不可）`,
      unremovable: true,
      passive: true,
    });
  }
  if (regen > 0) {
    out.push({
      kind: "regen",
      power: regen,
      remain: null,
      source: "生命泉の大軌跡",
      text: `軌跡：毎ラウンドHP ${regen} 回復（解除不可）`,
      unremovable: true,
      passive: true,
    });
  }
  if (coinGain > 0) {
    out.push({
      kind: "passive_coin",
      power: coinGain,
      remain: null,
      source: "軌跡",
      text: `軌跡：コイン獲得量 +${coinGain}%`,
      unremovable: true,
      passive: true,
    });
  }
  if (nodes.has(35)) {
    out.push({
      kind: "passive_atk",
      power: 1,
      remain: null,
      source: "鍛冶屋の大軌跡",
      text: "軌跡：ショップ購入時に攻撃力装備★1を追加入手",
      unremovable: true,
      passive: true,
    });
  }
  if (nodes.has(75)) {
    out.push({
      kind: "passive_atk",
      power: Math.max(1, itemAttackGrowth),
      remain: null,
      source: "闘志の秘薬",
      text: `軌跡：アイテム使用時に基礎攻撃力 +1（累積 +${itemAttackGrowth}）`,
      unremovable: true,
      passive: true,
    });
  }
  if (nodes.has(80)) {
    out.push({
      kind: "other",
      power: 2,
      remain: null,
      source: "万能の秘薬",
      text: "軌跡：アイテム使用時に効果が2回発動",
      unremovable: true,
      passive: true,
    });
  }

  return out;
}

function buildStatusBuffDescriptionList(player) {
  const base = player?.getBuffDescriptionList?.() ?? [];
  const trail = buildDojoTrailBuffUIEntries(player).map(b => b.text).filter(Boolean);
  return [...base, ...trail];
}

function buildMadStateData(player) {
  if (player.job !== "狂人") return null;

  const threshold = 120;
  const total = Number(player.total_damage_received ?? 0);

  return {
    threshold,
    total,
    remaining: Math.max(0, threshold - total),
    is_mad: total >= threshold,
  };
}

function buildAlchemistFusionCandidateData(player) {
  if (!player?.getAlchemistFusionCandidates) return [];
  return player.getAlchemistFusionCandidates().map(({ origin, obj }) => ({
    ...obj,
    is_equipped_normal: origin === "equip_slot",
  }));
}

function sampleDistinctItems(items, count) {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}

const DOLL_CHARGE_COST = 15;

function createMadSpecialItem(star = 1) {
  const value = star === 3 ? 30 : star === 2 ? 20 : 10;
  const price = star === 3 ? 30 : star === 2 ? 20 : 10;
  return {
    uid: crypto.randomUUID(),
    name: `★${star} 狂気の秘薬`,
    price,
    is_mad_special_item: true,
    self_damage: value,
    self_heal: value,
    effect_text: `使用時に ${value} ダメージを受け、その後 ${value} 回復する`,
  };
}

function createPriestSpecialItem() {
  const items = [
    {
      name: "聖なる香",
      price: 30,
      is_priest_item: true,
      priest_effect: "regen",
      effect_text: "10ラウンドの間、ターン開始時にHPを1回復する",
      is_equip: false,
    },
    {
      name: "祝福の刃",
      price: 15,
      is_priest_item: true,
      priest_effect: "blessing_attack",
      effect_text: "現在の祝福をすべて消費し、1Rの間、攻撃力を消費数の1/2アップする",
      is_equip: false,
    },
    {
      name: "大いなる祝祷",
      price: 20,
      is_priest_item: true,
      priest_effect: "blessing_heal",
      effect_text: "祝福を20消費し、HPを20回復する",
      is_equip: false,
    },
  ];
  return { ...items[Math.floor(Math.random() * items.length)] };
}

function replacePriestHpRecoveryItem(player, item) {
  if (player?.job !== "僧侶") return item;
  if (item?.effect_type !== "HP") return item;
  return createPriestSpecialItem();
}


function createBotSocket() {
  return {
    isBot: true,
    readyState: WebSocket.OPEN,
    send() {
      // CPUには送らない
    }
  };
}
// =========================================================
// ★ CPU専用：UIを通さず「Player.apply_item」でアイテム効果を適用（最新版準拠）
//   - item.js の effect_type（"攻撃力"/"防御力"/"HP"）に対応
//   - category は付いていないことがあるので見ない
// =========================================================
function cpuUseItemDirect(match, ws, item) {
  const P = ws.player;

  // 1) P.items に存在する「通常アイテム」だけ対象
  //    （装備・特殊・矢は別処理）
  if (!item) return false;
  if (item.is_equip) return false;
  if (item.is_arrow || item.equip_type === "arrow") return false;
  if (item.equip_type === "mage_equip" || item.equip_type === "alchemist_unique") return false;
  if (item.is_doll_costume) return false;

  // 2) HPが満タンなら HP回復アイテムは使わない（無駄撃ち防止）
  if (item.effect_type === "HP" && (P.hp >= P.max_hp)) return false;

  // 3) 効果適用（人間と同じ入口に統一）
  if (typeof P.apply_item !== "function") {
    // apply_item が無いなら諦める（ここをフォールバックで増やしたいなら後で足す）
    return false;
  }

  // 適用前ログ用
  const beforeHp = P.hp;

  P.apply_item(item);

  const healed = P.hp - beforeHp;
  if (healed > 0) {
    match.sendHealEvent(P, healed);
  }

  if (P.job === "陰陽師" && P.last_summoned_shikigami?.length) {
    match.sendShikigamiSummonEvent(P, P.last_summoned_shikigami);
    P.last_summoned_shikigami = [];
  }


  // 4) ログ（item.js の仕様に合わせる）
  if (item.is_onmyoji_item) {
    match.sendSystem(
      `🧪 ${P.name} が ${item.name} を使用（${item.shikigami_name}を召喚）`
    );
  } else if (item.effect_type === "HP") {
    match.sendSystem(
      `🧪 ${P.name} が ${item.name} を使用（HP ${beforeHp} → ${P.hp}）`
    );
  } else {
    const dur = item.duration ?? 0;
    match.sendSystem(
      `🧪 ${P.name} が ${item.name} を使用（${item.effect_type}+${item.power}${dur > 0 ? ` / ${dur}R` : ""}）`
    );
  }

  // 5) インベントリから削除（P.items から消す）
  P.items = (P.items ?? []).filter(i => i.uid !== item.uid);

  // 6) UI同期（重要）
  match.sendItemList(ws, P);
  match.sendStatusInfo(ws, P);
  match.sendSimpleStatusBoth();

  return true;
}


function debugLog(msg) {
  if (!DEBUG) return;
  for (const c of clients) {
    safeSend(c, { type: "debug_log", msg: String(msg) });
  }
}

const orgLog = console.log;
console.log = (...args) => {
  orgLog(...args);
  debugLog(args.join(" "));
};


const server = http.createServer();
const wss = new WebSocketServer({ server });

server.on("request", (req, res) => {
  // CORS (client may be hosted on a different origin)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // health
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  if (req.method === "GET" && req.url === "/api/ranking/storage_status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getAccountStoreInfo()));
    return;
  }

  // ----------------------------
  // API: ranking
  //   GET /api/ranking?job=戦士
  // ----------------------------
  if (req.method === "GET" && req.url && req.url.startsWith("/api/ranking")) {
    const u = new URL(req.url, "http://localhost");
    const job = u.searchParams.get("job") || "戦士";
    const data = getJobTopRankings(job, 5);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    return;
  }

  // ----------------------------
  // API: account summary
  //   GET /api/account/summary?account_id=...
  // ----------------------------
  if (req.method === "GET" && req.url && req.url.startsWith("/api/account/summary")) {
    const u = new URL(req.url, "http://localhost");
    const accountId = u.searchParams.get("account_id") || "";
    if (!accountId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "account_id required" }));
      return;
    }

    const jobs = Object.values(JOB_TEMPLATE).map(v => v.name);
    const data = getAccountSummary(accountId, jobs);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    return;
  }

  // ----------------------------
  // API: register (initial login)
  //   POST /api/account/register
  //   { account_id, name }
  // ----------------------------
  if (req.method === "POST" && req.url === "/api/account/register") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const j = JSON.parse(body || "{}");
        const accountId = String(j.account_id || "");
        const name = String(j.name || "");
        const backupJobs = (j.backup_jobs && typeof j.backup_jobs === "object") ? j.backup_jobs : null;
        if (!accountId || !name) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, reason: "account_id and name required" }));
          return;
        }
        // ensure exists
        getOrCreateAccount(accountId);
        const data = registerAccount({ accountId, name });

        // client backup restore (localStorage -> server)
        // サーバ側が初期化状態の場合のみ反映（不正上書き抑制）
        if (backupJobs) {
          try {
            importJobRecordBackup(accountId, backupJobs);
          } catch (e) {
            console.warn("importJobRecordBackup failed:", e);
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "invalid json" }));
      }
    });
    return;
  }

  // ----------------------------
  // API: change name
  //   POST /api/account/change_name
  //   { account_id, name }
  // ----------------------------
  if (req.method === "POST" && req.url === "/api/account/change_name") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const j = JSON.parse(body || "{}");
        const accountId = String(j.account_id || "");
        const name = String(j.name || "");
        if (!accountId || !name) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, reason: "account_id and name required" }));
          return;
        }
        const data = changeAccountName({ accountId, name });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "invalid json" }));
      }
    });
    return;
  }

  // not found
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});



let waitingPlayer = null;
// ルーム対戦：4桁コードごとの待機
const waitingRooms = new Map();


/* =========================================================
   Match クラス（1試合分）
   ========================================================= */
export class Match {
  constructor(p1, p2) {
    this.p1 = p1;
    this.p2 = p2;

    this.skill_lock = false;
    this.action_resolving = false;

    this.P1 = p1.player;
    this.P2 = p2.player;
    // ★ ここ！！（この直後）
    this.P1.opponent = this.P2;
    this.P2.opponent = this.P1;
    this.P1.match = this;
    this.P2.match = this;

    // ==============================
    // ★ マッチ種別（random / room / cpu / dojo）
    // ==============================
    this.matchType = p1.matchType || p2.matchType || "random";
    this.dojoRun = p1.dojoRun || p2.dojoRun || null;

    // ★ 切断判定のために相互参照
    try { this.p1.currentMatch = this; } catch {}
    try { this.p2.currentMatch = this; } catch {}

    // ★ ラウンドカウンタ
    this.round = 1;

    // ==============================
    // ★ 先攻・後攻決定ロジック
    // ==============================

    // p1.player.turn_order に指定があればそれを優先（CPU戦）
    // "first" | "second" | "random" | undefined
    let order = p1.player.turn_order;

    if (!order || order === "random") {
      // 対人戦 or CPU戦ランダム
      if (Math.random() < 0.5) {
        this.current = p1;
        this.enemy = p2;
      } else {
        this.current = p2;
        this.enemy = p1;
      }
    } else if (order === "first") {
      // 人間が先攻
      this.current = p1;
      this.enemy = p2;
    } else if (order === "second") {
      // CPUが先攻
      this.current = p2;
      this.enemy = p1;
    }

    this.ended = false;

    this.start();

  }


// ---------------------------------------------------------
// ステータス更新（攻撃・防御・バフ・式神）
// ---------------------------------------------------------
  sendStatusInfo(ws, actor) {

      const payload = {
        type: "status_info",
        attack: actor.doll ? (actor.doll.is_broken ? 0 : actor.getDollAttack()) : actor.get_total_attack(),
        defense: actor.doll ? (actor.doll.is_broken ? 0 : actor.getDollDefense()) : actor.get_total_defense(),
        buffs: buildStatusBuffDescriptionList(actor),

        // ★ これを必ず追加
        arrow_slots: actor.arrow_slots ?? 1,
      };

      
      // ★ 人形使い：人形情報を送信（攻撃/防御も含める）
      const isDollUser = actor.job === "人形使い"


      if (isDollUser && actor.doll) {
          payload.doll = {
              durability: actor.doll.durability,
              max_durability: actor.doll.max_durability,
              is_broken: actor.doll.is_broken,
              charge: Number(actor.doll.charge ?? 0),
              charge_need: DOLL_CHARGE_COST,
              pending_charge_ready: !!actor.doll.pending_charge_ready,

              // ※ getDollAttack は「壊れていると本体攻撃を返す」実装なので、表示上は 0 にする
              attack: actor.doll.is_broken ? 0 : actor.getDollAttack(),
              defense: actor.getDollDefense(),
          };
      } else {
          payload.doll = null;
      }



      // ★ 陰陽師だけ式神情報を送る
      if (actor.job === "陰陽師") {
          payload.shikigami = actor.getShikigamiList();
      } else {
          payload.shikigami = [];  // ← UIがエラーにならないよう空配列に
      }

      safeSend(ws, payload);
  }



  sendBattle(msg) {
    if (this.devMode) return;
    safeSend(this.p1, { type: "battle_log", msg });
    safeSend(this.p2, { type: "battle_log", msg });
  }


  // =========================================================
  // 演出用イベント（クライアントの damage_event / heal_event 用）
  // =========================================================

  sendSkill(msg) { 
    if (this.devMode) return;
    safeSend(this.p1, { type: "skill_log", msg });
    safeSend(this.p2, { type: "skill_log", msg });
  }

  sendSystem(msg) {
    if (this.devMode) return;
    safeSend(this.p1, { type: "system_log", msg });
    safeSend(this.p2, { type: "system_log", msg });
  }




  sendDamageEvent(targetPlayer, amount, kind = "normal", targetType = "body") {
    console.log("[SEND damage_event]", targetPlayer.name, amount, targetType);

    if (!amount || amount <= 0) return;

    const isTargetP1 = (targetPlayer === this.P1);

    const resolveTarget = (isP1, type) => {
      if (type === "doll") return isP1 ? "self_doll" : "enemy_doll";
      return isP1 ? "self" : "enemy";
    };

    // p1 視点
    safeSend(this.p1, {
      type: "damage_event",
      target: resolveTarget(isTargetP1, targetType),
      amount,
      kind,
    });

    // p2 視点（反転）
    safeSend(this.p2, {
      type: "damage_event",
      target: resolveTarget(!isTargetP1, targetType),
      amount,
      kind,
    });
  }

  sendSkillEffectEvent(targetPlayer, effect, targetType = "body") {
    if (!targetPlayer || !effect) return;

    const isTargetP1 = (targetPlayer === this.P1);
    const resolveTarget = (isP1, type) => {
      if (type === "doll") return isP1 ? "self_doll" : "enemy_doll";
      return isP1 ? "self" : "enemy";
    };

    safeSend(this.p1, {
      type: "skill_effect_event",
      target: resolveTarget(isTargetP1, targetType),
      effect,
    });

    safeSend(this.p2, {
      type: "skill_effect_event",
      target: resolveTarget(!isTargetP1, targetType),
      effect,
    });
  }

  getSkillEffectEvents(actor, target, stype, beforeHpActor = actor?.hp) {
    const targetType = target?.job === "人形使い" && target?.doll ? "doll" : "body";
    const selfType = String(stype).startsWith("doll_") && actor?.doll ? "doll" : "body";
    const targetEvent = (effect) => ({ player: target, type: targetType, effect });
    const selfEvent = (effect) => ({ player: actor, type: selfType, effect });
    const bodySelfEvent = (effect) => ({ player: actor, type: "body", effect });

    const eventMap = {
      warrior_1: [targetEvent("warrior_1_target")],
      warrior_2: [targetEvent("warrior_2_target"), bodySelfEvent("warrior_2_self")],
      warrior_3: [targetEvent("warrior_3_target")],
      knight_1: [targetEvent("knight_1_target"), bodySelfEvent("knight_1_self")],
      knight_2: [targetEvent("knight_2_target"), bodySelfEvent("knight_2_self")],
      knight_3: [targetEvent("knight_3_target")],
      priest_1: [bodySelfEvent("priest_1_self")],
      priest_2: [bodySelfEvent("priest_2_self")],
      priest_3: [targetEvent("priest_3_target")],
      thief_1: [targetEvent("thief_1_target")],
      thief_2: [targetEvent("thief_2_target")],
      thief_3: [targetEvent("thief_3_target"), bodySelfEvent("thief_3_self")],
      mage_1: [bodySelfEvent("mage_1_self")],
      mage_2: [targetEvent("mage_2_target")],
      mage_3: [targetEvent("mage_3_target")],
      onmyoji_1: [bodySelfEvent("onmyoji_1_self")],
      onmyoji_2: [bodySelfEvent("onmyoji_2_self")],
      onmyoji_3: [bodySelfEvent("onmyoji_3_self")],
      alchemist_1: [bodySelfEvent("alchemist_1_self")],
      alchemist_2: [bodySelfEvent("alchemist_2_self")],
      alchemist_3: [bodySelfEvent("alchemist_3_self")],
      archer_1: [bodySelfEvent("archer_1_self")],
      archer_2: [bodySelfEvent("archer_2_self")],
      archer_3: [bodySelfEvent("archer_3_self")],
      doll_1: [selfEvent("doll_1_self")],
      doll_2: [selfEvent("doll_2_self")],
      doll_3: [selfEvent("doll_3_self")],
      mad_2: [bodySelfEvent("mad_2_self")],
      mad_3: [bodySelfEvent("mad_3_self")],
    };

    if (stype === "mad_1") {
      const selfDamaged = Number(actor?.hp ?? 0) < Number(beforeHpActor ?? 0);
      return selfDamaged
        ? [bodySelfEvent("mad_1_self")]
        : [targetEvent("mad_1_target")];
    }

    return eventMap[stype] ?? [targetEvent(`${stype}_target`)];
  }

  sendSkillEffectEvents(actor, target, stype, beforeHpActor = actor?.hp) {
    for (const event of this.getSkillEffectEvents(actor, target, stype, beforeHpActor)) {
      this.sendSkillEffectEvent(event.player, event.effect, event.type);
    }
  }


  // ============================
  // ★ 回復イベント送信（UI用・人形対応）
  // ============================
  sendHealEvent(targetPlayer, amount, targetType = "body") {
    if (!amount || amount <= 0) return;

    if (targetType !== "doll" && targetPlayer?.job === "僧侶") {
      targetPlayer.blessing_count = Number(targetPlayer.blessing_count ?? 0) + 1;
    }

    const isTargetP1 = (targetPlayer === this.P1);

    const resolveTarget = (isP1, type) => {
      if (type === "doll") return isP1 ? "self_doll" : "enemy_doll";
      return isP1 ? "self" : "enemy";
    };

    safeSend(this.p1, {
      type: "heal_event",
      target: resolveTarget(isTargetP1, targetType),
      amount
    });

    safeSend(this.p2, {
      type: "heal_event",
      target: resolveTarget(!isTargetP1, targetType),
      amount
    });
  }

  sendShikigamiSummonEvent(player, names = []) {
    if (!Array.isArray(names) || names.length === 0) return;

    const isP1 = player === this.P1;
    const eventForP1 = {
      type: "shikigami_summon",
      target: isP1 ? "self" : "enemy",
      actor_name: player.name,
      names,
    };
    const eventForP2 = {
      type: "shikigami_summon",
      target: isP1 ? "enemy" : "self",
      actor_name: player.name,
      names,
    };

    safeSend(this.p1, eventForP1);
    safeSend(this.p2, eventForP2);
  }

  sendShikigamiSpecialEvent(player, payload = {}) {
    if (!player) return;

    const isP1 = player === this.P1;
    const eventForP1 = {
      type: "shikigami_special",
      target: isP1 ? "enemy" : "self",
      actor_name: player.name,
      ...payload,
    };
    const eventForP2 = {
      type: "shikigami_special",
      target: isP1 ? "self" : "enemy",
      actor_name: player.name,
      ...payload,
    };

    safeSend(this.p1, eventForP1);
    safeSend(this.p2, eventForP2);
  }

  sendSfxEvent(name, ws = null) {
    if (!name) return;
    const payload = { type: "sfx", name };

    if (ws) {
      safeSend(ws, payload);
    } else {
      safeSend(this.p1, payload);
      safeSend(this.p2, payload);
    }
  }

  sendBuffVisualEvent(player, sfxList = []) {
    if (!player) return;
    const sfx_list = (Array.isArray(sfxList) ? sfxList : [sfxList]).filter(Boolean);
    const isP1 = player === this.P1;
    const buffs_ui = buildBuffUIData(player);

    safeSend(this.p1, {
      type: "buff_visual_event",
      side: isP1 ? "self" : "enemy",
      buffs_ui,
      sfx_list,
    });
    safeSend(this.p2, {
      type: "buff_visual_event",
      side: isP1 ? "enemy" : "self",
      buffs_ui,
      sfx_list,
    });
  }



  sendError(msg, ws = null) {
    if (ws) {
      safeSend(ws, { type: "error_log", msg });
    } else {
      safeSend(this.p1, { type: "error_log", msg });
      safeSend(this.p2, { type: "error_log", msg });
    }
  }

  // ============================
  // ★ 中央ポップアップ通知（クライアントで表示）
  // ============================
  sendPopup(msg, ws = null, ms = 2500, sfx = null) {
    const payload = { type: "popup", msg, ms };
    if (sfx) payload.sfx = sfx;

    if (ws) {
      safeSend(ws, payload);
    } else {
      safeSend(this.p1, payload);
      safeSend(this.p2, payload);
    }
  }

  hasPendingDollCharge(actor) {
    return Array.isArray(actor?.pending_doll_charge_choices) && actor.pending_doll_charge_choices.length > 0;
  }

  resendPendingDollCharge(wsPlayer, actor) {
    if (!this.hasPendingDollCharge(actor)) return;
    if (actor.pending_doll_charge_option === "costume_boost") {
      this.sendDollChargeCostumeSelect(wsPlayer, actor);
      return;
    }
    safeSend(wsPlayer, {
      type: "doll_charge_choices",
      charge: Number(actor.doll?.charge ?? 0),
      choices: actor.pending_doll_charge_choices,
    });
  }

  getDollChargeBuffState(actor, key) {
    actor.doll.charge_buffs ??= {};
    actor.doll.charge_buffs[key] ??= { level: 1, picks: 0 };
    return actor.doll.charge_buffs[key];
  }

  buildDollChargeChoiceMeta(actor, key) {
    const state = this.getDollChargeBuffState(actor, key);
    const level = Number(state.level ?? 1);
    const isMaxLevel = level >= 5;
    const progressNeed = 1;
    const progressNow = isMaxLevel ? 1 : 0;
    const progressText = "";
    switch (key) {
      case "base_atk_up":
        return {
          title: `人形強化 Lv${level}`,
          desc: `人形の基礎攻撃力を永続で +${level} する`,
          level,
          progress_now: progressNow,
          progress_need: progressNeed,
          progress_text: progressText,
          progress_is_max: isMaxLevel,
        };
      case "extra_attack":
        if (level <= 3) {
          return {
            title: `追加攻撃 Lv${level}`,
            desc: `${level} ラウンドの間、人形が追加で1回攻撃する`,
            level,
            progress_now: progressNow,
            progress_need: progressNeed,
            progress_text: progressText,
            progress_is_max: isMaxLevel,
          };
        }
        if (level === 4) {
          return {
            title: "追加攻撃 Lv4",
            desc: "3ラウンドの間、人形が追加で2回攻撃する",
            level,
            progress_now: progressNow,
            progress_need: progressNeed,
            progress_text: progressText,
            progress_is_max: isMaxLevel,
          };
        }
        return {
          title: "追加攻撃 Lv5",
          desc: "追加攻撃が防御無視で永続化し、3ラウンドの間さらに2回追加攻撃する",
          level,
          progress_now: progressNow,
          progress_need: progressNeed,
          progress_text: progressText,
          progress_is_max: isMaxLevel,
        };
      case "gain_coins":
        return {
          title: `コイン獲得 Lv${level}`,
          desc: `コインを ${10 + (level - 1) * 5} 枚獲得する`,
          level,
          progress_now: progressNow,
          progress_need: progressNeed,
          progress_text: progressText,
          progress_is_max: isMaxLevel,
        };
      case "heal_durability":
        return {
          title: `耐久回復 Lv${level}`,
          desc: `人形耐久を ${level === 5 ? 20 : 10 + (level - 1) * 2} 回復する`,
          level,
          progress_now: progressNow,
          progress_need: progressNeed,
          progress_text: progressText,
          progress_is_max: isMaxLevel,
        };
      case "costume_boost": {
        const hasAnyCostume = !!Object.values(actor?.doll?.costumes ?? {}).some(Boolean);
        if (level === 5) {
          return {
            title: "衣装修復/強化 Lv5",
            desc: hasAnyCostume
              ? "衣装を1つ選び、星を1上げる（最大★8）。さらに装備中の全衣装の星を1上げる（最大★8）"
              : "衣装がないため今回は効果を使えない",
            level,
            progress_now: progressNow,
            progress_need: progressNeed,
            progress_text: progressText,
            progress_is_max: isMaxLevel,
          };
        }
        return {
          title: `衣装修復/強化 Lv${level}`,
          desc: hasAnyCostume
            ? `衣装を ${level} 回選び、ぼろぼろなら修理、通常なら星を1上げる（同じ衣装も選択可 / 最大★8）`
            : "衣装がないため今回は効果を使えない",
          level,
          progress_now: progressNow,
          progress_need: progressNeed,
          progress_text: progressText,
          progress_is_max: isMaxLevel,
        };
      }
      default:
        return {
          title: `チャージ効果 Lv${level}`,
          desc: "チャージ効果を発動する",
          level,
          progress_now: progressNow,
          progress_need: progressNeed,
          progress_text: progressText,
          progress_is_max: isMaxLevel,
        };
    }
  }

  advanceDollChargeBuffLevel(actor, key) {
    const state = this.getDollChargeBuffState(actor, key);
    state.picks = 0;
    state.level = state.level >= 5 ? 1 : Number(state.level ?? 1) + 1;
  }

  buildDollChargeParts(actor, excluded = []) {
    return Object.entries(actor.doll?.costumes ?? {})
      .filter(([, costume]) => !!costume && Number(costume?.star ?? 1) < 8)
      .map(([p, costume]) => ({
        key: p,
        label: { head: "帽子", body: "服", leg: "ズボン", foot: "靴" }[p] ?? p,
        name: costume?.name ?? "衣装",
        condition: costume?.condition ?? "normal",
        star: Number(costume?.star ?? 1),
      }));
  }

  countDollChargeCostumeCapacity(actor) {
    return Object.values(actor.doll?.costumes ?? {}).reduce((sum, costume) => {
      if (!costume) return sum;
      const star = Number(costume?.star ?? 1);
      if (star >= 8) return sum;
      return sum + (8 - star) + (costume?.condition === "boroboro" ? 1 : 0);
    }, 0);
  }

  sendDollChargeCostumeSelect(wsPlayer, actor) {
    const ctx = actor.pending_doll_charge_context ?? {};
    const parts = this.buildDollChargeParts(actor, ctx.selectedParts ?? []);
    safeSend(wsPlayer, {
      type: "doll_charge_costume_select",
      parts,
      remaining: Number(ctx.remaining ?? 1),
      level: Number(ctx.level ?? 1),
    });
  }

  finalizeDollChargeChoice(wsPlayer, actor, key, popupMsg) {
    actor.doll.charge -= DOLL_CHARGE_COST;
    actor.doll.pending_charge_ready = false;
    actor.pending_doll_charge_choices = null;
    actor.pending_doll_charge_option = null;
    actor.pending_doll_charge_context = null;
    this.advanceDollChargeBuffLevel(actor, key);

    this.sendPopup(popupMsg, wsPlayer, 2500);
    this.sendStatusInfo(wsPlayer, actor);
    this.sendStatusInfo(this.p1, this.P1);
    this.sendStatusInfo(this.p2, this.P2);
    safeSend(wsPlayer, { type: "doll_charge_resolved" });
    this.sendSimpleStatusBoth();
    this.sendItemList(wsPlayer, actor);
    safeSend(wsPlayer, { type: "coin_info", coins: actor.coins });

    if (Number(actor.doll.charge ?? 0) >= DOLL_CHARGE_COST) {
      actor.doll.pending_charge_ready = true;
    }
    return true;
  }

  requestDollChargeChoices(wsPlayer, actor) {
    if (actor.job !== "人形使い" || !actor.doll) {
      this.sendError("❌ 人形が存在しません。", wsPlayer);
      return false;
    }
    if (Number(actor.doll.charge ?? 0) < DOLL_CHARGE_COST) {
      this.sendError(`❌ チャージが足りません。（${Number(actor.doll.charge ?? 0)} / ${DOLL_CHARGE_COST}）`, wsPlayer);
      return false;
    }
    if (this.hasPendingDollCharge(actor)) {
      this.resendPendingDollCharge(wsPlayer, actor);
      return true;
    }
    actor.doll.pending_charge_ready = true;
    return this.triggerDollChargeChoices(wsPlayer, actor);
  }
  getDollChargeOptionPool(actor) {
    return [
      "base_atk_up",
      "extra_attack",
      "gain_coins",
      "heal_durability",
      "costume_boost",
    ].map(key => ({ key, ...this.buildDollChargeChoiceMeta(actor, key) }));
  }

  triggerDollChargeChoices(wsPlayer, actor) {
    if (actor.job !== "人形使い" || !actor.doll) return false;
    if (this.hasPendingDollCharge(actor)) return false;
    if (Number(actor.doll.charge ?? 0) < DOLL_CHARGE_COST) return false;

    actor.pending_doll_charge_option = null;
    actor.pending_doll_charge_choices = sampleDistinctItems(
      this.getDollChargeOptionPool(actor),
      3
    );

    if (wsPlayer?.isBot) {
      const picked = actor.pending_doll_charge_choices[
        Math.floor(Math.random() * actor.pending_doll_charge_choices.length)
      ];
      if (picked?.key === "costume_boost") {
        const parts = Object.entries(actor.doll.costumes ?? {})
          .filter(([, costume]) => !!costume && Number(costume?.star ?? 1) < 8)
          .map(([part]) => part);
        const part = parts.length > 0
          ? parts[Math.floor(Math.random() * parts.length)]
          : null;
        return this.resolveDollChargeChoice(wsPlayer, actor, picked.key, part);
      }
      return this.resolveDollChargeChoice(wsPlayer, actor, picked?.key ?? "");
    }

    safeSend(wsPlayer, {
      type: "doll_charge_choices",
      charge: Number(actor.doll.charge ?? 0),
      choices: actor.pending_doll_charge_choices,
    });
    this.sendStatusInfo(wsPlayer, actor);
    this.sendSimpleStatusBoth();
    return true;
  }

  resolveDollChargeChoice(wsPlayer, actor, key, part = null) {
    if (actor.job !== "人形使い" || !actor.doll) return false;
    if (Number(actor.doll.charge ?? 0) < DOLL_CHARGE_COST) {
      actor.pending_doll_charge_choices = null;
      actor.pending_doll_charge_option = null;
      actor.pending_doll_charge_context = null;
      actor.doll.pending_charge_ready = false;
      this.sendError("❌ チャージが足りません。", wsPlayer);
      return false;
    }

    const choices = Array.isArray(actor.pending_doll_charge_choices)
      ? actor.pending_doll_charge_choices
      : [];
    const choice = choices.find(c => c.key === key);
    if (!choice) {
      this.sendError("❌ 選択できないチャージ効果です。", wsPlayer);
      return false;
    }

    const level = Number(this.getDollChargeBuffState(actor, key).level ?? 1);

    if (key === "costume_boost") {
      const existingCtx = actor.pending_doll_charge_context ?? null;
      const selectedParts = Array.isArray(existingCtx?.selectedParts)
        ? existingCtx.selectedParts.map(String)
        : [];

      if (!part) {
        const availableParts = this.buildDollChargeParts(actor, selectedParts);
        if (availableParts.length === 0) {
          actor.pending_doll_charge_choices = null;
          actor.pending_doll_charge_option = null;
          actor.pending_doll_charge_context = null;
          this.sendPopup("強化できる衣装がありません。", wsPlayer, 2500);
          this.sendStatusInfo(wsPlayer, actor);
          this.sendSimpleStatusBoth();
          if (Number(actor.doll.charge ?? 0) >= DOLL_CHARGE_COST) {
            actor.doll.pending_charge_ready = true;
          }
          return true;
        }

        actor.pending_doll_charge_option = key;
        actor.pending_doll_charge_context = {
          level,
          selectedParts,
          remaining: level === 5
            ? 1
            : Math.min(level, this.countDollChargeCostumeCapacity(actor)),
        };
        this.sendDollChargeCostumeSelect(wsPlayer, actor);
        return true;
      }

      const costume = actor.doll.costumes?.[part];
      if (!costume || Number(costume?.star ?? 1) >= 8) {
        this.sendError("❌ その衣装は選択できません。", wsPlayer);
        return false;
      }

      actor.pending_doll_charge_option = key;
      const popupMessages = [];

      if (level === 5) {
        const beforeName = costume.name ?? "衣装";
        costume.star = Math.min(8, Number(costume.star ?? 1) + 1);
        actor.updateCostumeDisplayName(costume);
        popupMessages.push(`⭐ ${beforeName} の星が 1 上がった！`);

        for (const eq of Object.values(actor.doll.costumes ?? {})) {
          if (!eq) continue;
          eq.star = Math.min(8, Number(eq.star ?? 1) + 1);
          actor.updateCostumeDisplayName(eq);
        }
        popupMessages.push("✨ 装備中の全ての衣装の星が 1 上がった！");
        return this.finalizeDollChargeChoice(
          wsPlayer,
          actor,
          key,
          popupMessages.join("\n")
        );
      }

      const beforeName = costume.name ?? "衣装";
      if (costume.condition === "boroboro") {
        costume.condition = "normal";
        actor.updateCostumeDisplayName(costume);
        popupMessages.push(`🧵 ${beforeName} を修理した！`);
      } else {
        costume.star = Math.min(8, Number(costume.star ?? 1) + 1);
        actor.updateCostumeDisplayName(costume);
        popupMessages.push(`⭐ ${beforeName} の星が 1 上がった！`);
      }

      const nextSelectedParts = [...selectedParts, String(part)];
      const remainingCapacity = this.countDollChargeCostumeCapacity(actor);
      const remaining = Math.max(
        0,
        Math.min(level, nextSelectedParts.length + remainingCapacity) - nextSelectedParts.length
      );

      if (remaining > 0) {
        actor.pending_doll_charge_context = {
          level,
          selectedParts: nextSelectedParts,
          remaining,
        };
        this.sendPopup(`衣装を強化した！ あと ${remaining} 回選択してください。`, wsPlayer, 1800);
        if (wsPlayer?.isBot) {
          const nextParts = this.buildDollChargeParts(actor, nextSelectedParts);
          if (nextParts.length > 0) {
            const nextPart = nextParts[Math.floor(Math.random() * nextParts.length)];
            return this.resolveDollChargeChoice(wsPlayer, actor, key, nextPart?.key ?? null);
          }
        }
        this.sendDollChargeCostumeSelect(wsPlayer, actor);
        this.sendStatusInfo(wsPlayer, actor);
        this.sendSimpleStatusBoth();
        this.sendItemList(wsPlayer, actor);
        return true;
      }

      return this.finalizeDollChargeChoice(
        wsPlayer,
        actor,
        key,
        popupMessages.join("\n")
      );
    }

    let popupMsg = "チャージ効果を発動した！";

    if (key === "base_atk_up") {
      actor.doll.base_atk += level;
      popupMsg = `🪆 人形の基礎攻撃力が ${level} 上がった！`;
    } else if (key === "extra_attack") {
      const totalRounds = level <= 3 ? level : 3;
      const attacksPerTurn = level >= 4 ? 2 : 1;
      const ignoreDef = level >= 5;
      actor.doll.extra_attacks_this_turn = attacksPerTurn;
      actor.doll.extra_attack_buff = {
        rounds: Math.max(0, totalRounds - 1),
        attacks_per_turn: attacksPerTurn,
        ignore_def: ignoreDef,
      };
      if (ignoreDef) {
        actor.doll.extra_attack_ignore_def_permanent = true;
      }
      popupMsg = ignoreDef
        ? "⚡ 追加攻撃が防御無視で永続化し、3ラウンドの間さらに2回追加攻撃する！"
        : `⚡ ${totalRounds} ラウンドの間、人形が追加で ${attacksPerTurn} 回攻撃する！`;
    } else if (key === "gain_coins") {
      const gain = 10 + (level - 1) * 5;
      actor.coins += gain;
      popupMsg = `💰 コインを ${gain} 枚獲得した！`;
    } else if (key === "heal_durability") {
      const healAmount = level === 5 ? 20 : 10 + (level - 1) * 2;
      const before = Number(actor.doll.durability ?? 0);
      actor.doll.durability = Math.min(
        Number(actor.doll.max_durability ?? before),
        before + healAmount
      );
      const healed = actor.doll.durability - before;
      if (healed > 0) {
        this.sendHealEvent(actor, healed, "doll");
      }
      popupMsg = `🔧 人形耐久が ${before} → ${actor.doll.durability} に回復した！`;
    }

    return this.finalizeDollChargeChoice(wsPlayer, actor, key, popupMsg);
  }

  /* =========================================================
     試合開始
     ========================================================= */
  start() {
    this.sendSystem("🎮 バトル開始！");

    // ★ プレイヤー職業をクライアントへ送信
    safeSend(this.p1, { type: "job_info", job: this.P1.job });
    safeSend(this.p2, { type: "job_info", job: this.P2.job });

    this.updateHP();

  // ★ 弓兵：初期矢を server 側で装備（状態決定はここだけ）
  for (const P of [this.P1, this.P2]) {
    if (P.job === "弓兵" && !P.arrow) {
      const basicArrow = {
        ...ARROW_DATA.normal,
        uid: crypto.randomUUID(),
        is_arrow: true,
        equip_type: "arrow"
      };
      P.arrow = basicArrow;
    }
  }

    // ★ 先攻1ラウンド目用：ショップを事前生成
    this.P1.shop_items = this.generateShopList(this.P1);
    this.P2.shop_items = this.generateShopList(this.P2);

    // ★ 初期コイン送信
    safeSend(this.p1, { type: "coin_info", coins: this.P1.coins });
    safeSend(this.p2, { type: "coin_info", coins: this.P2.coins });

    // ★ 初期レベル情報を送信
    safeSend(this.p1, {
      type: "level_info",
      level: this.P1.level,
      canLevelUp: this.P1.can_level_up()
    });
    safeSend(this.p2, {
      type: "level_info",
      level: this.P2.level,
      canLevelUp: this.P2.can_level_up()
    });

    // EXP 情報（初期0）
    safeSend(this.p1, { type: "exp_info", exp: this.P1.exp });
    safeSend(this.p2, { type: "exp_info", exp: this.P2.exp });

    this.startRound();      // ★ これを追加

  }

  // ★ 変更（旧 startTurn）
  startRound() {

    const actorWS = this.current;
    const actor = (actorWS === this.p1 ? this.P1 : this.P2);

    // ★ 1ターンのアイテム使用回数（消費アイテム）をリセット
    actor.item_use_count = 0;

    if (actor.job === "人形使い" && actor.doll && actor.doll.pending_revive) {
      actor.doll.is_broken = false;
      actor.doll.pending_revive = false;
      actor.doll.revive_guard_rounds = 0;
      actor.doll.repair_kit_lock_rounds = 0;
      actor.doll.durability = Math.min(Number(actor.doll.max_durability ?? 50), 50);
      this.sendHealEvent(actor, actor.doll.durability, "doll");
    }

    const battleRound = Math.ceil(Number(this.round ?? 1) / 2);
    if (battleRound >= 30) {
      if (!this.suddenDeathAnnounced) {
        this.suddenDeathAnnounced = true;
        const warningText = "⚠ サドンデスモードに突入！以降、自分のターン開始時に防御無視ダメージを受けます";
        this.sendSystem(warningText);
        this.sendBattle(warningText);
        this.sendPopup(warningText, null, 3600, "boom");
      }
      const suddenDamage = 10 + Math.max(0, battleRound - 30);
      actor.sudden_death_debuff = {
        power: suddenDamage,
        round: battleRound,
        unremovable: true
      };
      let dealtSudden = 0;
      if (actor.job === "人形使い" && actor.doll) {
        const beforeDoll = Number(actor.doll.durability ?? 0);
        actor.doll.durability = Math.max(0, beforeDoll - suddenDamage);
        dealtSudden = Math.max(0, beforeDoll - Number(actor.doll.durability ?? 0));
        if (dealtSudden > 0) {
          this.sendDamageEvent(actor, dealtSudden, "dot", "doll");
        }
        if (actor.doll.durability <= 0) {
          const beforeBreakHp = Number(actor.hp ?? 0);
          actor.hp = Math.max(0, beforeBreakHp - 50);
          const breakDamage = Math.max(0, beforeBreakHp - Number(actor.hp ?? 0));
          if (breakDamage > 0) {
            this.sendDamageEvent(actor, breakDamage, "dot", "body");
          }
          actor.doll.is_broken = false;
          actor.doll.pending_revive = false;
          actor.doll.revive_guard_rounds = 0;
          actor.doll.repair_kit_lock_rounds = 0;
          actor.doll.durability = Math.min(Number(actor.doll.max_durability ?? 50), 50);
        }
      } else {
        const beforeSuddenHp = Number(actor.hp ?? 0);
        actor.hp = Math.max(0, beforeSuddenHp - suddenDamage);
        dealtSudden = Math.max(0, beforeSuddenHp - Number(actor.hp ?? 0));
        if (dealtSudden > 0) {
          this.sendDamageEvent(actor, dealtSudden, "dot", "body");
        }
      }
      this.sendSystem(`サドンデス：${actor.name} は防御無視 ${suddenDamage} ダメージを受けた`);
      if (actor.hp <= 0) {
        this.updateHP();
        this.sendSimpleStatusBoth();
        this.finishBattle(actorWS === this.p1 ? "p2" : "p1");
        return;
      }
    }

    if (actor.job === "人形使い" && actor.doll && Number(actor.doll.repair_kit_lock_rounds ?? 0) > 0) {
      actor.doll.repair_kit_lock_rounds -= 1;
    }
    if (actor.job === "人形使い" && actor.doll) {
      actor.doll.extra_attacks_this_turn = 0;
      if (actor.doll.extra_attack_buff && Number(actor.doll.extra_attack_buff.rounds ?? 0) > 0) {
        actor.doll.extra_attacks_this_turn = Number(actor.doll.extra_attack_buff.attacks_per_turn ?? 1);
        actor.doll.extra_attack_buff.rounds -= 1;
        if (Number(actor.doll.extra_attack_buff.rounds ?? 0) <= 0) {
          actor.doll.extra_attack_buff = null;
        }
      }
    }


    this.sendItemList(actorWS, actor);

    if (actor.job === "僧侶") {
      const passiveHeal = Math.max(1, Math.floor(Number(actor.hp ?? 0) / 40));
      const healedPassive = actor.restore_hp?.(passiveHeal) ?? 0;
      if (healedPassive > 0) {
        this.sendHealEvent(actor, healedPassive);
      }

      for (const b of actor.active_buffs ?? []) {
        if (b?.type !== "継続回復") continue;
        const dur = Number(b.rounds ?? b.duration ?? 0);
        if (dur <= 0) continue;
        const healed = actor.restore_hp?.(Number(b.power ?? 0)) ?? 0;
        if (healed > 0) {
          this.sendHealEvent(actor, healed);
        }
      }

      this.sendStatusInfo(actorWS, actor);
      this.sendSimpleStatusBoth();
    }

    // ===============================
    // 自己バフ：ラウンド開始時に減少
    // ===============================
    if (actor.decrease_buffs_start_of_round) {
      actor.decrease_buffs_start_of_round();
    }

    // ===============================
    // 氷結（freeze）：付与者のラウンド開始時に減少
    // ===============================
    for (const p of [this.P1, this.P2]) {
      if (!p.freeze_debuffs || p.freeze_debuffs.length === 0) continue;

      p.freeze_debuffs = p.freeze_debuffs
        .map(d => {
          if (d.owner === actor) {
            return { ...d, rounds: d.rounds - 1 };
          }
          return d;
        })
        .filter(d => d.rounds > 0);
    }




    // ▼ コイン配布（達人への道では戦闘中配布しない）
    if (this.matchType !== "dojo") {
      const bonus = actor.get_coin_bonus_per_round();
      actor.coins += (10 + bonus);
    }

    if (actor.job === "人形使い" && actor.doll) {
      actor.doll.charge = Number(actor.doll.charge ?? 0) + Number(actor.get_doll_charge_per_round?.() ?? 0);
      if (Number(actor.doll.charge ?? 0) >= DOLL_CHARGE_COST) {
        actor.doll.pending_charge_ready = true;
      }
    }

    // ▼ 魔導士装備パッシブ
    const beforeHp = actor.hp;

    actor.apply_mage_equip_effects();

    if (this.matchType === "dojo" && Number(actor._dojoTrailRoundRegen ?? 0) > 0) {
      actor.restore_hp?.(Number(actor._dojoTrailRoundRegen ?? 0));
    }

    const healed = actor.hp - beforeHp;
    if (healed > 0) {
      this.sendHealEvent(actor, healed);
    }


    // ================================
    // ★ 人形使い：暴走ラウンド進行（ラウンド開始時）
    // ================================
    if (
      actor.job === "人形使い" &&
      actor.doll &&
      actor.doll.is_rampage
    ) {
      actor.doll.rampage_rounds -= 1;

      this.sendSystem(
        `🔥 人形は暴走中… 残り ${actor.doll.rampage_rounds}R`
      );

      // --- 3R経過 → 自爆 ---
      if (actor.doll.rampage_rounds <= 0) {
        this.sendSystem("💥 暴走が限界に達した！人形が自爆した！");

        // 相互ダメージ（防御無視）
        const beforeActorHp = Number(actor.hp ?? 0);
        const enemy = actorWS === this.p1 ? this.P2 : this.P1;
        const beforeEnemyHp = Number(enemy.hp ?? 0);
        enemy.take_damage(20, true);
        this.sendDamageEvent(enemy, Math.max(0, beforeEnemyHp - Number(enemy.hp ?? 0)), "skill", "body");
        this.sendSfxEvent("boom");


        // 人形破壊・暴走解除
        actor.hp = Math.max(0, beforeActorHp - 50);
        this.sendDamageEvent(actor, Math.max(0, beforeActorHp - Number(actor.hp ?? 0)), "skill", "body");
        actor.doll.durability = Math.min(Number(actor.doll.max_durability ?? 50), 50);
        actor.doll.is_broken = false;
        actor.doll.is_rampage = false;
        actor.doll.repair_kit_lock_rounds = 0;
        actor.doll.revive_guard_rounds = 0;
        for (const costume of Object.values(actor.doll.costumes ?? {})) {
          if (costume) costume.condition = "boroboro";
        }

        this.sendSystem("🪆 人形は完全に破壊された…");
        this.sendStatusInfo(actorWS, actor);
        this.sendStatusInfo(actorWS === this.p1 ? this.p2 : this.p1, enemy);
        this.sendSimpleStatusBoth();
      }
    }

    // ================================
    // ★ 人形使い：耐久リジェネ（ラウンド開始時）
    // ================================
    if (
      actor.job === "人形使い" &&
      actor.applyDollRegen &&
      actor.doll &&
      !actor.doll.is_broken &&
      !actor.doll.is_rampage
    ) {
      const before = actor.doll.durability;

      actor.applyDollRegen();

      const after = actor.doll.durability;

      // ★ 実際に回復したときだけログ
      if (after > before) {
        this.sendSystem(
          `🪆 人形の耐久が ${before} → ${after} に回復した`
        );
      }
      const healed = after - before;
      this.sendHealEvent(actor, healed, "doll");

    }



    this.updateHP();
    safeSend(actorWS, { type: "coin_info", coins: actor.coins });

    // ▼ ショップ更新
    actor.shop_items = this.generateShopList(actor);

    safeSend(actorWS, {
      type: "coin_info",
      coins: actor.coins
    });

    // ▼ ラウンド情報送信
    this.sendRoundInfo();
    if (actor.job === "人形使い" && actor.doll && actor.doll.pending_charge_ready) {
      this.sendStatusInfo(actorWS, actor);
      this.sendSimpleStatusBoth();
    }
  }


  // ----------------------------------------
  // ★ オンラインショップ生成（オフライン版完全準拠）
  // ----------------------------------------
  generateShopList(P) {
    const list = [];
    const level = P.level;
    const ownedMageEquipSlots =
      P.job === "魔導士" ? getOwnedMageEquipSlots(P) : null;
    const availableMageEquips =
      P.job === "魔導士"
        ? MAGE_EQUIPS.filter(eq => !ownedMageEquipSlots.has(getMageSlot(eq)))
        : null;

    for (let i = 0; i < SHOP_SLOT_COUNT; i++) {
      let entry = null;
      const r = Math.random() * 100;

      // ================================
      // 人形使い：衣装＋修理キットのみ
      // ================================
      if (P.job === "人形使い") {

        // 25%：修理キット
        if (Math.random() < 0.25) {
          entry = {
            uid: crypto.randomUUID(),
            name: "修理キット",
            price: 30,
            is_doll_item: true,
            effect_text: "人形の耐久を20回復"
          };
        }
        // 75%：衣装
        else {
          const part =
            DOLL_COSTUME_PARTS[Math.floor(Math.random() * DOLL_COSTUME_PARTS.length)];

          const effect_type =
            DOLL_COSTUME_TYPES[Math.floor(Math.random() * DOLL_COSTUME_TYPES.length)];

          const star = Math.random() < 0.6
            ? 1
            : Math.random() < 0.85
              ? 2
              : 3;

          entry = createDollCostume({
            part,
            effect_type,
            star
          });
        }

        list.push({ ...entry });
        continue;
      }


      // 弓兵：70%で矢
      if (P.job === "弓兵") {
        if (r < 70) {
          const keys = Object.keys(ARROW_DATA);
          const k = keys[Math.floor(Math.random() * keys.length)];
          entry = {
            ...ARROW_DATA[k],
            is_equip: true,
            is_arrow: true,
            equip_type: "arrow"
          };
        } else {
          entry = (Math.random() < 0.5)
            ? generateEquipmentForLevel(level)
            : generateOneShopItem(level);
        }
        list.push({ ...entry });
        continue;
      }

      // 魔導士：70%魔導士装備、30%魔力水/通常アイテム/装備
      if (P.job === "魔導士") {

        if (r < 70 && availableMageEquips.length > 0) {
          entry = {
            ...availableMageEquips[
              Math.floor(Math.random() * availableMageEquips.length)
            ]
          };
        } else if (r < 70) {
          entry = (Math.random() < 0.5)
            ? generateEquipmentForLevel(level)
            : generateOneShopItem(level);
        } else {
          const r2 = Math.random();
          if (r2 < 0.5) {
            entry = { ...MAGE_MANA_ITEMS[Math.floor(Math.random() * MAGE_MANA_ITEMS.length)] };
          } else {
            entry = (Math.random() < 0.5)
              ? generateEquipmentForLevel(level)
              : generateOneShopItem(level);
          }
        }
        list.push({ ...entry });
        continue;
      }

      if (P.job === "陰陽師") {
        if (r < 40) {
          const lowTalismans = ONMYOJI_TALISMAN_ITEMS.filter(
            item => item.shikigami_rank === "low"
          );
          const highTalismans = ONMYOJI_TALISMAN_ITEMS.filter(
            item => item.shikigami_rank === "high"
          );
          const pool = (Math.random() < 0.78) ? lowTalismans : highTalismans;
          entry = { ...pool[Math.floor(Math.random() * pool.length)] };
        } else {
          entry = (Math.random() < 0.5)
            ? generateEquipmentForLevel(level)
            : generateOneShopItem(level);
        }
        list.push({ ...entry });
        continue;
      }

      if (P.job === "狂人") {
        if (r < 50) {
          entry = generateEquipmentForLevel(level);
        } else {
          entry = Math.random() < 0.5
            ? generateOneShopItem(level)
            : createMadSpecialItem(
                Math.random() < 0.6 ? 1 : Math.random() < 0.85 ? 2 : 3
              );
        }
        list.push({ ...entry });
        continue;
      }

      // 他職：50% 装備、50% アイテム
      entry = (r < 50)
        ? generateEquipmentForLevel(level)
        : generateOneShopItem(level);
      entry = replacePriestHpRecoveryItem(P, entry);

      list.push({ ...entry });
    }
    const normalized = list
      .filter(item => item && typeof item === "object")
      .slice(0, SHOP_SLOT_COUNT);

    while (normalized.length < SHOP_SLOT_COUNT) {
      const fallback = replacePriestHpRecoveryItem(P, generateOneShopItem(level));
      normalized.push({ ...fallback });
    }

    return normalized;
  }

  // ---------- ★ショップを開く ----------
  openShop(wsPlayer) {
      const P = (wsPlayer === this.p1 ? this.P1 : this.P2);
      if (wsPlayer !== this.current || this.action_resolving) {
        this.sendPopup("相手が考え中です。", wsPlayer, 1400);
        this.sendError("❌ 今は行動できません。", wsPlayer);
        return;
      }

      // ★更新禁止：基本は既存在庫をそのまま使う（欠損時だけ5枠へ修復）
      if (!Array.isArray(P.shop_items) || P.shop_items.filter(item => item && typeof item === "object").length < SHOP_SLOT_COUNT) {
        P.shop_items = this.generateShopList(P);
      }

      // ★ 既存の在庫をそのまま渡すだけ
      safeSend(wsPlayer, { 
          type: "shop_list",
          items: P.shop_items
      });
  }


  // ---------- ★購入処理（完全版） ----------
  buyItem(wsPlayer, index) {
    const P = (wsPlayer === this.p1 ? this.P1 : this.P2);
    if (wsPlayer !== this.current || this.action_resolving) {
      this.sendPopup("相手が考え中です。", wsPlayer, 1400);
      this.sendError("❌ 今は行動できません。", wsPlayer);
      return;
    }

    if (!P.shop_items || !P.shop_items[index]) {
      this.sendError("❌ 商品が存在しません。", wsPlayer);
      return;
    }
    if (P.shop_items[index].sold_out || P.shop_items[index].soldOut || P.shop_items[index].shop_sold_out) {
      this.sendPopup("この商品は売り切れです。", wsPlayer, 1800);
      this.sendError("❌ この商品は売り切れです。", wsPlayer);
      return;
    }
    

    // 取り出し（コピー）
    const item = { ...P.shop_items[index] };
    delete item.sold_out;
    delete item.soldOut;
    delete item.shop_sold_out;

    // 基本価格
    const basePrice = item.price ?? 0;
    let price = basePrice;

    // 錬金術師割引
    if (
      P.job === "錬金術師" &&
      item.is_equip &&
      item.equip_type !== "alchemist_unique"
    ) {
      price = Math.max(1, Math.floor(basePrice * 0.8));
    }

    // コインチェック
    if (P.coins < price) {
      // ★ 購入失敗（コイン不足）でも中央ポップアップを出す
      this.sendPopup(`コインが足りません（必要:${price}）`, wsPlayer, 2500);
      this.sendError(`❌ コイン不足（必要:${price}）`, wsPlayer);
      return;
    }

    // 支払い
    P.coins -= price;
    this.sendSimpleStatusBoth();
    // 固有ID付与
    item.uid = crypto.randomUUID();

    // ==============================
    // ★ 正しい分類処理（購入時）
    // ==============================
    if (item.is_arrow || item.equip_type === "arrow") {
        // 矢
        P.arrow_inventory.push(item);

    } else if (
        item.is_doll_costume &&
        P.job === "人形使い"
    ) {

        // 人形衣装 → 特殊装備インベントリ
        P.special_inventory.push(item);

    } else if (
        item.equip_type === "mage_equip" ||
        item.equip_type === "alchemist_unique"
    ) {
        // 魔導士装備・錬金特殊装備は「特殊装備インベントリ」
        P.special_inventory.push(item);

    } else if (item.is_mad_special_item) {
        P.items.push(item);

    } else if (item.is_equip) {
        // 通常装備
        P.equipment_inventory.push(item);

    } else {
        // 通常アイテム
        P.items.push(item);
    }

    // 再購入不可にしつつ、ショップ上には売り切れ表示として残す
    P.shop_items[index] = {
      ...P.shop_items[index],
      sold_out: true,
      soldOut: true,
      shop_sold_out: true
    };

    // ★ 購入後もショップを開いたまま更新できるよう、最新リストを返す
    safeSend(wsPlayer, {
      type: "shop_list",
      items: P.shop_items
    });


    // ------------------------------
    // ★ コイン更新＋アイテム一覧更新
    // ------------------------------
    safeSend(wsPlayer, {
      type: "coin_info",
      coins: P.coins
    });

    this.sendItemList(wsPlayer, P);

    safeSend(wsPlayer, {
      type: "purchased_item",
      item,
    });

    this.sendSystem(`🛒 ${P.name} は ${item.name} を購入した！`);

    // ★ 購入ポップアップ（購入者のみ）
    this.sendPopup(`${item.name} を購入しました`, wsPlayer, 2200);

    // ★ ラウンドは終了しない
  }

  combineNormalEquips(wsPlayer, uid1, uid2) {
    const P = (wsPlayer === this.p1 ? this.P1 : this.P2);
    const id1 = String(uid1 ?? "");
    const id2 = String(uid2 ?? "");

    if (!id1 || !id2 || id1 === id2) {
      this.sendError("❌ 合成する装備を2つ選んでください。", wsPlayer);
      return;
    }

    const allEquips = [
      ...(P.equipment ? [{ item: P.equipment, source: "equipped" }] : []),
      ...((P.equipment_inventory ?? []).map(it => ({ item: it, source: "inventory" }))),
    ];
    const pick1 = allEquips.find(entry => String(entry.item?.uid) === id1);
    const pick2 = allEquips.find(entry => String(entry.item?.uid) === id2);
    const eq1 = pick1?.item;
    const eq2 = pick2?.item;

    if (!eq1 || !eq2) {
      this.sendError("❌ 合成に必要な装備が見つかりません。", wsPlayer);
      return;
    }

    if (
      !eq1.is_equip || !eq2.is_equip ||
      eq1.equip_type !== "normal" || eq2.equip_type !== "normal"
    ) {
      this.sendError("❌ 通常装備のみ合成できます。", wsPlayer);
      return;
    }

    const star1 = Number(eq1.star ?? 1);
    const star2 = Number(eq2.star ?? 1);
    const category1 = String(eq1.equip_category ?? eq1.effect_type ?? "");
    const category2 = String(eq2.equip_category ?? eq2.effect_type ?? "");

    if (star1 !== star2 || category1 !== category2) {
      this.sendError("❌ 星と効果が同じ通常装備を2つ選んでください。", wsPlayer);
      return;
    }

    const nextEquip = upgradeEquipStar({
      ...eq1,
      uid: crypto.randomUUID(),
    });

    P.equipment_inventory = (P.equipment_inventory ?? []).filter(it =>
      String(it?.uid) !== id1 && String(it?.uid) !== id2
    );
    if (P.equipment && (String(P.equipment.uid) === id1 || String(P.equipment.uid) === id2)) {
      P.equipment = null;
    }
    P.equipment_inventory.push(nextEquip);

    this.sendBattle(`🔧 ${eq1.name} を合成して ${nextEquip.name} を作成した！`);
    this.sendPopup(`${nextEquip.name} を合成しました`, wsPlayer, 2200);
    this.sendItemList(wsPlayer, P);
    this.sendStatusInfo(wsPlayer, P);
    this.sendSimpleStatusBoth();
  }

  // ---------------------------------------------------------
  // ショップ再更新（コイン支払い）
  // ---------------------------------------------------------
  shopReroll(wsPlayer) {
    const actor = (wsPlayer === this.p1 ? this.P1 : this.P2);

    const cost = 5;
    if (actor.coins < cost) {
      // ★ 更新失敗（コイン不足）でも中央ポップアップを出す
      this.sendPopup(`コインが足りません（必要:${cost}）`, wsPlayer, 2500);
      safeSend(wsPlayer, {
        type: "error_log",
        msg: `❌ コインが足りません（必要: ${cost}）`
      });
      return;
    }

    // コイン消費
    actor.coins -= cost;

    // ショップリスト再生成
    actor.shop_items = this.generateShopList(actor);

    // ショップUI更新
    safeSend(wsPlayer, { 
      type: "shop_list", 
      items: actor.shop_items
    });

    // ★★★ これが本命 ★★★
    this.sendSimpleStatusBoth();
  }


  // --------------------------------------------------------
  // ★ アイテム / 装備 / 特殊装備 / 矢 使用（完全移植版）
  // --------------------------------------------------------
  useItem(wsPlayer, uid, action, slot = 1) {
      const P = (wsPlayer === this.p1 ? this.P1 : this.P2);
      if (wsPlayer !== this.current || this.action_resolving) {
        this.sendPopup("相手が考え中です。", wsPlayer, 1400);
        this.sendError("❌ 今は行動できません。", wsPlayer);
        return;
      }

    if (action === "unequip" || action === "unequip_special") {
      const targetUid = String(uid ?? "");
      const finishUnequip = (item, destination) => {
        if (!item) return false;
        P.items ??= [];
        P.equipment_inventory ??= [];
        P.special_inventory ??= [];
        P.arrow_inventory ??= [];
        P[destination] ??= [];
        P[destination].push(item);
        if (P.recalc_mage_passives) P.recalc_mage_passives();
        if (P.recalc_stats) P.recalc_stats();
        this.sendBattle(`${item.name ?? "装備"} を外した！`);
        this.sendPopup(`${item.name ?? "装備"} を外した！`, wsPlayer, 2000);
        this.sendItemList(wsPlayer, P);
        this.sendStatusInfo(wsPlayer, P);
        this.sendSimpleStatusBoth();
        this.updateHP();
        return true;
      };

      if (P.equipment && String(P.equipment.uid ?? "") === targetUid) {
        const item = P.equipment;
        P.equipment = null;
        finishUnequip(item, "equipment_inventory");
        return;
      }
      if (Array.isArray(P.extra_equipments)) {
        const idx = P.extra_equipments.findIndex(item => String(item?.uid ?? "") === targetUid);
        if (idx >= 0) {
          const item = P.extra_equipments.splice(idx, 1)[0];
          finishUnequip(item, "equipment_inventory");
          return;
        }
      }

      if (P.arrow && String(P.arrow.uid ?? "") === targetUid) {
        const item = P.arrow;
        P.arrow = null;
        finishUnequip(item, "arrow_inventory");
        return;
      }

      if (P.arrow2 && String(P.arrow2.uid ?? "") === targetUid) {
        const item = P.arrow2;
        P.arrow2 = null;
        finishUnequip(item, "arrow_inventory");
        return;
      }

      if (P.mage_equips) {
        for (const key of Object.keys(P.mage_equips)) {
          const item = P.mage_equips[key];
          if (item && String(item.uid ?? "") === targetUid) {
            P.mage_equips[key] = null;
            finishUnequip(item, "special_inventory");
            return;
          }
        }
      }

      if (P.alchemist_equip && String(P.alchemist_equip.uid ?? "") === targetUid) {
        const item = P.alchemist_equip;
        P.alchemist_equip = null;
        finishUnequip(item, "special_inventory");
        return;
      }

      if (P.doll?.costumes) {
        for (const key of Object.keys(P.doll.costumes)) {
          const item = P.doll.costumes[key];
          if (item && String(item.uid ?? "") === targetUid) {
            P.doll.costumes[key] = null;
            finishUnequip(item, "special_inventory");
            return;
          }
        }
      }

      if (P.special_equipped && String(P.special_equipped.uid ?? "") === targetUid) {
        const item = P.special_equipped;
        P.special_equipped = null;
        finishUnequip(item, "special_inventory");
        return;
      }
      if (P.special_equipment && String(P.special_equipment.uid ?? "") === targetUid) {
        const item = P.special_equipment;
        P.special_equipment = null;
        finishUnequip(item, "special_inventory");
        return;
      }
      if (Array.isArray(P.extra_special_equipments)) {
        const idx = P.extra_special_equipments.findIndex(item => String(item?.uid ?? "") === targetUid);
        if (idx >= 0) {
          const item = P.extra_special_equipments.splice(idx, 1)[0];
          finishUnequip(item, "special_inventory");
          return;
        }
      }

      this.sendPopup("外す装備が見つかりません", wsPlayer, 2500);
      this.sendError("❌ 外す装備が見つかりません。", wsPlayer);
      return;
    }

    // ============================
    // 1) uid からアイテムを検索（最優先）
    // ============================
    let item = null;
    let source = null;

    const pickup = (arr, name) => {
      const found = arr.find(x => x.uid === uid);
      if (found) {
        item = found;
        source = name;
      }
    };

    pickup(P.items, "items");
    pickup(P.equipment_inventory, "equipment_inventory");
    pickup(P.special_inventory, "special_inventory");
    pickup(P.arrow_inventory, "arrow_inventory");

    if (!item) {
      // ★ 使用回数が尽きた/既に消費済み等
      this.sendPopup("アイテムの使用回数がなくなりました", wsPlayer, 2500);
      this.sendError("❌ アイテムが見つかりません。", wsPlayer);
      this.sendItemList(wsPlayer, P);
      return;
    }


    // ============================
    // 0) 矢装備（slot 指定対応・即時UI更新）
    // ============================
    if (action === "arrow" && (item.is_arrow || item.equip_type === "arrow")) {

        // ★ slot 正規化（"2" → 2）
        const equipSlot = Number(slot || 1);

        let prevEquipped = null;

        // ---- slot2 指定 ----
        if (equipSlot === 2) {

            if (P.arrow_slots < 2) {
                this.sendError("❌ 矢スロット2は解放されていません。", wsPlayer);
                return;
            }

            prevEquipped = P.arrow2;

            if (P.arrow2) {
                P.arrow_inventory.push(P.arrow2);
            }

            P.arrow2 = item;
        }
        // ---- slot1 指定 ----
        else if (equipSlot === 1) {

            prevEquipped = P.arrow;

            if (P.arrow) {
                P.arrow_inventory.push(P.arrow);
            }

            P.arrow = item;
        }
        // ---- 不正 slot ----
        else {
            this.sendError("❌ 不正な矢スロット指定です。", wsPlayer);
            return;
        }

        // インベントリから削除
        P[source] = P[source].filter(x => x.uid !== uid);

        if (prevEquipped) {
            this.sendBattle(`${prevEquipped.name} と ${item.name} を付け替えた！`);
            this.sendPopup(`${prevEquipped.name} と ${item.name} を付け替えた！`, wsPlayer, 2000);
        } else {
            this.sendBattle(`${item.name} を装備した！`);
            this.sendPopup(`${item.name} を装備した！`, wsPlayer, 2000);
        }

        this.sendItemList(wsPlayer, P);
        this.sendStatusInfo(wsPlayer, P);
        this.sendSimpleStatusBoth();

        return;
    }








    // ============================
    // 3) 通常装備（攻撃/防御/コインUP）
    // ============================
    else if (
      action === "equip" &&
      item.is_equip &&
      item.equip_type === "normal"
    ) {
        P.extra_equipments = Array.isArray(P.extra_equipments) ? P.extra_equipments : [];
        const maxSlots = Math.max(1, Number(P.dojoEquipSlots?.equipment ?? 1));
        if (maxSlots > 1 && P.equipment && P.extra_equipments.length < maxSlots - 1) {
            P.extra_equipments.push(item);
            P[source] = P[source].filter(x => x.uid !== uid);
            this.sendItemList(wsPlayer, P);
            this.sendBattle(`${item.name} を追加装備した！`);
            this.sendPopup(`${item.name} を追加装備した！`, wsPlayer, 2000);
            if (P.recalc_stats) P.recalc_stats();
            this.sendStatusInfo(wsPlayer, P);
            this.sendSimpleStatusBoth();
            return;
        }
        const prevEquip = P.equipment;

        if (prevEquip) {
            P.equipment_inventory.push(prevEquip);
        }

        P.equipment = item;
        P[source] = P[source].filter(x => x.uid !== uid);
        // ★ 使用後、所持アイテムを再送
        this.sendItemList(wsPlayer, P);

        if (prevEquip) {
            this.sendBattle(`${prevEquip.name} と ${item.name} を付け替えた！`);
            this.sendPopup(`${prevEquip.name} と ${item.name} を付け替えた！`, wsPlayer, 2000);
        } else {
            this.sendBattle(`${item.name} を装備した！`);
            this.sendPopup(`${item.name} を装備した！`, wsPlayer, 2000);
        }
    }



    // ============================
    // 4) 魔導士装備（杖/本/指輪/ローブ）
    // ============================
    else if (action === "special" && item.equip_type === "mage_equip") {

        // ★ 魔導士装備の slot は自動判定（getMageSlot）
        const slot = getMageSlot(item);


      const prevMageEquip = P.mage_equips[slot];

      // 既存装備を戻す
      if (prevMageEquip) {
        P.special_inventory.push(prevMageEquip);
      }

      // 装備
      P.mage_equips[slot] = item;

      // 削除
      P[source] = P[source].filter(x => x.uid !== uid);


      // パッシブ再計算
      if (P.recalc_mage_passives) P.recalc_mage_passives();

      if (prevMageEquip) {
        this.sendBattle(`${prevMageEquip.name} と ${item.name} を付け替えた！`);
        this.sendPopup(`${prevMageEquip.name} と ${item.name} を付け替えた！`, wsPlayer, 2000);
      } else {
        this.sendBattle(`${item.name} を装備した！`);
        this.sendPopup(`${item.name} を装備した！`, wsPlayer, 2000);
      }
    }
    // ============================
    // 4.5) 錬金術師 特殊装備
    // ============================
    else if (action === "special" && item.equip_type === "alchemist_unique") {

        const prevAlchemistEquip = P.alchemist_equip;

        // 既存の錬金特殊装備があれば戻す
        if (prevAlchemistEquip) {
            P.special_inventory.push(prevAlchemistEquip);
        }

        // ★ 専用スロットに装備
        P.alchemist_equip = item;

        // inventory から削除
        P[source] = P[source].filter(x => x.uid !== uid);

        if (prevAlchemistEquip) {
            this.sendBattle(`${prevAlchemistEquip.name} と ${item.name} を付け替えた！`);
            this.sendPopup(`${prevAlchemistEquip.name} と ${item.name} を付け替えた！`, wsPlayer, 2000);
        } else {
            this.sendBattle(`${item.name} を装備した！`);
            this.sendPopup(`${item.name} を装備した！`, wsPlayer, 2000);
        }
    }

    else if (action === "special" && item.equip_type === "dojo_special") {
        P.extra_special_equipments = Array.isArray(P.extra_special_equipments) ? P.extra_special_equipments : [];
        const maxSlots = Math.max(1, Number(P.dojoEquipSlots?.special ?? 1));
        if (maxSlots > 1 && P.special_equipment && P.extra_special_equipments.length < maxSlots - 1) {
            P.extra_special_equipments.push(item);
            P[source] = P[source].filter(x => x.uid !== uid);
            this.sendBattle(`${item.name} を追加装備した！`);
            this.sendPopup(`${item.name} を追加装備した！`, wsPlayer, 2000);
            this.sendItemList(wsPlayer, P);
            this.sendStatusInfo(wsPlayer, P);
            this.sendSimpleStatusBoth();
            return;
        }
        const prev = P.special_equipment;
        if (prev) {
            P.special_inventory.push(prev);
        }
        P.special_equipment = item;
        P[source] = P[source].filter(x => x.uid !== uid);
        this.sendItemList(wsPlayer, P);
        this.sendStatusInfo(wsPlayer, P);
        this.sendSimpleStatusBoth();
        this.sendBattle(`${item.name} を装備した！`);
        this.sendPopup(`${item.name} を装備した！`, wsPlayer, 2000);
    }

    // ============================
    // ★ 人形使い：衣装装備
    // ============================
    else if (
      action === "special" &&
      item.is_doll_costume &&
      P.job === "人形使い"

    ) {
        if (!P.doll) {
            this.sendError("❌ 人形が存在しません。", wsPlayer);
            return;
        }

        const part = item.part; // head / body / leg / foot

        // ★ 衣装スロットが存在しない場合のみエラー
        if (!P.doll.costumes || !(part in P.doll.costumes)) {
            this.sendError("❌ 不正な衣装部位です。", wsPlayer);
            return;
        }


        // 既存衣装があれば戻す
        const prev = P.doll.costumes[part];
        if (prev) {
            P.special_inventory.push(prev);
        }

        // 装備
        P.doll.costumes[part] = item;

        // インベントリから削除
        P[source] = P[source].filter(x => x.uid !== uid);
        if (prev) {
            this.sendBattle(`${prev.name} と ${item.name} を付け替えた！`);
            this.sendPopup(`${prev.name} と ${item.name} を付け替えた！`, wsPlayer, 2000);
        } else {
            this.sendBattle(`${item.name} を装備した！`);
            this.sendPopup(`${item.name} を装備した！`, wsPlayer, 2000);
        }

        // UI更新
        this.sendItemList(wsPlayer, P);
        this.sendStatusInfo(wsPlayer, P);
        this.sendSimpleStatusBoth();
        return;
    }

    // ============================
    // ★ 人形使い：修理キット使用
    // ============================
    if (
      action === "use" &&
      item.name === "修理キット" &&
      P.job === "人形使い"

    ) {
        if (false && Number(P.doll?.repair_kit_lock_rounds ?? 0) > 0) {
            this.sendPopup(
                "人形が壊れた次のラウンドは修理キットを使用できません。",
                wsPlayer,
                2800
            );
            this.sendError(
                "❌ 人形が壊れた次のラウンドは修理キットを使用できません。",
                wsPlayer
            );
            return;
        }
        // ★ 暴走中は修理キット使用不可
        if (false && P.doll?.is_rampage) {
            this.sendError(
                "❌ 人形が暴走中は修理キットを使用できません。",
                wsPlayer
            );
            return;
        }

        if (!P.doll) {
            this.sendError("❌ 人形が存在しません。", wsPlayer);
            return;
        }

        // ★ 1ターンに使用できる消費アイテムは2つまで
        if (P.item_use_count == null) P.item_use_count = 0;
        if (P.item_use_count >= 2) {
            // ★ ターン内の使用回数上限に達した場合も中央ポップアップ
            this.sendPopup("このターンのアイテム使用回数がなくなりました", wsPlayer, 2500);
            this.sendError("1ターンに使用できるアイテムは2つまでです。", wsPlayer);
            return;
        }
        P.item_use_count += 1;
        applyDojoTrailItemUseBonuses(wsPlayer, this, item);

        this.sendBattle(`${item.name} を使用した！`);
        this.sendPopup(`${item.name} を使用した！`, wsPlayer, 2000);

        if (true) {
            const before = P.doll.durability;
            P.doll.durability = Math.min(
                P.doll.max_durability,
                P.doll.durability + 20
            );
            this.sendSystem(`🔧 人形耐久 ${before} → ${P.doll.durability}`);
            // ★ 人形回復演出（UI用）
            const healed = P.doll.durability - before;
            if (healed > 0) {
                this.sendHealEvent(P, healed, "doll");
            }
            
        } else {
            P.doll.is_broken = false;
            P.doll.durability = 15;
            P.doll.revive_guard_rounds = 1;
            P.doll.repair_kit_lock_rounds = 0;
            for (const costume of Object.values(P.doll.costumes ?? {})) {
                if (costume?.condition === "boroboro") {
                    costume.condition = "normal";
                }
            }
            this.sendSystem(
              "🔧 人形を修理し、戦闘に復帰させた！（1T無敵）"
            );
            // ★ 人形復活演出（UI用）
            this.sendHealEvent(P, P.doll.durability, "doll");
    
        }
        // ★ 衣装スロットが undefined なら null で初期化
        P.doll.costumes ??= {
            head: null,
            body: null,
            leg: null,
            foot: null
        };

        P[source] = P[source].filter(x => x.uid !== uid);

        this.sendItemList(wsPlayer, P);
        this.sendStatusInfo(wsPlayer, P);
        this.sendSimpleStatusBoth();
        return;
    }
    // ============================
    // ★ 消費アイテム共通処理
    // ============================
    if (action === "use" && !item.is_equip) {
      const consumesTurn = item.consumes_turn === true;

      // ★ 1ターンに使用できる消費アイテムは2つまで
      if (P.item_use_count == null) P.item_use_count = 0;
      if (P.item_use_count >= 2) {
        // ★ ターン内の使用回数上限に達した場合も中央ポップアップ
        this.sendPopup("このターンのアイテム使用回数がなくなりました", wsPlayer, 2500);
        this.sendError("1ターンに使用できるアイテムは2つまでです。", wsPlayer);
        this.sendItemList(wsPlayer, P);
        return;
      }

      const hpHealCap = P.job === "僧侶" ? 400 : Number(P.max_hp ?? 0);
      if (item.effect_type === "HP" && Number(P.hp ?? 0) >= hpHealCap) {
        this.sendPopup("HPが上限のため使用できません", wsPlayer, 2500);
        this.sendError("❌ HPが上限のため使用できません。", wsPlayer);
        this.sendItemList(wsPlayer, P);
        return;
      }

      if (item.is_mage_item && P.job === "魔導士" && Number(P.mana ?? 0) >= Number(P.mana_max ?? 0)) {
        this.sendPopup("魔力が上限のため使用できません", wsPlayer, 2500);
        this.sendError("❌ 魔力が上限のため使用できません。", wsPlayer);
        this.sendItemList(wsPlayer, P);
        return;
      }

      if (item.is_priest_item) {
        if (P.job !== "僧侶") {
          this.sendPopup("僧侶専用アイテムです", wsPlayer, 2500);
          this.sendError("❌ 僧侶専用アイテムです。", wsPlayer);
          this.sendItemList(wsPlayer, P);
          return;
        }

        let success = true;
        let message = `${item.name} を使用した！`;

        if (item.priest_effect === "regen") {
          P.active_buffs ??= [];
          P.active_buffs.push({
            type: "継続回復",
            power: 1,
            rounds: 10,
            source: item.name ?? "聖なる香",
            uid: crypto.randomUUID(),
          });
          message = `${item.name} を使用した！ 10Rの間、HPを1ずつ回復する`;
        } else if (item.priest_effect === "blessing_attack") {
          const consumed = Math.max(0, Number(P.blessing_count ?? 0));
          if (consumed <= 0) {
            success = false;
            message = "祝福がありません";
          } else {
            const power = Math.floor(consumed / 2);
            P.blessing_count = 0;
            if (power > 0) {
              P.active_buffs ??= [];
              P.active_buffs.push({
                type: "攻撃力",
                power,
                rounds: 1,
                source: item.name ?? "祝福の刃",
                uid: crypto.randomUUID(),
              });
            }
            message = `${item.name} を使用した！ 祝福${consumed}を消費し、攻撃力+${power}`;
          }
        } else if (item.priest_effect === "blessing_heal") {
          const blessing = Math.max(0, Number(P.blessing_count ?? 0));
          if (blessing < 20) {
            success = false;
            message = "祝福が20必要です";
          } else if (Number(P.hp ?? 0) >= 400) {
            success = false;
            message = "HPが上限のため使用できません";
          } else {
            P.blessing_count = blessing - 20;
            const beforeHp = Number(P.hp ?? 0);
            const healed = P.restore_hp?.(20) ?? 0;
            if (healed > 0) {
              this.sendHealEvent(P, healed);
              P.blessing_count = blessing - 20;
            }
            message = `${item.name} を使用した！ 祝福20を消費し、HP ${beforeHp} → ${P.hp}`;
          }
        }

        if (!success) {
          this.sendPopup(message, wsPlayer, 2500);
          this.sendError(`❌ ${message}`, wsPlayer);
          this.sendItemList(wsPlayer, P);
          return;
        }

        P.item_use_count += 1;
        applyDojoTrailItemUseBonuses(wsPlayer, this, item);
        P[source] = P[source].filter(x => x.uid !== uid);
        this.sendBattle(message);
        this.sendPopup(message, wsPlayer, 2200);
        this.sendItemList(wsPlayer, P);
        this.sendStatusInfo(wsPlayer, P);
        this.sendSimpleStatusBoth();
        return;
      }

      if (P.apply_item) {
        const beforeHp = P.hp;
        P.last_item_self_damage = 0;
        P.last_item_self_heal = 0;
        const opponent = P.opponent ?? null;
        const beforeOpponentHp = opponent ? Number(opponent.hp ?? 0) : null;
        const beforeOpponentEquip = opponent?.equipment ?? null;
        const beforeOpponentBuffCount = Array.isArray(opponent?.active_buffs)
          ? opponent.active_buffs.length
          : 0;
        const beforeOpponentBarrier = Number(opponent?.barrier ?? 0);
        const beforeSelfAttackBuff = Number(P.get_attack_buff_total?.() ?? 0);
        const beforeOpponentAttackBuff = Number(opponent?.get_attack_buff_total?.() ?? 0);
        const beforeSelfDefBuff = Number(P.get_def_buff_total?.() ?? 0) + Number(P.barrier ?? 0);
        const beforeOpponentDefBuff = Number(opponent?.get_def_buff_total?.() ?? 0) + Number(opponent?.barrier ?? 0);

        const applyResult = P.apply_item(item);
        if (applyResult === false) {
          this.sendPopup("このアイテムは使用できません", wsPlayer, 2500);
          this.sendError("❌ このアイテムは使用できません。", wsPlayer);
          this.sendItemList(wsPlayer, P);
          return;
        }

        // 達人への道：アイテム効果が2回発動（ID 80 ノード効果）
        if (Array.isArray(P.dojoTrailNodes) && P.dojoTrailNodes.includes(80)) {
          this.sendBattle(`万能の秘薬の効果で、${item.name} が再度発動する...`);
          P.apply_item(item);
        }

        P.item_use_count += 1;
        applyDojoTrailItemUseBonuses(wsPlayer, this, item);

        const selfDamage = Math.max(0, Number(P.last_item_self_damage ?? 0));
        if (selfDamage > 0) {
          this.sendDamageEvent(P, selfDamage, "normal", "body");
        }

        const healed = P.hp - beforeHp;
        if (healed > 0) {
          // ★ 回復演出イベント送信
          this.sendHealEvent(P, healed);
        }

        if (opponent && beforeOpponentHp != null) {
          const dealtToOpponent = Math.max(0, beforeOpponentHp - Number(opponent.hp ?? 0));
          if (dealtToOpponent > 0) {
            this.sendDamageEvent(opponent, dealtToOpponent, "skill", "body");
          }

          if (item.shikigami_name === "九尾") {
            if (dealtToOpponent > 0) {
              this.sendSfxEvent("boom");
            }

            const destroyedEquipName =
              beforeOpponentEquip && !opponent.equipment
                ? beforeOpponentEquip.name
                : null;
            const afterOpponentBuffCount = Array.isArray(opponent.active_buffs)
              ? opponent.active_buffs.length
              : 0;
            const removedBuffCount =
              Math.max(0, beforeOpponentBuffCount - afterOpponentBuffCount) +
              (beforeOpponentBarrier > 0 && Number(opponent.barrier ?? 0) <= 0 ? 1 : 0);

            if (destroyedEquipName || removedBuffCount > 0) {
              this.sendShikigamiSpecialEvent(P, {
                kind: "kyubi",
                destroyed_equip_name: destroyedEquipName,
                removed_buff_count: removedBuffCount,
              });
            }
          }
        }

        const afterSelfAttackBuff = Number(P.get_attack_buff_total?.() ?? 0);
        const afterOpponentAttackBuff = Number(opponent?.get_attack_buff_total?.() ?? 0);
        if (afterSelfAttackBuff > beforeSelfAttackBuff || afterOpponentAttackBuff > beforeOpponentAttackBuff) {
          this.sendSfxEvent("powerup");
        }
        const afterSelfDefBuff = Number(P.get_def_buff_total?.() ?? 0) + Number(P.barrier ?? 0);
        const afterOpponentDefBuff = Number(opponent?.get_def_buff_total?.() ?? 0) + Number(opponent?.barrier ?? 0);
        if (afterSelfDefBuff > beforeSelfDefBuff || afterOpponentDefBuff > beforeOpponentDefBuff) {
          this.sendSfxEvent("defup");
        }

        if (P.job === "陰陽師" && P.last_summoned_shikigami?.length) {
          this.sendShikigamiSummonEvent(P, P.last_summoned_shikigami);
          P.last_summoned_shikigami = [];
        }
      }
      else {
        this.sendPopup("このアイテムは使用できません", wsPlayer, 2500);
        this.sendError("❌ このアイテムは使用できません。", wsPlayer);
        this.sendItemList(wsPlayer, P);
        return;
      }

      this.sendBattle(`${item.name} を使用した！`);
      this.sendPopup(`${item.name} を使用した！`, wsPlayer, 2000);

      // インベントリから削除
      P[source] = P[source].filter(x => x.uid !== uid);

      // UI 更新
      this.sendItemList(wsPlayer, P);
      this.sendStatusInfo(wsPlayer, P);
      this.sendSimpleStatusBoth();

      if (consumesTurn) {
        this.endRound();
        return;
      }

      return; // ★ ここで必ず終了
    }



    // ============================
    // 6) ステータス再計算
    // ============================
    if (P.recalc_stats) P.recalc_stats();


    // ============================
    // ★ UI 即時同期（これが無いのが原因）
    // ============================
    this.sendItemList(wsPlayer, P);

    this.sendStatusInfo(wsPlayer, P);
    // ★ 簡易ステ（自分＋相手）
    this.sendSimpleStatusBoth();
  }

    // ===============================
    // 所持アイテム一覧を送信（共通）
    // ===============================
    sendItemList(wsPlayer, P) {
      const equippedSpecialItems = [];
      const specialEquip = buildSpecialEquip(P);
      for (const slot of specialEquip?.slots ?? []) {
        if (!slot?.item) continue;
        equippedSpecialItems.push({
          uid: slot.item.uid,
          ...slot.item,
          category: "special",
          is_equipped_special: true,
          equipped_slot_label: slot.label ?? slot.key ?? "特殊装備",
        });
      }
      const equippedSpecialUids = new Set(
        equippedSpecialItems
          .map(it => String(it?.uid ?? ""))
          .filter(Boolean)
      );

      safeSend(wsPlayer, {
        type: "item_list",
        item_uses_remaining: Math.max(0, 2 - Number(P.item_use_count ?? 0)),
        items: [
          ...(P.equipment ? [{
            uid: P.equipment.uid,
            ...P.equipment,
            category: "equip",
            is_equipped_normal: true
          }] : []),
          ...(P.extra_equipments ?? []).map(it => ({
            uid: it.uid,
            ...it,
            category: "equip",
            is_equipped_normal: true
          })),
          ...P.items.map(it => ({
            uid: it.uid,
            ...it,
            category: "item"
          })),
          ...P.equipment_inventory.map(it => ({
            uid: it.uid,
            ...it,
            category: "equip"
          })),
          ...equippedSpecialItems,
          ...P.special_inventory
            .filter(it => !equippedSpecialUids.has(String(it?.uid ?? "")))
            .map(it => ({
            uid: it.uid,
            ...it,
            category: "special"
          })),
          ...P.arrow_inventory
            .filter(it => !equippedSpecialUids.has(String(it?.uid ?? "")))
            .map(it => ({
            uid: it.uid,
            ...it,
            category: "special"
          }))
        ]
      });
    }


  // ★ ここに追加
  sendStatusDetail(ws, self, enemy, side) {
    const P = side === "self" ? self : enemy;
    // ===== 装備一覧生成（request_status_detail と同じ内容をここへ統一）=====
    const equipmentList = [];

    // 通常装備
    if (P.equipment) {
      equipmentList.push(`通常装備：${P.equipment.name}`);
    }

    // 錬金術師装備
    if (P.alchemist_equip) {
      equipmentList.push(`錬金装備：${P.alchemist_equip.name}`);
    }

    // 弓兵の矢
    if (P.arrow) {
      equipmentList.push(`矢(slot1)：${P.arrow.name}`);
    }
    if (P.arrow2) {
      equipmentList.push(`矢(slot2)：${P.arrow2.name}`);
    }

    // 魔導士装備
    if (P.mage_equips) {
      for (const [slot, eq] of Object.entries(P.mage_equips)) {
        if (!eq) continue;

        const slotName = {
          staff: "杖",
          book: "本",
          ring: "指輪",
          robe: "ローブ"
        }[slot] ?? slot;

        equipmentList.push(`魔導士装備（${slotName}）：${eq.name}`);
      }
    }

    safeSend(ws, {
      type: "status_detail",
      side,

      // ===== 基本ステータス（★これが無いと undefined）=====
      hp: P.hp,
      max_hp: P.max_hp,
      overheal_max_hp: P.job === "僧侶" ? 400 : P.max_hp,
      attack: P.doll ? (P.doll.is_broken ? 0 : P.getDollAttack()) : P.get_total_attack(),
      defense: P.doll ? (P.doll.is_broken ? 0 : P.getDollDefense()) : P.get_total_defense(),
      coins: P.coins,
      blessing_count: Number(P.blessing_count ?? 0),
      level: P.level,
      exp: P.exp,
      mad_state: buildMadStateData(P),

      // ===== 魔導士 =====
      mana: P.job === "魔導士" ? P.mana : null,
      mana_max: P.job === "魔導士" ? P.mana_max : null,


      // ===== 装備・バフ =====
      equipment: equipmentList,
      buffs: buildStatusBuffDescriptionList(P),

      // ===== 式神 =====
      shikigami: P.shikigami_effects?.map(s =>
        s.rounds !== undefined
          ? `${s.name}（残り${s.rounds}R）`
          : s.name
      ) ?? [],

      // ===== 人形（人形使い）=====
      doll: (P.job === "人形使い" && P.doll)
        ? {
            durability: P.doll.durability,
            max_durability: P.doll.max_durability,
            is_broken: P.doll.is_broken,
            charge: Number(P.doll.charge ?? 0),
            attack: P.doll.is_broken ? 0 : P.getDollAttack(),
            defense: P.getDollDefense(),
            costumes: P.doll.costumes ?? {}
          }
        : null
    });

  }

  /* =========================================================
     HP更新
     ========================================================= */
  updateHP() {
    safeSend(this.p1, {
      type: "hp",
      myHP: this.P1.hp,
      enemyHP: this.P2.hp
    });
    safeSend(this.p2, {
      type: "hp",
      myHP: this.P2.hp,
      enemyHP: this.P1.hp
    });
  }

  sendInitialStatusSnapshot() {
    safeSend(this.p1, { type: "job_info", job: this.P1.job });
    safeSend(this.p2, { type: "job_info", job: this.P2.job });

    this.updateHP();

    safeSend(this.p1, { type: "coin_info", coins: this.P1.coins });
    safeSend(this.p2, { type: "coin_info", coins: this.P2.coins });

    safeSend(this.p1, {
      type: "level_info",
      level: this.P1.level,
      canLevelUp: this.P1.can_level_up()
    });
    safeSend(this.p2, {
      type: "level_info",
      level: this.P2.level,
      canLevelUp: this.P2.can_level_up()
    });

    safeSend(this.p1, { type: "exp_info", exp: this.P1.exp });
    safeSend(this.p2, { type: "exp_info", exp: this.P2.exp });

    this.sendStatusInfo(this.p1, this.P1);
    this.sendStatusInfo(this.p2, this.P2);
    this.sendItemList(this.p1, this.P1);
    this.sendItemList(this.p2, this.P2);
    this.sendSimpleStatusBoth();
  }
  
  // =========================================================
  // ★ 簡易ステータス即時同期（自分＋相手）
  // =========================================================
  sendSimpleStatusBoth() {
    const send = (ws, self, enemy) => {
      // 自分
      const selfNextLevelExp = LEVEL_REQUIREMENTS[self.level] ?? null;
      safeSend(ws, {
        type: "status_simple",
        side: "self",
        name: self.name ?? "Player",
        profile: self.profile ?? null,
        hp: self.hp,
        max_hp: self.max_hp,
        overheal_max_hp: self.job === "僧侶" ? 400 : self.max_hp,
        attack: self.doll ? (self.doll.is_broken ? 0 : self.getDollAttack()) : self.get_total_attack(),
        defense: self.doll ? (self.doll.is_broken ? 0 : self.getDollDefense()) : self.get_total_defense(),
        coins: self.coins,
        blessing_count: Number(self.blessing_count ?? 0),
        level: self.level,
        exp: self.exp ?? 0,
        next_level_exp: selfNextLevelExp,
        next_level_label: selfNextLevelExp == null
          ? "次Lv: MAX"
          : `次LvまでEXP: ${Math.max(0, selfNextLevelExp - (self.exp ?? 0))}`,
        job: self.job ?? "不明",
        is_dojo_enemy: !!self.isDojoEnemy,
        dojo_enemy_id: self.dojoEnemyId ?? null,
        dojo_enemy_image: self.dojoEnemyImage ?? null,
        dojo_enemy_scale: self.dojoEnemyScale ?? 1,

        mana: self.job === "魔導士" ? self.mana : null,
        mana_max: self.job === "魔導士" ? self.mana_max : null,
        


        arrow_slots: self.arrow_slots ?? 1,
        equip_slots: self.dojoEquipSlots ?? { equipment: 1, special: 1 },
        damage_taken_last_round: self.damage_taken_last_round ?? 0,
        damage_taken_last_turn: self.damage_taken_last_turn ?? 0,
        archer_buff: self.archer_buff ?? null,
        archer_pierce_rounds: self.archer_pierce_rounds ?? (self.archer_next_pierce ? 1 : 0),

        // ★ 必ず配列に正規化
        equipment: [
          ...(Array.isArray(self.equipment)
            ? self.equipment
            : (self.equipment ? [self.equipment] : [])),
          ...(self.extra_equipments ?? [])
        ],


        doll: (self.job === "人形使い"  && self.doll)
          ? {
              durability: self.doll.durability,
              max_durability: self.doll.max_durability,
              is_broken: self.doll.is_broken,
              charge: Number(self.doll.charge ?? 0),
              charge_need: DOLL_CHARGE_COST,
              pending_charge_ready: !!self.doll.pending_charge_ready,
              attack: self.doll.is_broken ? 0 : self.getDollAttack(),
              defense: self.getDollDefense(),
            }
          : null,

        // ★ 追加：特殊装備
        special_equip: buildSpecialEquip(self),

        // ★ 追加：スキル残り回数（UI用）
        skill_remaining: buildSkillRemaining(self),

        // ★ 追加：バフ（UI用）
        buffs_ui: buildBuffUIData(self),
        mad_state: buildMadStateData(self),

      });


      // 相手
      const enemyNextLevelExp = LEVEL_REQUIREMENTS[enemy.level] ?? null;
      safeSend(ws, {
        type: "status_simple",
        side: "enemy",
        name: enemy.name ?? "CPU",
        profile: enemy.profile ?? null,
        hp: enemy.hp,
        max_hp: enemy.max_hp,
        overheal_max_hp: enemy.job === "僧侶" ? 400 : enemy.max_hp,
        attack: enemy.doll ? (enemy.doll.is_broken ? 0 : enemy.getDollAttack()) : enemy.get_total_attack(),
        defense: enemy.doll ? (enemy.doll.is_broken ? 0 : enemy.getDollDefense()) : enemy.get_total_defense(),
        coins: enemy.coins,
        blessing_count: Number(enemy.blessing_count ?? 0),
        level: enemy.level,
        exp: enemy.exp ?? 0,
        next_level_exp: enemyNextLevelExp,
        next_level_label: enemyNextLevelExp == null
          ? "次Lv: MAX"
          : `次LvまでEXP: ${Math.max(0, enemyNextLevelExp - (enemy.exp ?? 0))}`,
        job: enemy.job ?? "不明",
        is_dojo_enemy: !!enemy.isDojoEnemy,
        dojo_enemy_id: enemy.dojoEnemyId ?? null,
        dojo_enemy_image: enemy.dojoEnemyImage ?? null,
        dojo_enemy_scale: enemy.dojoEnemyScale ?? 1,

        mana: enemy.job === "魔導士" ? enemy.mana : null,
        mana_max: enemy.job === "魔導士" ? enemy.mana_max : null,

        arrow_slots: enemy.arrow_slots ?? 1,
        equip_slots: enemy.dojoEquipSlots ?? { equipment: 1, special: 1 },
        damage_taken_last_round: enemy.damage_taken_last_round ?? 0,
        damage_taken_last_turn: enemy.damage_taken_last_turn ?? 0,
        archer_buff: enemy.archer_buff ?? null,
        archer_pierce_rounds: enemy.archer_pierce_rounds ?? (enemy.archer_next_pierce ? 1 : 0),

        // ★ 必ず配列に正規化
        equipment: [
          ...(Array.isArray(enemy.equipment)
            ? enemy.equipment
            : (enemy.equipment ? [enemy.equipment] : [])),
          ...(enemy.extra_equipments ?? [])
        ],


        doll: (enemy.doll != null)
          ? {
              durability: enemy.doll.durability,
              max_durability: enemy.doll.max_durability,
              is_broken: enemy.doll.is_broken,
              charge: Number(enemy.doll.charge ?? 0),
              charge_need: DOLL_CHARGE_COST,
              pending_charge_ready: !!enemy.doll.pending_charge_ready,
              attack: enemy.doll.is_broken ? 0 : enemy.getDollAttack(),
              defense: enemy.getDollDefense(),
            }
          : null,

        special_equip: buildSpecialEquip(enemy),

        skill_remaining: buildSkillRemaining(enemy),

        // ★ 追加：バフ（UI用）
        buffs_ui: buildBuffUIData(enemy),
        mad_state: buildMadStateData(enemy),

      });

    };

    send(this.p1, this.P1, this.P2);
    send(this.p2, this.P2, this.P1);
  }

  /* =========================================================
    ラウンド開始通知
    ========================================================= */
  sendRoundInfo() {

    if (this.ended) return;

    // ---------------------------------
    // 手番表示（これは今まで通り）
    // ---------------------------------
    safeSend(this.current, {
      type: "your_turn",
      msg: `▶ あなたのラウンド（ラウンド${this.round}）`
    });

    safeSend(this.enemy, {
      type: "wait_turn",
      msg: `⏳ 相手のラウンド（ラウンド${this.round}）`
    });

    // ---------------------------------
    // ★ 簡易ステータスはここで一元送信
    // （相手が ? になる問題の根本対策）
    // ---------------------------------
    this.sendSimpleStatusBoth();

    // ---------------------------------
    // 以降は「ws / self / enemy」を
    // 使わない処理だけにする
    // ---------------------------------
  }


  dojoEnemyStrike(actor, target, { label = "通常攻撃", multiplier = 1, ignoreDefense = 0, hits = 1, kind = "normal" } = {}) {
    const logs = [];
    let total = 0;
    for (let i = 0; i < hits && target.hp > 0; i += 1) {
      const raw = Math.max(1, Math.floor(Number(actor.getActualAttack?.() ?? actor.get_total_attack()) * multiplier));
      let dealt;
      if (ignoreDefense > 0) {
        const saved = target.get_total_defense;
        const reducedDefense = Math.max(0, Number(target.get_total_defense?.() ?? 0) - ignoreDefense);
        target.get_total_defense = () => reducedDefense;
        dealt = target.take_damage(raw, false, actor);
        target.get_total_defense = saved;
      } else {
        dealt = target.take_damage(raw, false, actor);
      }
      total += Math.max(0, dealt);
      if (dealt > 0) this.sendDamageEvent(target, dealt, kind, "body");
      if (actor.dojoEnemyId === "ashura" && actor.dojoAwakened) {
        actor.base_attack = Number(actor.base_attack ?? actor.attack ?? 0) + 1;
        actor.attack = Number(actor.attack ?? actor.base_attack ?? 0) + 1;
      }
    }
    logs.push(`${actor.name} の${label}！ ${total}ダメージ！`);
    this.sendSfxEvent("attack");
    return logs;
  }

  handleDojoEnemyAction(actor, target) {
    if (!actor?.isDojoEnemy) return false;
    if (actor.process_buffs) actor.process_buffs();

    const isBoss = actor.dojoStageKind === "boss" || actor.dojoStageKind === "final_boss" || actor.dojoStageKind === "mid_boss";
    const isHalf = Number(actor.hp ?? 0) <= Math.floor(Number(actor.max_hp ?? 1) / 2);
    if (isBoss && isHalf && !actor.dojoAwakened) {
      actor.dojoAwakened = true;
      const msg = actor.dojoEnemyId === "ashura"
        ? "阿修羅が覚醒した！ 攻撃するたび攻撃力が上がる！"
        : `${actor.name} が覚醒した！ 行動が激しくなった！`;
      this.sendPopup(msg, null, 2800, "boom");
      this.sendBattle(`⚠ ${msg}`);
    }

    const action = pickDojoEnemyAction(actor);
    const strong = actor.dojoAwakened ? 1.22 : 1;
    let title = "通常攻撃";
    let desc = "";
    let logs = [];
    const healSelf = (amount, name) => {
      const healed = actor.restore_hp?.(amount) ?? 0;
      if (healed > 0) this.sendHealEvent(actor, healed);
      return `${actor.name} は${name}で ${healed} 回復した！`;
    };

    if (actor.dojoEnemyId === "ashura") {
      if (action === "normal") {
        title = "三連撃";
        desc = "通常攻撃を3回行う。覚醒後は攻撃ごとに攻撃力+1。";
        logs = this.dojoEnemyStrike(actor, target, { label: "三連撃", hits: 3 });
      } else if (action === "a") {
        title = "修羅の闘気";
        desc = "攻撃力を上げ、続けて通常攻撃を行う。";
        dojoAddBuff(actor, "攻撃力", 4 + Math.floor(Number(actor.dojoStage ?? 1) / 10), 3, title);
        this.sendBuffVisualEvent(actor, "powerup");
        logs = [`${actor.name} の攻撃力が上がった！`, ...this.dojoEnemyStrike(actor, target, { label: "追撃", hits: 3 })];
      } else if (action === "b") {
        title = "金剛三面";
        desc = "1ラウンドの間、防御力を3倍にする。";
        const add = Math.max(1, Number(actor.get_total_defense?.() ?? actor.defense ?? 0) * 2);
        dojoAddBuff(actor, "防御力", add, 1, title);
        logs = [`${actor.name} の防御力が3倍になった！`];
        this.sendSfxEvent("defup");
      } else {
        title = "阿修羅穿ち";
        desc = "相手の防御力を20無視して通常攻撃を行う。";
        logs = this.dojoEnemyStrike(actor, target, { label: "阿修羅穿ち", hits: 3, ignoreDefense: 20 });
      }
    } else if (actor.dojoEnemyId === "slime") {
      if (action === "a") { title = "溶解液"; desc = "防御力を一時的に下げる。"; dojoAddBuff(target, "防御力低下", 3, 2, title); logs = [`${target.name} の防御力が下がった！`]; }
      else if (action === "b") { title = "ぷるぷる再生"; desc = "HPを回復する。"; logs = [healSelf(10 + Math.floor(actor.max_hp / 12), title)]; }
      else if (action === "c") { title = "強めの体当たり"; desc = "少し強い攻撃。"; logs = this.dojoEnemyStrike(actor, target, { label: title, multiplier: 1.35 }); }
      else { logs = this.dojoEnemyStrike(actor, target); }
    } else if (actor.dojoEnemyId === "goblin") {
      if (action === "a") { title = "めった斬り"; desc = "2連続攻撃。"; logs = this.dojoEnemyStrike(actor, target, { label: title, multiplier: 0.72, hits: 2 }); }
      else if (action === "b") { title = "悪知恵"; desc = "攻撃力を上げる。"; dojoAddBuff(actor, "攻撃力", 3, 3, title); logs = [`${actor.name} の攻撃力が上がった！`]; this.sendBuffVisualEvent(actor, "powerup"); }
      else if (action === "c") { title = "こそ泥"; desc = "通常アイテム・通常装備だけを盗む。"; const stolen = stealDojoGoblinItem(target); logs = [stolen ? `${actor.name} は ${stolen.name ?? "持ち物"} を盗んだ！` : `${actor.name} は盗みを試みたが、盗める物がなかった！`]; }
      else { logs = this.dojoEnemyStrike(actor, target); }
    } else if (actor.dojoEnemyId === "wolf") {
      if (action === "a") { title = "高速連撃"; desc = "3回の軽い攻撃。"; logs = this.dojoEnemyStrike(actor, target, { label: title, multiplier: 0.55, hits: 3 }); }
      else if (action === "b") { title = "防御無視噛みつき"; desc = "防御力を無視して噛みつく。"; logs = this.dojoEnemyStrike(actor, target, { label: title, multiplier: 0.95, ignoreDefense: 9999 }); }
      else if (action === "c") { title = "遠吠え"; desc = "次の攻撃に備え、攻撃力を上げる。"; dojoAddBuff(actor, "攻撃力", 5, 2, title); logs = [`${actor.name} は遠吠えで次の強攻撃を予告した！`]; this.sendBuffVisualEvent(actor, "powerup"); }
      else { logs = this.dojoEnemyStrike(actor, target); }
    } else if (actor.dojoEnemyId === "golem") {
      if (action === "a") { title = "硬化"; desc = "防御力を上げる。"; dojoAddBuff(actor, "防御力", 5, 3, title); logs = [`${actor.name} の防御力が上がった！`]; this.sendBuffVisualEvent(actor, "defup"); }
      else if (action === "b") { title = "岩投げ"; desc = "高威力攻撃。"; logs = this.dojoEnemyStrike(actor, target, { label: title, multiplier: 1.55 }); }
      else if (action === "c") { title = "地響き"; desc = "攻撃しつつ防御力を上げる。"; dojoAddBuff(actor, "防御力", 3, 2, title); this.sendBuffVisualEvent(actor, "defup"); logs = this.dojoEnemyStrike(actor, target, { label: title, multiplier: 1.05 }); }
      else { logs = this.dojoEnemyStrike(actor, target); }
    } else if (actor.dojoEnemyId === "ghost") {
      if (action === "a") { title = "霊体すり抜け"; desc = "防御力を無視して攻撃。"; logs = this.dojoEnemyStrike(actor, target, { label: title, multiplier: 0.95, ignoreDefense: 9999 }); }
      else if (action === "b") { title = "呪い"; desc = "攻撃力を一時的に下げる。"; dojoAddBuff(target, "攻撃力低下", 3, 2, title); logs = [`${target.name} の攻撃力が下がった！`]; }
      else if (action === "c") { title = "魂吸収"; desc = "攻撃してHPを吸収する。"; const before = target.hp; logs = this.dojoEnemyStrike(actor, target, { label: title, multiplier: 0.9, ignoreDefense: 8 }); logs.push(healSelf(Math.floor(Math.max(0, before - target.hp) / 2), title)); }
      else { logs = this.dojoEnemyStrike(actor, target); }
    } else if (actor.dojoEnemyId === "mushroom") {
      if (action === "a") { title = "毒胞子"; desc = "毒で継続ダメージを与える。"; dojoAddPoison(target, 4 + Math.floor(Number(actor.dojoStage ?? 1) / 8), 3, "毒"); logs = [`${target.name} は毒を受けた！`]; }
      else if (action === "b") { title = "菌糸再生"; desc = "HPを回復する。"; logs = [healSelf(12 + Math.floor(actor.max_hp / 14), title)]; }
      else if (action === "c") { title = "弱化胞子"; desc = "防御力を下げる。"; dojoAddBuff(target, "防御力低下", 4, 2, title); logs = [`${target.name} の防御力が下がった！`]; }
      else { logs = this.dojoEnemyStrike(actor, target); }
    } else {
      if (action === "a") { title = "神威"; desc = "攻撃力を上げて攻撃する。"; dojoAddBuff(actor, "攻撃力", Math.ceil(3 * strong), 3, title); this.sendBuffVisualEvent(actor, "powerup"); logs = [`${actor.name} の攻撃力が上がった！`, ...this.dojoEnemyStrike(actor, target, { label: title, multiplier: 1.05 * strong })]; }
      else if (action === "b") { title = "守護神域"; desc = "防御力を上げる。"; dojoAddBuff(actor, "防御力", Math.ceil(5 * strong), 2, title); logs = [`${actor.name} の防御力が上がった！`]; this.sendBuffVisualEvent(actor, "defup"); }
      else if (action === "c") { title = "裁きの一撃"; desc = "防御を一部無視する強攻撃。"; logs = this.dojoEnemyStrike(actor, target, { label: title, multiplier: 1.35 * strong, ignoreDefense: 12 }); }
      else { logs = this.dojoEnemyStrike(actor, target, { multiplier: 1.0 * strong }); }
    }

    const popup = `${actor.name}：${title}\n${desc || logs[0] || ""}`;
    this.sendPopup(popup, null, isBoss ? 3000 : 2400);
    for (const line of logs) this.sendBattle(`👹 ${line}`);
    this.updateHP();
    this.sendSimpleStatusBoth();
    if (target.hp <= 0) {
      const winnerKey = actor === this.P1 ? "p1" : "p2";
      this.finishBattle(winnerKey);
      return true;
    }
    this.endRound();
    return true;
  }


   

  /* =========================================================
     行動処理
     ========================================================= */
  async handleAction(wsPlayer, action) {
    if (this.ended) {
      this.sendSystem("⚠ この対戦はすでに終了しています。");
      return;
    }
    if (this.action_resolving) {
      this.sendPopup("相手が考え中です。", wsPlayer, 1400);
      this.sendError("❌ 行動処理中です。", wsPlayer);
      return;
    }

    // 自分のラウンド以外は行動不可
    if (wsPlayer !== this.current) {
      this.sendError("❌ 今はあなたのラウンドではありません。", wsPlayer);
      return;
    }

    const actor = wsPlayer === this.p1 ? this.P1 : this.P2;
    const target = wsPlayer === this.p1 ? this.P2 : this.P1;

    if (this.matchType === "dojo" && actor.isDojoEnemy) {
      this.handleDojoEnemyAction(actor, target);
      return;
    }

    // ★ バフラウンド処理（正しい位置）
    if (actor.process_buffs) actor.process_buffs();

    /* ---------- 攻撃 ---------- */
    if (action === "攻撃") {

      // ★ 弓兵は矢攻撃を使用
      if (actor.job === "弓兵") {

        const results = actor.trigger_arrow_attack(target) ?? [];
        for (const r of results) {
          this.sendBattle(
            `🏹 ${actor.name} の追撃（${r.name}）！ ${r.dealt}ダメージ`
          );

          // ============================
          // ★ UI用：弓兵追撃ダメージ演出
          // ============================
          if (r.dealt > 0) {
            const targetType =
              target.job === "人形使い" &&
              target.doll &&
              !target.doll.is_broken
                ? "doll"
                : "body";

            // pursuit 色（黄色）を使う
            this.sendDamageEvent(target, r.dealt, "pursuit", targetType);
          }

        }

        // ★ 矢防御貫通のラウンド消費
        if (Number(actor.archer_pierce_rounds ?? 0) > 0) {
          actor.archer_pierce_rounds -= 1;
          actor.archer_next_pierce = actor.archer_pierce_rounds > 0;
          if (actor.archer_pierce_rounds <= 0) {
            actor.archer_pierce_rounds = 0;
            actor.archer_next_pierce = false;
            this.sendSystem("🏹 矢の防御貫通効果が終了しました");
          }
        } else if (actor.archer_next_pierce) {
          actor.archer_next_pierce = false;
        }





        // ★ 追撃バフのラウンド消費
        if (actor.archer_buff && actor.archer_buff.rounds > 0) {
          actor.archer_buff.rounds -= 1;
          if (actor.archer_buff.rounds <= 0) {
            actor.archer_buff = null;
            this.sendSystem("🏹 追撃効果が終了しました");
          }
        }

      } else {
        const dmg = actor.getActualAttack();
        const dealt = target.take_damage(dmg, false, actor);
        
      // ============================
      // ★ UI用：ダメージ演出送信
      // ============================
        if (dealt > 0) {
          const targetType =
            target.job === "人形使い" &&
            target.doll &&
            !target.doll.is_broken
              ? "doll"
              : "body";

          this.sendDamageEvent(target, dealt, "normal", targetType);
          this.sendSfxEvent("attack");
        }


        this.sendBattle(
          actor.job === "人形使い" &&
          actor.doll &&
          !actor.doll.is_broken
            ? `🪆 人形の攻撃！ ${dealt}ダメージ！`
            : `🗡 ${actor.name} の攻撃！ ${dealt}ダメージ！`
        );

        if (
          actor.job === "人形使い" &&
          actor.doll &&
          !actor.doll.is_broken &&
          Number(actor.doll.extra_attacks_this_turn ?? 0) > 0 &&
          target.hp > 0
        ) {
          const extraAttackCount = Number(actor.doll.extra_attacks_this_turn ?? 0);
          const ignoreExtraDef = !!(
            actor.doll.extra_attack_ignore_def_permanent ||
            actor.doll.extra_attack_buff?.ignore_def
          );
          actor.doll.extra_attacks_this_turn = 0;

          for (let i = 0; i < extraAttackCount && target.hp > 0; i += 1) {
            const extraDamage = actor.getActualAttack();
            const extraDealt = target.take_damage(extraDamage, ignoreExtraDef, actor, true);
            if (extraDealt > 0) {
              const targetType =
                target.job === "人形使い" &&
                target.doll &&
                !target.doll.is_broken
                  ? "doll"
                  : "body";
              this.sendDamageEvent(target, extraDealt, "pursuit", targetType);
            }
            this.sendBattle(`🪆 人形の追加攻撃！ ${extraDealt}ダメージ！`);
          }
        }


      }



      // ★ 烏天狗の追撃（内部トリガー基準）
      if (actor.karasu_tengu_triggers > 0) {
        const logs = actor.trigger_karasu_tengu(target) ?? [];
        logs.forEach(dmg2 => {
          this.sendSkill(`🐦 烏天狗の追撃！ ${dmg2}ダメージ！`);

          // ============================
          // ★ UI用：烏天狗追撃ダメージ演出
          // ============================
          if (dmg2 > 0) {
            const targetType =
              target.job === "人形使い" &&
              target.doll &&
              !target.doll.is_broken
                ? "doll"
                : "body";

            this.sendDamageEvent(target, dmg2, "pursuit", targetType);
          }

        });

      }




      this.updateHP();

      // 勝敗チェック
      if (target.hp <= 0) {
        const winnerKey = actor === this.P1 ? "p1" : "p2";
        this.finishBattle(winnerKey);
        return;
      }

      this.endRound();
      return;
    }

    /* ---------- スキル（失敗ならラウンド消費しない） ---------- */
    if (
      (action === "スキル1" || action === "スキル2" || action === "スキル3") &&
      actor.job !== 9 &&
      Number(actor.job) !== 9
    ) {

      const num = Number(action.replace("スキル", ""));
      const success = await this.useSkill(wsPlayer, actor, target, num);

      // ★ 失敗なら：ここで終了（ラウンド交代しない・使用済みにもならない）
      if (!success) return;

      // 成功時のみ：勝敗チェックとラウンド終了は useSkill 内でやる（※下の修正版に合わせる）
      return;
    }

    this.sendError("❌ 未対応のアクション", wsPlayer);
  }


  /* =========================================================
     スキル発動処理
     ========================================================= */
    async useSkill(wsPlayer, actor, target, num) {

      if (this.skill_lock) return false;
      this.skill_lock = true;

      // ★ 人形使いは Player._use_doll_skill に直接委譲
      if (actor.job === "人形使い") {

        const stype = `doll_${num}`;

        // ★ スキル発動前の差分保存
        const beforeHpActor = actor.hp;
        const beforeDollDurability = actor.doll?.durability ?? 0;

        let result = actor._use_doll_skill(stype, target);
        if (result && typeof result.then === "function") {
          result = await result;
        }

        if (!result || !result.ok) {
          this.sendPopup(
            result?.reason ?? "スキルを使用できません",
            wsPlayer,
            2800
          );
          this.sendError(
            `❌ スキル失敗：${result?.reason ?? "不明なエラー"}`,
            wsPlayer
          );
          this.skill_lock = false;
          return false;
        }
        
        // ★ HP減少 → ダメージ演出
        const hpLost = beforeHpActor - actor.hp;
        if (hpLost > 0) {
          this.sendDamageEvent(actor, hpLost, "skill", "body");
        }

        // ★ 人形耐久回復 → 回復演出
        const dollHealed =
          (actor.doll?.durability ?? 0) - beforeDollDurability;

        if (dollHealed > 0) {
          this.sendHealEvent(actor, dollHealed, "doll");
        }
        // ★ ログは server が出す
        for (const msg of result.logs ?? []) {
          this.sendSkill(msg);
        }
        this.sendSkillEffectEvents(actor, target, stype, beforeHpActor);

        this.updateHP();
        this.sendStatusInfo(wsPlayer, actor);
        this.sendSimpleStatusBoth();

        this.skill_lock = false;
        this.endRound();
        return true;
      }


      // ===== ここから下は既存の通常職 =====


    const job = actor.job;
    const prefix = {
      "戦士": "warrior",
      "騎士": "knight",
      "僧侶": "priest",
      "盗賊": "thief",
      "魔導士": "mage",
      "陰陽師": "onmyoji",
      "錬金術師": "alchemist",
      "弓兵": "archer",
      "狂人": "mad",
    }[job];

    const stype = `${prefix}_${num}`;

    // ★ 魔導士：魔力不足は中央ポップアップで通知（最低必要魔力付き）
    if (actor.job === "魔導士") {
      const needMana = (stype === "mage_2") ? 30 : (stype === "mage_3") ? 60 : 0;
      if (needMana > 0 && actor.mana < needMana) {
        this.sendPopup(`魔力が足りません（最低必要魔力:${needMana}）`, wsPlayer, 2500);
        this.sendError(`❌ 魔力が足りません（最低必要魔力: ${needMana}）`, wsPlayer);
        this.skill_lock = false;
        return false;
      }
    }

    this.sendSkill(`✨ ${actor.name} のスキル発動：${stype}`);

    // -------- 1) レベルチェック（最優先） --------
    if (actor.level < num) {
      this.sendError(`❌ スキル${num} は Lv${num} で解放されます！`, wsPlayer);
      this.skill_lock = false;
      return false;
    }

    // -------- 2) 使用済みチェック --------
    if (!(actor.job === "魔導士" && (stype === "mage_2" || stype === "mage_3"))) {

      if (actor.used_skill_set.has(stype)) {
        this.sendError("❌ このスキルはすでに使用済みです！", wsPlayer);
        this.skill_lock = false;
        return false;
      }
    }

    // -------- 3) スキル封印中 --------
    if (actor.skill_sealed) {
      this.sendError("❌ スキルは封印されている…！", wsPlayer);
      this.skill_lock = false;
      return false;
    }

    // -------- 4) スキル関数実行（★ async 対応が本体） --------
    const method = `_use_${prefix}_skill`;
    const fn = actor[method];

    if (!fn) {
      this.sendError(`❌ 未実装スキル: ${method}`, wsPlayer);
      this.skill_lock = false;
      return false;
    }

    // ============================
    // ★ 演出検知用：スキル実行「前」の状態を記録
    // ============================
    const beforeHpActor = actor.hp;
    const beforeHpTarget = target.hp;
    const beforeActorAttackBuff = Number(actor.get_attack_buff_total?.() ?? 0);
    const beforeTargetAttackBuff = Number(target.get_attack_buff_total?.() ?? 0);
    const beforeActorDefBuff = Number(actor.get_def_buff_total?.() ?? 0) + Number(actor.barrier ?? 0);
    const beforeTargetDefBuff = Number(target.get_def_buff_total?.() ?? 0) + Number(target.barrier ?? 0);

    // 人形ダメージ検知（相手が人形使いの時）
    const beforeDollTarget =
      (target.job === "人形使い" && target.doll)
        ? (target.doll.durability ?? 0)
        : null;

    // ★ async / sync 両対応：Promise なら await する
    let ok = fn.call(actor, stype, target);
    if (ok && typeof ok.then === "function") {
      ok = await ok;
    }

    if (!ok) {
      this.sendError(`❌ スキル失敗：${stype}`, wsPlayer);
      this.skill_lock = false;
      return false; // ★ 失敗を返す（ターン消費させない）
    }

    const afterActorAttackBuff = Number(actor.get_attack_buff_total?.() ?? 0);
    const afterTargetAttackBuff = Number(target.get_attack_buff_total?.() ?? 0);
    const attackBuffIncreased =
      afterActorAttackBuff > beforeActorAttackBuff ||
      afterTargetAttackBuff > beforeTargetAttackBuff;
    const afterActorDefBuff = Number(actor.get_def_buff_total?.() ?? 0) + Number(actor.barrier ?? 0);
    const afterTargetDefBuff = Number(target.get_def_buff_total?.() ?? 0) + Number(target.barrier ?? 0);
    const defBuffIncreased =
      afterActorDefBuff > beforeActorDefBuff ||
      afterTargetDefBuff > beforeTargetDefBuff;
    const hasSkillDamage =
      beforeHpActor > actor.hp ||
      beforeHpTarget > target.hp ||
      (beforeDollTarget != null &&
        target.doll &&
        Number(beforeDollTarget) > Number(target.doll.durability ?? 0));

    if (hasSkillDamage && attackBuffIncreased) {
      this.sendBuffVisualEvent(actor, "powerup");
    }
    if (hasSkillDamage && defBuffIncreased) {
      this.sendBuffVisualEvent(actor, "defup");
    }

    this.sendSkillEffectEvents(actor, target, stype, beforeHpActor);

    // ============================
    // ★ ダメージイベント送信（スキル成功後に差分を見る）
    //   - 通常攻撃と同じ赤表示にするため kind は "normal"
    // ============================
    const damagedActor = beforeHpActor - actor.hp;
    if (damagedActor > 0) {
      this.sendDamageEvent(actor, damagedActor, "normal", "body");
    }

    const damagedTarget = beforeHpTarget - target.hp;
    if (damagedTarget > 0) {
      this.sendDamageEvent(target, damagedTarget, "normal", "body");
    }

    if (damagedTarget > 0) {
      if (stype === "mage_2" || stype === "mage_3") {
        this.sendSfxEvent("boom");
      } else {
        this.sendSfxEvent("attack");
      }
    }

    // 人形へのダメージ（HPが減らないケース）
    if (beforeDollTarget != null && target.doll) {
      const afterDollTarget = target.doll.durability ?? 0;
      const damagedDoll = beforeDollTarget - afterDollTarget;
      if (damagedDoll > 0) {
        this.sendDamageEvent(target, damagedDoll, "normal", "doll");
      }
    }

    // ============================
    // ★ 回復イベント送信（スキル成功後に差分を見る）
    // ============================
    const healedActor = actor.hp - beforeHpActor;
    if (healedActor > 0) {
      this.sendHealEvent(actor, healedActor);
    }

    const healedTarget = target.hp - beforeHpTarget;
    if (healedTarget > 0) {
      this.sendHealEvent(target, healedTarget);
    }

    if (!hasSkillDamage && attackBuffIncreased) {
      this.sendBuffVisualEvent(actor, "powerup");
    }
    if (!hasSkillDamage && defBuffIncreased) {
      this.sendBuffVisualEvent(actor, "defup");
    }

    if (prefix === "onmyoji") {
      this.sendShikigamiSummonEvent(actor, actor.last_summoned_shikigami);
      this.sendStatusInfo(wsPlayer, actor);
      actor.last_summoned_shikigami = [];
    }



    // -------- 5) 使用済みに登録（成功時のみ） --------
    if (!(actor.job === "魔導士" && (stype === "mage_2" || stype === "mage_3"))) {
      actor.used_skill_set.add(stype);
    }

    // 魔導士の魔力更新
    if (actor.job === "魔導士") {
      safeSend(wsPlayer, {
        type: "mana_info",
        mana: actor.mana,
        mana_max: actor.mana_max
      });
    }

    this.sendItemList(wsPlayer, actor);


    // 弓兵・陰陽師の追加処理（成功時のみ）

// ★ 烏天狗の追撃は handleAction 側でのみ処理する
// （ここでは何もしない）


    this.updateHP();

    if (target.hp <= 0) {
      const winner = actor === this.P1 ? "p1" : "p2";
      this.finishBattle(winner);
      this.skill_lock = false;
      return true;
    }

    this.skill_lock = false;
    this.endRound(); // ★ 成功した時だけラウンド消費
    return true;
  }





  /* =========================================================
     DOT処理（鬼火など）
     ========================================================= */
  applyDots() {
    const players = [
      { P: this.P1, ws: this.p1 },
      { P: this.P2, ws: this.p2 }
    ];

    for (const { P } of players) {
      if (!P.dot_effects) continue;

      const remain = [];

      for (const dot of P.dot_effects) {
        const target = P;
        const beforeHp = target.hp;
        const beforeDoll = target.doll ? Number(target.doll.durability ?? 0) : null;
        const dotPower = Number(dot.power ?? 0);

        if (target.job === "人形使い" && target.doll) {
          target.hp = beforeHp;
          target.doll.durability = Math.max(0, beforeDoll - dotPower);
        } else if (
          target.job === "狂人" &&
          target.madman_guts &&
          beforeHp - dotPower <= 0
        ) {
          target.madman_guts = false;
          target.madman_no_heal = true;
          target.hp = 10;
          this.sendPopup(`💢 ${target.name} の我慢が発動！`, null, 1800);
        } else {
          target.hp = Math.max(0, beforeHp - dotPower);
        }

        const dealt = target.job === "人形使い" && target.doll
          ? Math.max(0, beforeDoll - Number(target.doll.durability ?? 0))
          : beforeHp - target.hp;

        this.sendBattle(
          `🔥 ${target.name} は ${dot.name} により ${dot.power} ダメージ！（防御無視）`
        );

        if (dealt > 0) {
          this.sendDamageEvent(
            target,
            dealt,
            "dot",
            target.job === "人形使い" && target.doll ? "doll" : "body"
          );
        }

        if (
          target.job === "人形使い" &&
          target.doll &&
          target.doll.durability <= 0 &&
          !target.doll.is_broken &&
          !target.doll.pending_revive
        ) {
          const beforeBreakHp = Number(target.hp ?? 0);
          target.hp = Math.max(0, beforeBreakHp - 50);
          const breakDamage = Math.max(0, beforeBreakHp - Number(target.hp ?? 0));
          if (breakDamage > 0) {
            this.sendDamageEvent(target, breakDamage, "dot", "body");
          }
          target.doll.is_broken = true;
          target.doll.pending_revive = true;
          target.doll.revive_guard_rounds = 0;
          target.doll.repair_kit_lock_rounds = 0;

          const currentPlayer = this.current === this.p1 ? this.P1 : this.P2;
          if (target === currentPlayer) {
            target.doll.is_broken = false;
            target.doll.pending_revive = false;
            target.doll.durability = Math.min(Number(target.doll.max_durability ?? 50), 50);
          }
        }

        if (
          target.job === "狂人" &&
          dealt > 0
        ) {
          target.total_damage_received =
            (target.total_damage_received ?? 0) + dealt;

          if (
            (target.total_damage_received ?? 0) >= 120 &&
            target.hp > 0 &&
            !target.madman_no_heal
          ) {
            const rageHeal = Math.floor(dealt / 5);
            if (rageHeal > 0) {
              const healed = target.restore_hp?.(rageHeal) ?? 0;
              if (healed > 0) {
                this.sendHealEvent(target, healed);
                this.sendBattle(`😈 ${target.name} は狂化で ${healed} 回復した！`);
              }
            }
          }
        }

        if (target.job === "狂人" && beforeHp - dotPower <= 0 && target.hp === 10) {
          this.sendBattle(`💢 ${target.name} は我慢で踏みとどまった！ HP10で耐えた！`);
        }


        // ★ DOTターン消費（turns / rounds 両対応）
        const turnsNow = Number(dot.turns ?? dot.rounds ?? 0);
        dot.turns = turnsNow - 1;

        // 表示側が rounds を参照していても崩れないように同期
        if (dot.rounds != null) dot.rounds = dot.turns;

        if (dot.turns > 0) remain.push(dot);

      }

      P.dot_effects = remain;
    }

    this.updateHP();

    // DOTで決着した場合
    if (this.P1.hp <= 0 || this.P2.hp <= 0) {
      if (this.ended) return;

      let result;
      if (this.P1.hp > this.P2.hp) result = "p1";
      else if (this.P2.hp > this.P1.hp) result = "p2";
      else result = "draw";

      this.finishBattle(result);
    }
  }


  /* =========================================================
     対戦終了処理（勝敗 & EXP / コイン補填）
     ========================================================= */
  finishBattle(result) {
    if (this.ended) return;
    this.ended = true;

    let winner = null;
    let loser = null;
    let wsWinner = null;
    let wsLoser = null;

    if (result === "p1") {
      winner = this.P1;
      loser = this.P2;
      wsWinner = this.p1;
      wsLoser = this.p2;
      this.sendBattle(`🎉 ${this.P1.name} の勝利！！`);
      this.sendSimpleStatusBoth();
    } else if (result === "p2") {
      winner = this.P2;
      loser = this.P1;
      wsWinner = this.p2;
      wsLoser = this.p1;
      this.sendBattle(`🎉 ${this.P2.name} の勝利！！`);
      this.sendSimpleStatusBoth();
    } else {
      this.sendBattle("🤝 引き分け！");
      this.sendSimpleStatusBoth();
    }



    if (this.matchType === "dojo") {
      this.finishDojoBattle(result, winner, loser, wsWinner, wsLoser);
      return;
    }

    // ============================
    // ★ 対戦終了イベント（UI演出用）
    //   - 勝者: win / 敗者: lose / 引き分け: draw
    // ============================
    if (result === "p1" && wsWinner && wsLoser) {
      safeSend(wsWinner, { type: "battle_end", result: "win" });
      safeSend(wsLoser,  { type: "battle_end", result: "lose" });
    } else if (result === "p2" && wsWinner && wsLoser) {
      safeSend(wsWinner, { type: "battle_end", result: "win" });
      safeSend(wsLoser,  { type: "battle_end", result: "lose" });
    } else {
      // draw
      safeSend(this.p1, { type: "battle_end", result: "draw" });
      safeSend(this.p2, { type: "battle_end", result: "draw" });
    }

    if (winner && loser) {

      // 勝者 / 敗者

    } else {
      // 引き分け
    }
    // ============================
    // Account-based job ratings / wins-losses
    //   - random: 両者レート更新（通常）
    //   - room  : 勝敗のみ（レート変動なし）
    //   - cpu   : 人間側のみ（レート変動少なめ）
    // ============================
    const accId1 = this.p1?.accountId;
    const accId2 = this.p2?.accountId;

    const isBotMatch = !!this.p1?.isBot || !!this.p2?.isBot;
    const isRoomMatch = this.matchType === "room";
    const resultDetailByWs = new Map();
    const readRatingSnapshot = (accountId, job) => {
      if (!accountId || !job) return { rating: 1000, wins: 0, losses: 0 };
      const acc = getOrCreateAccount(String(accountId));
      const rec = acc?.jobs?.[job] || {};
      return {
        rating: Number(rec.rating ?? 1000) || 1000,
        wins: Number(rec.wins ?? 0) || 0,
        losses: Number(rec.losses ?? 0) || 0
      };
    };
    const makeRateDetail = (before, after, job) => ({
      ranked: true,
      job,
      oldRating: Number(before?.rating ?? 1000) || 1000,
      newRating: Number(after?.rating ?? before?.rating ?? 1000) || 1000,
      delta: (Number(after?.rating ?? before?.rating ?? 1000) || 1000) - (Number(before?.rating ?? 1000) || 1000),
      wins: Number(after?.wins ?? before?.wins ?? 0) || 0,
      losses: Number(after?.losses ?? before?.losses ?? 0) || 0
    });

    if (isBotMatch) {
      // CPU戦：人間側のみ
      const humanWs = this.p1?.isBot ? this.p2 : this.p1;
      const humanAcc = humanWs?.accountId;
      const humanJob = (humanWs === this.p1) ? this.P1.job : this.P2.job;

      // ★ CPU戦ボタンで開始した対戦は戦績/レートに反映しない
      // ★ ランダム対戦の自動CPU（cpuKind === "auto"）のみ反映する
      if (humanAcc && humanWs?.cpuKind === "auto") {
        const before = readRatingSnapshot(humanAcc, humanJob);
        let r = "draw";
        if (result === "p1" && humanWs === this.p1) r = "win";
        else if (result === "p2" && humanWs === this.p2) r = "win";
        else if (result === "p1" || result === "p2") r = "lose";

        const recorded = recordCpuMatchResult({
          accountId: String(humanAcc),
          job: humanJob,
          result: r,
          kFactor: 16
        });
        if (recorded?.ok) {
          resultDetailByWs.set(humanWs, makeRateDetail(before, recorded.updated, humanJob));
        }
      } else if (humanWs) {
        resultDetailByWs.set(humanWs, { ranked: false, reason: "cpu" });
      }

    } else if (accId1 && accId2) {
      let r = "draw";
      if (result === "p1") r = "A";
      else if (result === "p2") r = "B";

      if (isRoomMatch) {
        // ★ ルーム対戦は戦績/レートに一切反映しない
        resultDetailByWs.set(this.p1, { ranked: false, reason: "room" });
        resultDetailByWs.set(this.p2, { ranked: false, reason: "room" });
      } else {
        const beforeA = readRatingSnapshot(accId1, this.P1.job);
        const beforeB = readRatingSnapshot(accId2, this.P2.job);
        const recorded = recordMatchResult({
          accountIdA: String(accId1),
          jobA: this.P1.job,
          accountIdB: String(accId2),
          jobB: this.P2.job,
          result: r,
          kFactor: 32
        });
        if (recorded?.ok) {
          resultDetailByWs.set(this.p1, makeRateDetail(beforeA, recorded.updated?.A, this.P1.job));
          resultDetailByWs.set(this.p2, makeRateDetail(beforeB, recorded.updated?.B, this.P2.job));
        }
      }
    }

    const resultForWs = (ws) => {
      if (result === "draw") return "draw";
      if (result === "p1") return ws === this.p1 ? "win" : "lose";
      if (result === "p2") return ws === this.p2 ? "win" : "lose";
      return "draw";
    };
    const sendResultDetail = (ws, selfPlayer, enemyPlayer) => {
      if (!ws || ws.isBot) return;
      safeSend(ws, {
        type: "battle_result_detail",
        result: resultForWs(ws),
        matchType: this.matchType,
        selfName: selfPlayer?.name || "",
        enemyName: enemyPlayer?.name || "",
        rating: resultDetailByWs.get(ws) || { ranked: false, reason: "none" }
      });
    };
    sendResultDetail(this.p1, this.P1, this.P2);
    sendResultDetail(this.p2, this.P2, this.P1);


    // 自動レベルアップ判定（両者）
    const pairs = [
      [this.P1, this.p1],
      [this.P2, this.p2]
    ];

    for (const [P, ws] of pairs) {
      const res = P.try_level_up_auto ? P.try_level_up_auto() : null;

      if (res && res.auto) {
        this.sendSkill(
          `📘 ${P.name} は EXP により Lv${P.level} にアップ！（攻撃+${res.inc ?? 0}）`
        );
      }

      safeSend(ws, {
        type: "level_info",
        level: P.level,
        canLevelUp: P.can_level_up()
      });

      safeSend(ws, { type: "exp_info", exp: P.exp });
      safeSend(ws, { type: "coin_info", coins: P.coins });
    }
  }

  finishDojoBattle(result, winner, loser, wsWinner, wsLoser) {
    const run = this.dojoRun;
    const humanWs = this.p1?.isBot ? this.p2 : this.p1;
    const human = humanWs === this.p1 ? this.P1 : this.P2;
    if (!run || !humanWs || !human) {
      safeSend(humanWs, { type: "battle_end", result: result === "draw" ? "draw" : "lose" });
      return;
    }

    const humanWon =
      (result === "p1" && humanWs === this.p1) ||
      (result === "p2" && humanWs === this.p2);

    if (!humanWon) {
      if (humanWs.accountId) {
        clearSavedDojoRun({ accountId: humanWs.accountId, job: run.jobName });
      }
      if (humanWs.accountId) {
        recordDojoProgress({
          accountId: humanWs.accountId,
          job: run.jobName,
          stage: Number(run.stage ?? 1),
          cleared: false
        });
      }
      // 達人への道：アイテム攻撃力上昇をリセット（挑戦失敗時）
      if (human) {
        human.dojoItemAttackBuff = 0;
        human.dojoItemDoubleEffect = false;
      }
      safeSend(humanWs, {
        type: "dojo_failed",
        run: buildDojoRunView(run, human, humanWs),
        result: result === "draw" ? "draw" : "lose"
      });
      return;
    }

    returnDojoBattleItemsToStorage(human);
    const drops = generateDojoDrops(run, human);
    applyDojoDrops(run, human, drops);
    const prestigeGain = drops
      .filter(drop => drop?.type === "prestige")
      .reduce((sum, drop) => sum + Number(drop.amount ?? 0), 0);
    addDojoRunTrailPoints(run, prestigeGain);
    const trailState = ensureDojoRunTrailState(run);
    if ((trailState?.trailNodes || []).map(Number).includes(5)) {
      trailState.trailAttackGrowth = Number(trailState.trailAttackGrowth ?? 0) + 1;
    }
    applyDojoTrailBonusesToPlayer(humanWs);
    run.lastDrops = drops;
    run.highestStage = Math.max(Number(run.highestStage ?? 0), Number(run.stage ?? 1));
    const isClear = Number(run.stage ?? 1) >= 30;
    if (humanWs.accountId) {
      recordDojoProgress({
        accountId: humanWs.accountId,
        job: run.jobName,
        stage: Number(run.stage ?? 1),
        cleared: isClear
      });
    }

    if (isClear) {
      run.cleared = true;
      if (humanWs.accountId) {
        clearSavedDojoRun({ accountId: humanWs.accountId, job: run.jobName });
      }
      // 達人への道：アイテム攻撃力上昇をリセット（挑戦クリア時）
      if (human) {
        human.dojoItemAttackBuff = 0;
        human.dojoItemDoubleEffect = false;
      }
      safeSend(humanWs, {
        type: "dojo_clear",
        run: buildDojoRunView(run, human, humanWs),
        drops
      });
      return;
    }

    run.stage = Number(run.stage ?? 1) + 1;
    run.waiting = true;
    human.shop_items = generateDojoShopList(human);
    saveCurrentDojoRun(humanWs);
    safeSend(humanWs, {
      type: "dojo_stage_clear",
      run: buildDojoRunView(run, human, humanWs),
      drops
    });
  }




  // =========================================================
  // ★ 通信切断：切断した側の敗北で即終了
  // =========================================================
  handleDisconnect(disconnectedWs) {
    if (this.ended) return;

    const winnerWs = (disconnectedWs === this.p1) ? this.p2 : this.p1;

    // 残った側へ通知
    safeSend(winnerWs, {
      type: "system_log",
      msg: "対戦相手が切断しました。勝利となります"
    });

    const res = (disconnectedWs === this.p1) ? "p2" : "p1";
    this.finishBattle(res);
  }

  /* =========================================================
     ラウンド終了処理
     ========================================================= */
  endRound() { // ★ 修正（旧 endTurn）
    this.skill_lock = false;
    this.action_resolving = false;

    if (this.ended) return;

    const actor = this.current === this.p1 ? this.P1 : this.P2;
    const target = this.current === this.p1 ? this.P2 : this.P1;

    // ★ 最大レベル未満の時だけ毎ターン EXP +5（達人への道では戦闘中EXPなし）
    if (this.matchType !== "dojo" && (LEVEL_REQUIREMENTS[actor.level] ?? null) != null) {
      actor.exp = (actor.exp ?? 0) + 5;
    }

    // 自動レベルアップ判定
    const res = this.matchType !== "dojo" && actor.try_level_up_auto ? actor.try_level_up_auto() : null;

    if (res && res.auto) {
      this.sendSkill(
        `📘 ${actor.name} は EXP により Lv${actor.level} にアップ！（攻撃+${res.inc ?? 0}）`
      );
    }

    // EXP / レベル情報同期
    const actorWs = this.current;
    safeSend(actorWs, {
      type: "level_info",
      level: actor.level,
      canLevelUp: actor.can_level_up()
    });
    safeSend(actorWs, {
      type: "exp_info",
      exp: actor.exp
    });

    actor.decrease_shikigami_end_of_round();

    this.applyDots();
    if (this.ended) return;


    // ラウンド交代
    [this.current, this.enemy] = [this.enemy, this.current];
    this.round++; // ★ 修正（旧 this.turn++）

    // ★ 次のラウンド開始処理（ここでコイン配布）
    this.startRound(); // ★ 修正（旧 startTurn）

    // コイン同期
    safeSend(this.p1, { type: "coin_info", coins: this.P1.coins });
    safeSend(this.p2, { type: "coin_info", coins: this.P2.coins });

    // ★ sendRoundInfo は startRound() の末尾で送っているため、ここでは二重送信しない

  // ★ 次がCPUのラウンドなら行動させる
  if (this.current.isBot) {
    maybeCpuTurn(this);
  }
    
  }

  // ---------- ★修正版：ショップを開く ----------
  openShop(wsPlayer) {
    const P = (wsPlayer === this.p1 ? this.P1 : this.P2);
    if (wsPlayer !== this.current || this.action_resolving) {
      this.sendPopup("相手が考え中です。", wsPlayer, 1400);
      this.sendError("❌ 今は行動できません。", wsPlayer);
      return;
    }

    // ★ ショップを開いても中身を更新しない（欠損時だけ5枠へ修復）
    if (!Array.isArray(P.shop_items) || P.shop_items.filter(item => item && typeof item === "object").length < SHOP_SLOT_COUNT) {
      P.shop_items = this.generateShopList(P);
    }

    safeSend(wsPlayer, {
      type: "shop_list",
      items: P.shop_items
    });
  }

}

function getDojoStageKind(stage) {
  if (Number(stage) === 30) return "final_boss";
  if (Number(stage) % 10 === 0) return "boss";
  if (Number(stage) % 5 === 0) return "mid_boss";
  return "normal";
}

function randInt(min, max) {
  const lo = Math.ceil(Number(min));
  const hi = Math.floor(Number(max));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function shuffleCopy(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const DOJO_ENEMY_IMAGE_BASE = "Assets/dojo/enemies/";
const DOJO_NORMAL_ENEMIES = [
  { id: "slime", name: "スライム", image: `${DOJO_ENEMY_IMAGE_BASE}slime.png`, scale: 1.0 },
  { id: "goblin", name: "ゴブリン", image: `${DOJO_ENEMY_IMAGE_BASE}goblin.png`, scale: 1.0 },
  { id: "wolf", name: "ウルフ", image: `${DOJO_ENEMY_IMAGE_BASE}wolf.png`, scale: 1.05 },
  { id: "golem", name: "ゴーレム", image: `${DOJO_ENEMY_IMAGE_BASE}golem.png`, scale: 1.12 },
  { id: "ghost", name: "幽霊", image: `${DOJO_ENEMY_IMAGE_BASE}ghost.png`, scale: 1.06 },
  { id: "mushroom", name: "キノコ", image: `${DOJO_ENEMY_IMAGE_BASE}mushroom.png`, scale: 1.0 },
];

const DOJO_MID_BOSSES = [
  { id: "anubis", name: "アヌビス", image: `${DOJO_ENEMY_IMAGE_BASE}anubis.png`, scale: 1.38 },
  { id: "athena", name: "アテナ", image: `${DOJO_ENEMY_IMAGE_BASE}athena.png`, scale: 1.34 },
  { id: "kali", name: "カーリー", image: `${DOJO_ENEMY_IMAGE_BASE}kali.png`, scale: 1.42 },
];

const DOJO_BIG_BOSSES = [
  { id: "susanoo", name: "スサノオ", image: `${DOJO_ENEMY_IMAGE_BASE}susanoo.png`, scale: 1.55 },
  { id: "thor", name: "トール", image: `${DOJO_ENEMY_IMAGE_BASE}thor.png`, scale: 1.55 },
  { id: "zeus", name: "ゼウス", image: `${DOJO_ENEMY_IMAGE_BASE}zeus.png`, scale: 1.62 },
  { id: "ashura", name: "阿修羅", image: `${DOJO_ENEMY_IMAGE_BASE}ashura.png`, scale: 1.7 },
];

function ensureDojoBossPools(run) {
  if (!run) return;
  if (!Array.isArray(run.midBossPool) || run.midBossPool.length < 3) {
    run.midBossPool = shuffleCopy(DOJO_MID_BOSSES.map(b => b.id)).slice(0, 3);
  }
  if (!Array.isArray(run.bigBossPool) || run.bigBossPool.length < 3) {
    run.bigBossPool = shuffleCopy(DOJO_BIG_BOSSES.map(b => b.id)).slice(0, 3);
  }
}

function getDojoBossDef(run, kind, stage) {
  ensureDojoBossPools(run);
  if (kind === "mid_boss") {
    const idx = Math.max(0, [5, 15, 25].indexOf(Number(stage)));
    const id = run?.midBossPool?.[idx] ?? DOJO_MID_BOSSES[idx % DOJO_MID_BOSSES.length].id;
    return DOJO_MID_BOSSES.find(b => b.id === id) ?? DOJO_MID_BOSSES[0];
  }
  if (kind === "boss" || kind === "final_boss") {
    const idx = Number(stage) === 30 ? 2 : Math.max(0, [10, 20].indexOf(Number(stage)));
    const id = run?.bigBossPool?.[idx] ?? DOJO_BIG_BOSSES[idx % DOJO_BIG_BOSSES.length].id;
    return DOJO_BIG_BOSSES.find(b => b.id === id) ?? DOJO_BIG_BOSSES[0];
  }
  return null;
}

function getDojoEnemyStats(stage, kind, enemyId) {
  const s = Math.max(1, Number(stage ?? 1));
  let hp = 30 + Math.floor((s - 1) * 16.2);
  let atk = 5 + Math.floor((s - 1) * 1.38);
  let def = 1 + Math.floor((s - 1) * 0.59);
  const normalMods = {
    slime: { hp: 1.05, atk: 0.95, def: 0.9 },
    goblin: { hp: 0.95, atk: 1.05, def: 0.9 },
    wolf: { hp: 0.9, atk: 1.16, def: 0.85 },
    golem: { hp: 1.25, atk: 0.95, def: 1.35 },
    ghost: { hp: 0.92, atk: 1.08, def: 0.75 },
    mushroom: { hp: 1.04, atk: 0.9, def: 1.05 },
  };
  const mod = normalMods[enemyId] ?? { hp: 1, atk: 1, def: 1 };
  hp = Math.round(hp * mod.hp);
  atk = Math.round(atk * mod.atk);
  def = Math.round(def * mod.def);
  if (s >= 16 && kind === "normal") {
    hp = Math.round(hp * 1.12);
    atk = Math.round(atk * 1.08);
    def = Math.round(def * 1.08);
  }
  if (kind === "mid_boss") {
    hp = Math.round(hp * 1.45);
    atk = Math.round(atk * 1.14);
    def = Math.round(def * 1.18);
  } else if (kind === "boss" || kind === "final_boss") {
    hp = Math.round(hp * 1.85);
    atk = Math.round(atk * 1.28);
    def = Math.round(def * 1.25);
  }
  if (enemyId === "ashura") {
    hp = Math.round(hp * 1.1);
    atk = Math.max(1, Math.round(atk * 0.72));
    def = Math.round(def * 1.08);
  }
  return { hp: Math.max(1, hp), attack: Math.max(1, atk), defense: Math.max(0, def) };
}

const DOJO_TRAIL_NODE_COUNT = 80;

function ensureDojoRunTrailState(run) {
  if (!run || typeof run !== "object") {
    return { prestigePoints: 0, trailNodes: [], trailAttackGrowth: 0, trailItemAttackGrowth: 0, trailCoinSpent: 0 };
  }
  if (!run.dojoTrail || typeof run.dojoTrail !== "object") {
    run.dojoTrail = { prestigePoints: 0, trailNodes: [], trailAttackGrowth: 0, trailItemAttackGrowth: 0, trailCoinSpent: 0 };
  }
  const state = run.dojoTrail;
  state.prestigePoints = Math.max(0, Number(state.prestigePoints ?? 0));
  state.trailAttackGrowth = Math.max(0, Number(state.trailAttackGrowth ?? 0));
  state.trailItemAttackGrowth = Math.max(0, Number(state.trailItemAttackGrowth ?? 0));
  state.trailCoinSpent = Math.max(0, Number(state.trailCoinSpent ?? 0));
  state.trailNodes = [...new Set((state.trailNodes || [])
    .map(n => Number(n))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= DOJO_TRAIL_NODE_COUNT))]
    .sort((a, b) => a - b);
  return state;
}

function addDojoRunTrailPoints(run, amount = 0) {
  const state = ensureDojoRunTrailState(run);
  const add = Math.max(0, Math.floor(Number(amount ?? 0)));
  state.prestigePoints = Number(state.prestigePoints ?? 0) + add;
  return state;
}

function previewDojoTrailUnlock(run, nodeId) {
  const state = ensureDojoRunTrailState(run);
  const id = Number(nodeId);
  const target = DOJO_TRAIL_NODES.find(node => Number(node.id) === id);
  if (!Number.isInteger(id) || id < 1 || id > DOJO_TRAIL_NODE_COUNT) {
    return { ok: false, reason: "invalid node", totalCost: 0, nodes: [], prestigePoints: state.prestigePoints };
  }
  if (!target) {
    return { ok: false, reason: "invalid node", totalCost: 0, nodes: [], prestigePoints: state.prestigePoints };
  }
  const unlocked = new Set((state.trailNodes || []).map(Number));
  if (unlocked.has(id)) {
    return { ok: false, reason: "already unlocked", totalCost: 0, nodes: [], prestigePoints: state.prestigePoints };
  }
  const required = DOJO_TRAIL_NODES
    .filter(node => Number(node.branch) === Number(target.branch) && Number(node.lane) <= Number(target.lane))
    .sort((a, b) => Number(a.lane) - Number(b.lane))
    .filter(node => !unlocked.has(Number(node.id)));
  const totalCost = required.reduce((sum, node) => sum + Math.max(0, Number(node.cost ?? 0)), 0);
  return {
    ok: true,
    totalCost,
    nodes: required.map(node => ({
      id: Number(node.id),
      name: node.name,
      cost: Math.max(0, Number(node.cost ?? 0))
    })),
    prestigePoints: Number(state.prestigePoints ?? 0),
    canUnlock: Number(state.prestigePoints ?? 0) >= totalCost
  };
}

function unlockDojoRunTrailNode(run, nodeId) {
  const state = ensureDojoRunTrailState(run);
  const preview = previewDojoTrailUnlock(run, nodeId);
  if (!preview.ok) {
    return { ...preview, prestigePoints: state.prestigePoints, trailNodes: [...state.trailNodes] };
  }
  if (Number(state.prestigePoints ?? 0) < Number(preview.totalCost ?? 0)) {
    return { ...preview, ok: false, reason: "not enough points", prestigePoints: state.prestigePoints, trailNodes: [...state.trailNodes] };
  }
  const ids = preview.nodes.map(node => Number(node.id));
  state.prestigePoints = Number(state.prestigePoints ?? 0) - Number(preview.totalCost ?? 0);
  state.trailNodes = [...new Set([...state.trailNodes, ...ids])].sort((a, b) => a - b);
  return { ok: true, unlockedNodes: ids, unlockedNodeDetails: preview.nodes, totalCost: preview.totalCost, prestigePoints: state.prestigePoints, trailNodes: [...state.trailNodes] };
}

const DOJO_TRAIL_ATTACK_ICON = "Assets/dojo/trail-icons/attack-up.png";
const DOJO_TRAIL_DEFENSE_ICON = "Assets/dojo/trail-icons/defense-up.png";
const DOJO_TRAIL_EXCALIBUR_ICON = "Assets/dojo/trail-icons/excalibur.png";
const DOJO_TRAIL_AEGIS_ICON = "Assets/dojo/trail-icons/aegis.png";
const DOJO_TRAIL_HP_ICON = "Assets/dojo/trail-icons/hp-up.png";
const DOJO_TRAIL_SLOT_ICON = "Assets/dojo/trail-icons/aegis.png";
const DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON = "Assets/dojo/trail-icons/equipment-slot-small.png";
const DOJO_TRAIL_EQUIP_SLOT_MAJOR_1_ICON = "Assets/dojo/trail-icons/equipment-slot-major-1.png";
const DOJO_TRAIL_EQUIP_SLOT_MAJOR_2_ICON = "Assets/dojo/trail-icons/equipment-slot-major-2.png";
const DOJO_TRAIL_ITEM_SLOT_SMALL_ICON = "Assets/dojo/trail-icons/item-slot-small.png";
const DOJO_TRAIL_ITEM_ATTACK_MAJOR_ICON = "Assets/dojo/trail-icons/item-attack-major.png";
const DOJO_TRAIL_ITEM_DOUBLE_MAJOR_ICON = "Assets/dojo/trail-icons/item-double-major.png";
const DOJO_TRAIL_COIN_GAIN_SMALL_ICON = "Assets/dojo/trail-icons/coin-gain-small.png";
const DOJO_TRAIL_COIN_SHOP_ATTACK_MAJOR_ICON = "Assets/dojo/trail-icons/coin-shop-attack-major.png";
const DOJO_TRAIL_COIN_SPENT_ATTACK_MAJOR_ICON = "Assets/dojo/trail-icons/coin-spent-attack-major.png";
const DOJO_TRAIL_MAJOR_05_ICON = "Assets/dojo/trail-icons/trail-major-05.png";
const DOJO_TRAIL_MAJOR_15_ICON = "Assets/dojo/trail-icons/trail-major-15.png";
const DOJO_TRAIL_MAJOR_25_ICON = "Assets/dojo/trail-icons/trail-major-25.png";
const DOJO_TRAIL_MAJOR_30_ICON = "Assets/dojo/trail-icons/trail-major-30.png";
const DOJO_TRAIL_MAJOR_35_ICON = "Assets/dojo/trail-icons/trail-major-35.png";
const DOJO_TRAIL_MAJOR_40_ICON = "Assets/dojo/trail-icons/trail-major-40.png";
const DOJO_TRAIL_MAJOR_45_ICON = "Assets/dojo/trail-icons/trail-major-45.png";
const DOJO_TRAIL_MAJOR_50_ICON = "Assets/dojo/trail-icons/trail-major-50.png";
const DOJO_TRAIL_MAJOR_55_ICON = "Assets/dojo/trail-icons/trail-major-55.png";
const DOJO_TRAIL_MAJOR_60_ICON = "Assets/dojo/trail-icons/trail-major-60.png";
const DOJO_TRAIL_SMALL_EFFECTS = [
  { name: "攻撃力 +1", effect_text: "全小軌跡共通の小効果：攻撃力が1上昇する。" },
  { name: "防御力 +1", effect_text: "全小軌跡共通の小効果：防御力が1上昇する。" },
  { name: "最大HP +5", effect_text: "全小軌跡共通の小効果：最大HPが5上昇する。" },
  { name: "回復量 +1%", effect_text: "全小軌跡共通の小効果：回復量が1%上昇する。" },
  { name: "コイン獲得 +1%", effect_text: "全小軌跡共通の小効果：コイン獲得量が1%上昇する。" }
];

const DOJO_TRAIL_LEFT_COLUMN_EFFECTS = {
  1: { name: "攻撃力 +1", effect_text: "攻撃力が1上昇する。", icon: DOJO_TRAIL_ATTACK_ICON },
  2: { name: "攻撃力 +1", effect_text: "攻撃力が1上昇する。", icon: DOJO_TRAIL_ATTACK_ICON },
  3: { name: "攻撃力 +1", effect_text: "攻撃力が1上昇する。", icon: DOJO_TRAIL_ATTACK_ICON },
  4: { name: "攻撃力 +1", effect_text: "攻撃力が1上昇する。", icon: DOJO_TRAIL_ATTACK_ICON },
  5: { name: "闘志の大軌跡", effect_text: "解放後、達人への道でステージをクリアするたびに攻撃力が1上昇する。", icon: DOJO_TRAIL_ATTACK_ICON },
  6: { name: "攻撃力 +2", effect_text: "攻撃力が2上昇する。", icon: DOJO_TRAIL_ATTACK_ICON },
  7: { name: "攻撃力 +2", effect_text: "攻撃力が2上昇する。", icon: DOJO_TRAIL_ATTACK_ICON },
  8: { name: "攻撃力 +2", effect_text: "攻撃力が2上昇する。", icon: DOJO_TRAIL_ATTACK_ICON },
  9: { name: "攻撃力 +2", effect_text: "攻撃力が2上昇する。", icon: DOJO_TRAIL_ATTACK_ICON },
  10: { name: "聖剣の大軌跡", effect_text: "特殊装備エクスカリバーを入手する。", icon: DOJO_TRAIL_EXCALIBUR_ICON }
};

const DOJO_TRAIL_SECOND_COLUMN_EFFECTS = {
  11: { name: "防御力 +1", effect_text: "防御力が1上昇する。", icon: DOJO_TRAIL_DEFENSE_ICON },
  12: { name: "防御力 +1", effect_text: "防御力が1上昇する。", icon: DOJO_TRAIL_DEFENSE_ICON },
  13: { name: "防御力 +1", effect_text: "防御力が1上昇する。", icon: DOJO_TRAIL_DEFENSE_ICON },
  14: { name: "防御力 +1", effect_text: "防御力が1上昇する。", icon: DOJO_TRAIL_DEFENSE_ICON },
  15: { name: "堅攻の大軌跡", effect_text: "自身の現在の攻撃力の1/10だけ基礎攻撃力が上昇する。", icon: DOJO_TRAIL_DEFENSE_ICON },
  16: { name: "防御力 +2", effect_text: "防御力が2上昇する。", icon: DOJO_TRAIL_DEFENSE_ICON },
  17: { name: "防御力 +2", effect_text: "防御力が2上昇する。", icon: DOJO_TRAIL_DEFENSE_ICON },
  18: { name: "防御力 +2", effect_text: "防御力が2上昇する。", icon: DOJO_TRAIL_DEFENSE_ICON },
  19: { name: "防御力 +2", effect_text: "防御力が2上昇する。", icon: DOJO_TRAIL_DEFENSE_ICON },
  20: { name: "守護盾の大軌跡", effect_text: "特殊装備アイギスを入手する。", icon: DOJO_TRAIL_AEGIS_ICON }
};

const DOJO_TRAIL_THIRD_COLUMN_EFFECTS = {
  21: { name: "最大HP +5", effect_text: "最大HPが5上昇する。最大HPが増えた分、現在HPも回復する。", icon: DOJO_TRAIL_HP_ICON },
  22: { name: "最大HP +5", effect_text: "最大HPが5上昇する。最大HPが増えた分、現在HPも回復する。", icon: DOJO_TRAIL_HP_ICON },
  23: { name: "最大HP +5", effect_text: "最大HPが5上昇する。最大HPが増えた分、現在HPも回復する。", icon: DOJO_TRAIL_HP_ICON },
  24: { name: "最大HP +5", effect_text: "最大HPが5上昇する。最大HPが増えた分、現在HPも回復する。", icon: DOJO_TRAIL_HP_ICON },
  25: { name: "生命攻の大軌跡", effect_text: "自身の現在HPの1/10だけ基礎攻撃力が上昇する。", icon: DOJO_TRAIL_HP_ICON },
  26: { name: "最大HP +10", effect_text: "最大HPが10上昇する。最大HPが増えた分、現在HPも回復する。", icon: DOJO_TRAIL_HP_ICON },
  27: { name: "最大HP +10", effect_text: "最大HPが10上昇する。最大HPが増えた分、現在HPも回復する。", icon: DOJO_TRAIL_HP_ICON },
  28: { name: "最大HP +10", effect_text: "最大HPが10上昇する。最大HPが増えた分、現在HPも回復する。", icon: DOJO_TRAIL_HP_ICON },
  29: { name: "最大HP +10", effect_text: "最大HPが10上昇する。最大HPが増えた分、現在HPも回復する。", icon: DOJO_TRAIL_HP_ICON },
  30: { name: "生命泉の大軌跡", effect_text: "最大HPが40上昇し、毎ラウンドHPが2回復する。", icon: DOJO_TRAIL_HP_ICON }
};

const DOJO_TRAIL_FOURTH_COLUMN_EFFECTS = {
  31: { name: "コイン獲得量 +5%", effect_text: "達人への道のコイン獲得量が5%上がる。", icon: DOJO_TRAIL_COIN_GAIN_SMALL_ICON },
  32: { name: "コイン獲得量 +5%", effect_text: "達人への道のコイン獲得量が5%上がる。", icon: DOJO_TRAIL_COIN_GAIN_SMALL_ICON },
  33: { name: "コイン獲得量 +5%", effect_text: "達人への道のコイン獲得量が5%上がる。", icon: DOJO_TRAIL_COIN_GAIN_SMALL_ICON },
  34: { name: "コイン獲得量 +5%", effect_text: "達人への道のコイン獲得量が5%上がる。", icon: DOJO_TRAIL_COIN_GAIN_SMALL_ICON },
  35: { name: "鍛冶屋の大軌跡", effect_text: "ショップでコインを消費して購入すると、攻撃力装備★1が追加で手に入る。", icon: DOJO_TRAIL_COIN_SHOP_ATTACK_MAJOR_ICON },
  36: { name: "コイン獲得量 +10%", effect_text: "達人への道のコイン獲得量が10%上がる。", icon: DOJO_TRAIL_COIN_GAIN_SMALL_ICON },
  37: { name: "コイン獲得量 +10%", effect_text: "達人への道のコイン獲得量が10%上がる。", icon: DOJO_TRAIL_COIN_GAIN_SMALL_ICON },
  38: { name: "コイン獲得量 +10%", effect_text: "達人への道のコイン獲得量が10%上がる。", icon: DOJO_TRAIL_COIN_GAIN_SMALL_ICON },
  39: { name: "コイン獲得量 +10%", effect_text: "達人への道のコイン獲得量が10%上がる。", icon: DOJO_TRAIL_COIN_GAIN_SMALL_ICON },
  40: { name: "投資の大軌跡", effect_text: "この挑戦中に消費したコインの1/10だけ基礎攻撃力が上がる。", icon: DOJO_TRAIL_COIN_SPENT_ATTACK_MAJOR_ICON }
};

const DOJO_TRAIL_SEVENTH_COLUMN_EFFECTS = {
  61: { name: "装備持ち込み枠 +1", effect_text: "達人への道の装備持ち込み枠が1増える。", icon: DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON },
  62: { name: "装備持ち込み枠 +1", effect_text: "達人への道の装備持ち込み枠が1増える。", icon: DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON },
  63: { name: "装備持ち込み枠 +1", effect_text: "達人への道の装備持ち込み枠が1増える。", icon: DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON },
  64: { name: "装備持ち込み枠 +1", effect_text: "達人への道の装備持ち込み枠が1増える。", icon: DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON },
  65: { name: "装備拡張の大軌跡", effect_text: "装備できる装備枠と特殊装備枠が1増える。", icon: DOJO_TRAIL_EQUIP_SLOT_MAJOR_1_ICON },
  66: { name: "装備枠 +1", effect_text: "装備できる装備枠が1増える。", icon: DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON },
  67: { name: "特殊装備持ち込み枠 +1", effect_text: "持ち込める特殊装備枠が1増える。", icon: DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON },
  68: { name: "装備枠 +1", effect_text: "装備できる装備枠が1増える。", icon: DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON },
  69: { name: "特殊装備持ち込み枠 +1", effect_text: "持ち込める特殊装備枠が1増える。", icon: DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON },
  70: { name: "特殊装備枠 +3", effect_text: "装備できる特殊装備枠が3増える。", icon: DOJO_TRAIL_EQUIP_SLOT_MAJOR_2_ICON }
};

const DOJO_TRAIL_ITEM_COLUMN_EFFECTS = {
  71: { name: "アイテム持ち込み枠 +1", effect_text: "達人への道のアイテム持ち込み枠が1増える。", icon: DOJO_TRAIL_ITEM_SLOT_SMALL_ICON },
  72: { name: "アイテム持ち込み枠 +1", effect_text: "達人への道のアイテム持ち込み枠が1増える。", icon: DOJO_TRAIL_ITEM_SLOT_SMALL_ICON },
  73: { name: "アイテム持ち込み枠 +1", effect_text: "達人への道のアイテム持ち込み枠が1増える。", icon: DOJO_TRAIL_ITEM_SLOT_SMALL_ICON },
  74: { name: "アイテム持ち込み枠 +1", effect_text: "達人への道のアイテム持ち込み枠が1増える。", icon: DOJO_TRAIL_ITEM_SLOT_SMALL_ICON },
  75: { name: "闘志の秘薬", effect_text: "アイテム使用時に基礎攻撃力が上昇する（達人への道挑戦中は永続、挑戦終了時のみリセット）。", icon: DOJO_TRAIL_ITEM_ATTACK_MAJOR_ICON },
  76: { name: "アイテム持ち込み枠 +1", effect_text: "達人への道のアイテム持ち込み枠が1増える。", icon: DOJO_TRAIL_ITEM_SLOT_SMALL_ICON },
  77: { name: "アイテム持ち込み枠 +1", effect_text: "達人への道のアイテム持ち込み枠が1増える。", icon: DOJO_TRAIL_ITEM_SLOT_SMALL_ICON },
  78: { name: "アイテム持ち込み枠 +1", effect_text: "達人への道のアイテム持ち込み枠が1増える。", icon: DOJO_TRAIL_ITEM_SLOT_SMALL_ICON },
  79: { name: "アイテム持ち込み枠 +1", effect_text: "達人への道のアイテム持ち込み枠が1増える。", icon: DOJO_TRAIL_ITEM_SLOT_SMALL_ICON },
  80: { name: "万能の秘薬", effect_text: "アイテム使用時に効果が2回発動する。", icon: DOJO_TRAIL_ITEM_DOUBLE_MAJOR_ICON }
};

const DOJO_TRAIL_MAJOR_ICON_OVERRIDES = {
  5: DOJO_TRAIL_MAJOR_05_ICON,
  15: DOJO_TRAIL_MAJOR_15_ICON,
  25: DOJO_TRAIL_MAJOR_25_ICON,
  30: DOJO_TRAIL_MAJOR_30_ICON,
  35: DOJO_TRAIL_COIN_SHOP_ATTACK_MAJOR_ICON,
  40: DOJO_TRAIL_COIN_SPENT_ATTACK_MAJOR_ICON,
  45: DOJO_TRAIL_MAJOR_45_ICON,
  50: DOJO_TRAIL_MAJOR_50_ICON,
  55: DOJO_TRAIL_MAJOR_55_ICON,
  60: DOJO_TRAIL_MAJOR_60_ICON
};

function createDojoExcalibur() {
  return {
    uid: crypto.randomUUID(),
    name: "エクスカリバー",
    is_equip: true,
    equip_type: "dojo_special",
    dojo_special_effect: "excalibur",
    attack_bonus: 5,
    icon_src: DOJO_TRAIL_EXCALIBUR_ICON,
    effect_text: "攻撃力+5。攻撃力アップバフが自身についた時、次の自分の攻撃力+10（重複なし）。"
  };
}

function createDojoAegis() {
  return {
    uid: crypto.randomUUID(),
    name: "アイギス",
    is_equip: true,
    equip_type: "dojo_special",
    dojo_special_effect: "aegis",
    defense_bonus: 5,
    icon_src: DOJO_TRAIL_AEGIS_ICON,
    effect_text: "基礎防御力+5。防御力アップバフを受けている間、その数値分だけ攻撃力も上昇する。"
  };
}

function createDojoAttackEquipStar1() {
  return {
    uid: crypto.randomUUID(),
    name: "★1 攻撃力装備",
    star: 1,
    is_equip: true,
    equip_type: "normal",
    equip_category: "攻撃力",
    effect_type: "攻撃力",
    equip_power: 2,
    power: 2,
    price: 0,
    effect_text: "攻撃力+2",
    is_arrow: false
  };
}

function createDojoTrailNode(id) {
  const branchSize = 10;
  const rawBranch = Math.floor((id - 1) / branchSize);
  const branch = rawBranch === 5 ? 7 : rawBranch === 7 ? 5 : rawBranch;
  const lane = ((id - 1) % branchSize) + 1;
  const within = (lane - 1) % 5;
  const isMajor = within === 4;
  const group = Math.ceil(lane / 5);
  const distanceByLane = [0, 9.5, 14, 18.5, 24, 32, 41.5, 47, 52, 58, 64.5];
  const angle = (-138 + branch * (96 / 7)) * Math.PI / 180;
  const distance = distanceByLane[lane] ?? (10 + lane * 6);
  const effect = DOJO_TRAIL_LEFT_COLUMN_EFFECTS[id] ?? DOJO_TRAIL_SECOND_COLUMN_EFFECTS[id] ?? DOJO_TRAIL_THIRD_COLUMN_EFFECTS[id] ?? DOJO_TRAIL_FOURTH_COLUMN_EFFECTS[id] ?? DOJO_TRAIL_SEVENTH_COLUMN_EFFECTS[id] ?? DOJO_TRAIL_ITEM_COLUMN_EFFECTS[id] ?? DOJO_TRAIL_SMALL_EFFECTS[(id - 1) % DOJO_TRAIL_SMALL_EFFECTS.length];
  const majorIconOverride = DOJO_TRAIL_MAJOR_ICON_OVERRIDES[id];
  return {
    id,
    isMajor,
    branch,
    ring: group,
    lane,
    name: effect.name ?? (isMajor ? `大きな軌跡 ${Math.ceil(id / 5)}` : "軌跡"),
    effect: effect.effect_text,
    effect_text: effect.effect_text,
    icon: majorIconOverride ?? effect.icon ?? null,
    cost: isMajor ? 3 : 1,
    x: 50 + Math.cos(angle) * distance,
    y: 90 + Math.sin(angle) * distance
  };
}

const DOJO_TRAIL_NODES = Array.from({ length: DOJO_TRAIL_NODE_COUNT }, (_, i) => createDojoTrailNode(i + 1));

function buildDojoTrailView(wsOrAccountId, jobName = "戦士") {
  const accountId = typeof wsOrAccountId === "string" ? wsOrAccountId : wsOrAccountId?.accountId;
  const job = typeof wsOrAccountId === "string" ? jobName : (wsOrAccountId?.dojoRun?.jobName ?? jobName);
  const state = typeof wsOrAccountId === "string"
    ? (accountId ? getDojoTrailState({ accountId, job }) : null)
    : ensureDojoRunTrailState(wsOrAccountId?.dojoRun);
  const unlocked = new Set((state?.trailNodes || []).map(Number));
  return {
    prestigePoints: Number(state?.prestigePoints ?? 0),
    unlockedNodes: [...unlocked].sort((a, b) => a - b),
    unlockedCount: unlocked.size,
    trailAttackGrowth: Number(state?.trailAttackGrowth ?? 0),
    total: DOJO_TRAIL_NODE_COUNT,
    nodes: DOJO_TRAIL_NODES.map(node => ({ ...node, unlocked: unlocked.has(node.id) }))
  };
}

function getDojoTrailAttackBonus(state) {
  const unlocked = new Set((state?.trailNodes || []).map(Number));
  let bonus = Number(state?.trailAttackGrowth ?? 0) + Number(state?.trailItemAttackGrowth ?? 0);
  for (const id of [1, 2, 3, 4]) if (unlocked.has(id)) bonus += 1;
  for (const id of [6, 7, 8, 9]) if (unlocked.has(id)) bonus += 2;
  if (unlocked.has(40)) bonus += Math.floor(Number(state?.trailCoinSpent ?? 0) / 10);
  return bonus;
}

function getDojoTrailCoinGainPercent(state) {
  const unlocked = new Set((state?.trailNodes || []).map(Number));
  let percent = 0;
  for (const id of [31, 32, 33, 34]) if (unlocked.has(id)) percent += 5;
  for (const id of [36, 37, 38, 39]) if (unlocked.has(id)) percent += 10;
  return percent;
}

function applyDojoTrailCoinGainBonus(run, amount) {
  const base = Math.max(0, Math.floor(Number(amount ?? 0)));
  const percent = getDojoTrailCoinGainPercent(ensureDojoRunTrailState(run));
  if (percent <= 0 || base <= 0) return base;
  return Math.max(base, Math.floor(base * (100 + percent) / 100));
}

function recordDojoCoinSpent(ws, amount) {
  if (!ws?.dojoRun || !ws?.player) return 0;
  const spent = Math.max(0, Math.floor(Number(amount ?? 0)));
  if (spent <= 0) return 0;
  const state = ensureDojoRunTrailState(ws.dojoRun);
  state.trailCoinSpent = Number(state.trailCoinSpent ?? 0) + spent;
  applyDojoTrailBonusesToPlayer(ws);
  return spent;
}

function getDojoTrailDefenseBonus(state) {
  const unlocked = new Set((state?.trailNodes || []).map(Number));
  let bonus = 0;
  for (const id of [11, 12, 13, 14]) if (unlocked.has(id)) bonus += 1;
  for (const id of [16, 17, 18, 19]) if (unlocked.has(id)) bonus += 2;
  return bonus;
}

function getDojoTrailRatioAttackBonus(state, player, staticAttackBonus) {
  const unlocked = new Set((state?.trailNodes || []).map(Number));
  const currentBaseAttack = Number(player?.base_attack ?? player?.attack ?? 0);
  let bonus = 0;
  if (unlocked.has(15)) {
    bonus += Math.max(0, Math.floor((currentBaseAttack + Number(staticAttackBonus ?? 0)) / 10));
  }
  if (unlocked.has(25)) {
    bonus += Math.max(0, Math.floor(Number(player?.hp ?? 0) / 10));
  }
  return bonus;
}

function getDojoTrailMaxHpBonus(state) {
  const unlocked = new Set((state?.trailNodes || []).map(Number));
  let bonus = 0;
  for (const id of [21, 22, 23, 24]) if (unlocked.has(id)) bonus += 5;
  for (const id of [26, 27, 28, 29]) if (unlocked.has(id)) bonus += 10;
  if (unlocked.has(30)) bonus += 40;
  return bonus;
}

function hasDojoTrailRoundRegen(state) {
  const unlocked = new Set((state?.trailNodes || []).map(Number));
  return unlocked.has(30);
}

function getDojoTrailSlotBonuses(state) {
  const unlocked = new Set((state?.trailNodes || []).map(Number));
  let itemCarry = 0;
  let equipmentCarry = 0;
  let specialCarry = 0;
  let equipmentEquip = 1;
  let specialEquip = 1;
  for (const id of [71, 72, 73, 74, 76, 77, 78, 79]) if (unlocked.has(id)) itemCarry += 1;
  for (const id of [61, 62, 63, 64]) if (unlocked.has(id)) equipmentCarry += 1;
  for (const id of [67, 69]) if (unlocked.has(id)) specialCarry += 1;
  if (unlocked.has(65)) {
    equipmentEquip += 1;
    specialEquip += 1;
  }
  for (const id of [66, 68]) if (unlocked.has(id)) equipmentEquip += 1;
  if (unlocked.has(70)) specialEquip += 3;
  return {
    carrySlots: {
      items: 1 + itemCarry,
      equipment: 1 + equipmentCarry,
      special: 1 + specialCarry
    },
    equipSlots: {
      equipment: equipmentEquip,
      special: specialEquip
    }
  };
}

function applyDojoTrailSlotBonusesToPlayer(ws) {
  if (!ws?.dojoRun || !ws?.player) return;
  ensureDojoInventoryState(ws.player);
  const bonuses = getDojoTrailSlotBonuses(ensureDojoRunTrailState(ws.dojoRun));
  ws.player.dojoCarrySlots = { ...bonuses.carrySlots };
  ws.player.dojoEquipSlots = { ...bonuses.equipSlots };
  pruneDojoLoadout(ws.player);
}

function hasDojoExcalibur(player) {
  const lists = [
    player?.dojoStorage?.special,
    player?.special_inventory,
    player?.special_equipment ? [player.special_equipment] : []
  ];
  return lists.some(list => (list || []).some(it => it?.dojo_special_effect === "excalibur" || it?.name === "エクスカリバー"));
}

function hasDojoAegis(player) {
  const lists = [
    player?.dojoStorage?.special,
    player?.special_inventory,
    player?.special_equipment ? [player.special_equipment] : []
  ];
  return lists.some(list => (list || []).some(it => it?.dojo_special_effect === "aegis" || it?.name === "アイギス"));
}

function addDojoExcaliburToStorage(player) {
  if (!player || hasDojoExcalibur(player)) return false;
  addUniqueDojoStorage(player, "special", createDojoExcalibur());
  return true;
}

function addDojoAegisToStorage(player) {
  if (!player || hasDojoAegis(player)) return false;
  addUniqueDojoStorage(player, "special", createDojoAegis());
  return true;
}

function applyDojoTrailBonusesToPlayer(ws) {
  if (!ws?.dojoRun || !ws?.player) return;
  const state = ensureDojoRunTrailState(ws.dojoRun);
  const player = ws.player;
  const rawCurrentHp = Number(player.hp ?? player.max_hp ?? 1);
  const currentHpBeforeReapply = Number.isFinite(rawCurrentHp) ? rawCurrentHp : 1;
  const previousAttack = Number(player._dojoTrailAttackBonusApplied ?? 0);
  const previousDefense = Number(player._dojoTrailDefenseBonusApplied ?? 0);
  const previousMaxHp = Number(player._dojoTrailMaxHpBonusApplied ?? 0);
  if (previousAttack) {
    player.base_attack = Number(player.base_attack ?? player.attack ?? 0) - previousAttack;
    player.attack = Number(player.attack ?? player.base_attack ?? 0) - previousAttack;
  }
  if (previousDefense) {
    player.base_defense = Number(player.base_defense ?? player.defense ?? 0) - previousDefense;
    player.defense = Number(player.defense ?? player.base_defense ?? 0) - previousDefense;
  }
  if (previousMaxHp) {
    player.max_hp = Math.max(1, Number(player.max_hp ?? 1) - previousMaxHp);
  }
  const staticAttackBonus = getDojoTrailAttackBonus(state);
  const attackBonus = staticAttackBonus + getDojoTrailRatioAttackBonus(state, player, staticAttackBonus);
  const defenseBonus = getDojoTrailDefenseBonus(state);
  const maxHpBonus = getDojoTrailMaxHpBonus(state);
  const coinGainPercent = getDojoTrailCoinGainPercent(state);
  player._dojoTrailAttackBonusApplied = attackBonus;
  player._dojoTrailDefenseBonusApplied = defenseBonus;
  player._dojoTrailMaxHpBonusApplied = maxHpBonus;
  player._dojoTrailRoundRegen = hasDojoTrailRoundRegen(state) ? 2 : 0;
  player._dojoTrailCoinGainPercent = coinGainPercent;
  player.base_attack = Number(player.base_attack ?? player.attack ?? 0) + attackBonus;
  player.attack = Number(player.attack ?? player.base_attack ?? 0) + attackBonus;
  player.base_defense = Number(player.base_defense ?? player.defense ?? 0) + defenseBonus;
  player.defense = Number(player.defense ?? player.base_defense ?? 0) + defenseBonus;
  const baseMaxHpBeforeApply = Math.max(1, Number(player.max_hp ?? player.hp ?? 1));
  const hpIncrease = Math.max(0, maxHpBonus - previousMaxHp);
  const hpAlreadyIncludesTrailMax =
    previousMaxHp === 0 &&
    (!!player._dojoRestoredFromSave || currentHpBeforeReapply > baseMaxHpBeforeApply);
  const effectiveHpIncrease = hpAlreadyIncludesTrailMax ? 0 : hpIncrease;
  player.max_hp = baseMaxHpBeforeApply + maxHpBonus;
  player.hp = Math.max(0, Math.min(player.max_hp, currentHpBeforeReapply + effectiveHpIncrease));
  delete player._dojoRestoredFromSave;
  if ((state?.trailNodes || []).map(Number).includes(10)) addDojoExcaliburToStorage(player);
  if ((state?.trailNodes || []).map(Number).includes(20)) addDojoAegisToStorage(player);
  

  // 達人への道：アイテム関連のノード情報を初期化
  player.dojoTrailNodes = (state?.trailNodes || []).map(Number);
  player.dojoItemAttackBuff = Number(state?.trailItemAttackGrowth ?? 0);
  player.dojoItemDoubleEffect = player.dojoTrailNodes.includes(80);
  player.dojoTrailBuffs = buildDojoTrailBuffUIEntries(player);
}

function applyDojoTrailItemUseBonuses(ws, match = null, item = null) {
  if (!ws?.dojoRun || !ws?.player) return;
  const state = ensureDojoRunTrailState(ws.dojoRun);
  const unlocked = new Set((state?.trailNodes || []).map(Number));
  if (!unlocked.has(75)) return;
  state.trailItemAttackGrowth = Number(state.trailItemAttackGrowth ?? 0) + 1;
  applyDojoTrailBonusesToPlayer(ws);
  match?.sendBattle?.(`闘志の秘薬の効果で、${item?.name ?? "アイテム"}使用後の基礎攻撃力が1上昇した。`);
}

function createDojoEnemy(stage, run = null) {
  const kind = getDojoStageKind(stage);
  const bossDef = getDojoBossDef(run, kind, stage);
  const def = bossDef ?? pickRandom(DOJO_NORMAL_ENEMIES);
  const enemy = new Player(def.name, 1);
  const s = Number(stage ?? 1);
  const stats = getDojoEnemyStats(s, kind, def.id);
  enemy.job = kind === "normal" ? "モンスター" : "ボス";
  enemy.max_hp = stats.hp;
  enemy.hp = enemy.max_hp;
  enemy.base_attack = stats.attack;
  enemy.attack = stats.attack;
  enemy.base_defense = stats.defense;
  enemy.defense = stats.defense;
  enemy.coins = 0;
  enemy.exp = 0;
  enemy.level = Math.min(30, s);
  enemy.isDojoEnemy = true;
  enemy.dojoStage = s;
  enemy.dojoStageKind = kind;
  enemy.dojoEnemyId = def.id;
  enemy.dojoEnemyImage = def.image;
  enemy.dojoEnemyScale = def.scale;
  enemy.dojoAwakened = false;
  enemy.items = [];
  enemy.equipment = null;
  enemy.equipment_inventory = [];
  enemy.special_equipment = null;
  enemy.special_inventory = [];
  return enemy;
}

function isDojoGoblinStealable(item) {
  if (!item) return false;
  if (item.is_mage_item || item.effect_type === "MANA") return false;
  if (item.is_onmyoji_item) return false;
  if (item.is_doll_item || item.is_doll_costume) return false;
  if (item.is_mad_special_item) return false;
  if (item.is_priest_item) return false;
  if (item.is_arrow || item.equip_type === "arrow") return false;
  if (item.equip_type === "mage_equip") return false;
  if (item.equip_type === "alchemist_unique") return false;
  if (item.equip_type === "dojo_special") return false;
  return true;
}

function dojoAddBuff(player, type, power, rounds, source) {
  player.active_buffs ??= [];
  player.active_buffs.push({ type, power, rounds, source });
}

function dojoAddPoison(player, power, turns, source = "毒") {
  player.dot_effects ??= [];
  player.dot_effects.push({ name: source, power, turns, rounds: turns });
}

function stealDojoGoblinItem(target) {
  const candidates = [];
  (target.items ?? []).forEach((it, index) => {
    if (isDojoGoblinStealable(it) && !it.is_equip) candidates.push({ key: "items", index, item: it });
  });
  (target.equipment_inventory ?? []).forEach((it, index) => {
    if (isDojoGoblinStealable(it) && it.is_equip) candidates.push({ key: "equipment_inventory", index, item: it });
  });
  if (!candidates.length) return null;
  const pick = pickRandom(candidates);
  target[pick.key].splice(pick.index, 1);
  return pick.item;
}

function pickDojoEnemyAction(enemy) {
  const boss = enemy.dojoStageKind === "boss" || enemy.dojoStageKind === "final_boss" || enemy.dojoStageKind === "mid_boss";
  const half = Number(enemy.hp ?? 0) <= Math.floor(Number(enemy.max_hp ?? 1) / 2);
  const r = Math.random() * 100;
  if (!boss) {
    if (r < 40) return "normal";
    if (r < 60) return "a";
    if (r < 80) return "b";
    return "c";
  }
  if (half) {
    if (r < 15) return "normal";
    if (r < 40) return "a";
    if (r < 70) return "b";
    return "c";
  }
  if (r < 25) return "normal";
  if (r < 50) return "a";
  if (r < 75) return "b";
  return "c";
}

function resetDojoBattleState(player) {
  player.used_skill_set = new Set();
  player.active_buffs = [];
  player.dot_effects = [];
  player.freeze_debuffs = [];
  player.shikigami_effects = [];
  player.skill_sealed = false;
  player.barrier = 0;
  player.item_use_count = 0;
  player.sudden_death_debuff = null;
}

function ensureDojoInventoryState(player) {
  if (!player.dojoStorage || typeof player.dojoStorage !== "object") {
    player.dojoStorage = {
      items: [],
      equipment: [],
      special: []
    };
  }
  player.dojoStorage.items = Array.isArray(player.dojoStorage.items) ? player.dojoStorage.items : [];
  player.dojoStorage.equipment = Array.isArray(player.dojoStorage.equipment) ? player.dojoStorage.equipment : [];
  player.dojoStorage.special = Array.isArray(player.dojoStorage.special) ? player.dojoStorage.special : [];
  if (!player.dojoLoadout || typeof player.dojoLoadout !== "object") {
    player.dojoLoadout = { items: [], equipment: [], special: [] };
  }
  player.dojoLoadout.items = Array.isArray(player.dojoLoadout.items) ? player.dojoLoadout.items : [];
  player.dojoLoadout.equipment = Array.isArray(player.dojoLoadout.equipment) ? player.dojoLoadout.equipment : [];
  player.dojoLoadout.special = Array.isArray(player.dojoLoadout.special) ? player.dojoLoadout.special : [];
  if (!player.dojoCarrySlots || typeof player.dojoCarrySlots !== "object") {
    player.dojoCarrySlots = { items: 1, equipment: 1, special: 1 };
  }
  player.dojoCarrySlots.items = Math.max(1, Number(player.dojoCarrySlots.items ?? 1));
  player.dojoCarrySlots.equipment = Math.max(1, Number(player.dojoCarrySlots.equipment ?? 1));
  player.dojoCarrySlots.special = Math.max(1, Number(player.dojoCarrySlots.special ?? 1));
}

function pruneDojoLoadout(player) {
  ensureDojoInventoryState(player);
  for (const key of ["items", "equipment", "special"]) {
    const available = new Set(player.dojoStorage[key].map(it => String(it?.uid)));
    const limit = Number(player.dojoCarrySlots[key] ?? 1);
    player.dojoLoadout[key] = player.dojoLoadout[key]
      .map(String)
      .filter(uid => available.has(uid))
      .slice(0, limit);
  }
}

function dojoStorageKey(category) {
  if (category === "item" || category === "items") return "items";
  if (category === "equip" || category === "equipment") return "equipment";
  if (category === "special") return "special";
  return null;
}

function addUniqueDojoStorage(player, category, item) {
  if (!item) return;
  ensureDojoInventoryState(player);
  const key = dojoStorageKey(category);
  if (!key) return;
  if (!item.uid) item.uid = crypto.randomUUID();
  const list = player.dojoStorage[key];
  if (!list.some(x => String(x?.uid) === String(item.uid))) {
    list.push(item);
  }
}

function addItemToDojoStorage(player, item) {
  if (!item) return;
  if (item.is_arrow || item.equip_type === "arrow" || item.equip_type === "mage_equip" || item.equip_type === "alchemist_unique" || item.equip_type === "dojo_special" || item.is_doll_costume) {
    addUniqueDojoStorage(player, "special", item);
  } else if (item.is_equip) {
    addUniqueDojoStorage(player, "equipment", item);
  } else {
    addUniqueDojoStorage(player, "items", item);
  }
}

function combineDojoStorageEquips(ws, uid1, uid2) {
  if (!ws?.player) return false;
  const P = ws.player;
  ensureDojoInventoryState(P);
  const id1 = String(uid1 ?? "");
  const id2 = String(uid2 ?? "");

  if (!id1 || !id2 || id1 === id2) {
    safeSend(ws, { type: "popup", msg: "合成する装備を2つ選んでください。", ms: 2400 });
    return false;
  }

  const storage = P.dojoStorage.equipment ?? [];
  const eq1 = storage.find(it => String(it?.uid) === id1);
  const eq2 = storage.find(it => String(it?.uid) === id2);
  if (!eq1 || !eq2) {
    safeSend(ws, { type: "popup", msg: "合成に必要な装備が見つかりません。", ms: 2400 });
    return false;
  }

  if (!eq1.is_equip || !eq2.is_equip || eq1.equip_type !== "normal" || eq2.equip_type !== "normal") {
    safeSend(ws, { type: "popup", msg: "通常装備のみ合成できます。", ms: 2400 });
    return false;
  }

  const star1 = Number(eq1.star ?? 1);
  const star2 = Number(eq2.star ?? 1);
  const category1 = String(eq1.equip_category ?? eq1.effect_type ?? "");
  const category2 = String(eq2.equip_category ?? eq2.effect_type ?? "");
  if (star1 !== star2 || category1 !== category2) {
    safeSend(ws, { type: "popup", msg: "星と効果が同じ通常装備を2つ選んでください。", ms: 2400 });
    return false;
  }

  const nextEquip = upgradeEquipStar({
    ...eq1,
    uid: crypto.randomUUID(),
  });
  P.dojoStorage.equipment = storage.filter(it => String(it?.uid) !== id1 && String(it?.uid) !== id2);
  P.dojoStorage.equipment.push(nextEquip);
  P.dojoLoadout.equipment = (P.dojoLoadout.equipment ?? [])
    .map(String)
    .filter(uid => uid !== id1 && uid !== id2);
  safeSend(ws, { type: "popup", msg: `${nextEquip.name} を合成しました`, ms: 2200 });
  return true;
}

function returnDojoBattleItemsToStorage(player) {
  ensureDojoInventoryState(player);
  for (const it of player.items ?? []) addUniqueDojoStorage(player, "items", it);
  if (player.equipment) addUniqueDojoStorage(player, "equipment", player.equipment);
  for (const it of player.extra_equipments ?? []) addUniqueDojoStorage(player, "equipment", it);
  for (const it of player.equipment_inventory ?? []) addUniqueDojoStorage(player, "equipment", it);
  if (player.special_equipment) addUniqueDojoStorage(player, "special", player.special_equipment);
  for (const it of player.extra_special_equipments ?? []) addUniqueDojoStorage(player, "special", it);
  for (const it of player.special_inventory ?? []) addUniqueDojoStorage(player, "special", it);
  if (player.arrow) addUniqueDojoStorage(player, "special", player.arrow);
  if (player.arrow2) addUniqueDojoStorage(player, "special", player.arrow2);
  for (const it of player.arrow_inventory ?? []) addUniqueDojoStorage(player, "special", it);
  for (const it of Object.values(player.mage_equips ?? {})) {
    if (it) addUniqueDojoStorage(player, "special", it);
  }
  if (player.alchemist_equip) addUniqueDojoStorage(player, "special", player.alchemist_equip);
  const previousLoadout = player._dojoSelectedLoadoutBeforeBattle;

  player.items = [];
  player.equipment = null;
  player.extra_equipments = [];
  player.equipment_inventory = [];
  player.special_equipment = null;
  player.extra_special_equipments = [];
  player.special_inventory = [];
  player.arrow = null;
  player.arrow2 = null;
  player.arrow_inventory = [];
  if (player.mage_equips) {
    for (const key of Object.keys(player.mage_equips)) player.mage_equips[key] = null;
  }
  player.alchemist_equip = null;
}

function takeSelectedDojoStorage(player, key) {
  ensureDojoInventoryState(player);
  const slotCount = Number(player.dojoCarrySlots[key] ?? 1);
  const selected = new Set(player.dojoLoadout[key].slice(0, slotCount).map(String));
  const picked = [];
  player.dojoStorage[key] = player.dojoStorage[key].filter(item => {
    if (selected.has(String(item?.uid))) {
      picked.push(item);
      return false;
    }
    return true;
  });
  player.dojoLoadout[key] = picked.map(it => it.uid);
  return picked;
}

function applyDojoLoadoutToBattle(player) {
  ensureDojoInventoryState(player);
  const selectedBefore = {
    items: [...(player.dojoLoadout.items ?? [])],
    equipment: [...(player.dojoLoadout.equipment ?? [])],
    special: [...(player.dojoLoadout.special ?? [])]
  };
  player.items = takeSelectedDojoStorage(player, "items");
  player.equipment_inventory = takeSelectedDojoStorage(player, "equipment");
  const special = takeSelectedDojoStorage(player, "special");
  player.special_inventory = special.filter(it => !(it.is_arrow || it.equip_type === "arrow"));
  player.arrow_inventory = special.filter(it => it.is_arrow || it.equip_type === "arrow");
  player.equipment = null;
  player.extra_equipments = [];
  player.special_equipment = null;
  player.extra_special_equipments = [];
  player.arrow = null;
  player.arrow2 = null;
  player._dojoSelectedLoadoutBeforeBattle = selectedBefore;
}

function buildDojoRunView(run, player, wsOrAccountId = null) {
  ensureDojoInventoryState(player);
  pruneDojoLoadout(player);
  const currentExp = Number(player?.exp ?? 0);
  const nextExp = LEVEL_REQUIREMENTS[player?.level] ?? null;
  const trailBuffs = Array.isArray(player.dojoTrailBuffs)
    ? player.dojoTrailBuffs
    : buildDojoTrailBuffUIEntries(player);
  return {
    stage: Number(run?.stage ?? 1),
    maxStage: 30,
    jobName: run?.jobName ?? player?.job ?? "戦士",
    hp: Math.max(1, Number(player?.hp ?? 0)),
    max_hp: Number(player?.max_hp ?? 0),
    attack: player?.doll ? (player.doll.is_broken ? 0 : player.getDollAttack()) : Number(player?.get_total_attack?.() ?? player?.attack ?? 0),
    defense: player?.doll ? (player.doll.is_broken ? 0 : player.getDollDefense()) : Number(player?.get_total_defense?.() ?? player?.defense ?? 0),
    trailBuffs,
    level: Number(player?.level ?? 1),
    exp: currentExp,
    next_level_exp: nextExp,
    next_level_remaining: nextExp == null ? 0 : Math.max(0, Number(nextExp) - currentExp),
    coins: Number(player?.coins ?? 0),
    items: player.dojoStorage.items,
    equipment: player.dojoStorage.equipment,
    special: player.dojoStorage.special,
    loadout: player.dojoLoadout,
    carrySlots: player.dojoCarrySlots,
    equipSlots: player.dojoEquipSlots ?? { equipment: 1, special: 1 },
    trail: buildDojoTrailView(wsOrAccountId, run?.jobName ?? player?.job ?? "戦士"),
    lastDrops: run?.lastDrops ?? [],
    highestStage: Number(run?.highestStage ?? 0),
    cleared: !!run?.cleared
  };
}

function generateDojoDrops(run, player) {
  const stage = Number(run?.stage ?? 1);
  const kind = getDojoStageKind(stage);
  if (kind === "final_boss") return [];
  const drops = [
    { type: "coin", name: "コイン", amount: applyDojoTrailCoinGainBonus(run, randInt(5, 20)) },
    { type: "exp", name: "EXP", amount: 5 },
  ];
  if (kind === "boss") {
    drops.push({ type: "prestige", name: "軌跡ポイント", amount: randInt(8, 10) });
    drops.push({ type: "proof", name: "達人の証", amount: 2 });
  } else if (kind === "mid_boss") {
    drops.push({ type: "prestige", name: "軌跡ポイント", amount: randInt(5, 8) });
    drops.push({ type: "proof", name: "達人の証", amount: 1 });
  } else {
    drops.push({ type: "prestige", name: "軌跡ポイント", amount: randInt(2, 5) });
  }

  const isBoss = kind === "boss" || kind === "mid_boss";
  const dropRate = isBoss ? 0.55 : 0.28;
  if (Math.random() < dropRate) {
    const level = isBoss ? 3 : 1;
    if (Math.random() < 0.55) {
      let eq = null;
      for (let i = 0; i < 12; i++) {
        const candidate = generateEquipmentForLevel(level);
        if (!isCoinEquipment(candidate)) {
          eq = candidate;
          break;
        }
      }
      if (eq) {
        eq.uid = crypto.randomUUID();
        drops.push({ type: "equip", name: eq.name, item: eq });
      } else {
        const item = generateOneShopItem(level);
        item.uid = crypto.randomUUID();
        drops.push({ type: "item", name: item.name, item });
      }
    } else {
      const item = generateOneShopItem(level);
      item.uid = crypto.randomUUID();
      drops.push({ type: "item", name: item.name, item });
    }
  }
  return drops;
}

function applyDojoDrops(run, player, drops) {
  for (const drop of drops ?? []) {
    if (drop?.type === "coin") {
      player.coins = Number(player.coins ?? 0) + Number(drop.amount ?? 0);
    } else if (drop?.type === "exp") {
      player.exp = Number(player.exp ?? 0) + Number(drop.amount ?? 0);
    } else if (drop?.type === "equip" && drop.item) {
      addUniqueDojoStorage(player, "equipment", drop.item);
    } else if (drop?.type === "item" && drop.item) {
      addItemToDojoStorage(player, drop.item);
    } else if (drop?.type === "special" && drop.item) {
      addUniqueDojoStorage(player, "special", drop.item);
    }
  }
}

function addShopItemToPlayerInventory(P, item) {
  P.items = Array.isArray(P.items) ? P.items : [];
  P.equipment_inventory = Array.isArray(P.equipment_inventory) ? P.equipment_inventory : [];
  P.special_inventory = Array.isArray(P.special_inventory) ? P.special_inventory : [];
  P.arrow_inventory = Array.isArray(P.arrow_inventory) ? P.arrow_inventory : [];
  if (item.is_arrow || item.equip_type === "arrow") {
    P.arrow_inventory.push(item);
  } else if (item.is_doll_costume && P.job === "人形使い") {
    P.special_inventory.push(item);
  } else if (item.equip_type === "mage_equip" || item.equip_type === "alchemist_unique") {
    P.special_inventory.push(item);
  } else if (item.is_mad_special_item) {
    P.items.push(item);
  } else if (item.is_equip) {
    P.equipment_inventory.push(item);
  } else {
    P.items.push(item);
  }
}

function serializeDojoPlayer(player) {
  const trailMaxHpBonus = Number(player?._dojoTrailMaxHpBonusApplied ?? 0);
  return {
    name: player?.name ?? "Player",
    profile: player?.profile ?? null,
    job: player?.job ?? "戦士",
    level: Number(player?.level ?? 1),
    exp: Number(player?.exp ?? 0),
    hp: Number(player?.hp ?? 0),
    max_hp: Math.max(1, Number(player?.max_hp ?? 0) - trailMaxHpBonus),
    dojoTrailBonusesStripped: true,
    base_attack: Number(player?.base_attack ?? player?.attack ?? 0) - Number(player?._dojoTrailAttackBonusApplied ?? 0),
    attack: Number(player?.attack ?? 0) - Number(player?._dojoTrailAttackBonusApplied ?? 0),
    base_defense: Number(player?.base_defense ?? player?.defense ?? 0) - Number(player?._dojoTrailDefenseBonusApplied ?? 0),
    defense: Number(player?.defense ?? 0) - Number(player?._dojoTrailDefenseBonusApplied ?? 0),
    coins: Number(player?.coins ?? 0),
    items: player?.items ?? [],
    dojoStorage: player?.dojoStorage ?? { items: [], equipment: [], special: [] },
    dojoLoadout: player?.dojoLoadout ?? { items: [], equipment: [], special: [] },
    dojoCarrySlots: player?.dojoCarrySlots ?? { items: 1, equipment: 1, special: 1 },
    dojoEquipSlots: player?.dojoEquipSlots ?? { equipment: 1, special: 1 },
    equipment: player?.equipment ?? null,
    extra_equipments: player?.extra_equipments ?? [],
    equipment_inventory: player?.equipment_inventory ?? [],
    special_equipment: player?.special_equipment ?? null,
    extra_special_equipments: player?.extra_special_equipments ?? [],
    special_inventory: player?.special_inventory ?? [],
    arrow: player?.arrow ?? null,
    arrow2: player?.arrow2 ?? null,
    arrow_inventory: player?.arrow_inventory ?? [],
    arrow_slots: Number(player?.arrow_slots ?? 1),
    shop_items: player?.shop_items ?? []
  };
}

function restoreDojoPlayer(saved, fallbackName = "Player", run = null) {
  const player = attachPlayerProfile(new Player(saved?.name || fallbackName, 1), saved?.profile ?? {});
  player.level = Math.max(1, Number(saved?.level ?? player.level ?? 1));
  player.exp = Number(saved?.exp ?? 0);
  let savedMaxHp = Number(saved?.max_hp ?? player.max_hp ?? 200);
  if (saved?.dojoTrailBonusesStripped !== true && run) {
    savedMaxHp -= getDojoTrailMaxHpBonus(ensureDojoRunTrailState(run));
  }
  player.max_hp = Math.max(1, savedMaxHp);
  player.hp = Math.max(1, Number(saved?.hp ?? player.max_hp));
  player._dojoRestoredFromSave = true;
  player.base_attack = Number(saved?.base_attack ?? player.base_attack ?? player.attack ?? 0);
  player.attack = Number(saved?.attack ?? player.attack ?? player.base_attack ?? 0);
  player.base_defense = Number(saved?.base_defense ?? player.base_defense ?? player.defense ?? 0);
  player.defense = Number(saved?.defense ?? player.defense ?? 0);
  player.coins = Number(saved?.coins ?? 0);
  player.items = Array.isArray(saved?.items) ? saved.items : [];
  player.dojoStorage = saved?.dojoStorage ?? { items: [], equipment: [], special: [] };
  player.dojoLoadout = saved?.dojoLoadout ?? { items: [], equipment: [], special: [] };
  player.dojoCarrySlots = saved?.dojoCarrySlots ?? { items: 1, equipment: 1, special: 1 };
  player.dojoEquipSlots = saved?.dojoEquipSlots ?? { equipment: 1, special: 1 };
  ensureDojoInventoryState(player);
  player.equipment = saved?.equipment ?? null;
  player.extra_equipments = Array.isArray(saved?.extra_equipments) ? saved.extra_equipments : [];
  player.equipment_inventory = Array.isArray(saved?.equipment_inventory) ? saved.equipment_inventory : [];
  player.special_equipment = saved?.special_equipment ?? null;
  player.extra_special_equipments = Array.isArray(saved?.extra_special_equipments) ? saved.extra_special_equipments : [];
  player.special_inventory = Array.isArray(saved?.special_inventory) ? saved.special_inventory : [];
  player.arrow = saved?.arrow ?? player.arrow ?? null;
  player.arrow2 = saved?.arrow2 ?? null;
  player.arrow_inventory = Array.isArray(saved?.arrow_inventory) ? saved.arrow_inventory : [];
  player.arrow_slots = Math.max(1, Number(saved?.arrow_slots ?? player.arrow_slots ?? 1));
  player.shop_items = Array.isArray(saved?.shop_items) ? saved.shop_items : [];
  return player;
}

function buildDojoSavePayload(ws) {
  if (!ws?.dojoRun || !ws?.player) return null;
  return {
    run: {
      ...ws.dojoRun,
      waiting: true
    },
    player: serializeDojoPlayer(ws.player)
  };
}

function saveCurrentDojoRun(ws) {
  if (!ws?.accountId || !ws?.dojoRun || !ws?.player) return;
  saveDojoRun({
    accountId: ws.accountId,
    job: ws.dojoRun.jobName ?? "戦士",
    savedRun: buildDojoSavePayload(ws)
  });
}

function isCoinEquipment(item) {
  return !!item?.is_equip && (
    item.effect_type === "coin_per_turn" ||
    item.equip_category === "coin" ||
    item.equip_category === "コイン" ||
    item.name?.includes?.("コイン")
  );
}

function generateDojoShopList(player) {
  const list = [];
  let guard = 0;
  while (list.length < SHOP_SLOT_COUNT && guard < 80) {
    guard += 1;
    const batch = Match.prototype.generateShopList.call(null, player);
    for (const item of batch) {
      if (!isCoinEquipment(item)) list.push(item);
      if (list.length >= SHOP_SLOT_COUNT) break;
    }
  }

  while (list.length < SHOP_SLOT_COUNT) {
    const item = generateOneShopItem(Math.max(1, Number(player?.level ?? 1)));
    if (item && !isCoinEquipment(item)) {
      list.push({ ...item, uid: item.uid ?? crypto.randomUUID() });
    }
  }

  return list.slice(0, SHOP_SLOT_COUNT);
}

function ensureDojoPrepShop(ws) {
  if (!ws?.player) return [];
  if (!Array.isArray(ws.player.shop_items) || ws.player.shop_items.length === 0) {
    ws.player.shop_items = generateDojoShopList(ws.player);
  } else {
    ws.player.shop_items = ws.player.shop_items
      .filter(item => item && typeof item === "object")
      .filter(item => !isCoinEquipment(item))
      .slice(0, SHOP_SLOT_COUNT);
    if (ws.player.shop_items.length < SHOP_SLOT_COUNT) {
      ws.player.shop_items = generateDojoShopList(ws.player);
    }
  }
  return ws.player.shop_items;
}

function sendDojoPrepShop(ws) {
  safeSend(ws, {
    type: "dojo_shop_list",
    items: ensureDojoPrepShop(ws)
  });
}

function startDojoStage(humanWS) {
  const run = humanWS.dojoRun;
  if (!run || !humanWS.player) return;
  run.waiting = false;
  applyDojoTrailBonusesToPlayer(humanWS);
  applyDojoTrailSlotBonusesToPlayer(humanWS);
  applyDojoLoadoutToBattle(humanWS.player);
  resetDojoBattleState(humanWS.player);
  humanWS.player.turn_order = "first";
  humanWS.matchType = "dojo";
  humanWS.dojoRun = run;

  const botWS = createBotSocket();
  botWS.matchType = "dojo";
  botWS.dojoRun = run;
  ensureDojoBossPools(run);
  botWS.player = createDojoEnemy(run.stage, run);

  const match = new Match(humanWS, botWS);
  humanWS.currentMatch = match;
  safeSend(humanWS, {
    type: "match_start",
    mode: "dojo",
    self_name: humanWS.player?.name ?? "Player",
    enemy_name: botWS.player.name,
    dojo: buildDojoRunView(run, humanWS.player, humanWS)
  });
  match.sendInitialStatusSnapshot();
}

function startDojoRun(ws, { accountId, name, job, resume, profile }) {
  const jobKey = Number(job);
  if (jobKey !== 1) {
    safeSend(ws, { type: "dojo_error", msg: "フェーズ1では戦士のみ挑戦できます。" });
    return;
  }
  ws.accountId = accountId ? String(accountId) : null;
  ws.matchType = "dojo";
  ws.profile = normalizePlayerProfile(profile);
  const acc = ws.accountId ? getOrCreateAccount(ws.accountId) : null;
  const playerName = name || acc?.name || "Player";

  const saved = ws.accountId ? getSavedDojoRun({ accountId: ws.accountId, job: "戦士" }) : null;
  if (saved && jobKey === 1) {
    const resumeMode = resume;
    if (resumeMode !== "continue" && resumeMode !== "new") {
      safeSend(ws, {
        type: "dojo_resume_available",
        stage: Number(saved?.run?.stage ?? 1),
        savedAt: saved?.savedAt ?? null
      });
      return;
    }
    if (resumeMode === "continue") {
      const restoredRun = {
        ...(saved.run ?? {}),
        mode: "dojo",
        jobName: "戦士",
        waiting: true,
        cleared: false
      };
      ws.player = attachPlayerProfile(restoreDojoPlayer(saved.player, playerName, restoredRun), ws.profile);
      ws.dojoRun = restoredRun;
      ensureDojoBossPools(ws.dojoRun);
      ensureDojoRunTrailState(ws.dojoRun);
      sendDojoWaiting(ws);
      return;
    }
    clearSavedDojoRun({ accountId: ws.accountId, job: "戦士" });
  }

  const player = attachPlayerProfile(new Player(playerName, 1), ws.profile);
  player.coins = 0;
  player.exp = 0;
  ensureDojoInventoryState(player);
  player.shop_items = generateDojoShopList(player);
  ws.player = player;
  ws.dojoRun = {
    mode: "dojo",
    jobName: "戦士",
    stage: 1,
    highestStage: 1,
    startedAt: Date.now(),
    lastDrops: [],
    midBossPool: shuffleCopy(DOJO_MID_BOSSES.map(b => b.id)).slice(0, 3),
    bigBossPool: shuffleCopy(DOJO_BIG_BOSSES.map(b => b.id)).slice(0, 3),
      dojoTrail: { prestigePoints: 0, trailNodes: [], trailAttackGrowth: 0, trailItemAttackGrowth: 0, trailCoinSpent: 0 },
    trailUpgrades: {},
    waiting: true,
    cleared: false
  };
  if (ws.accountId) {
    recordDojoProgress({ accountId: ws.accountId, job: "戦士", stage: 1, cleared: false });
  }
  sendDojoWaiting(ws);
}

function sendDojoWaiting(ws) {
  if (!ws?.dojoRun || !ws?.player) return;
  ensureDojoPrepShop(ws);
  applyDojoTrailBonusesToPlayer(ws);
  applyDojoTrailSlotBonusesToPlayer(ws);
  safeSend(ws, { type: "dojo_waiting", run: buildDojoRunView(ws.dojoRun, ws.player, ws) });
}

async function handleDojoSocketMessage(ws, m) {
  if (m.type === "dojo_next_stage") {
    if (!ws.dojoRun || !ws.player) return;
    if (ws.dojoRun.cleared) {
      safeSend(ws, { type: "dojo_error", msg: "すでに達人への道を踏破しています。" });
      return;
    }
    startDojoStage(ws);
    return;
  }

  if (m.type === "dojo_end_run") {
    const endMode = m.mode === "abandon" ? "abandon" : "save";
    if (ws.dojoRun && ws.accountId) {
      if (endMode === "save") {
        saveCurrentDojoRun(ws);
      } else {
        clearSavedDojoRun({ accountId: ws.accountId, job: ws.dojoRun.jobName ?? "戦士" });
      }
      recordDojoProgress({
        accountId: ws.accountId,
        job: ws.dojoRun.jobName,
        stage: Number(ws.dojoRun.stage ?? 1),
        cleared: false
      });
    }
    ws.dojoRun = null;
    ws.currentMatch = null;
    ws.matchType = null;
    safeSend(ws, { type: "dojo_ended" });
    return;
  }

  if (m.type === "dojo_waiting_request") {
    sendDojoWaiting(ws);
    return;
  }

  if (m.type === "open_dojo_trail") {
    if (!ws.dojoRun || !ws.player || ws.dojoRun.waiting !== true) return;
    safeSend(ws, { type: "dojo_trail_state", trail: buildDojoTrailView(ws) });
    return;
  }

  if (m.type === "dojo_unlock_trail") {
    if (!ws.dojoRun || !ws.player || ws.dojoRun.waiting !== true) return;
    const nodeId = Math.floor(Number(m.nodeId ?? 0) || 0);
    const node = DOJO_TRAIL_NODES.find(n => n.id === nodeId);
    if (!node) {
      safeSend(ws, { type: "dojo_error", msg: "軌跡を解放できません。" });
      return;
    }
    const result = unlockDojoRunTrailNode(ws.dojoRun, nodeId);
    if (!result.ok) {
      safeSend(ws, { type: "popup", msg: result.reason === "not enough points" ? "軌跡ポイントが足りません。" : "この軌跡は解放できません。", ms: 2400 });
    } else {
      const unlockedIds = new Set((result.unlockedNodes || [nodeId]).map(Number));
      if ((unlockedIds.has(10) && addDojoExcaliburToStorage(ws.player)) || (unlockedIds.has(20) && addDojoAegisToStorage(ws.player))) {
        saveCurrentDojoRun(ws);
      }
      applyDojoTrailBonusesToPlayer(ws);
      applyDojoTrailSlotBonusesToPlayer(ws);
      saveCurrentDojoRun(ws);
      const names = (result.unlockedNodeDetails || [{ name: node.name }]).map(n => n.name).filter(Boolean);
      const msg = names.length > 1
        ? `${names.length}個の軌跡を一括解放しました。`
        : `${node.name} を解放しました。`;
      safeSend(ws, { type: "popup", msg, ms: 2200 });
    }
    safeSend(ws, { type: "dojo_trail_state", trail: buildDojoTrailView(ws) });
    sendDojoWaiting(ws);
    return;
  }

  if (m.type === "dojo_level_up_request") {
    if (!ws.dojoRun || !ws.player || ws.dojoRun.waiting !== true) return;
    const P = ws.player;
    const req = LEVEL_REQUIREMENTS[P.level];
    if (req == null) {
      safeSend(ws, { type: "dojo_level_up_check", canExp: false, canCoins: false, isMax: true });
      return;
    }
    const need = req - Number(P.exp ?? 0);
    if (need <= 0) {
      safeSend(ws, { type: "dojo_level_up_check", canExp: true, canCoins: false });
    } else if (Number(P.coins ?? 0) >= need) {
      safeSend(ws, { type: "dojo_level_up_check", canExp: false, canCoins: true, needCoins: need });
    } else {
      safeSend(ws, { type: "dojo_level_up_check", canExp: false, canCoins: false });
    }
    return;
  }

  if (m.type === "dojo_level_up_exp") {
    if (!ws.dojoRun || !ws.player || ws.dojoRun.waiting !== true) return;
    const P = ws.player;
    const res = P.try_level_up_auto ? P.try_level_up_auto() : null;
    if (!res || !res.auto) {
      safeSend(ws, { type: "popup", msg: "EXPが足りません。", ms: 2400 });
      return;
    }
    saveCurrentDojoRun(ws);
    safeSend(ws, { type: "popup", msg: `${P.name} は Lv${P.level} にアップ！`, ms: 2400 });
    sendDojoWaiting(ws);
    return;
  }

  if (m.type === "dojo_level_up_coins") {
    if (!ws.dojoRun || !ws.player || ws.dojoRun.waiting !== true) return;
    const P = ws.player;
    const beforeCoins = Number(P.coins ?? 0);
    const res = P.try_level_up_with_coins ? P.try_level_up_with_coins() : null;
    if (!res || !res.success) {
      safeSend(ws, { type: "popup", msg: "コインが足りません。", ms: 2400 });
      return;
    }
    recordDojoCoinSpent(ws, beforeCoins - Number(P.coins ?? 0));
    saveCurrentDojoRun(ws);
    safeSend(ws, { type: "popup", msg: `${P.name} は Lv${P.level} にアップ！`, ms: 2400 });
    sendDojoWaiting(ws);
    return;
  }

  if (m.type === "open_dojo_shop") {
    if (!ws.dojoRun || !ws.player || ws.dojoRun.waiting !== true) return;
    sendDojoPrepShop(ws);
    return;
  }

  if (m.type === "dojo_shop_reroll") {
    if (!ws.dojoRun || !ws.player || ws.dojoRun.waiting !== true) return;
    const cost = 5;
    if (Number(ws.player.coins ?? 0) < cost) {
      safeSend(ws, { type: "popup", msg: `コインが足りません（必要:${cost}）`, ms: 2500 });
      return;
    }
    ws.player.coins = Number(ws.player.coins ?? 0) - cost;
    recordDojoCoinSpent(ws, cost);
    ws.player.shop_items = generateDojoShopList(ws.player);
    saveCurrentDojoRun(ws);
    sendDojoPrepShop(ws);
    sendDojoWaiting(ws);
    return;
  }

  if (m.type === "dojo_buy_item") {
    if (!ws.dojoRun || !ws.player || ws.dojoRun.waiting !== true) return;
    const P = ws.player;
    ensureDojoPrepShop(ws);
    const index = Number(m.index);
    if (!Number.isInteger(index) || !P.shop_items?.[index]) {
      safeSend(ws, { type: "error_log", msg: "❌ 商品が存在しません。" });
      return;
    }
    if (P.shop_items[index].sold_out || P.shop_items[index].soldOut || P.shop_items[index].shop_sold_out) {
      safeSend(ws, { type: "popup", msg: "この商品は売り切れです。", ms: 1800 });
      return;
    }
    const item = { ...P.shop_items[index], uid: crypto.randomUUID() };
    delete item.sold_out;
    delete item.soldOut;
    delete item.shop_sold_out;
    const basePrice = Number(item.price ?? 0);
    const price = P.job === "錬金術師" && item.is_equip && item.equip_type !== "alchemist_unique"
      ? Math.max(1, Math.floor(basePrice * 0.8))
      : basePrice;
    if (Number(P.coins ?? 0) < price) {
      safeSend(ws, { type: "popup", msg: `コインが足りません（必要:${price}）`, ms: 2500 });
      return;
    }
    P.coins = Number(P.coins ?? 0) - price;
    addItemToDojoStorage(P, item);
    const trailState = ensureDojoRunTrailState(ws.dojoRun);
    const extraAttackEquip = (trailState?.trailNodes || []).map(Number).includes(35)
      ? createDojoAttackEquipStar1()
      : null;
    if (extraAttackEquip) addItemToDojoStorage(P, extraAttackEquip);
    recordDojoCoinSpent(ws, price);
    P.shop_items[index] = {
      ...P.shop_items[index],
      sold_out: true,
      soldOut: true,
      shop_sold_out: true
    };
    saveCurrentDojoRun(ws);
    safeSend(ws, { type: "dojo_purchased_item", item });
    safeSend(ws, { type: "popup", msg: extraAttackEquip ? `${item.name} を購入しました（攻撃力装備★1も入手）` : `${item.name} を購入しました`, ms: 2200 });
    sendDojoPrepShop(ws);
    sendDojoWaiting(ws);
    return;
  }

  if (m.type === "dojo_set_loadout") {
    if (!ws.dojoRun || !ws.player || ws.dojoRun.waiting !== true) return;
    const key = dojoStorageKey(m.category);
    const uid = String(m.uid ?? "");
    if (!key || !uid) return;
    const P = ws.player;
    ensureDojoInventoryState(P);
    const exists = P.dojoStorage[key].some(it => String(it?.uid) === uid);
    if (!exists) return;
    const selected = new Set(P.dojoLoadout[key].map(String));
    if (selected.has(uid)) {
      selected.delete(uid);
    } else {
      if (selected.size >= Number(P.dojoCarrySlots[key] ?? 1)) {
        const first = selected.values().next().value;
        if (first) selected.delete(first);
      }
      selected.add(uid);
    }
    P.dojoLoadout[key] = [...selected];
    saveCurrentDojoRun(ws);
    sendDojoWaiting(ws);
    return;
  }

  if (m.type === "dojo_combine_equips") {
    if (!ws.dojoRun || !ws.player || ws.dojoRun.waiting !== true) return;
    if (combineDojoStorageEquips(ws, m.uid1, m.uid2)) {
      saveCurrentDojoRun(ws);
    }
    sendDojoWaiting(ws);
    return;
  }

  const match = ws.currentMatch;
  if (!match || match.matchType !== "dojo") return;
  const P = ws.player;
  if (match.ended) return;

  if (m.type === "level_up_request" || m.type === "level_up_exp" || m.type === "level_up_coins") {
    match.sendError("達人への道では戦闘中レベルアップは使用できません。", ws);
    safeSend(ws, { type: "level_up_check", canExp: false, canCoins: false, dojoDisabled: true });
    return;
  }

  if (m.type === "open_shop") {
    match.openShop(ws);
    return;
  }
  if (m.type === "buy_item") {
    match.buyItem(ws, m.index);
    return;
  }
  if (m.type === "shop_reroll") {
    match.shopReroll(ws);
    return;
  }

  if (m.type === "dojo_auto_action") {
    if (match.current !== ws) return;
    await autoPlayerTurn(match, ws);
    return;
  }

  if (m.type === "action") {
    await match.handleAction(ws, m.action);
    return;
  }
  if (m.type === "request_status_detail") {
    match.sendStatusDetail(ws, match.P1, match.P2, m.target === "enemy" ? "enemy" : "self");
    return;
  }
  if (m.type === "use_item") {
    match.useItem(ws, m.item_id, m.action, m.slot);
    return;
  }
  if (m.type === "combine_equips") {
    match.combineNormalEquips(ws, m.uid1, m.uid2);
    return;
  }
  if (m.type === "skill1") await match.useSkill(ws, P, P.opponent, 1);
  if (m.type === "skill2") await match.useSkill(ws, P, P.opponent, 2);
  if (m.type === "skill3") await match.useSkill(ws, P, P.opponent, 3);
}

function startCpuMatch(humanWS) {
  const botWS = createBotSocket();

  // ===============================
  // ★ CPU職業：指定があればそれを使う
  // ===============================
  let cpuJobKey = humanWS.player.cpu_job;

  // 職業名で来た場合 → JOB_TEMPLATE の番号に変換
  if (typeof cpuJobKey === "string") {
    const found = Object.entries(JOB_TEMPLATE)
      .find(([_, v]) => v.name === cpuJobKey);
    cpuJobKey = found ? Number(found[0]) : null;
  }

  // 未指定 or 不正 → ランダム
  if (cpuJobKey == null || isNaN(cpuJobKey)) {
    const keys = Object.keys(JOB_TEMPLATE);
    cpuJobKey = Number(
      keys[Math.floor(Math.random() * keys.length)]
    );
  }

  const cpuPlayer = new Player("CPU", cpuJobKey);
  botWS.player = cpuPlayer;

  const match = new Match(humanWS, botWS);


  // =================================================
  // ★ CPU戦：人間側メッセージをこの match に流す
  // =================================================
  const handleCpuMessage = async (raw2) => {
    const m = JSON.parse(raw2.toString());
    const sock = humanWS;
    const P = match.P1; // human は必ず P1

    if (match.ended) return;

    // ---------- 人形使い：スキルUI系 ----------
    if (m.type === "request_doll_skill1") {
      if (sock !== match.current) {
        match.sendError("❌ 今はあなたのラウンドではありません。", sock);
        return;
      }
      safeSend(sock, { type: "request_doll_part_select" });
      return;
    }

    if (m.type === "use_doll_skill1") {
      P.selected_doll_part = m.part;
      await match.useSkill(sock, P, P.opponent, 1);
      return;
    }

    if (m.type === "use_doll_skill2") {
      P.pending_hp_cost = Number(m.hpCost);
      await match.useSkill(sock, P, P.opponent, 2);
      return;
    }

    if (m.type === "request_doll_skill3") {
      await match.useSkill(sock, P, P.opponent, 3);
      return;
    }

    if (m.type === "request_doll_charge") {
      match.requestDollChargeChoices(sock, P);
      return;
    }

    if (m.type === "select_doll_charge") {
      match.resolveDollChargeChoice(sock, P, String(m.key ?? ""));
      return;
    }

    if (m.type === "select_doll_charge_part") {
      match.resolveDollChargeChoice(
        sock,
        P,
        String(P.pending_doll_charge_option ?? ""),
        String(m.part ?? "")
      );
      return;
    }

    if (m.type === "request_alchemist_skill3_select") {
      if (sock !== match.current) {
        match.sendError("❌ 今はあなたのラウンドではありません。", sock);
        return;
      }
      const candidates = buildAlchemistFusionCandidateData(P);
      if (candidates.length < 3) {
        match.sendPopup("合成に使える装備が3つありません。", sock, 2500);
        match.sendError("❌ 合成に使える装備が3つありません。", sock);
        return;
      }
      safeSend(sock, { type: "alchemist_skill3_candidates", items: candidates });
      return;
    }

    if (m.type === "use_alchemist_skill3") {
      if (sock !== match.current) {
        match.sendError("❌ 今はあなたのラウンドではありません。", sock);
        return;
      }
      const selected = Array.isArray(m.uids) ? m.uids.map(uid => String(uid)) : [];
      if (selected.length !== 3 || new Set(selected).size !== 3) {
        match.sendPopup("合成する装備を3つ選んでください。", sock, 2500);
        match.sendError("❌ 合成する装備を3つ選んでください。", sock);
        return;
      }
      P.pending_alchemist_selection = selected;
      await match.useSkill(sock, P, P.opponent, 3);
      P.pending_alchemist_selection = [];
      return;
    }

    // ---------- 行動 ----------
    if (m.type === "action") {
      await match.handleAction(sock, m.action);
      return;
    }

    // ---------- ステータス詳細 ----------
    if (m.type === "request_status_detail") {
      match.sendStatusDetail(
        sock,
        match.P1,
        match.P2,
        m.target === "enemy" ? "enemy" : "self"
      );
      return;
    }

    // ---------- アイテム ----------
    if (m.type === "use_item") {
      match.useItem(sock, m.item_id, m.action, m.slot);
      return;
    }
    if (m.type === "combine_equips") {
      match.combineNormalEquips(sock, m.uid1, m.uid2);
      return;
    }

    // ---------- ショップ ----------
    if (m.type === "open_shop") {
      match.openShop(sock);
      return;
    }
    if (m.type === "buy_item") {
      match.buyItem(sock, m.index);
      return;
    }
    if (m.type === "shop_reroll") {
      match.shopReroll(sock);
      return;
    }

    // ---------- レベルアップ ----------
    if (m.type === "level_up_request") {
      const req = LEVEL_REQUIREMENTS[P.level];
      if (!req) {
        safeSend(sock, { type: "level_up_check", canExp: false, canCoins: false, isMax: true });
        return;
      }
      const need = req - P.exp;
      if (need <= 0) {
        safeSend(sock, { type: "level_up_check", canExp: true, canCoins: false });
      } else if (P.coins >= need) {
        safeSend(sock, {
          type: "level_up_check",
          canExp: false,
          canCoins: true,
          needCoins: need
        });
      } else {
        safeSend(sock, { type: "level_up_check", canExp: false, canCoins: false });
      }
      return;
    }

    if (m.type === "level_up_exp") {
      const res = P.try_level_up_auto?.();
      if (!res?.auto) return;
      safeSend(sock, { type: "level_info", level: P.level, canLevelUp: P.can_level_up() });
      safeSend(sock, { type: "exp_info", exp: P.exp });
      match.sendSimpleStatusBoth();
      return;
    }

    if (m.type === "level_up_coins") {
      const res = P.try_level_up_with_coins?.();
      if (!res?.success) return;
      safeSend(sock, { type: "level_info", level: P.level, canLevelUp: P.can_level_up() });
      safeSend(sock, { type: "exp_info", exp: P.exp });
      safeSend(sock, { type: "coin_info", coins: P.coins });
      match.sendSimpleStatusBoth();
      return;
    }
  };

  humanWS.on("message", handleCpuMessage);

  safeSend(humanWS, {
    type: "match_start",
    self_name: humanWS.player?.name ?? "Player",
    enemy_name: "CPU"
  });
  match.sendInitialStatusSnapshot();

  // ★ CPUが後攻なら即思考開始
  setTimeout(() => maybeCpuTurn(match), 1000);
}

// =========================================================
// ★ CPU用：装備比較（true = 付け替える価値あり）
// =========================================================
function isBetterEquip(newItem, currentItem) {
  if (!currentItem) return true; // 何も付けていないならOK

  // 攻撃力
  const newAtk = newItem.power ?? newItem.atk ?? 0;
  const curAtk = currentItem.power ?? currentItem.atk ?? 0;

  // 防御力
  const newDef = newItem.def ?? 0;
  const curDef = currentItem.def ?? 0;

  // シンプルな合計評価
  return (newAtk + newDef) > (curAtk + curDef);
}

function getOwnedMageEquipSlots(P) {
  const ownedSlots = new Set();

  for (const slot of ["staff", "ring", "robe", "book"]) {
    if (P.mage_equips?.[slot]) ownedSlots.add(slot);
  }

  for (const item of P.special_inventory ?? []) {
    if (item?.equip_type === "mage_equip") {
      ownedSlots.add(getMageSlot(item));
    }
  }

  return ownedSlots;
}

// =========================================================
// ★ 弓兵AI：矢の優先度
// =========================================================
function getArrowPriority(it) {
  if (!it) return 0;

  // 名前ベース（ARROW_DATA の name に依存）
  if (it.name?.includes("会心")) return 5;
  if (it.name?.includes("毒")) return 4;
  if (it.name?.includes("氷結")) return 3;
  if (it.name?.includes("反撃")) return 2;

  return 1; // 普通の矢
}

// =========================================================
// ★ CPU用：人形スキル2のHP消費量自動決定
// =========================================================
function decideCpuDollSkill2Cost(P) {
  if (!P.doll || P.doll.is_broken) return null;

  const hpRate = P.hp / P.max_hp;

  if (hpRate >= 0.7) return 40;
  if (hpRate >= 0.4) return 30;
  if (hpRate >= 0.2) return 20;
  if (hpRate >= 0.1) return 10;

  return null; // 危険域では使わない
}

// =========================================================
// ★ CPU用：スキル使用可否を完全判定（使用済み・条件不足防止）
// =========================================================
function canUseCpuSkill(P, id) {
  let key;

  // ★ CPU：人形使いスキル2はHP条件を満たす時のみ使用可
  if (P.job === "人形使い" && id === 2) {
    const cost = decideCpuDollSkill2Cost(P);
    if (!cost) return false;
  }

  if (P.job === "人形使い") {
    key = `doll_${id}`;
  } else {
    const prefix = {
      "戦士": "warrior",
      "騎士": "knight",
      "僧侶": "priest",
      "盗賊": "thief",
      "魔導士": "mage",
      "陰陽師": "onmyoji",
      "錬金術師": "alchemist",
      "弓兵": "archer",
      "狂人": "mad",
    }[P.job];

    if (!prefix) return false; // 念のため
    key = `${prefix}_${id}`;
  }

  // 使用済み
  if (P.used_skill_set?.has(key)) return false;

  // レベル不足
  if (P.level < id) return false;

  // 魔導士マナ
  if (P.job === "魔導士") {
    if (id === 2 && P.mana < 30) return false;
    if (id === 3 && P.mana < 60) return false;
  }

  return true;
}

// =========================================================
// ★ CPU AI：状態分析（修正版）
// =========================================================
function analyzeCpuState(match, ws) {
  const P = ws.player;
  const E = P.opponent;

  // ============================
  // ★ 錬金術師：合成候補装備数
  // ============================
  let alchemistEquipCount = 0;

  if (P.job === "錬金術師") {
    if (
      P.equipment &&
      P.equipment.equip_type !== "mage_equip" &&
      P.equipment.equip_type !== "alchemist_unique"
    ) {
      alchemistEquipCount++;
    }

    for (const eq of P.equipment_inventory ?? []) {
      if (
        eq.equip_type !== "mage_equip" &&
        eq.equip_type !== "alchemist_unique"
      ) {
        alchemistEquipCount++;
      }
    }
  }

  // ★ item.js の仕様に合わせる：effect_type は "攻撃力"/"防御力"/"HP"
  //    category/effect は見ない（付いていない）
  const usableItem =
    (P.items ?? []).find(it => {
      if (!it) return false;

      // 装備系は除外（P.items に混ざってても弾く）
      if (it.is_equip) return false;
      if (it.is_arrow || it.equip_type === "arrow") return false;
      if (it.equip_type === "mage_equip" || it.equip_type === "alchemist_unique") return false;
      if (it.is_doll_costume) return false;

      // HP満タンなら回復は使わない
      if (it.effect_type === "HP" && P.hp >= P.max_hp) return false;

      // 上記以外は「使える」とみなす
      return true;
    }) ?? null;


  // =========================
  // ★ CPU用：装備候補選定（returnの前）
  // =========================
  const equipCandidate =
    (P.equipment_inventory ?? []).find(it =>
      isBetterEquip(it, P.equipment)
    ) ?? null;

  // =========================
  // ★ CPU用：特殊装備候補（性能が上がる場合のみ）
  // =========================
  const specialCandidate =
    (P.special_inventory ?? []).find(it => {

      // ---------- 人形衣装 ----------
      if (it.is_doll_costume) {
        if (!P.doll) return false;

        const cur = P.doll.costumes?.[it.part];
        if (!cur) return true; // 未装備ならOK

        // ★ 性能が上がらないなら除外
        if (
          (it.star ?? 1) <= (cur.star ?? 1) &&
          (it.attack ?? 0) <= (cur.attack ?? 0) &&
          (it.defense ?? 0) <= (cur.defense ?? 0)
        ) {
          return false;
        }
        return true;
      }

      // ---------- 矢 ----------
      if (it.is_arrow || it.equip_type === "arrow") {
        if (P.arrow?.uid === it.uid) return false;
        if (P.arrow2?.uid === it.uid) return false;
        return true;
      }

    // ---------- 魔導士装備（部位別で判定） ----------
    if (it.equip_type === "mage_equip") {
      const slot = getMageSlot(it);
      const cur = P.mage_equips?.[slot];

      // 未装備なら OK
      if (!cur) return true;

      // ★ すでに同じ部位を持っている → 基本的にスキップ
      // （性能比較したいならここで isBetterMageEquip を入れる）
      return false;
    }


      // ---------- その他の特殊装備 ----------
      if (P.special_equipped) {
        if (P.special_equipped.uid === it.uid) return false;
      }

      return true;
    }) ?? null;

  // =========================
  // ★ CPU用：矢の装備候補（優先度ルール確定版）
  // =========================
  let arrowCandidate = null;

  if (P.job === "弓兵") {

    const inv = (P.arrow_inventory ?? [])
      .filter(it => it && (it.is_arrow || it.equip_type === "arrow"));

    // 所持矢の中で最優先度
    const bestOwned = inv.reduce((best, it) => {
      if (!best) return it;
      return getArrowPriority(it) > getArrowPriority(best)
        ? it
        : best;
    }, null);

    if (bestOwned) {

      // ① slot2 が空いている → 同優先度でも装備（枠埋め）
      if (P.arrow_slots >= 2 && !P.arrow2) {
        arrowCandidate = bestOwned;
      }

      // ② 両方埋まっている → 低い方と比較
      else if (P.arrow && P.arrow2) {
        const p1 = getArrowPriority(P.arrow);
        const p2 = getArrowPriority(P.arrow2);

        const lowEquipped = (p1 <= p2) ? P.arrow : P.arrow2;

        const bestP = getArrowPriority(bestOwned);
        const lowP  = getArrowPriority(lowEquipped);

        // 所持 ＞ 装備中 のときだけ入れ替え
        if (bestP > lowP) {
          arrowCandidate = bestOwned;
        }
      }
    }
  }

  let specialAlreadyEquipped = false;

  if (specialCandidate?.is_doll_costume && P.doll?.costumes) {
    const cur = P.doll.costumes[specialCandidate.part];
    if (cur && cur.uid === specialCandidate.uid) {
      specialAlreadyEquipped = true;
    }
  }


  return {
    hpRate: P.hp / P.max_hp,
    enemyHpRate: E.hp / E.max_hp,

    coins: P.coins,
    
    alchemistEquipCount,   // ★ これを追加

    usableItem,
    hasUsableItem: !!usableItem,


    // ★ ここが重要
    hasEquip: !!P.equipment,
    equipItem: equipCandidate,

    hasSpecialEquip: !!specialCandidate,
    specialEquip: specialCandidate,
    specialAlreadyEquipped,

    arrowEquip: arrowCandidate,
    hasArrowEquip: !!arrowCandidate,

    canBuy:
      (P.coins ?? 0) >= 5 &&
      Array.isArray(P.shop_items) &&
      P.shop_items.length > 0,

    canSkill1: canUseCpuSkill(P, 1),
    canSkill2: canUseCpuSkill(P, 2),
    canSkill3: canUseCpuSkill(P, 3),

  };

}


function decideCpuAction(state) {
  // =========================
  // 1) 準備行動（ラウンド非消費）
  // =========================

  // 回復（HPが減っていて、回復アイテムを持っている）
  if (state.hasUsableItem) {
    return { type: "use_item" };
  }

  // =========================
  // ★ 矢装備（最優先）
  // =========================
  if (state.hasArrowEquip) {
    return { type: "arrow" };
  }

  // 特殊装備（本当に付け替え価値がある場合のみ）
  if (state.hasSpecialEquip) {

    // ★ 人形使い：同じ部位の付け直しは禁止
    if (
      state.specialEquip?.is_doll_costume &&
      state.specialEquip.part &&
      state.specialEquipAlreadyEquipped === true
    ) {
      // 何もしない（次へ）
    } else {
      return { type: "special" };
    }
  }


  // 通常装備（未装備なら装備）
  if (!state.hasEquip && state.equipItem) {
    return { type: "equip" };
  }

  // ショップ（“必要があるときだけ”行く：まだ整ってない要素がある時）
  // ※ ここが「shop連打」になりにくいポイント
  if (
    state.canBuy &&
    (
      !state.hasEquip ||              // 装備なし
      state.hasSpecialEquip ||        // 特殊をまだ付けたい
      (state.hpRate < 0.7 && !state.hasHealItem) // 回復したいのにアイテムが無い
    )
  ) {
    return { type: "shop" };
  }

  // =========================
  // 2) 消費行動（ラウンド消費）
  // =========================
  // =========================
  // ★ 錬金術師：合成不能なら即攻撃（無限防止）
  // =========================
  if (
    state.job === "錬金術師" &&
    state.canSkill3 &&
    (state.alchemistEquipCount ?? 0) < 3
  ) {
    return { type: "attack" };
  }

  // =========================
  // ★ 錬金術師：三重合成は装備3つ以上ある時だけ
  // =========================
  if (
    state.canSkill3 &&
    (
      state.job !== "錬金術師" ||
      (state.alchemistEquipCount ?? 0) >= 3
    )
  ) {
    return { type: "skill", id: 3 };
  }

  if (state.canSkill2) return { type: "skill", id: 2 };
  if (state.canSkill1) return { type: "skill", id: 1 };

  return { type: "attack" };
}

// =========================================================
// ★ 開発用：CPU行動を1手だけ実行（UIなし）
// =========================================================
async function cpuStep(match, ws) {
  const state = analyzeCpuState(match, ws);
  const action = decideCpuAction(state);

  const P = ws.player;

  // 準備行動は1回だけ
  if (action.type === "use_item" && state.usableItem) {
    const used = cpuUseItemDirect(match, ws, state.usableItem);
    const consumesTurn = used && (
      state.usableItem.name === "修理キット" ||
      state.usableItem.consumes_turn === true
    );
    if (consumesTurn) match.endRound();
    return consumesTurn;
  }

  if (action.type === "equip" && state.equipItem) {
    match.useItem(ws, state.equipItem.uid, "equip");
    return false;
  }

  if (action.type === "special" && state.specialEquip) {
    match.useItem(ws, state.specialEquip.uid, "special");
    return false;
  }

  if (action.type === "arrow" && state.arrowEquip) {
    const slot = (P.arrow_slots >= 2 && !P.arrow2) ? 2 : 1;
    match.useItem(ws, state.arrowEquip.uid, "arrow", slot);
    return false;
  }

  // ===== 消費行動 =====
  if (action.type === "skill") {
    if (P.job === "人形使い" && action.id === 2) {
      const cost = decideCpuDollSkill2Cost(P);
      if (!cost) {
        await match.handleAction(ws, "攻撃");
        return true;
      }
      P.pending_hp_cost = cost;
    }

    await match.handleAction(ws, "スキル" + action.id);
    return true;
  }

  await match.handleAction(ws, "攻撃");
  return true;
}

async function autoPlayerTurn(match, ws) {
  if (!match || !ws || match.ended || match.current !== ws) return;
  if (match._playerAutoThinking) return;

  match._playerAutoThinking = true;
  try {
    for (let i = 0; i < 4; i++) {
      if (match.ended || match.current !== ws) return;
      const consumedTurn = await cpuStep(match, ws);
      if (consumedTurn || match.ended || match.current !== ws) return;
      if (!match.simulate) await new Promise(r => setTimeout(r, 220));
    }

    if (!match.ended && match.current === ws) {
      await match.handleAction(ws, "攻撃");
    }
  } finally {
    match._playerAutoThinking = false;
  }
}

const CPU_THINK_MIN_MS = 750;
const CPU_THINK_MAX_MS = 1450;
const CPU_ATTACK_ONLY_MIN_MS = 3200;
const CPU_ATTACK_ONLY_MAX_MS = 3800;
const CPU_STEP_INTERVAL_MS = 650;

function randomCpuThinkDelay(minMs = CPU_THINK_MIN_MS, maxMs = CPU_THINK_MAX_MS) {
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

function getCpuOpponentSocket(match, botWS) {
  if (match?.p1 === botWS) return match.p2;
  if (match?.p2 === botWS) return match.p1;
  return match?.p1?.isBot ? match.p2 : match?.p2?.isBot ? match.p1 : null;
}

async function waitCpuThink(match, botWS, label = "考え中", minMs = CPU_THINK_MIN_MS, maxMs = CPU_THINK_MAX_MS) {
  if (match.simulate) return true;
  if (match.ended || match.current !== botWS) return false;

  const ms = randomCpuThinkDelay(minMs, maxMs);
  const targetWs = getCpuOpponentSocket(match, botWS);
  if (targetWs && !targetWs.isBot) {
    match.sendPopup(`CPUが${label}...`, targetWs, Math.max(1800, Math.min(ms + 450, 4200)));
  }

  await new Promise(r => setTimeout(r, ms));
  return !match.ended && match.current === botWS;
}

// =========================================================
// ★ CPU AI：ターン処理（1ラウンドで準備→最後に消費）
// =========================================================
export async function maybeCpuTurn(match) {
  if (match.ended) return;
  if (!match.current?.isBot) return;

  if (match._cpuThinking) return;
  match._cpuThinking = true;

  const botWS = match.current;
  const P = botWS.player; // ★ これが必要
  let didSomething = false; // ★ 追加：準備行動で本当に何か起きたか

  if (match.matchType === "dojo" && P?.isDojoEnemy) {
    try {
      if (!(await waitCpuThink(match, botWS, "行動を選択中", CPU_THINK_MIN_MS, CPU_THINK_MAX_MS))) return;
      await match.handleAction(botWS, "dojo_enemy_action");
      return;
    } finally {
      match._cpuThinking = false;
    }
  }


  try {
    // =========================
    // 準備行動フェーズ（最大3回）
    // =========================
    const MAX_PREP = 3;

    for (let k = 0; k < MAX_PREP; k++) {
      if (match.ended) return;
      if (match.current !== botWS) return; // 手番が変わったら中止

      const state = analyzeCpuState(match, botWS);
      const action = decideCpuAction(state);

      // 「消費行動」になったら準備終了→この後に実行する
      if (action.type === "skill" || action.type === "attack") {
        break;
      }

      if (!(await waitCpuThink(match, botWS, "考え中"))) return;

      switch (action.type) {

        case "use_item":
          if (state.usableItem) {
            const used = cpuUseItemDirect(match, botWS, state.usableItem);

            // ★ 修理キットとターン消費アイテムはターンを終了
            if (
              used &&
              (
                state.usableItem.name === "修理キット" ||
                state.usableItem.consumes_turn === true
              )
            ) {
              match.endRound();
              return;
            }
          }
          break;


        // =========================
        // ★ 矢装備（正しい独立ケース）
        // =========================
        case "arrow":
          if (state.arrowEquip) {
            const slot =
              (P.arrow_slots >= 2 && !P.arrow2) ? 2 : 1;

            match.useItem(
              botWS,
              state.arrowEquip.uid,
              "arrow",
              slot
            );
          }
          break;

        case "equip":
          if (state.equipItem) {
            match.useItem(botWS, state.equipItem.uid, "equip");
          }
          break;

        case "special":

          // ============================
          // ★ 人形使い：人形が壊れている時は装備行動をしない
          // ============================
          if (P.job === "人形使い" && (!P.doll || P.doll.is_broken)) {
            // 無効な準備行動を避けるため、必ず消費行動にフォールバック
            await match.handleAction(botWS, "攻撃");
            return;
          }

          if (state.specialEquip) {

            // ============================
            // ★ 人形使い：衣装交換優先制御
            // ============================
            if (
              P.job === "人形使い" &&
              state.specialEquip.is_doll_costume &&
              P.doll?.costumes
            ) {
              const newIt = state.specialEquip;
              const part = newIt.part;

              const candidates = [];

              const equipped = P.doll.costumes[part];
              if (equipped) candidates.push(equipped);

              for (const it of P.special_inventory ?? []) {
                if (it.is_doll_costume && it.part === part) {
                  candidates.push(it);
                }
              }

              let removeTarget = candidates.find(it => it.is_broken);

              if (!removeTarget && candidates.length > 0) {
                removeTarget = candidates.reduce((a, b) =>
                  (a.star ?? 1) <= (b.star ?? 1) ? a : b
                );
              }

              if (removeTarget === equipped) {
                P.selected_doll_part = part;
              }
            }

            match.useItem(botWS, state.specialEquip.uid, "special");
          }
          break;







        case "shop": {
          match.openShop(botWS);

          const P = botWS.player;
          


          // ============================
          // 既に取得済み部位は買わない
          // ============================
          let shopCandidates = (P.shop_items ?? []).filter(it =>
            !(it?.sold_out || it?.soldOut || it?.shop_sold_out)
          );
          // ============================
          // ★ 弓兵：同じ優先度の矢は2本まで
          // ============================
          if (P.job === "弓兵") {
            shopCandidates = shopCandidates.filter(it => {
              if (!it.is_arrow && it.equip_type !== "arrow") return true;

              const sameCount =
                (P.arrow_inventory ?? []).filter(a =>
                  getArrowPriority(a) === getArrowPriority(it)
                ).length +
                ([P.arrow, P.arrow2].filter(a =>
                  a && getArrowPriority(a) === getArrowPriority(it)
                ).length);

              // ★ 3本目は禁止
              return sameCount < 2;
            });
          }
          // ============================
          // ★ 弓兵：装備中より弱い矢は買わない
          // ============================
          if (P.job === "弓兵" && P.arrow && P.arrow2) {

            const lowEquippedPriority = Math.min(
              getArrowPriority(P.arrow),
              getArrowPriority(P.arrow2)
            );

            shopCandidates = shopCandidates.filter(it => {
              if (!it.is_arrow && it.equip_type !== "arrow") return true;

              // ★ 装備中2枠の低い方以下は買わない
              return getArrowPriority(it) > lowEquippedPriority;
            });
          }
    
          // ============================
          // ★ 人形使い：衣装購入ルール
          // ============================
          if (P.job === "人形使い") {

            // 部位ごとの所持衣装（装備＋インベントリ）
            const ownedByPart = {
              head: [],
              body: [],
              leg: [],
              foot: []
            };

            // 装備中
            if (P.doll?.costumes) {
              for (const part of Object.keys(ownedByPart)) {
                const cur = P.doll.costumes[part];
                if (cur) ownedByPart[part].push(cur);
              }
            }

            // インベントリ
            for (const it of P.special_inventory ?? []) {
              if (it.is_doll_costume && ownedByPart[it.part]) {
                ownedByPart[it.part].push(it);
              }
            }

            shopCandidates = shopCandidates.filter(it => {
              if (!it.is_doll_costume) return true;

              const list = ownedByPart[it.part];
              if (!list || list.length === 0) {
                // その部位を一切持っていない → 買う
                return true;
              }

              const maxStar = Math.max(...list.map(x => x.star ?? 1));

              // ⭐ 星が高い → 買う
              if ((it.star ?? 1) > maxStar) return true;

              // ⭐ 同じ星 → ボロボロ衣装しか無いなら買う
              if ((it.star ?? 1) === maxStar) {
                const hasNonBroken = list.some(x => !x.is_broken);
                return !hasNonBroken;
              }

              // ⭐ 星が低い → 買わない
              return false;
            });
          }

          if (P.job === "魔導士") {

            const ownedMageSlots = new Set();

            // 装備中
            for (const slot of ["staff", "book", "ring", "robe"]) {
              if (P.mage_equips?.[slot]) {
                ownedMageSlots.add(slot);
              }
            }

            // インベントリ内
            for (const it of P.special_inventory ?? []) {
              if (it.equip_type === "mage_equip") {
                const slot = getMageSlot(it);
                ownedMageSlots.add(slot);
              }
            }

            // すでに持っている部位は除外
            shopCandidates = shopCandidates.filter(it => {
              if (it.equip_type !== "mage_equip") return true;
              const slot = getMageSlot(it);
              return !ownedMageSlots.has(slot);
            });
          }

          // ============================
          // 実際に購入
          // ============================
          if (shopCandidates.length > 0) {
            const it = shopCandidates[
              Math.floor(Math.random() * shopCandidates.length)
            ];
            const idx = P.shop_items.findIndex(x => x.uid === it.uid);
            if (idx >= 0) {
              match.buyItem(botWS, idx);
              didSomething = true; 
            }
          }

          break;
        }


        default:
          // 何もしない
          break;
      }

      // ちょい待って状態更新（UI同期やログが落ち着く）
      if (!match.simulate) {
        await new Promise(r => setTimeout(r, CPU_STEP_INTERVAL_MS));
      }

    }
    // ============================
    // ★ 準備行動で何も起きなかった場合は強制攻撃（無限防止）
    // ============================
    if (!didSomething) {
      if (!(await waitCpuThink(match, botWS, "攻撃を考え中", CPU_ATTACK_ONLY_MIN_MS, CPU_ATTACK_ONLY_MAX_MS))) return;
      await match.handleAction(botWS, "攻撃");
      return;
    }

    // =========================
    // 最後に消費行動（必ず1回）
    // =========================
    if (match.ended) return;
    if (match.current !== botWS) return;

    const finalState = analyzeCpuState(match, botWS);
    const finalAction = decideCpuAction(finalState);
    if (!(await waitCpuThink(
      match,
      botWS,
      finalAction.type === "skill" ? "スキルを考え中" : "攻撃を考え中",
      finalAction.type === "attack" ? CPU_ATTACK_ONLY_MIN_MS : CPU_THINK_MIN_MS,
      finalAction.type === "attack" ? CPU_ATTACK_ONLY_MAX_MS : CPU_THINK_MAX_MS
    ))) return;

    if (finalAction.type === "skill") {

      const P = botWS.player;

      // ★ スキル封印・使用不可なら即攻撃に切り替える
      if (P.skill_sealed || !canUseCpuSkill(P, finalAction.id)) {
        await match.handleAction(botWS, "攻撃");
        return;
      }


      // =========================
      // ★ CPU用：人形スキル2のHP自動指定
      // =========================
      if (P.job === "人形使い" && finalAction.id === 2) {
        const cost = decideCpuDollSkill2Cost(P);
        if (!cost) {
          await match.handleAction(botWS, "攻撃");
          return;
        }
        P.pending_hp_cost = cost; // ★ ここが核心
      }

      if (!canUseCpuSkill(P, finalAction.id)) {
        await match.handleAction(botWS, "攻撃");
        return;
      }

      await match.handleAction(
        botWS,
        "スキル" + finalAction.id
      );
      return;
    }




    // デフォルトは攻撃
    await match.handleAction(botWS, "攻撃");
    return;

  } finally {
    match._cpuThinking = false;
  }
}






/* =========================================================
   接続処理
   ========================================================= */
wss.on("connection", (ws) => {
  clients.add(ws);
  console.log("接続: クライアント");

  ws.on("close", () => {
    clients.delete(ws);

    // 待機キューから除外
    if (waitingPlayer === ws) waitingPlayer = null;

    const rc = ws.roomCode;
    if (rc && waitingRooms.get(rc) === ws) {
      waitingRooms.delete(rc);
    }

    // 進行中の試合があれば、切断側の敗北で即終了
    const m = ws.currentMatch;
    if (m && !m.ended) {
      m.handleDisconnect(ws);
    }
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "join_dojo") {
      const accountId = msg.account_id ? String(msg.account_id) : null;
      let name = msg.name || "Player";
      if (accountId) {
        const acc = getOrCreateAccount(accountId);
        if (acc?.name) name = acc.name;
      }
      startDojoRun(ws, {
        accountId,
        name,
        job: msg.job,
        resume: msg.resume,
        profile: msg.profile
      });
      return;
    }

    if (ws.matchType === "dojo") {
      handleDojoSocketMessage(ws, msg).catch(err => {
        console.error("[DOJO] message error", err);
        safeSend(ws, { type: "dojo_error", msg: "達人への道の処理でエラーが発生しました。" });
      });
      return;
    }

    if (msg.type === "join_cpu") {
      
      console.log("[CPU MATCH] join_cpu received");

      const accountId = msg.account_id ? String(msg.account_id) : null;
      ws.accountId = accountId;
      ws.matchType = "cpu";
      // ★ CPU戦の種別: "menu"(CPU戦ボタン) or "auto"(ランダム対戦の自動CPU)
      ws.cpuKind = msg.cpu_kind ? String(msg.cpu_kind) : "menu";

      let name = msg.name;
      if (accountId) {
        const acc = getOrCreateAccount(accountId);
        if (acc?.name) name = acc.name;
      }
      let jobKey = Number(msg.job);

      const player = attachPlayerProfile(new Player(name, jobKey), msg.profile);
      ws.player = player;

      ws.player.cpu_job = msg.cpu_job ?? null;
      ws.player.turn_order = msg.turn_order ?? "random"; // ★ ここに入れる

      startCpuMatch(ws);
      return;
    }


    // ---------------------------------------------------------
    // ルーム対戦: join_room（4桁コード一致で即対戦）
    // ---------------------------------------------------------
    if (msg.type === "join_room") {
      const roomCode = msg.room_code ? String(msg.room_code).trim() : "";
      if (!/^\d{4}$/.test(roomCode)) {
        safeSend(ws, { type: "system_log", msg: "❌ ルーム番号は4桁の数字で入力してください" });
        return;
      }

      const accountId = msg.account_id ? String(msg.account_id) : null;
      ws.accountId = accountId;
      ws.matchType = "room";
      ws.roomCode = roomCode;

      let name = msg.name;
      if (accountId) {
        const acc = getOrCreateAccount(accountId);
        if (acc?.name) name = acc.name;
      }

      let jobKey = msg.job;
      if (typeof jobKey === "string" && isNaN(jobKey)) {
        for (const [k, v] of Object.entries(JOB_TEMPLATE)) {
          if (v.name === jobKey) {
            jobKey = Number(k);
            break;
          }
        }
      } else {
        jobKey = Number(jobKey);
      }

      ws.player = attachPlayerProfile(new Player(name, jobKey), msg.profile);

      const waiting = waitingRooms.get(roomCode);
      if (!waiting) {
        waitingRooms.set(roomCode, ws);
        safeSend(ws, {
          type: "system_log",
          msg: `👥 ルーム ${roomCode}：対戦相手を待っています…`
        });
        return;
      }

      // 相手がすでに待機中なら開始
      waitingRooms.delete(roomCode);

      const p1 = waiting;
      const p2 = ws;

      p1.matchType = "room";
      p2.matchType = "room";

      const match = new Match(p1, p2);

      safeSend(p1, {
        type: "match_start",
        self_name: p1.player?.name ?? "Player",
        enemy_name: p2.player?.name ?? "Player"
      });
      safeSend(p2, {
        type: "match_start",
        self_name: p2.player?.name ?? "Player",
        enemy_name: p1.player?.name ?? "Player"
      });
      match.sendInitialStatusSnapshot();

      // 既存の対人戦と同じメッセージ処理を流用するため、
      // この後の join_random と同じ処理ブロックに落とす必要がある。
      // → ここでは専用ハンドラを設定して return する。

      const handlePlayerMessage = async (sock, raw2) => {
        const m = JSON.parse(raw2.toString());
        const P = sock === p1 ? match.P1 : match.P2;

        // 以下、join_random の共通ハンドラと同等（必要分のみ）
        if (m.type === "request_doll_skill1") {
          if (sock !== match.current) {
            match.sendError("❌ 今はあなたのラウンドではありません。", sock);
            return;
          }
          if (P.used_skill_set?.has("doll_1")) {
            match.sendError("❌ このスキルはすでに使用済みです。", sock);
            return;
          }
          safeSend(sock, { type: "request_doll_part_select" });
          return;
        }

        if (m.type === "use_doll_skill1") {
          if (sock !== match.current) {
            match.sendError("❌ 今はあなたのラウンドではありません。", sock);
            return;
          }
          if (!P.doll) {
            match.sendError("❌ 人形が存在しません。", sock);
            return;
          }
          P.selected_doll_part = m.part;
          await match.useSkill(sock, P, P.opponent, 1);
          return;
        }

        if (m.type === "use_doll_skill2") {
          if (sock !== match.current) {
            match.sendError("❌ 今はあなたのラウンドではありません。", sock);
            return;
          }
          P.pending_hp_cost = Number(m.hpCost);
          await match.useSkill(sock, P, P.opponent, 2);
          return;
        }

        if (m.type === "request_doll_skill3") {
          await match.useSkill(sock, P, P.opponent, 3);
          return;
        }
        if (m.type === "request_doll_charge") {
          match.requestDollChargeChoices(sock, P);
          return;
        }

    if (m.type === "select_doll_charge") {
          match.resolveDollChargeChoice(sock, P, String(m.key ?? ""));
          return;
        }

        if (m.type === "select_doll_charge_part") {
          match.resolveDollChargeChoice(
            sock,
            P,
            String(P.pending_doll_charge_option ?? ""),
            String(m.part ?? "")
          );
          return;
        }

        if (m.type === "request_alchemist_skill3_select") {
          if (sock !== match.current) {
            match.sendError("❌ 今はあなたのラウンドではありません。", sock);
            return;
          }
          const candidates = buildAlchemistFusionCandidateData(P);
          if (candidates.length < 3) {
            match.sendPopup("合成に使える装備が3つありません。", sock, 2500);
            match.sendError("❌ 合成に使える装備が3つありません。", sock);
            return;
          }
          safeSend(sock, { type: "alchemist_skill3_candidates", items: candidates });
          return;
        }

        if (m.type === "use_alchemist_skill3") {
          if (sock !== match.current) {
            match.sendError("❌ 今はあなたのラウンドではありません。", sock);
            return;
          }
          const selected = Array.isArray(m.uids) ? m.uids.map(uid => String(uid)) : [];
          if (selected.length !== 3 || new Set(selected).size !== 3) {
            match.sendPopup("合成する装備を3つ選んでください。", sock, 2500);
            match.sendError("❌ 合成する装備を3つ選んでください。", sock);
            return;
          }
          P.pending_alchemist_selection = selected;
          await match.useSkill(sock, P, P.opponent, 3);
          P.pending_alchemist_selection = [];
          return;
        }

        if (m.type === "action") {
          await match.handleAction(sock, m.action);
          return;
        }

        if (m.type === "request_status_detail") {
          match.sendStatusDetail(
            sock,
            match.P1,
            match.P2,
            m.target === "enemy" ? "enemy" : "self"
          );
          return;
        }

        if (m.type === "use_item") {
          match.useItem(sock, m.item_id, m.action, m.slot);
          return;
        }
        if (m.type === "combine_equips") {
          match.combineNormalEquips(sock, m.uid1, m.uid2);
          return;
        }

        if (m.type === "open_shop") {
          match.openShop(sock);
          return;
        }
        if (m.type === "buy_item") {
          match.buyItem(sock, m.index);
          return;
        }
        if (m.type === "shop_reroll") {
          match.shopReroll(sock);
          return;
        }

        if (m.type === "level_up_request") {
          const req = LEVEL_REQUIREMENTS[P.level];
          if (!req) {
            safeSend(sock, { type: "level_up_check", canExp: false, canCoins: false, isMax: true });
            return;
          }
          const need = req - P.exp;
          if (need <= 0) {
            safeSend(sock, { type: "level_up_check", canExp: true, canCoins: false });
          } else if (P.coins >= need) {
            safeSend(sock, { type: "level_up_check", canExp: false, canCoins: true, needCoins: need });
          } else {
            safeSend(sock, { type: "level_up_check", canExp: false, canCoins: false });
          }
          return;
        }

        if (m.type === "level_up_exp") {
          const res = P.try_level_up_auto?.();
          if (!res?.auto) return;
          safeSend(sock, { type: "level_info", level: P.level, canLevelUp: P.can_level_up() });
          safeSend(sock, { type: "exp_info", exp: P.exp });
          match.sendSimpleStatusBoth();
          return;
        }

        if (m.type === "level_up_coins") {
          const res = P.try_level_up_with_coins?.();
          if (!res?.success) return;
          safeSend(sock, { type: "level_info", level: P.level, canLevelUp: P.can_level_up() });
          safeSend(sock, { type: "exp_info", exp: P.exp });
          safeSend(sock, { type: "coin_info", coins: P.coins });
          match.sendSimpleStatusBoth();
          return;
        }
      };

      p1.on("message", (raw2) => handlePlayerMessage(p1, raw2));
      p2.on("message", (raw2) => handlePlayerMessage(p2, raw2));

      return;
    }

    console.log(
      "[JOIN_CPU]",
      "player job =", msg.job,
      "cpu_job =", msg.cpu_job
    );

    // ---------------------------------------------------------
    // 接続: join
    // ---------------------------------------------------------
    /* ---------- JOIN ---------- */
    if (msg.type === "join" || msg.type === "join_random") {


        const accountId = msg.account_id ? String(msg.account_id) : null;
        ws.accountId = accountId;
        ws.matchType = "random";

        let name = msg.name;
        if (accountId) {
          const acc = getOrCreateAccount(accountId);
          if (acc?.name) name = acc.name;
        }
        let jobKey = msg.job;

        // ★ 職業名で送られてきた場合、番号に変換
        if (typeof jobKey === "string" && isNaN(jobKey)) {
            for (const [k, v] of Object.entries(JOB_TEMPLATE)) {
                if (v.name === jobKey) {
                    jobKey = Number(k);
                    break;
                }
            }
        } else {
            jobKey = Number(jobKey);
        }


        console.log("接続:", name, "job=", jobKey);

        // プレイヤー生成
        const player = attachPlayerProfile(new Player(name, jobKey), msg.profile);

        // WS → player の紐付け
        ws.player = player;

      if (!waitingPlayer) {
        waitingPlayer = ws;
        safeSend(ws, {
          type: "system_log",
          msg: "👤 対戦相手を待っています…"
        });
      } else {
        const p1 = waitingPlayer;
        const p2 = ws;
        waitingPlayer = null;

        safeSend(p1, {
          type: "system_log",
          msg: `🔗 対戦開始！相手：${p2.player?.name ?? "Player"}`
        });
        safeSend(p2, {
          type: "system_log",
          msg: `🔗 対戦開始！相手：${p1.player?.name ?? "Player"}`
        });

        const match = new Match(p1, p2);

        // ★ これを追加
        safeSend(p1, {
          type: "match_start",
          self_name: p1.player?.name ?? "Player",
          enemy_name: p2.player?.name ?? "Player"
        });
        safeSend(p2, {
          type: "match_start",
          self_name: p2.player?.name ?? "Player",
          enemy_name: p1.player?.name ?? "Player"
        });
        match.sendInitialStatusSnapshot();

        // =====================================
        // 共通メッセージハンドラ（正）
        // =====================================
        const handlePlayerMessage = async (sock, raw2) => {
          const m = JSON.parse(raw2.toString());
          const P = sock === p1 ? match.P1 : match.P2;
          // ================================
          // 人形使い：スキル1 入口（部位選択UI）
          // ================================
          if (m.type === "request_doll_skill1") {

            // 自分のラウンド以外は不可
            if (sock !== match.current) {
              match.sendError("❌ 今はあなたのラウンドではありません。", sock);
              return;
            }

            // 1試合1回制限
            if (P.used_skill_set?.has("doll_1")) {
              match.sendError("❌ このスキルはすでに使用済みです。", sock);
              return;
            }

            // 部位選択UIを要求
            safeSend(sock, {
              type: "request_doll_part_select"
            });
            return;
          }

          // ================================
          // 人形使い：スキル1 確定（仕立て直し）
          // ================================
          if (m.type === "use_doll_skill1") {

            if (sock !== match.current) {
              match.sendError("❌ 今はあなたのラウンドではありません。", sock);
              return;
            }

            if (!P.doll) {
              match.sendError("❌ 人形が存在しません。", sock);
              return;
            }

            // ★ 選択部位を Player に渡す
            P.selected_doll_part = m.part;

            // ★ 共通スキル処理へ
            await match.useSkill(sock, P, P.opponent, 1);
            return;
          }

          // ================================
          // 人形使い：スキル2（生命縫合）
          // ================================
          if (m.type === "use_doll_skill2") {

            if (sock !== match.current) {
              match.sendError("❌ 今はあなたのラウンドではありません。", sock);
              return;
            }

            if (!P.doll) {
              match.sendError("❌ 人形が存在しません。", sock);
              return;
            }

            // ★ 消費HPを Player に渡す
            P.pending_hp_cost = Number(m.hpCost);

            // ★ 共通スキル処理へ
            await match.useSkill(sock, P, P.opponent, 2);
            return;
          }

          // ================================
          // 人形使い：スキル3（暴走）
          // ================================
          if (m.type === "request_doll_skill3") {

            if (sock !== match.current) {
              match.sendError("❌ 今はあなたのラウンドではありません。", sock);
              return;
            }

            if (!P.doll) {
              match.sendError("❌ 人形が存在しません。", sock);
              return;
            }

            // ★ 共通スキル処理へ
            await match.useSkill(sock, P, P.opponent, 3);
            return;
          }
        if (m.type === "request_doll_charge") {
          match.requestDollChargeChoices(sock, P);
          return;
        }

    if (m.type === "select_doll_charge") {
            match.resolveDollChargeChoice(sock, P, String(m.key ?? ""));
            return;
          }

          if (m.type === "select_doll_charge_part") {
            match.resolveDollChargeChoice(
              sock,
              P,
              String(P.pending_doll_charge_option ?? ""),
              String(m.part ?? "")
            );
            return;
          }

          if (m.type === "request_alchemist_skill3_select") {
            if (sock !== match.current) {
              match.sendError("❌ 今はあなたのラウンドではありません。", sock);
              return;
            }
            const candidates = buildAlchemistFusionCandidateData(P);
            if (candidates.length < 3) {
              match.sendPopup("合成に使える装備が3つありません。", sock, 2500);
              match.sendError("❌ 合成に使える装備が3つありません。", sock);
              return;
            }
            safeSend(sock, { type: "alchemist_skill3_candidates", items: candidates });
            return;
          }

          if (m.type === "use_alchemist_skill3") {
            if (sock !== match.current) {
              match.sendError("❌ 今はあなたのラウンドではありません。", sock);
              return;
            }
            const selected = Array.isArray(m.uids) ? m.uids.map(uid => String(uid)) : [];
            if (selected.length !== 3 || new Set(selected).size !== 3) {
              match.sendPopup("合成する装備を3つ選んでください。", sock, 2500);
              match.sendError("❌ 合成する装備を3つ選んでください。", sock);
              return;
            }
            P.pending_alchemist_selection = selected;
            await match.useSkill(sock, P, P.opponent, 3);
            P.pending_alchemist_selection = [];
            return;
          }


          // ================================
          // 対戦終了後は何もさせない
          // ================================
          if (match.ended && m.type !== "debug") {
            safeSend(sock, {
              type: "system_log",
              msg: "⚠ この対戦はすでに終了しています。再接続してください。"
            });
            return;
          }

          // ---------- アクション ----------
          if (m.type === "action") {
            await match.handleAction(sock, m.action);
            return;
          }

          // ================================
          // ★ 詳細ステータス要求（統一版）
          // ================================
          if (m.type === "request_status_detail") {

            const self = (sock === match.p1 ? match.P1 : match.P2);
            const enemy = (self === match.P1 ? match.P2 : match.P1);

            // ★ 既存の共通関数に丸投げする
            match.sendStatusDetail(
              sock,
              self,
              enemy,
              m.target === "enemy" ? "enemy" : "self"
            );

            return;
          }




          // ---------- アイテム / 装備 使用 ----------
          if (m.type === "use_item") {
              match.useItem(sock, m.item_id, m.action, m.slot);
              return;
          }
          if (m.type === "combine_equips") {
              match.combineNormalEquips(sock, m.uid1, m.uid2);
              return;
          }

          
          // ---------- ショップ再更新（コイン支払い） ----------
          if (m.type === "shop_reroll") {
              match.shopReroll(sock);
              return;
          }


          // ---------- ショップを開く ----------
          if (m.type === "open_shop") {
            match.openShop(sock);
            return;
          }

          // ---------- ショップ購入 ----------
          if (m.type === "buy_item") {
            match.buyItem(sock, m.index);
            return;
          }

          // ---------- 旧仕様の level_up（あればコイン or EXPで処理） ----------
          if (m.type === "level_up") {
            // 旧ボタンが残っていても一応動くようにしておく
            const auto = P.try_level_up_auto ? P.try_level_up_auto() : null;

            if (auto && auto.auto) {
              // EXPだけで上がる
              match.sendSkill(
                `⭐ ${P.name} は EXP により Lv${P.level} にアップ！（攻撃+${auto.inc ?? 0}）`
              );
            } else if (auto && auto.canPay) {
              // コイン補填でレベルアップ
              const res = P.try_level_up_with_coins();
              if (!res || !res.success) {
                match.sendError("❌ レベルアップに必要なコインが足りません。", sock);
                return;
              }
              match.sendSkill(
                `💰 ${P.name} はコインを使って Lv${P.level} にアップ！（攻撃+${res.inc ?? 0}）`
              );
              
            } else {
              match.sendError("❌ コインが足りません。", sock);
              return;
            }

            safeSend(sock, {
              type: "level_info",
              level: P.level,
              canLevelUp: P.can_level_up()
            });
            safeSend(sock, {
              type: "exp_info",
              exp: P.exp
            });
            safeSend(sock, {
              type: "coin_info",
              coins: P.coins
            });

            match.sendSimpleStatusBoth();

            return;
          }

          // ---------- level_up_request（新仕様） ----------
          if (m.type === "level_up_request") {
            const req = LEVEL_REQUIREMENTS[P.level];
            if (req == null) {
              safeSend(sock, {
                type: "level_up_check",
                canExp: false,
                canCoins: false,
                isMax: true
              });
              return;
            }

            const needExp = req - P.exp;

            // EXPだけで上がる？
            if (needExp <= 0) {
              safeSend(sock, {
                type: "level_up_check",
                canExp: true,
                canCoins: false
              });
              return;
            }

            // コイン補填可能？
            if (P.coins >= needExp) {
              safeSend(sock, {
                type: "level_up_check",
                canExp: false,
                canCoins: true,
                needCoins: needExp
              });
              return;
            }

            // どちらも不可
            safeSend(sock, {
              type: "level_up_check",
              canExp: false,
              canCoins: false
            });
            return;
          }

          // ---------- EXP でレベルアップ ----------
          if (m.type === "level_up_exp") {
            const res = P.try_level_up_auto ? P.try_level_up_auto() : null;

            if (!res || !res.auto) {
              match.sendError("❌ EXPが足りません。", sock);
              return;
            }

            // UI同期
            safeSend(sock, {
              type: "level_info",
              level: P.level,
              canLevelUp: P.can_level_up()
            });
            safeSend(sock, {
              type: "exp_info",
              exp: P.exp
            });

            match.sendSimpleStatusBoth();

            match.sendSkill(
              `💫 ${P.name} は EXP により Lv${P.level} にアップ！（攻撃+${res.inc ?? 0}）`
            );
            return;
          }

          // ---------- コイン補填でレベルアップ ----------
          if (m.type === "level_up_coins") {
            const res = P.try_level_up_with_coins
              ? P.try_level_up_with_coins()
              : null;

            if (!res || !res.success) {
              match.sendError("❌ コインが足りません。", sock);
              return;
            }

            safeSend(sock, {
              type: "level_info",
              level: P.level,
              canLevelUp: P.can_level_up()
            });
            safeSend(sock, {
              type: "exp_info",
              exp: P.exp
            });
            safeSend(sock, {
              type: "coin_info",
              coins: P.coins
            });

            match.sendSimpleStatusBoth();

            match.sendSkill(
              `💰 ${P.name} はコインを使って Lv${P.level} にアップ！（攻撃+${res.inc ?? 0}）`
            );
            return;
          }
        };

        // p1 / p2 に同じハンドラを登録
        p1.on("message", (raw2) => handlePlayerMessage(p1, raw2));
        p2.on("message", (raw2) => handlePlayerMessage(p2, raw2));
      }
    }
  });
});
