// （import 群は変更なし）
import WebSocket, { WebSocketServer } from "ws";
import { Player } from "./player.js";
import {
  LEVEL_REQUIREMENTS,
  JOB_TEMPLATE,
  ARROW_DATA,
  createDollCostume,
  DOLL_COSTUME_PARTS,
  DOLL_COSTUME_TYPES,
  JOB_SKILLS,
  SUMMONER_DRAGON_DATA,
  SUMMONER_DRAGON_TYPES,
  SUMMONER_HATCH_TURNS,
  SUMMONER_GROWTH_MAX,
  SUMMONER_FEED_GROWTH,
  createSummonerEggItem,
  createSummonerFeedItem
} from "./constants.js";
// ★ dev/simulate 用：職業データを外部から参照可能にする（本番影響なし）
export const JOB_DATA = JOB_TEMPLATE;

import crypto from "crypto";
import { generateOneShopItem } from "./item.js";
import { generateEquipmentForLevel, NORMAL_EQUIP_MAX_STAR, upgradeEquipStar } from "./equip.js";
import { MAGE_EQUIPS } from "./equip.js";
import { getMageSlot } from "./player.js";
import { MAGE_MANA_ITEMS } from "./mage_items.js";
import { ONMYOJI_TALISMAN_ITEMS } from "./onmyoji_items.js";
import http from "http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
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
  importJobRecordBackup,
  importDojoProgressBackup,
  exportDojoProgressBackup
} from "./account_store.js";

// =========================================================
// ★ dev / simulate 判定（本番影響なし）
// =========================================================
export const DEV_MODE = process.argv.includes("--dev-ai");
const RUN_CPU_SIM = process.argv.some(arg => String(arg) === "--cpu-sim" || String(arg).startsWith("--cpu-sim"));

const CPU_AI_WEIGHT_DEFAULTS = {
  onmyoji: {
    baseTalismanScore: 6800,
    lowRankBonus: 750,
    highRankBonus: 1700,
    lowHpHighRankBonus: 1800,
    lowHpLowRankBonus: 700,
    enemyLowHpHighRankBonus: 1200,
    enemyLowHpLowRankBonus: 450,
    catVsMageBonus: 5200,
    catVsArcherOrSummonerBonus: 900,
    catEnemyDamagedBonus: 650,
    kyuubiManyBuffsBonus: 5200,
    kyuubiPerBuffBonus: 750,
    kyuubiOneBuffBonus: 1700,
    kyuubiVsMageOrMadBonus: 900,
    whiteDragonTwoPoisonBonus: 7200,
    whiteDragonOnePoisonBonus: 3600,
    whiteDragonManyDebuffBonus: 2600,
    whiteDragonVsArcherPoisonBonus: 2800,
    whiteDragonLowHpBonus: 2200,
    genbuVsPhysicalBonus: 1250,
    tenguVsThreatBonus: 950,
    onibiHealthyEnemyBonus: 800,
    shopMissingTalismanBonus: 900,
    actionShopFewTalismansScore: 4400,
    actionShopEnoughTalismansScore: 2100,
    actionUseItemMinimumScore: 2600,
    actionUseItemScoreOffset: 4200,
  },
};

function mergeCpuAiWeights(base, override) {
  if (!override || typeof override !== "object") return base;
  const next = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base?.[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      next[key] = mergeCpuAiWeights(base[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function loadCpuAiWeights() {
  const requested = getCliArgValue("cpu-ai-weights", process.env.CPU_AI_WEIGHTS || "cpu_ai_weights.json");
  const resolved = requested ? path.resolve(process.cwd(), requested) : "";
  if (!resolved || !existsSync(resolved)) return CPU_AI_WEIGHT_DEFAULTS;
  try {
    const parsed = JSON.parse(readFileSync(resolved, "utf8"));
    return mergeCpuAiWeights(CPU_AI_WEIGHT_DEFAULTS, parsed);
  } catch (err) {
    console.warn(`[CPU_AI] failed to load weights: ${resolved}`, err?.message ?? err);
    return CPU_AI_WEIGHT_DEFAULTS;
  }
}

const CPU_AI_WEIGHTS = loadCpuAiWeights();



// デバッグログ ON/OFF
const DEBUG = true;
const SHOP_SLOT_COUNT = 5;
const ARROW_SHOP_SET_COUNT = 3;
const ARCHER_START_ARROW_COUNT = 5;
const DOJO_TRAIL_COIN_SPENT_ATTACK_STEP = 20;

const clients = new Set();

function createArrowItem(base, count = ARROW_SHOP_SET_COUNT) {
  const arrows = Math.max(1, Math.floor(Number(count ?? ARROW_SHOP_SET_COUNT)));
  return {
    ...base,
    uid: crypto.randomUUID(),
    is_equip: true,
    is_arrow: true,
    equip_type: "arrow",
    arrow_count: arrows,
    arrows_remaining: arrows,
  };
}

function isArrowItem(item) {
  return !!item && (item.is_arrow || item.equip_type === "arrow");
}

function getArrowStackKey(item) {
  if (!isArrowItem(item)) return "";
  return String(item.effect ?? item.arrow_effect ?? item.name ?? item.icon_src ?? "").trim().toLowerCase();
}

function getArrowAmmoCount(item) {
  if (!isArrowItem(item)) return 0;
  const count = Number(item.arrows_remaining ?? item.arrow_count ?? 0);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

function setArrowAmmoCount(item, count) {
  const next = Math.max(0, Math.floor(Number(count) || 0));
  item.arrow_count = next;
  item.arrows_remaining = next;
  return item;
}

function mergeArrowAmmo(target, incoming) {
  const add = Math.max(1, getArrowAmmoCount(incoming));
  setArrowAmmoCount(target, getArrowAmmoCount(target) + add);
  return target;
}

function cloneArrowStack(item, count) {
  const clone = {
    ...item,
    uid: crypto.randomUUID(),
  };
  return setArrowAmmoCount(clone, count);
}

function addArrowToPlayerStack(P, item, { includeEquipped = true } = {}) {
  if (!P || !isArrowItem(item)) return { item, merged: false, target: "none" };
  P.arrow_inventory = Array.isArray(P.arrow_inventory) ? P.arrow_inventory : [];
  const key = getArrowStackKey(item);
  if (includeEquipped) {
    for (const slot of ["arrow", "arrow2"]) {
      if (P[slot] && getArrowStackKey(P[slot]) === key) {
        return { item: mergeArrowAmmo(P[slot], item), merged: true, target: "equipped", slot };
      }
    }
  }
  const inventoryTarget = P.arrow_inventory.find(it => getArrowStackKey(it) === key);
  if (inventoryTarget) {
    return { item: mergeArrowAmmo(inventoryTarget, item), merged: true, target: "inventory" };
  }
  P.arrow_inventory.push(item);
  return { item, merged: false, target: "inventory" };
}

function normalizePlayerArrowInventory(P) {
  if (!P || !Array.isArray(P.arrow_inventory)) return;
  const merged = [];
  for (const item of P.arrow_inventory) {
    if (!isArrowItem(item)) {
      merged.push(item);
      continue;
    }
    const key = getArrowStackKey(item);
    const existing = merged.find(it => isArrowItem(it) && getArrowStackKey(it) === key);
    if (existing) mergeArrowAmmo(existing, item);
    else merged.push(item);
  }
  P.arrow_inventory = merged;
}

function normalizePlayerArrowStorage(P) {
  if (!P) return;
  P.arrow_inventory = Array.isArray(P.arrow_inventory) ? P.arrow_inventory : [];
  P.special_inventory = Array.isArray(P.special_inventory) ? P.special_inventory : [];

  if (P.special_inventory.length > 0) {
    const special = [];
    for (const item of P.special_inventory) {
      if (isArrowItem(item)) {
        addArrowToPlayerStack(P, item, { includeEquipped: true });
      } else {
        special.push(item);
      }
    }
    P.special_inventory = special;
  }

  normalizePlayerArrowInventory(P);

  if (P.arrow && P.arrow2 && getArrowStackKey(P.arrow) === getArrowStackKey(P.arrow2)) {
    mergeArrowAmmo(P.arrow, P.arrow2);
    P.arrow2 = null;
  }

  for (const slot of ["arrow", "arrow2"]) {
    const equipped = P[slot];
    if (!isArrowItem(equipped)) continue;
    const key = getArrowStackKey(equipped);
    const rest = [];
    for (const item of P.arrow_inventory) {
      if (isArrowItem(item) && getArrowStackKey(item) === key) {
        mergeArrowAmmo(equipped, item);
      } else {
        rest.push(item);
      }
    }
    P.arrow_inventory = rest;
  }

  normalizePlayerArrowInventory(P);
}

function getPlayerArrowSlotKey(slot) {
  const equipSlot = Number(slot || 1);
  if (equipSlot === 1) return "arrow";
  if (equipSlot === 2) return "arrow2";
  return "";
}

function isSummonerPlayer(P) {
  return !!P && P.job === "召喚士";
}

function ensureSummonerState(P) {
  if (!isSummonerPlayer(P)) return null;
  if (typeof P.ensureSummonerState === "function") return P.ensureSummonerState();
  P.summoner ??= { front: null, resonance_turns: 0, dragons: [] };
  P.summoner.dragons = Array.isArray(P.summoner.dragons) ? P.summoner.dragons : [];
  return P.summoner;
}

function createSummonerDragonEntry(type, stage = "egg") {
  const data = SUMMONER_DRAGON_DATA[type];
  if (!data) return null;
  return {
    uid: crypto.randomUUID(),
    type,
    name: data.name,
    stage,
    hatch_turns_remaining: stage === "egg" ? SUMMONER_HATCH_TURNS : 0,
    growth: 0,
    growth_max: SUMMONER_GROWTH_MAX,
  };
}

function getSummonerOwnedTypes(P) {
  const state = ensureSummonerState(P);
  return new Set((state?.dragons ?? []).map(dragon => dragon?.type).filter(Boolean));
}

function getSummonerDragon(P, type) {
  const key = String(type ?? "");
  return (ensureSummonerState(P)?.dragons ?? []).find(dragon => dragon?.type === key) ?? null;
}

function isSummonerDragonAdult(dragon) {
  return dragon?.stage === "adult";
}

function getSummonerStageLabel(stage) {
  return stage === "adult" ? "成体" : stage === "juvenile" ? "幼体" : "卵";
}

function normalizeSummonerFront(P) {
  const state = ensureSummonerState(P);
  if (!state) return null;
  const front = state.dragons.find(dragon => dragon?.type === state.front && dragon.stage !== "egg");
  if (!front) {
    const next = state.dragons.find(dragon => dragon?.stage !== "egg");
    state.front = next?.type ?? null;
  }
  return state.front;
}

function buildSummonerStatus(P) {
  const state = ensureSummonerState(P);
  if (!state) return null;
  normalizeSummonerFront(P);
  return {
    front: state.front ?? null,
    resonance_turns: Math.max(0, Number(state.resonance_turns ?? 0)),
    dragons: (state.dragons ?? []).map(dragon => {
      const data = SUMMONER_DRAGON_DATA[dragon.type] ?? {};
      return {
        uid: dragon.uid,
        type: dragon.type,
        name: dragon.name ?? data.name ?? "竜",
        stage: dragon.stage ?? "egg",
        stage_label: getSummonerStageLabel(dragon.stage),
        hatch_turns_remaining: Math.max(0, Number(dragon.hatch_turns_remaining ?? 0)),
        growth: Math.max(0, Number(dragon.growth ?? 0)),
        growth_max: Math.max(1, Number(dragon.growth_max ?? SUMMONER_GROWTH_MAX)),
        is_front: String(state.front ?? "") === String(dragon.type ?? ""),
        icon_src: data.icon_src ?? "",
        egg_icon_src: data.egg_icon_src ?? "",
        juvenile_src: data.juvenile_src ?? "",
        adult_src: data.adult_src ?? "",
        effect_text: data.effect_text ?? "",
      };
    }),
  };
}

function getSummonerEggChoices(P) {
  const owned = getSummonerOwnedTypes(P);
  return SUMMONER_DRAGON_TYPES
    .filter(type => !owned.has(type))
    .map(type => {
      const data = SUMMONER_DRAGON_DATA[type] ?? {};
      return {
        type,
        name: data.name ?? type,
        icon_src: data.egg_icon_src ?? data.icon_src ?? "",
        desc: `${data.egg_color ?? ""}の竜の卵。${data.effect_text ?? ""}`,
      };
    });
}

function getSummonerGrowthTargets(P) {
  return (ensureSummonerState(P)?.dragons ?? [])
    .filter(dragon => dragon && dragon.stage !== "adult")
    .map(dragon => {
      const data = SUMMONER_DRAGON_DATA[dragon.type] ?? {};
      const next = dragon.stage === "egg" ? "幼体" : "成体";
      const progress = dragon.stage === "egg"
        ? `孵化まであと${Math.max(0, Number(dragon.hatch_turns_remaining ?? 0))}T`
        : `成長値 ${Math.max(0, Number(dragon.growth ?? 0))}/${Math.max(1, Number(dragon.growth_max ?? SUMMONER_GROWTH_MAX))}`;
      return {
        type: dragon.type,
        name: dragon.name ?? data.name ?? "竜",
        stage: dragon.stage,
        stage_label: getSummonerStageLabel(dragon.stage),
        icon_src: dragon.stage === "egg" ? (data.egg_icon_src ?? data.icon_src ?? "") : (data.icon_src ?? ""),
        desc: `${progress} / 使用後 ${next}`,
      };
    });
}

function addSummonerEgg(P, type) {
  const state = ensureSummonerState(P);
  const data = SUMMONER_DRAGON_DATA[type];
  if (!state || !data) return { ok: false, reason: "竜の卵を取得できません。" };
  if (getSummonerDragon(P, type)) {
    return { ok: false, reason: `${data.name}はすでに契約済みです。` };
  }
  const entry = createSummonerDragonEntry(type, "egg");
  state.dragons.push(entry);
  return { ok: true, dragon: entry };
}

function evolveSummonerDragon(P, dragon, toStage = null) {
  if (!dragon) return null;
  const before = dragon.stage;
  if (toStage) {
    dragon.stage = toStage;
  } else if (dragon.stage === "egg") {
    dragon.stage = "juvenile";
  } else if (dragon.stage === "juvenile") {
    dragon.stage = "adult";
  }
  if (dragon.stage === "juvenile") {
    dragon.hatch_turns_remaining = 0;
    dragon.growth = Math.max(0, Number(dragon.growth ?? 0));
  } else if (dragon.stage === "adult") {
    dragon.hatch_turns_remaining = 0;
    dragon.growth = SUMMONER_GROWTH_MAX;
  }
  normalizeSummonerFront(P);
  return before !== dragon.stage ? { before, after: dragon.stage } : null;
}

function advanceSummonerGrowthStage(P, type) {
  const dragon = getSummonerDragon(P, type);
  if (!dragon) return { ok: false, reason: "対象の卵/竜が見つかりません。" };
  if (isSummonerDragonAdult(dragon)) {
    return { ok: false, reason: "成体には使用できません。" };
  }
  const evolved = evolveSummonerDragon(P, dragon);
  return { ok: !!evolved, dragon, evolved };
}

function applySummonerFeed(P, type = null) {
  const state = ensureSummonerState(P);
  if (!state) return { ok: false, reason: "召喚士専用アイテムです。" };
  const requested = String(type ?? "");
  const hasExplicitTarget = requested && requested !== "1";
  let dragon = hasExplicitTarget
    ? getSummonerDragon(P, requested)
    : null;
  if (hasExplicitTarget && !dragon) {
    return { ok: false, reason: "選んだ卵/竜が見つかりません。" };
  }
  if (hasExplicitTarget && dragon?.stage === "egg") {
    return { ok: false, reason: "竜の餌は幼体にだけ使用できます。" };
  }
  if (!dragon) {
    dragon = state.dragons.find(d => d?.type === state.front && d.stage === "juvenile") ??
      state.dragons.find(d => d && d.stage === "juvenile") ??
      null;
  }
  if (!dragon) return { ok: false, reason: "餌を与えられる幼体の竜がいません。" };
  if (dragon.stage === "juvenile") {
    dragon.growth = Math.min(SUMMONER_GROWTH_MAX, Number(dragon.growth ?? 0) + SUMMONER_FEED_GROWTH);
    if (dragon.growth >= SUMMONER_GROWTH_MAX) {
      const evolved = evolveSummonerDragon(P, dragon, "adult");
      return { ok: true, dragon, evolved, message: `${dragon.name}が成体へ成長した！` };
    }
    return { ok: true, dragon, message: `${dragon.name}の成長値 +${SUMMONER_FEED_GROWTH}（${dragon.growth}/${SUMMONER_GROWTH_MAX}）` };
  }
  return { ok: false, reason: "成体には餌を使えません。" };
}

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
  const frameId = profile?.frameId != null ? String(profile.frameId).slice(0, 64) : "";
  const frameSrc = profile?.frameSrc != null ? String(profile.frameSrc).slice(0, 240) : "";
  return { iconJobId, titleJobId, titleText, iconSrc, frameId, frameSrc };
}

function attachPlayerProfile(player, profile = {}) {
  if (!player) return player;
  player.profile = normalizePlayerProfile(profile);
  return player;
}

const CPU_AI_TITLE_PREFIX = {
  1: "見習い",
  2: "駆け出し",
  3: "修練生",
  4: "熟練",
  5: "達人",
  6: "名人",
  7: "英雄",
  8: "覇者",
  9: "伝説",
  10: "神域に到達せし",
};

const CPU_AI_RATING = {
  1: 850,
  2: 950,
  3: 1050,
  4: 1150,
  5: 1250,
  6: 1375,
  7: 1500,
  8: 1625,
  9: 1775,
  10: 1950,
};

const CPU_AI_MISTAKE_RATE = {
  1: 0.35,
  2: 0.28,
  3: 0.22,
  4: 0.16,
  5: 0.11,
  6: 0.08,
  7: 0.05,
  8: 0.03,
  9: 0.015,
  10: 0,
};

const CPU_AI_STYLE_LABEL = {
  balanced: "標準",
  aggro: "アグロ",
  survival: "生存重視",
  economy: "経済重視",
  combo: "コンボ重視",
};

const CPU_AI_STYLE_IDS = Object.keys(CPU_AI_STYLE_LABEL);

const CPU_AI_DEFAULT_STYLE_BY_JOB = {
  1: "aggro",
  2: "survival",
  3: "survival",
  4: "combo",
  5: "aggro",
  6: "economy",
  7: "economy",
  8: "aggro",
  9: "combo",
  10: "combo",
};

function normalizeCpuAiLevel(value) {
  if (value === "random" || value == null || value === "") return null;
  const level = Math.floor(Number(value));
  return Number.isFinite(level) ? Math.min(10, Math.max(1, level)) : null;
}

function pickCpuAiLevel(value) {
  return normalizeCpuAiLevel(value) ?? (Math.floor(Math.random() * 10) + 1);
}

function getCpuAiTitle(jobKey, aiLevel) {
  const prefix = CPU_AI_TITLE_PREFIX[normalizeCpuAiLevel(aiLevel) ?? 1] ?? CPU_AI_TITLE_PREFIX[1];
  const jobName = JOB_TEMPLATE?.[Number(jobKey)]?.name ?? "CPU";
  return `${prefix}${jobName}`;
}

function pickCpuAiStyle(value, jobKey) {
  const raw = value == null || value === "" || value === "auto"
    ? ""
    : String(value).trim().toLowerCase();
  if (raw === "random") {
    return CPU_AI_STYLE_IDS[Math.floor(Math.random() * CPU_AI_STYLE_IDS.length)] ?? "balanced";
  }
  if (CPU_AI_STYLE_LABEL[raw]) return raw;
  return CPU_AI_DEFAULT_STYLE_BY_JOB[Number(jobKey)] ?? "balanced";
}

function applyCpuAiRank(cpuPlayer, jobKey, requestedRank, requestedStyle = "auto") {
  if (!cpuPlayer) return cpuPlayer;
  const aiLevel = pickCpuAiLevel(requestedRank);
  const aiStyle = pickCpuAiStyle(requestedStyle, jobKey);
  const titleText = getCpuAiTitle(jobKey, aiLevel);
  cpuPlayer.isBot = true;
  cpuPlayer.cpu_ai_level = aiLevel;
  cpuPlayer.cpu_ai_rating = CPU_AI_RATING[aiLevel] ?? 1000;
  cpuPlayer.cpu_ai_style = aiStyle;
  cpuPlayer.cpu_ai_style_label = CPU_AI_STYLE_LABEL[aiStyle] ?? CPU_AI_STYLE_LABEL.balanced;
  cpuPlayer.profile = normalizePlayerProfile({
    ...(cpuPlayer.profile ?? {}),
    iconJobId: String(jobKey),
    titleJobId: String(jobKey),
    titleText,
  });
  return cpuPlayer;
}

function buildMatchStartPayload(selfPlayer, enemyPlayer, extra = {}) {
  return {
    type: "match_start",
    self_name: selfPlayer?.name ?? "Player",
    self_job: selfPlayer?.job ?? "",
    self_profile: selfPlayer?.profile ?? null,
    enemy_name: enemyPlayer?.name ?? "Player",
    enemy_job: enemyPlayer?.job ?? "",
    enemy_profile: enemyPlayer?.profile ?? null,
    enemy_cpu_ai_level: enemyPlayer?.cpu_ai_level ?? null,
    enemy_cpu_ai_rating: enemyPlayer?.cpu_ai_rating ?? null,
    enemy_cpu_ai_style: enemyPlayer?.cpu_ai_style ?? null,
    enemy_cpu_ai_style_label: enemyPlayer?.cpu_ai_style_label ?? null,
    enemy_is_dojo_enemy: !!enemyPlayer?.isDojoEnemy,
    enemy_dojo_enemy_id: enemyPlayer?.dojoEnemyId ?? null,
    enemy_dojo_enemy_image: enemyPlayer?.dojoEnemyImage ?? null,
    enemy_dojo_enemy_scale: enemyPlayer?.dojoEnemyScale ?? 1,
    enemy_dojo_stage_kind: enemyPlayer?.dojoStageKind ?? null,
    ...extra
  };
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
  const out = {};
  const trailNodes = new Set((player.dojoTrailNodes || []).map(Number));

  for (let i = 0; i < list.length; i++) {
    const stype = list[i]?.type;
    const num = i + 1;
    if (!stype) {
      out[num] = 0;
      continue;
    }

    if (player.job === "戦士" && stype === "warrior_4" && !trailNodes.has(55)) {
      out[num] = -1;
      continue;
    }
    if (player.job === "戦士" && stype === "warrior_5" && !trailNodes.has(60)) {
      out[num] = -1;
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
const SKILL_SEAL_BUFF_TYPE = "\u30b9\u30ad\u30eb\u5c01\u5370";
const SKILL_SEALED_POPUP_MESSAGE = "\u30b9\u30ad\u30eb\u5c01\u5370\u4e2d\u3067\u3059\u3002\u30b9\u30ad\u30eb\u306f\u4f7f\u7528\u3067\u304d\u307e\u305b\u3093\u3002";

function getSkillSealTurnsForStatus(player) {
  if (!player) return 0;
  const direct = Math.max(0, Number(player.skill_sealed_rounds ?? 0));
  const buffs = Array.isArray(player.active_buffs) ? player.active_buffs : [];
  const activeTurns = buffs
    .filter(buff => buff?.type === SKILL_SEAL_BUFF_TYPE)
    .map(buff => Number(buff.duration ?? buff.rounds ?? buff.turns ?? 0))
    .filter(turns => Number.isFinite(turns) && turns > 0);
  return Math.max(direct, ...activeTurns, 0);
}

function isPlayerSkillSealed(player) {
  return !!player?.skill_sealed || getSkillSealTurnsForStatus(player) > 0;
}

function getArcherExtraBuffEntries(player) {
  if (!player) return [];
  if (typeof player.get_archer_extra_buffs === "function") {
    return player.get_archer_extra_buffs();
  }
  const fromArray = Array.isArray(player.archer_buffs) ? player.archer_buffs : [];
  const buffs = fromArray
    .map(buff => ({
      rounds: Math.floor(Number(buff?.rounds ?? buff?.duration ?? 0)),
      extra: Math.max(0, Math.floor(Number(buff?.extra ?? buff?.power ?? 1))),
      source: buff?.source ?? "追撃強化",
    }))
    .filter(buff => buff.rounds > 0 && buff.extra > 0);
  if (buffs.length > 0) return buffs;
  if (!Array.isArray(player.archer_buffs) && player.archer_buff && Number(player.archer_buff.rounds ?? 0) > 0) {
    return [{
      rounds: Math.floor(Number(player.archer_buff.rounds ?? 0)),
      extra: Math.max(1, Math.floor(Number(player.archer_buff.extra ?? 1))),
      source: player.archer_buff.source ?? "追撃強化",
    }];
  }
  return [];
}

function getArcherExtraBuffSummary(player) {
  const buffs = getArcherExtraBuffEntries(player);
  const extra = buffs.reduce((sum, buff) => sum + Math.max(0, Number(buff.extra ?? 0)), 0);
  if (extra <= 0) return null;
  return {
    extra,
    rounds: Math.max(...buffs.map(buff => Number(buff.rounds ?? 0))),
  };
}

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
      text: "僧侶パッシブ：自分のターン開始時、HPを1回復（最大HP400 / 解除不可）",
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
  } else if (player.job === "召喚士") {
    out.push({
      kind: "summoner_passive",
      power: 0,
      remain: null,
      source: "召喚士パッシブ",
      text: "召喚士パッシブ：卵を孵化させ、前衛/後衛の竜効果で戦う",
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
        : `${b.type ?? "効果"} ${sign}${Math.abs(power)}（あと${remain}T）`;

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
        text: `凍結：攻撃 -${atkDown}（あと${remain}T）`,
      });
    }
  }

  if (Array.isArray(player.defense_debuffs)) {
    for (const d of player.defense_debuffs) {
      const remain = Number(d.rounds ?? d.duration ?? 0);
      const defDown = Number(d.defDown ?? d.power ?? 0);
      out.push({
        kind: "def_down",
        power: defDown,
        remain,
        source: "防御低下の矢",
        text: `防御低下：防御力-${defDown}（あと${remain}T）`,
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
        text: `${name}：${power} ダメージ（あと${remain}T）`,
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

  if (Number(player.dojo_invincible_rounds ?? 0) > 0) {
    const rounds = Number(player.dojo_invincible_rounds ?? 0);
    out.push({
      kind: "barrier",
      power: rounds,
      remain: rounds,
      source: "無敵の霊薬",
      text: `無敵：受けるダメージを0にする（あと${rounds}T）`,
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


  if (player.job === "弓兵") {
    const archerBuffs = getArcherExtraBuffEntries(player);
    const sourceCounts = new Map();
    archerBuffs.forEach(buff => {
      const source = String(buff.source ?? "追撃強化");
      sourceCounts.set(source, Number(sourceCounts.get(source) ?? 0) + 1);
    });
    const sourceSeen = new Map();
    archerBuffs.forEach((buff, index) => {
      const extra = Math.max(1, Number(buff.extra ?? 1));
      const rounds = Math.max(1, Number(buff.rounds ?? 1));
      const source = String(buff.source ?? "追撃強化");
      sourceSeen.set(source, Number(sourceSeen.get(source) ?? 0) + 1);
      const label = Number(sourceCounts.get(source) ?? 0) > 1
        ? `${source}${Number(sourceSeen.get(source) ?? 1)}`
        : source;
      out.push({
        kind: "archer_extra_attack",
        power: extra,
        remain: rounds,
        source: label,
        text: `${label}：追加攻撃 +${extra}（あと${rounds}T）`,
      });
    });
  }
  if (
    player.job === "弓兵" &&
    (!!player.archer_no_consume_permanent || Number(player.archer_no_consume_rounds ?? 0) > 0)
  ) {
    const rounds = Number(player.archer_no_consume_rounds ?? 0);
    out.push({
      kind: "archer_no_consume",
      power: 0,
      remain: player.archer_no_consume_permanent ? null : rounds,
      source: "無尽射撃",
      text: player.archer_no_consume_permanent
        ? "無尽射撃：矢を消費しない（永続）"
        : `無尽射撃：矢を消費しない（あと${rounds}T）`,
    });
  }

  if (player.job === "召喚士" && player.summoner) {
    for (const entry of buildSummonerFrontBuffUIEntries(player)) {
      out.push(entry);
    }
    const resonanceTurns = Math.max(0, Number(player.summoner.resonance_turns ?? 0));
    if (resonanceTurns > 0) {
      out.push({
        kind: "summoner_resonance",
        power: resonanceTurns,
        remain: resonanceTurns,
        source: "竜脈解放",
        text: `竜脈解放：すべての竜が前衛効果を発揮（あと${resonanceTurns}T）`,
      });
      for (const entry of buildSummonerResonanceBacklineBuffUIEntries(player, resonanceTurns)) {
        out.push(entry);
      }
    }
    const normalDefense = Number(player.getSummonerDefenseBonus?.() ?? 0);
    if (normalDefense > 0) {
      out.push({
        kind: "summoner_fafnir",
        power: normalDefense,
        remain: null,
        source: "ファフニール",
        text: `ファフニール：防御力 +${normalDefense}`,
      });
    }
    const specialDefense = Number(player.getSummonerSpecialDefenseBonus?.() ?? 0);
    if (specialDefense > 0) {
      out.push({
        kind: "summoner_fafnir",
        power: specialDefense,
        remain: null,
        source: "ファフニール",
        text: `ファフニール：特殊防御力 +${specialDefense}${player.hasSummonerFafnirReflect?.() ? " / 被ダメージ50%反射" : ""}`,
      });
    }
  }

  if (player.job === "人形使い" && player.doll) {
    if (player.doll.is_rampage) {
      const rounds = Math.max(0, Number(player.doll.rampage_rounds ?? 0));
      out.push({
        kind: "doll_rampage",
        power: rounds,
        remain: rounds,
        source: "人形暴走",
        text: `人形暴走：衣装効果2倍。破壊または自爆時に相手へ20ダメージ（残り${rounds}T）`,
      });
    }

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
          ? `追加攻撃：防御無視が永続。あと${extraAttackRounds}T、毎回 ${Math.max(1, extraAttackCount)} 回追加攻撃`
          : "追加攻撃：防御無視が永続";
      } else {
        text = `追加攻撃：あと${extraAttackRounds}T、毎回 ${Math.max(1, extraAttackCount)} 回追加攻撃`;
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

  const madState = buildMadStateData(player);
  if (madState) {
    out.push({
      kind: "mad",
      power: madState.total,
      remain: null,
      source: "狂人パッシブ",
      text: madState.is_mad
        ? `累積被ダメージ：${madState.total}/${madState.threshold}（狂化状態・解除不可）`
        : `累積被ダメージ：${madState.total}/${madState.threshold}（狂化まであと${madState.remaining}・解除不可）`,
      unremovable: true,
      passive: true,
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

function getSummonerDragonFrontEffectText(dragon) {
  if (!dragon || dragon.stage === "egg") return "";
  const stageLabel = dragon.stage === "adult" ? "成体" : "幼体";
  if (dragon.type === "tiamat") {
    const damage = dragon.stage === "adult" ? 18 : 10;
    return dragon.stage === "adult"
      ? `${stageLabel}前衛：行動後、防御無視${damage}ダメージ`
      : `${stageLabel}前衛：行動後、防御50%無視${damage}ダメージ`;
  }
  if (dragon.type === "nidhogg") {
    return dragon.stage === "adult"
      ? `${stageLabel}前衛：行動後、3T攻撃-2と3T毒3`
      : `${stageLabel}前衛：行動後、2T毒2`;
  }
  if (dragon.type === "fafnir") {
    return dragon.stage === "adult"
      ? `${stageLabel}前衛：特殊防御+5 / 被ダメージ50%反射`
      : `${stageLabel}前衛：防御+3`;
  }
  return "";
}

function buildSummonerFrontBuffUIEntries(player) {
  if (!player?.summoner) return [];
  const frontType = String(player.summoner.front ?? "");
  if (!frontType) return [];
  const dragon = (player.summoner.dragons ?? [])
    .find(entry => entry && entry.stage !== "egg" && String(entry.type ?? "") === frontType);
  if (!dragon) return [];
  const effect = getSummonerDragonFrontEffectText(dragon);
  if (!effect) return [];
  const name = dragon.name ?? SUMMONER_DRAGON_DATA?.[dragon.type]?.name ?? "竜";
  return [{
    kind: `summoner_${dragon.type}`,
    power: 0,
    remain: null,
    source: `前衛竜：${name}`,
    text: `前衛竜：${name}（${effect}）`,
    unremovable: true,
    passive: true,
  }];
}

function buildSummonerResonanceBacklineBuffUIEntries(player, resonanceTurns = null) {
  if (!player?.summoner || Number(player.summoner.resonance_turns ?? 0) <= 0) return [];
  const remain = Math.max(0, Number(resonanceTurns ?? player.summoner.resonance_turns ?? 0));
  const frontType = String(player.summoner.front ?? "");
  return (player.summoner.dragons ?? [])
    .filter(dragon => dragon && dragon.stage !== "egg" && String(dragon.type ?? "") !== frontType)
    .map(dragon => {
      const effect = getSummonerDragonFrontEffectText(dragon);
      if (!effect) return null;
      const name = dragon.name ?? SUMMONER_DRAGON_DATA?.[dragon.type]?.name ?? "竜";
      return {
        kind: `summoner_resonance_${dragon.type}`,
        power: 0,
        remain,
        source: `竜脈解放：${name}`,
        text: `竜脈解放：${name}も前衛効果（${effect} / あと${remain}T）`,
        unremovable: true,
      };
    })
    .filter(Boolean);
}

function buildDojoTrailBuffUIEntries(player) {
  if (!player || !Array.isArray(player.dojoTrailNodes)) return [];
  const nodes = new Set((player.dojoTrailNodes || []).map(Number));
  const out = [];
  const attackBonus = Math.max(0, Number(player._dojoTrailAttackBonusApplied ?? 0));
  const defenseBonus = Math.max(0, Number(player._dojoTrailDefenseBonusApplied ?? 0));
  const maxHpBonus = Math.max(0, Number(player._dojoTrailMaxHpBonusApplied ?? 0));
  const regen = Math.max(0, Number(player._dojoTrailRoundRegen ?? 0));
  const coinGainPercent = Math.max(0, Number(player._dojoTrailCoinGainPercent ?? 0));
  const dropRateBonus = Math.max(0, Number(player._dojoTrailDropRateBonusPercent ?? 0));
  const rareDropBonusCount = Math.max(0, Number(player._dojoTrailRareDropBonusCount ?? 0));
  const itemAttackGrowth = Math.max(0, Number(player.dojoItemAttackBuff ?? 0));
  const normalItemEffectBonus = getDojoNormalItemEffectBonusFromNodes(nodes);
  const skillDamageBonus =
    [51, 52, 53, 54].reduce((sum, id) => sum + (nodes.has(id) ? 5 : 0), 0) +
    [56, 57, 58, 59].reduce((sum, id) => sum + (nodes.has(id) ? 10 : 0), 0);

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
      text: `軌跡：毎ターンHP ${regen} 回復（解除不可）`,
      unremovable: true,
      passive: true,
    });
  }
  if (coinGainPercent > 0) {
    out.push({
      kind: "other",
      power: coinGainPercent,
      remain: null,
      source: "軌跡",
      text: `軌跡：コイン獲得量 +${coinGainPercent}%`,
      unremovable: true,
      passive: true,
    });
  }
  if (nodes.has(35)) {
    out.push({
      kind: "other",
      power: 1,
      remain: null,
      source: "商才の大軌跡",
      text: "軌跡：ショップ購入時、攻撃力装備★1も入手",
      unremovable: true,
      passive: true,
    });
  }
  if (nodes.has(40)) {
    const spentAttackBonus = Math.max(0, Math.floor(Number(player.dojoTrailState?.trailCoinSpent ?? player._dojoTrailCoinSpent ?? 0) / DOJO_TRAIL_COIN_SPENT_ATTACK_STEP));
    out.push({
      kind: "passive_atk",
      power: spentAttackBonus,
      remain: null,
      source: "蓄財の大軌跡",
      text: `軌跡：消費コイン${DOJO_TRAIL_COIN_SPENT_ATTACK_STEP}枚につき攻撃力+1（現在+${spentAttackBonus}）`,
      unremovable: true,
      passive: true,
    });
  }
  if (dropRateBonus > 0) {
    out.push({
      kind: "other",
      power: dropRateBonus,
      remain: null,
      source: "軌跡",
      text: `軌跡：アイテム・装備ドロップ率 +${dropRateBonus}%`,
      unremovable: true,
      passive: true,
    });
  }
  if (nodes.has(45)) {
    out.push({
      kind: "other",
      power: 1,
      remain: null,
      source: "宝箱の大軌跡",
      text: "軌跡：勝利時、アイテムまたは装備が必ず1つドロップ",
      unremovable: true,
      passive: true,
    });
  }
  if (rareDropBonusCount > 0) {
    out.push({
      kind: "other",
      power: rareDropBonusCount,
      remain: null,
      source: "上級ドロップ率アップ",
      text: `軌跡：★2・★3ドロップ確率アップ（${rareDropBonusCount}段階）`,
      unremovable: true,
      passive: true,
    });
  }
  if (nodes.has(50)) {
    out.push({
      kind: "other",
      power: 2,
      remain: null,
      source: "秘宝の大軌跡",
      text: "軌跡：勝利時、アイテム1種と装備1種を保証。特殊アイテム/特殊装備も低確率で抽選",
      unremovable: true,
      passive: true,
    });
  }
  if (skillDamageBonus > 0) {
    out.push({
      kind: "other",
      power: skillDamageBonus,
      remain: null,
      source: "スキル威力の軌跡",
      text: `軌跡：戦士スキルダメージ +${skillDamageBonus}`,
      unremovable: true,
      passive: true,
    });
  }
  if (nodes.has(55)) {
    out.push({
      kind: "other",
      power: 4,
      remain: null,
      source: "剛勇覚醒の大軌跡",
      text: "軌跡：戦士スキル4「剛勇覚醒」解放",
      unremovable: true,
      passive: true,
    });
  }
  if (nodes.has(60)) {
    out.push({
      kind: "other",
      power: 5,
      remain: null,
      source: "覇断一閃の大軌跡",
      text: "軌跡：戦士スキル5「覇断一閃」解放",
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
  if (normalItemEffectBonus > 0) {
    out.push({
      kind: "other",
      power: normalItemEffectBonus,
      remain: null,
      source: "通常アイテム効果の軌跡",
      text: `軌跡：攻撃力・防御力・HPの通常アイテム効果 +${normalItemEffectBonus}`,
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

function buildStatusInfoDescriptionList(player) {
  const list = buildStatusBuffDescriptionList(player);
  const mad = buildMadStateData(player);
  if (mad) {
    list.push(
      mad.is_mad
        ? `狂人：累積被ダメージ ${mad.total}/${mad.threshold}（狂化状態）`
        : `狂人：累積被ダメージ ${mad.total}/${mad.threshold}（狂化まであと${mad.remaining}）`
    );
  }
  return list;
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
      effect_text: "10Tの間、ターン開始時にHPを1回復する",
      is_equip: false,
    },
    {
      name: "祝福の刃",
      price: 15,
      is_priest_item: true,
      priest_effect: "blessing_attack",
      effect_text: "現在の祝福をすべて消費し、3Tの間、攻撃力を消費数の1/2アップする",
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

async function handleSummonerClientMessage(match, sock, P, m) {
  if (!match || !sock || !P || !m) return false;

  if (m.type === "request_summoner_skill1") {
    match.requestSummonerSkill1Choices(sock, P);
    return true;
  }
  if (m.type === "use_summoner_skill1") {
    if (sock !== match.current) {
      match.sendError("❌ 今はあなたのターンではありません。", sock);
      return true;
    }
    P.pending_summoner_egg_type = String(m.dragon_type ?? "");
    await match.useSkill(sock, P, P.opponent, 1);
    return true;
  }
  if (m.type === "request_summoner_skill2") {
    match.requestSummonerSkill2Choices(sock, P);
    return true;
  }
  if (m.type === "use_summoner_skill2") {
    if (sock !== match.current) {
      match.sendError("❌ 今はあなたのターンではありません。", sock);
      return true;
    }
    P.pending_summoner_growth_type = String(m.dragon_type ?? "");
    await match.useSkill(sock, P, P.opponent, 2);
    return true;
  }
  if (m.type === "switch_summoner_front") {
    match.switchSummonerFront(sock, P, String(m.dragon_type ?? ""));
    return true;
  }
  return false;
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

  if (item.is_summoner_feed) {
    if (P.job !== "召喚士") return false;
    if (P.item_use_count == null) P.item_use_count = 0;
    if (Number(P.item_use_count) >= 2) return false;
    const result = applySummonerFeed(P);
    if (!result?.ok) return false;
    P.item_use_count += 1;
    applyDojoTrailItemUseBonuses(ws, match, item);
    P.items = (P.items ?? []).filter(i => i.uid !== item.uid);
    match.sendSystem(`🐉 ${P.name} は ${result.message ?? "竜の餌を使用した"}`);
    match.sendSkillEffectEvent?.(P, "summoner_2_self", "body");
    match.sendItemList(ws, P);
    match.sendStatusInfo(ws, P);
    match.sendSimpleStatusBoth();
    return true;
  }

  if (P.item_use_count == null) P.item_use_count = 0;
  if (Number(P.item_use_count) >= 2) return false;

  if (item.is_doll_item) {
    if (!P.doll || typeof P.useDollRepairKit !== "function") return false;

    const repairResult = P.useDollRepairKit();
    if (!repairResult?.ok) return false;

    P.item_use_count += 1;
    applyDojoTrailItemUseBonuses(ws, match, item);
    P.items = (P.items ?? []).filter(i => i.uid !== item.uid);

    match.sendSystem(`🧰 ${P.name} は ${item.name} を使用した（人形耐久 ${repairResult.beforeDurability} → ${repairResult.afterDurability}）`);
    if (repairResult.healed > 0) {
      match.sendHealEvent(P, repairResult.healed, "doll");
    }
    if (repairResult.repairedCostume) {
      const repaired = repairResult.repairedCostume;
      match.sendSystem(`🧵 ${P.name} の${repaired.label}「${repaired.name}」を修復した`);
    }

    match.sendItemList(ws, P);
    match.sendStatusInfo(ws, P);
    match.sendSimpleStatusBoth();
    return true;
  }

  if (item.is_priest_item) {
    if (P.job !== "僧侶") return false;

    let message = `${item.name} を使用した`;
    if (item.priest_effect === "regen") {
      P.active_buffs ??= [];
      P.active_buffs.push({
        type: "継続回復",
        power: 1,
        rounds: 10,
        source: item.name ?? "聖なる香",
        uid: crypto.randomUUID(),
      });
      message = `${item.name} を使用（10T継続回復）`;
    } else if (item.priest_effect === "blessing_attack") {
      const consumed = Math.max(0, Number(P.blessing_count ?? 0));
      if (consumed <= 0) return false;
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
      message = `${item.name} を使用（祝福${consumed}消費 / 攻撃力+${power}）`;
    } else if (item.priest_effect === "blessing_heal") {
      const blessing = Math.max(0, Number(P.blessing_count ?? 0));
      if (blessing < 20 || Number(P.hp ?? 0) >= 400) return false;
      P.blessing_count = blessing - 20;
      const beforeHp = Number(P.hp ?? 0);
      const healed = P.restore_hp?.(20) ?? 0;
      if (healed > 0) {
        match.sendHealEvent(P, healed);
        P.blessing_count = blessing - 20;
      }
      message = `${item.name} を使用（祝福20消費 / HP ${beforeHp} → ${P.hp}）`;
    } else {
      return false;
    }

    P.item_use_count += 1;
    applyDojoTrailItemUseBonuses(ws, match, item);
    P.items = (P.items ?? []).filter(i => i.uid !== item.uid);
    match.sendSystem(`🧪 ${P.name} が ${message}`);
    match.sendItemList(ws, P);
    match.sendStatusInfo(ws, P);
    match.sendSimpleStatusBoth();
    return true;
  }

  // 2) HPが満タンなら HP回復アイテムは使わない（無駄撃ち防止）
  if (item.effect_type === "HP" && (P.hp >= P.max_hp)) return false;

  // 3) 効果適用（人間と同じ入口に統一）
  if (typeof P.apply_item !== "function") {
    // apply_item が無いなら諦める（ここをフォールバックで増やしたいなら後で足す）
    return false;
  }

  // 適用前ログ用
  const beforeHp = P.hp;

  const applyResult = P.apply_item(item);
  if (applyResult === false) {
    match.sendItemList(ws, P);
    return false;
  }
  P.item_use_count += 1;
  applyDojoTrailItemUseBonuses(ws, match, item);

  const healed = P.hp - beforeHp;
  if (healed > 0) {
    match.sendHealEvent(P, healed);
  }

  if (P.job === "陰陽師" && P.last_summoned_shikigami?.length) {
    match.sendShikigamiSummonEvent(P, P.last_summoned_shikigami);
    P.last_summoned_shikigami = [];
  }


  const displayItem = applyDojoNormalItemEffectBonusForPlayer(P, item);

  // 4) ログ（item.js の仕様に合わせる）
  if (displayItem.is_onmyoji_item) {
    match.sendSystem(
      `🧪 ${P.name} が ${displayItem.name} を使用（${displayItem.shikigami_name}を召喚）`
    );
  } else if (displayItem.effect_type === "HP") {
    match.sendSystem(
      `🧪 ${P.name} が ${displayItem.name} を使用（HP ${beforeHp} → ${P.hp}）`
    );
  } else {
    const dur = displayItem.duration ?? 0;
    match.sendSystem(
      `🧪 ${P.name} が ${displayItem.name} を使用（${displayItem.effect_type}+${displayItem.power}${dur > 0 ? ` / ${dur}T` : ""}）`
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

  if (req.method === "GET" && req.url && req.url.startsWith("/api/account/dojo_backup")) {
    const u = new URL(req.url, "http://localhost");
    const accountId = u.searchParams.get("account_id") || "";
    if (!accountId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "account_id required" }));
      return;
    }

    const jobs = Object.values(JOB_TEMPLATE).map(v => v.name);
    const data = exportDojoProgressBackup(accountId, jobs);
    res.writeHead(data?.ok ? 200 : 404, { "Content-Type": "application/json" });
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
        const backupDojoProgress = (j.backup_dojo_progress && typeof j.backup_dojo_progress === "object") ? j.backup_dojo_progress : null;
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
        if (backupDojoProgress) {
          try {
            importDojoProgressBackup(accountId, backupDojoProgress);
          } catch (e) {
            console.warn("importDojoProgressBackup failed:", e);
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

const PORT = RUN_CPU_SIM ? 0 : (process.env.PORT || 8080);

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
server.listen(PORT, () => {
  if (!RUN_CPU_SIM) console.log(`Listening on port ${PORT}`);
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

    // ★ 全体の手番カウンタ（内部用）
    this.round = 1;
    this.P1.turn_count = 0;
    this.P2.turn_count = 0;

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
    this.started = false;
    this.battleReadySockets = new Set(
      [this.p1, this.p2].filter(sock => sock?.isBot)
    );
    this.pendingFafnirReflectEvents = [];

  }

  getPlayerBySocket(wsPlayer) {
    if (wsPlayer === this.p1) return this.P1;
    if (wsPlayer === this.p2) return this.P2;
    return null;
  }

  getPlayerTurnCount(wsPlayer) {
    const player = this.getPlayerBySocket(wsPlayer);
    return Math.max(0, Number(player?.turn_count ?? 0));
  }

  incrementPlayerTurnCount(wsPlayer) {
    const player = this.getPlayerBySocket(wsPlayer);
    if (!player) return 0;
    player.turn_count = Math.max(0, Number(player.turn_count ?? 0)) + 1;
    return player.turn_count;
  }

  markBattleReady(wsPlayer) {
    if (this.ended || this.started) return;
    if (wsPlayer !== this.p1 && wsPlayer !== this.p2) return;

    this.battleReadySockets.add(wsPlayer);
    const readyP1 = this.p1?.isBot || this.battleReadySockets.has(this.p1);
    const readyP2 = this.p2?.isBot || this.battleReadySockets.has(this.p2);
    if (readyP1 && readyP2) {
      this.start();
    }
  }


// ---------------------------------------------------------
// ステータス更新（攻撃・防御・バフ・式神）
// ---------------------------------------------------------
  sendStatusInfo(ws, actor) {

      const payload = {
        type: "status_info",
        attack: actor.doll ? (actor.doll.is_broken ? 0 : actor.getDollAttack()) : actor.get_total_attack(),
        defense: actor.doll ? (actor.doll.is_broken ? 0 : actor.getDollDefense()) : actor.get_total_defense(),
        special_defense: Math.max(0, Number(actor.get_special_defense?.() ?? 0)),
        buffs: buildStatusInfoDescriptionList(actor),
        mad_state: buildMadStateData(actor),
        skill_sealed: isPlayerSkillSealed(actor),
        skill_sealed_turns: getSkillSealTurnsForStatus(actor),
        skill_sealed_rounds: getSkillSealTurnsForStatus(actor),

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
              is_rampage: !!actor.doll.is_rampage,
              rampage_rounds: Number(actor.doll.rampage_rounds ?? 0),
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
      payload.summoner = buildSummonerStatus(actor);



      // ★ 陰陽師だけ式神情報を送る
      if (actor.job === "陰陽師") {
          payload.shikigami = actor.getShikigamiList();
      } else {
          payload.shikigami = [];  // ← UIがエラーにならないよう空配列に
      }

      safeSend(ws, payload);
  }



  sendBattle(msg, extra = {}) {
    if (this.devMode) return;
    msg = this.normalizeLogMessage(msg);
    safeSend(this.p1, { type: "battle_log", msg, ...extra });
    safeSend(this.p2, { type: "battle_log", msg, ...extra });
  }


  // =========================================================
  // 演出用イベント（クライアントの damage_event / heal_event 用）
  // =========================================================

  sendSkill(msg) { 
    if (this.devMode) return;
    msg = this.normalizeLogMessage(msg);
    safeSend(this.p1, { type: "skill_log", msg });
    safeSend(this.p2, { type: "skill_log", msg });
  }

  getSkillDefByType(stype) {
    for (const skills of Object.values(JOB_SKILLS ?? {})) {
      const found = (skills ?? []).find(skill => skill?.type === stype);
      if (found) return found;
    }
    return null;
  }

  getSkillDefForActor(actor, stype, num) {
    return (JOB_SKILLS?.[actor?.job] ?? [])[Number(num) - 1] ?? this.getSkillDefByType(stype);
  }

  getFallbackSkillName(stype, num = null) {
    const match = String(stype ?? "").match(/^([a-z]+)_(\d+)$/);
    if (!match) return num ? `スキル${num}` : "スキル";
    const prefixLabel = {
      warrior: "戦士",
      knight: "騎士",
      priest: "僧侶",
      thief: "盗賊",
      mage: "魔導士",
      onmyoji: "陰陽師",
      alchemist: "錬金術師",
      archer: "弓兵",
      doll: "人形",
      summoner: "召喚士",
      mad: "狂人",
    }[match[1]] ?? "スキル";
    return `${prefixLabel}スキル${match[2]}`;
  }

  getSkillDisplayName(skillDef, stype, num = null) {
    const name = String(skillDef?.name ?? "").trim();
    return name || this.getFallbackSkillName(stype, num);
  }

  getSkillDescriptionText(skillDef) {
    const description = String(skillDef?.description ?? "").trim();
    if (description) return description;
    const effect = String(skillDef?.effect ?? "").trim();
    const power = skillDef?.power != null ? String(skillDef.power).trim() : "";
    return [effect && `効果: ${effect}`, power && `威力: ${power}`].filter(Boolean).join(" / ");
  }

  buildSkillActivationLog(actor, skillDef, stype, num = null) {
    const name = this.getSkillDisplayName(skillDef, stype, num);
    const desc = this.getSkillDescriptionText(skillDef);
    return desc
      ? `✨ ${actor?.name ?? "プレイヤー"} の「${name}」発動！ ${desc}`
      : `✨ ${actor?.name ?? "プレイヤー"} の「${name}」発動！`;
  }

  normalizeLogMessage(msg) {
    if (typeof msg === "function") return "ログ内容を表示できませんでした。";
    let text = String(msg ?? "").trim();
    if (!text) return "";

    text = text.replace(/_use_[a-z]+_skill/g, "スキル処理");
    text = text.replace(/\b(?:warrior|knight|priest|thief|mage|onmyoji|alchemist|archer|doll|summoner|mad)_[1-5]\b/g, (stype) => {
      const skillDef = this.getSkillDefByType(stype);
      return this.getSkillDisplayName(skillDef, stype);
    });
    text = text.replace(/_(?:target|self)\b/g, "");
    text = text.replace(/\bundefined\b/g, "不明");
    text = text.replace(/\bnull\b/g, "なし");
    return text;
  }

  sendSkillResultSummary(actor, target, detail = {}) {
    const lines = [];
    const records = Array.isArray(detail.skillDamageRecords) ? detail.skillDamageRecords : [];
    const totalRecordDamage = records.reduce((sum, record) => sum + Math.max(0, Number(record?.dealt ?? 0)), 0);
    const hasDollTarget = records.some(record => record?.targetType === "doll");
    const targetName = hasDollTarget ? `${target?.name ?? "相手"}の人形` : (target?.name ?? "相手");

    if (records.length > 0) {
      if (totalRecordDamage > 0) {
        lines.push(records.length > 1
          ? `${targetName}に合計${totalRecordDamage}ダメージ（${records.length}ヒット）`
          : `${targetName}に${totalRecordDamage}ダメージ`);
      } else {
        lines.push(`${targetName}へのダメージは防がれた`);
      }
    } else if (Number(detail.damagedTarget ?? 0) > 0) {
      lines.push(`${target?.name ?? "相手"}に${Number(detail.damagedTarget)}ダメージ`);
    }

    if (Number(detail.damagedActor ?? 0) > 0) {
      lines.push(`${actor?.name ?? "自分"}は反動で${Number(detail.damagedActor)}ダメージ`);
    }
    if (Number(detail.healedActor ?? 0) > 0) {
      lines.push(`${actor?.name ?? "自分"}はHPを${Number(detail.healedActor)}回復`);
    }
    if (Number(detail.healedTarget ?? 0) > 0) {
      lines.push(`${target?.name ?? "相手"}はHPを${Number(detail.healedTarget)}回復`);
    }
    const actorAttackDelta = Number(detail.actorAttackBuffDelta ?? (detail.actorAttackBuffIncreased ? 1 : 0));
    const actorDefDelta = Number(detail.actorDefBuffDelta ?? (detail.actorDefBuffIncreased ? 1 : 0));
    const targetAttackDelta = Number(detail.targetAttackBuffDelta ?? 0);
    const targetDefDelta = Number(detail.targetDefBuffDelta ?? 0);
    if (actorAttackDelta > 0) lines.push(`${actor?.name ?? "自分"}の攻撃力が上昇`);
    if (actorAttackDelta < 0) lines.push(`${actor?.name ?? "自分"}の攻撃力が低下`);
    if (actorDefDelta > 0) lines.push(`${actor?.name ?? "自分"}の防御力が上昇`);
    if (actorDefDelta < 0) lines.push(`${actor?.name ?? "自分"}の防御力が低下`);
    if (targetAttackDelta > 0) lines.push(`${target?.name ?? "相手"}の攻撃力が上昇`);
    if (targetAttackDelta < 0) lines.push(`${target?.name ?? "相手"}の攻撃力が低下`);
    if (targetDefDelta > 0) lines.push(`${target?.name ?? "相手"}の防御力が上昇`);
    if (targetDefDelta < 0) lines.push(`${target?.name ?? "相手"}の防御力が低下`);

    this.sendSkill(`→ ${lines.length ? lines.join(" / ") : "効果を適用しました。"}`);
  }

  sendSystem(msg) {
    if (this.devMode) return;
    msg = this.normalizeLogMessage(msg);
    safeSend(this.p1, { type: "system_log", msg });
    safeSend(this.p2, { type: "system_log", msg });
  }

  buildLiveStatusPatch(player, overrides = {}) {
    if (!player) return null;
    const nextLevelExp = LEVEL_REQUIREMENTS[player.level] ?? null;
    const hasOverride = key => Object.prototype.hasOwnProperty.call(overrides, key);
    const dollSource = hasOverride("doll") ? overrides.doll : player.doll;
    return {
      name: player.name ?? "Player",
      profile: player.profile ?? null,
      cpu_ai_level: player.cpu_ai_level ?? null,
      cpu_ai_rating: player.cpu_ai_rating ?? null,
      cpu_ai_style: player.cpu_ai_style ?? null,
      cpu_ai_style_label: player.cpu_ai_style_label ?? null,
      hp: hasOverride("hp") ? overrides.hp : player.hp,
      max_hp: hasOverride("max_hp") ? overrides.max_hp : player.max_hp,
      overheal_max_hp: player.job === "僧侶" ? 400 : (hasOverride("max_hp") ? overrides.max_hp : player.max_hp),
      attack: player.doll ? (player.doll.is_broken ? 0 : player.getDollAttack()) : player.get_total_attack(),
      defense: player.doll ? (player.doll.is_broken ? 0 : player.getDollDefense()) : player.get_total_defense(),
      special_defense: Math.max(0, Number(player.get_special_defense?.() ?? 0)),
      coins: player.coins,
      blessing_count: Number(player.blessing_count ?? 0),
      level: player.level,
      exp: player.exp ?? 0,
      next_level_exp: nextLevelExp,
      next_level_label: nextLevelExp == null
        ? "次Lv: MAX"
        : `次LvまでEXP: ${Math.max(0, nextLevelExp - (player.exp ?? 0))}`,
      job: player.job ?? "不明",
      is_dojo_enemy: !!player.isDojoEnemy,
      dojo_enemy_id: player.dojoEnemyId ?? null,
      dojo_enemy_image: player.dojoEnemyImage ?? null,
      dojo_enemy_scale: player.dojoEnemyScale ?? 1,
      mana: player.job === "魔導士" ? player.mana : null,
      mana_max: player.job === "魔導士" ? player.mana_max : null,
      arrow_slots: player.arrow_slots ?? 1,
      equip_slots: player.dojoEquipSlots ?? { equipment: 1, special: 1 },
      damage_taken_last_round: player.damage_taken_last_round ?? 0,
      damage_taken_last_turn: player.damage_taken_last_turn ?? 0,
      archer_buff: getArcherExtraBuffSummary(player),
      archer_buffs: getArcherExtraBuffEntries(player),
      archer_no_consume_rounds: player.archer_no_consume_rounds ?? 0,
      archer_no_consume_permanent: !!player.archer_no_consume_permanent,
      archer_pierce_rounds: player.archer_pierce_rounds ?? (player.archer_next_pierce ? 1 : 0),
      skill_sealed: isPlayerSkillSealed(player),
      skill_sealed_turns: getSkillSealTurnsForStatus(player),
      skill_sealed_rounds: getSkillSealTurnsForStatus(player),
      dojo_skill_damage_bonus: Math.max(0, Number(player.get_dojo_skill_damage_bonus?.() ?? 0)),
      dojo_coin_gain_percent: Math.max(0, Number(player._dojoTrailCoinGainPercent ?? 0)),
      equipment: [
        ...(Array.isArray(player.equipment)
          ? player.equipment
          : (player.equipment ? [player.equipment] : [])),
        ...(player.extra_equipments ?? [])
      ],
      doll: (dollSource != null)
        ? {
            durability: dollSource.durability,
            max_durability: dollSource.max_durability,
            is_broken: dollSource.is_broken,
            is_rampage: !!dollSource.is_rampage,
            rampage_rounds: Number(dollSource.rampage_rounds ?? 0),
            charge: Number(dollSource.charge ?? 0),
            charge_need: DOLL_CHARGE_COST,
            pending_charge_ready: !!dollSource.pending_charge_ready,
            attack: dollSource.is_broken ? 0 : player.getDollAttack(),
            defense: player.getDollDefense(),
            costumes: dollSource.costumes ?? {},
          }
        : null,
      summoner: buildSummonerStatus(player),
      special_equip: buildSpecialEquip(player),
      skill_remaining: buildSkillRemaining(player),
      buffs_ui: buildBuffUIData(player),
      mad_state: buildMadStateData(player),
    };
  }




  sendDamageEvent(targetPlayer, amount, kind = "normal", targetType = "body", extra = {}) {
    console.log("[SEND damage_event]", targetPlayer.name, amount, targetType);

    const damageAmount = Math.max(0, Number(amount ?? 0));
    if (damageAmount <= 0 && !extra.show_zero && !extra.allow_zero) return;

    const isTargetP1 = (targetPlayer === this.P1);

    const resolveTarget = (isP1, type) => {
      if (type === "doll") return isP1 ? "self_doll" : "enemy_doll";
      return isP1 ? "self" : "enemy";
    };
    const sourcePlayer = extra?.source_player ?? null;
    const sourceSideForP1 = sourcePlayer === "p1" ? "self" : sourcePlayer === "p2" ? "enemy" : null;
    const sourceSideForP2 = sourcePlayer === "p1" ? "enemy" : sourcePlayer === "p2" ? "self" : null;
    // p1 視点
    safeSend(this.p1, {
      type: "damage_event",
      target: resolveTarget(isTargetP1, targetType),
      amount: damageAmount,
      kind,
      hit_sfx: damageAmount >= 50 ? "boom" : "attack",
      status_patch: this.buildLiveStatusPatch(targetPlayer),
      ...extra,
      ...(sourceSideForP1 ? { source_side: sourceSideForP1, arrow_source_side: sourceSideForP1 } : {}),
    });

    // p2 視点（反転）
    safeSend(this.p2, {
      type: "damage_event",
      target: resolveTarget(!isTargetP1, targetType),
      amount: damageAmount,
      kind,
      hit_sfx: damageAmount >= 50 ? "boom" : "attack",
      status_patch: this.buildLiveStatusPatch(targetPlayer),
      ...extra,
      ...(sourceSideForP2 ? { source_side: sourceSideForP2, arrow_source_side: sourceSideForP2 } : {}),
    });

    if (extra?.action_source !== "summoner_fafnir_reflect") {
      this.flushFafnirReflectEventsFor(targetPlayer);
    }
  }

  queueFafnirReflectEvent(defender, attacker, amount, targetType = "body") {
    if (!defender || !attacker) return;
    if (!Array.isArray(this.pendingFafnirReflectEvents)) {
      this.pendingFafnirReflectEvents = [];
    }
    this.pendingFafnirReflectEvents.push({
      defender,
      attacker,
      amount: Math.max(0, Number(amount ?? 0)),
      targetType,
    });
  }

  flushFafnirReflectEventsFor(defender) {
    if (!defender || !Array.isArray(this.pendingFafnirReflectEvents) || this.pendingFafnirReflectEvents.length <= 0) return;

    const events = [];
    const remaining = [];
    for (const event of this.pendingFafnirReflectEvents) {
      if (event?.defender === defender) events.push(event);
      else remaining.push(event);
    }
    this.pendingFafnirReflectEvents = remaining;

    for (const event of events) {
      const attacker = event?.attacker;
      if (!attacker) continue;
      const reflected = Math.max(0, Number(event.amount ?? 0));
      const reflectedTargetType = event.targetType || this.getDamageTargetType(attacker);
      this.sendSkillEffectEvent(attacker, "summoner_fafnir_target", reflectedTargetType);
      this.sendBattle(`ファフニールの反射！ ${attacker.name} に ${reflected} ダメージ！`);
      this.sendDamageEvent(attacker, reflected, "pursuit", reflectedTargetType, {
        show_zero: true,
        action_source: "summoner_fafnir_reflect",
      });
    }
  }

  getDamageTargetType(player) {
    return player?.doll && !player.doll.is_broken ? "doll" : "body";
  }

  hasEquippedDojoSpecialEffect(player, effect) {
    const equips = [
      player?.special_equipment,
      ...(Array.isArray(player?.extra_special_equipments) ? player.extra_special_equipments : [])
    ];
    return equips.some(eq => eq?.dojo_special_effect === effect);
  }

  applyDojoMuramasaDrain(actor, amount) {
    const damage = Math.max(0, Number(amount ?? 0));
    if (damage <= 0 || !this.hasEquippedDojoSpecialEffect(actor, "muramasa")) return 0;
    const healAmount = Math.floor(damage / 10);
    if (healAmount <= 0) return 0;
    const healed = actor?.restore_hp?.(healAmount) ?? 0;
    if (healed > 0) {
      this.sendHealEvent(actor, healed);
      this.sendBattle(`ムラサメ：${actor.name} は ${healed} 回復した。`);
    }
    return healed;
  }

  applyDojoDurandalCounter(defender, attacker, receivedAmount) {
    const damageTaken = Math.max(0, Number(receivedAmount ?? 0));
    if (damageTaken <= 0 || !defender || !attacker) return 0;
    if (defender === attacker || Number(defender.hp ?? 0) <= 0) return 0;
    if (!this.hasEquippedDojoSpecialEffect(defender, "durandal")) return 0;

    const attack = Math.max(0, Number(defender.get_total_attack?.() ?? defender.attack ?? 0));
    const defense = Math.max(0, Number(defender.get_total_defense?.() ?? defender.defense ?? 0));
    const counterDamage = Math.max(1, Math.floor((attack + defense) / 2));
    const targetType = this.getDamageTargetType(attacker);
    const dealt = attacker.take_damage(counterDamage, true, defender);
    this.sendBattle(`デュランダル：${defender.name} の反撃！ ${dealt}ダメージ！`);
    this.sendDamageEvent(attacker, dealt, "pursuit", targetType, {
      show_zero: true,
      action_source: "durandal_counter",
    });
    this.applyDojoMuramasaDrain(defender, dealt);
    return dealt;
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
      warrior_4: [bodySelfEvent("warrior_4_self"), targetEvent("warrior_4_target")],
      warrior_5: [targetEvent("warrior_5_target")],
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
      summoner_1: [bodySelfEvent("summoner_1_self")],
      summoner_2: [bodySelfEvent("summoner_2_self")],
      summoner_3: [bodySelfEvent("summoner_3_self"), targetEvent("summoner_3_target")],
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

  sendSkillEffectEventList(events = []) {
    for (const event of events) {
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
      amount,
      status_patch: this.buildLiveStatusPatch(targetPlayer),
    });

    safeSend(this.p2, {
      type: "heal_event",
      target: resolveTarget(!isTargetP1, targetType),
      amount,
      status_patch: this.buildLiveStatusPatch(targetPlayer),
    });
  }

  sendShikigamiSummonEvent(player, names = []) {
    if (!Array.isArray(names) || names.length === 0) return;

    const isP1 = player === this.P1;
    const targetPlayer = isP1 ? this.P2 : this.P1;
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

    for (const name of names) {
      const detail = this.getShikigamiEffectLog(player, targetPlayer, name);
      if (detail) this.sendSkill(detail);
    }
  }

  getShikigamiEffectLog(player, targetPlayer, name) {
    const actorName = player?.name ?? "陰陽師";
    const targetName = targetPlayer?.name ?? "相手";
    const selfName = player?.name ?? "自分";

    if (name === "鬼火") {
      return `🕯 ${actorName} は式神「鬼火」を召喚。${targetName}に鬼火を付与：お互いのターン終了時に5ダメージ（3T）`;
    }
    if (name === "猫又") {
      return `🐈‍⬛ ${actorName} は式神「猫又」を召喚。${targetName}にスキル封印を付与（3T）`;
    }
    if (name === "玄武") {
      return `🐢 ${actorName} は式神「玄武」を召喚。${selfName}に防御力+5（3T）と攻撃無効バリア1回を付与`;
    }
    if (name === "烏天狗") {
      return `🐦 ${actorName} は式神「烏天狗」を召喚。${selfName}に追撃効果を付与：攻撃/スキル時に追加攻撃（残り3回）`;
    }
    if (name === "九尾") {
      return `🦊 ${actorName} は式神「九尾」を召喚。${targetName}に防御無視30ダメージ、装備破壊、バフ解除を発動`;
    }
    if (name === "白龍") {
      return `🐉 ${actorName} は式神「白龍」を召喚。${selfName}のHPを30＋防御力分回復し、デバフを解除`;
    }
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
      status_patch: this.buildLiveStatusPatch(player),
    });
    safeSend(this.p2, {
      type: "buff_visual_event",
      side: isP1 ? "enemy" : "self",
      buffs_ui,
      sfx_list,
      status_patch: this.buildLiveStatusPatch(player),
    });
  }



  sendError(msg, ws = null) {
    msg = this.normalizeLogMessage(msg);
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

  sendThiefStealPopup(actor) {
    const result = actor?.last_thief_steal_result;
    if (!result) return;

    if (result.success) {
      const sourceName = result.source === "shop"
        ? "ショップ"
        : (result.sourceName ?? "相手");
      const itemKind = result.itemKind ?? "持ち物";
      const itemName = result.itemName ?? "不明な持ち物";
      this.sendPopup(`${actor.name} が ${sourceName} から${itemKind}「${itemName}」を盗んだ！`, null, 3000);
    } else {
      this.sendPopup(`${actor.name} は盗みを試みたが、盗める物がなかった！`, null, 2400);
    }

    actor.last_thief_steal_result = null;
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
            desc: `${level}Tの間、人形が追加で1回攻撃する`,
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
            desc: "3Tの間、人形が追加で2回攻撃する",
            level,
            progress_now: progressNow,
            progress_need: progressNeed,
            progress_text: progressText,
            progress_is_max: isMaxLevel,
          };
        }
        return {
          title: "追加攻撃 Lv5",
          desc: "追加攻撃が防御無視で永続化し、3Tの間さらに2回追加攻撃する",
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
    if (this.cpuSimLog && actor?.job === "人形使い") {
      const enemy = actor.opponent;
      this.cpuSimLog.push({
        turn: Number(actor.turn_count ?? 0),
        phase: "doll_charge_choice",
        actor: actor.job,
        aiLevel: actor.cpu_ai_level ?? null,
        aiStyle: actor.cpu_ai_style ?? null,
        action: "doll_charge_choice",
        skill: null,
        choice: key,
        part: actor._last_doll_charge_choice_part ?? null,
        chargeLevel: Number(this.getDollChargeBuffState(actor, key).level ?? 1),
        dollDurability: Number(actor.doll?.durability ?? 0),
        dollMaxDurability: Number(actor.doll?.max_durability ?? 0),
        dollRampage: !!actor.doll?.is_rampage,
        rampageRounds: Number(actor.doll?.rampage_rounds ?? 0),
        hp: Number(actor.hp ?? 0),
        enemyHp: Number(enemy?.hp ?? 0),
      });
      actor._last_doll_charge_choice_part = null;
    }
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
      const picked = pickCpuDollChargeChoice(actor, actor.pending_doll_charge_choices);
      if (picked?.key === "costume_boost") {
        return this.resolveDollChargeChoice(wsPlayer, actor, picked.key, pickCpuDollChargePart(actor));
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
    actor._last_doll_charge_choice_part = part ?? null;

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
            return this.resolveDollChargeChoice(wsPlayer, actor, key, pickCpuDollChargePart(actor));
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
        ? "⚡ 追加攻撃が防御無視で永続化し、3Tの間さらに2回追加攻撃する！"
        : `⚡ ${totalRounds}Tの間、人形が追加で ${attacksPerTurn} 回攻撃する！`;
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
    if (this.started || this.ended) return;
    this.started = true;

    this.sendSystem("🎮 バトル開始！");

    // ★ プレイヤー職業をクライアントへ送信
    safeSend(this.p1, { type: "job_info", job: this.P1.job });
    safeSend(this.p2, { type: "job_info", job: this.P2.job });

    this.updateHP();

  // ★ 弓兵：初期矢を server 側で装備（状態決定はここだけ）
  for (const P of [this.P1, this.P2]) {
    if (P.job === "弓兵" && !P.arrow) {
      P.arrow = createArrowItem(ARROW_DATA.normal, ARCHER_START_ARROW_COUNT);
    }
  }

    // ★ 先攻1ターン目用：ショップを事前生成
    if (this.matchType === "tutorial") {
      this.P1.shop_items = createTutorialShopList();
      this.P2.shop_items = [];
    } else {
      this.P1.shop_items = this.generateShopList(this.P1);
      this.P2.shop_items = this.generateShopList(this.P2);
    }

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
    const actorTurnCount = this.incrementPlayerTurnCount(actorWS);

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

    const battleTurn = actorTurnCount;
    if (battleTurn >= 30) {
      if (!this.suddenDeathAnnounced) {
        this.suddenDeathAnnounced = true;
        const warningText = "⚠ サドンデスモードに突入！以降、自分のターン開始時に防御無視ダメージを受けます";
        this.sendSystem(warningText);
        this.sendBattle(warningText);
        this.sendPopup(warningText, null, 3600, "boom");
      }
      const suddenDamage = 10 + Math.max(0, battleTurn - 30);
      actor.sudden_death_debuff = {
        power: suddenDamage,
        turn: battleTurn,
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
      const passiveHeal = 1;
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
    // 自己バフ：自分のターン開始時に減少
    // ===============================
    if (actor.decrease_buffs_start_of_round) {
      actor.decrease_buffs_start_of_round();
    }
    this.decrementArcherTurnStartBuffs(actor);

    // ▼ コイン配布（達人への道では戦闘中配布しない）
    const skipOpeningCoinPayout = this.round === 1 && actorTurnCount === 1;
    if (this.matchType !== "dojo" && !skipOpeningCoinPayout) {
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

    if (this.matchType === "dojo" && Number(actor.dojo_invincible_rounds ?? 0) > 0) {
      actor.dojo_invincible_rounds = Math.max(0, Number(actor.dojo_invincible_rounds ?? 0) - 1);
      if (Number(actor.dojo_invincible_rounds ?? 0) <= 0) {
        this.sendSystem(`🛡 ${actor.name} の無敵効果が終了しました`);
      }
    }

    if (this.matchType === "dojo" && actor.dojo_attack_growth_active) {
      const growth = Math.max(1, Number(actor.dojo_attack_growth_per_round ?? 2));
      actor.base_attack = Number(actor.base_attack ?? actor.attack ?? 0) + growth;
      actor.attack = Number(actor.attack ?? actor.base_attack ?? 0) + growth;
      this.sendBattle(`成長の戦薬：${actor.name} の攻撃力が ${growth} 上がった！`);
      this.sendStatusInfo(actorWS, actor);
      this.sendSimpleStatusBoth();
    }

    const healed = actor.hp - beforeHp;
    if (healed > 0) {
      this.sendHealEvent(actor, healed);
    }


    // ================================
    // ★ 人形使い：暴走ターン進行（ターン開始時）
    // ================================
    if (
      actor.job === "人形使い" &&
      actor.doll &&
      actor.doll.is_rampage
    ) {
      actor.doll.rampage_rounds -= 1;

      this.sendSystem(
        `🔥 人形は暴走中… 残り T`
      );

      // --- 経過 → 自爆 ---
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
    // ★ 人形使い：耐久リジェネ（ターン開始時）
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

    // ▼ ターン情報送信
    this.sendRoundInfo();
    if (actor.job === "人形使い" && actor.doll && actor.doll.pending_charge_ready) {
      this.sendStatusInfo(actorWS, actor);
      this.sendSimpleStatusBoth();
    }

    this.scheduleCpuTurn(450);
  }

  scheduleCpuTurn(delayMs = 450) {
    if (!this.started || this.ended || !this.current?.isBot) return;
    if (this.simulate) return;
    if (this._cpuTurnTimer) return;

    this._cpuTurnTimer = setTimeout(() => {
      this._cpuTurnTimer = null;
      if (this.ended || !this.current?.isBot) return;

      const recoverCpuTurn = (err, label = "turn failed") => {
        if (err) console.error(`[CPU] ${label}`, err);
        this._cpuThinking = false;
        this._cpuThinkingAt = 0;

        if (this.ended || !this.current?.isBot) return;
        cpuConsumeTurnAction(this, this.current).catch(fallbackErr => {
          console.error("[CPU] fallback action failed", fallbackErr);
        });
      };

      Promise.resolve(maybeCpuTurn(this))
        .then(() => {
          if (this.ended || !this.current?.isBot || this._cpuThinking) return;
          return cpuConsumeTurnAction(this, this.current);
        })
        .catch(err => recoverCpuTurn(err));
    }, Math.max(0, Number(delayMs) || 0));
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
            effect_text: "人形の耐久を20回復。ボロボロ衣装があれば1つ修復"
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
          entry = createArrowItem(ARROW_DATA[k], ARROW_SHOP_SET_COUNT);
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

    if (P.job === "召喚士") {
      const owned = getSummonerOwnedTypes(P);
      const eggEntries = shuffleCopy(SUMMONER_DRAGON_TYPES.filter(type => !owned.has(type)))
        .slice(0, 3)
        .map(type => createSummonerEggItem(type))
        .filter(Boolean)
        .map(item => ({ ...item, is_summoner_shop: true, shop_slot_kind: "summoner_egg" }));
      const feedEntry = {
        ...createSummonerFeedItem(),
        is_summoner_shop: true,
        shop_slot_kind: "summoner_feed",
      };
      return [...normalized, ...eggEntries, feedEntry];
    }

    return normalized;
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

    if (item.is_summoner_egg) {
      if (P.job !== "召喚士") {
        this.sendError("❌ 召喚士専用の商品です。", wsPlayer);
        return;
      }
      const dragonType = String(item.summoner_dragon_type ?? "");
      if (!SUMMONER_DRAGON_DATA[dragonType]) {
        this.sendError("❌ 不正な竜の卵です。", wsPlayer);
        return;
      }
      if (getSummonerDragon(P, dragonType)) {
        this.sendPopup("この竜はすでに契約済みです。", wsPlayer, 2200);
        this.sendError("❌ この竜はすでに契約済みです。", wsPlayer);
        return;
      }
    }

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
    let purchasedItem = item;
    if (item.is_summoner_egg && P.job === "召喚士") {
        const added = addSummonerEgg(P, item.summoner_dragon_type);
        if (!added?.ok) {
          P.coins += price;
          this.sendPopup(added?.reason ?? "竜の卵を取得できません。", wsPlayer, 2200);
          this.sendError(`❌ ${added?.reason ?? "竜の卵を取得できません。"}`, wsPlayer);
          return;
        }
        purchasedItem = {
          ...item,
          summoner_dragon: added.dragon,
          summoner: buildSummonerStatus(P),
        };
        this.sendStatusInfo(wsPlayer, P);
        this.sendSimpleStatusBoth();
    } else if (item.is_summoner_feed) {
        P.items.push(item);

    } else if (isArrowItem(item)) {
        // 矢
        const arrowAdd = addArrowToPlayerStack(P, item, { includeEquipped: true });
        purchasedItem = {
          ...arrowAdd.item,
          is_equipped_special: arrowAdd.target === "equipped",
          purchased_merge_target: arrowAdd.target,
        };

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
      items: P.shop_items.map(it => applyDojoNormalItemEffectBonusForPlayer(P, it))
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
      item: purchasedItem,
    });

    this.sendSystem(`🛒 ${P.name} は ${item.name} を購入した！`);

    // ★ 購入ポップアップ（購入者のみ）
    this.sendPopup(`${item.name} を購入しました`, wsPlayer, 2200);

    // ★ ターンは終了しない
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

    if (star1 >= NORMAL_EQUIP_MAX_STAR) {
      this.sendError(`❌ 装備合成の最大レベルは${NORMAL_EQUIP_MAX_STAR}です。`, wsPlayer);
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
      items: actor.shop_items.map(it => applyDojoNormalItemEffectBonusForPlayer(actor, it))
    });

    // ★★★ これが本命 ★★★
    this.sendSimpleStatusBoth();
  }


  // --------------------------------------------------------
  // ★ アイテム / 装備 / 特殊装備 / 矢 使用（完全移植版）
  // --------------------------------------------------------
  useItem(wsPlayer, uid, action, slot = 1) {
      const P = (wsPlayer === this.p1 ? this.P1 : this.P2);
      normalizePlayerArrowStorage(P);
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
        if (destination === "arrow_inventory" && isArrowItem(item)) {
          addArrowToPlayerStack(P, item, { includeEquipped: false });
        } else {
          P[destination].push(item);
        }
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

    if (!item && action === "arrow") {
      if (P.arrow && String(P.arrow.uid ?? "") === String(uid ?? "")) {
        item = P.arrow;
        source = "equipped_arrow";
      } else if (P.arrow2 && String(P.arrow2.uid ?? "") === String(uid ?? "")) {
        item = P.arrow2;
        source = "equipped_arrow2";
      }
    }

    if (!item) {
      // ★ 使用回数が尽きた/既に消費済み等
      this.sendPopup("アイテムの使用回数がなくなりました", wsPlayer, 2500);
      this.sendError("❌ アイテムが見つかりません。", wsPlayer);
      this.sendItemList(wsPlayer, P);
      return;
    }

    if (action === "use" && item.is_summoner_feed) {
      if (P.job !== "召喚士") {
        this.sendPopup("召喚士専用アイテムです", wsPlayer, 2500);
        this.sendError("❌ 召喚士専用アイテムです。", wsPlayer);
        return;
      }
      if (P.item_use_count == null) P.item_use_count = 0;
      if (P.item_use_count >= 2) {
        this.sendPopup("このターンのアイテム使用回数がなくなりました", wsPlayer, 2500);
        this.sendError("1ターンに使用できるアイテムは2つまでです。", wsPlayer);
        this.sendItemList(wsPlayer, P);
        return;
      }
      const result = applySummonerFeed(P, slot);
      if (!result?.ok) {
        this.sendPopup(result?.reason ?? "竜の餌を使用できません。", wsPlayer, 2500);
        this.sendError(`❌ ${result?.reason ?? "竜の餌を使用できません。"}`, wsPlayer);
        this.sendItemList(wsPlayer, P);
        return;
      }
      P.item_use_count += 1;
      applyDojoTrailItemUseBonuses(wsPlayer, this, item);
      P[source] = P[source].filter(x => x.uid !== uid);
      const message = result.message ?? `${result.dragon?.name ?? "竜"}に餌を与えた。`;
      this.sendBattle(`🍖 ${P.name} は ${message}`);
      this.sendPopup(message, wsPlayer, 2200);
      this.sendSkillEffectEvent(P, "summoner_2_self", "body");
      this.sendItemList(wsPlayer, P);
      this.sendStatusInfo(wsPlayer, P);
      this.sendSimpleStatusBoth();
      return;
    }


    // ============================
    // 0) 矢装備（slot 指定対応・即時UI更新）
    // ============================
    if (action === "arrow" && isArrowItem(item)) {
        const targetSlot = getPlayerArrowSlotKey(slot);
        if (!targetSlot) {
            this.sendError("❌ 不正な矢スロット指定です。", wsPlayer);
            return;
        }
        if (targetSlot === "arrow2" && P.arrow_slots < 2) {
            this.sendError("❌ 矢スロット2は解放されていません。", wsPlayer);
            return;
        }

        const sourceSlot =
            source === "equipped_arrow" ? "arrow" :
            source === "equipped_arrow2" ? "arrow2" :
            "";
        let prevEquipped = P[targetSlot] ?? null;
        let equippedItem = item;
        let splitEquipped = false;

        if (sourceSlot) {
            this.sendPopup("装備中の矢は一度外してから付け替えてください", wsPlayer, 2200);
            this.sendItemList(wsPlayer, P);
            return;
        }

        const itemKey = getArrowStackKey(item);
        const sameEquippedSlot = ["arrow", "arrow2"].find(slotKey =>
          P[slotKey] && getArrowStackKey(P[slotKey]) === itemKey
        );

        if (sameEquippedSlot) {
            mergeArrowAmmo(P[sameEquippedSlot], item);
            P[source] = P[source].filter(x => x.uid !== uid);
            normalizePlayerArrowStorage(P);
            this.sendBattle(`${item.name} を装備中の矢にまとめた！`);
            this.sendPopup(`${item.name} を装備中の矢にまとめた！`, wsPlayer, 2000);
            this.sendItemList(wsPlayer, P);
            this.sendStatusInfo(wsPlayer, P);
            this.sendSimpleStatusBoth();
            return;
        }

        if (sourceSlot) {
            if (sourceSlot === targetSlot) {
                this.sendPopup(`${item.name} はすでにそのスロットに装備中です`, wsPlayer, 1600);
                this.sendItemList(wsPlayer, P);
                return;
            }

            if (!prevEquipped && getArrowAmmoCount(item) > 1) {
                const splitCount = Math.max(1, Math.floor(getArrowAmmoCount(item) / 2));
                setArrowAmmoCount(item, getArrowAmmoCount(item) - splitCount);
                equippedItem = cloneArrowStack(item, splitCount);
                P[targetSlot] = equippedItem;
                splitEquipped = true;
            } else {
                P[targetSlot] = item;
                P[sourceSlot] = prevEquipped;
            }
        } else {
            if (prevEquipped) {
                addArrowToPlayerStack(P, prevEquipped, { includeEquipped: false });
            }
            P[targetSlot] = item;
            P[source] = P[source].filter(x => x.uid !== uid);
        }

        normalizePlayerArrowStorage(P);

        if (splitEquipped) {
            this.sendBattle(`${item.name} を別スロットに分けて装備した！`);
            this.sendPopup(`${item.name} を別スロットに分けて装備した！`, wsPlayer, 2000);
        } else if (prevEquipped) {
            this.sendBattle(`${prevEquipped.name} と ${equippedItem.name} を付け替えた！`);
            this.sendPopup(`${prevEquipped.name} と ${equippedItem.name} を付け替えた！`, wsPlayer, 2000);
        } else {
            this.sendBattle(`${equippedItem.name} を装備した！`);
            this.sendPopup(`${equippedItem.name} を装備した！`, wsPlayer, 2000);
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
        if (!P.doll) {
            this.sendError("❌ 人形が存在しません。", wsPlayer);
            return;
        }
        if (typeof P.useDollRepairKit !== "function") {
            this.sendError("❌ 修理キットを使用できません。", wsPlayer);
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
        const repairResult = P.useDollRepairKit(slot);
        if (!repairResult?.ok) {
            this.sendError("❌ 修理キットを使用できません。", wsPlayer);
            return;
        }
        P.item_use_count += 1;
        applyDojoTrailItemUseBonuses(wsPlayer, this, item);

        this.sendBattle(`${item.name} を使用した！`);
        this.sendPopup(`${item.name} を使用した！`, wsPlayer, 2000);

        this.sendSystem(`🔧 人形耐久 ${repairResult.beforeDurability} → ${repairResult.afterDurability}`);
        if (repairResult.healed > 0) {
            this.sendHealEvent(P, repairResult.healed, "doll");
        }
        if (repairResult.repairedCostume) {
            const repaired = repairResult.repairedCostume;
            const msg = `🧵 ${repaired.label}の${repaired.name}を修復した！`;
            this.sendSystem(msg);
            this.sendPopup(msg, wsPlayer, 2400);
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
          message = `${item.name} を使用した！ 10Tの間、HPを1ずつ回復する`;
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

        const applyResult = P.apply_item(item);
        if (applyResult === false) {
          this.sendPopup("このアイテムは使用できません", wsPlayer, 2500);
          this.sendError("❌ このアイテムは使用できません。", wsPlayer);
          this.sendItemList(wsPlayer, P);
          return;
        }

        // 達人への道：万能の秘薬でアイテム効果が2回発動。
        if (P.dojoItemDoubleEffect === true) {
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

        // Buff SE is derived from the following status_simple update on the client.
        // Sending it here as well makes item buffs play the same SE twice.

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

      const itemUseMessage = P.last_item_message
        ? `${item.name} を使用した！ ${P.last_item_message}`
        : `${item.name} を使用した！`;
      P.last_item_message = "";
      this.sendBattle(itemUseMessage);
      this.sendPopup(itemUseMessage, wsPlayer, 2000);

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
      normalizePlayerArrowStorage(P);
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
          ...P.items.map(it => {
            const displayItem = applyDojoNormalItemEffectBonusForPlayer(P, it);
            return {
              uid: displayItem.uid,
              ...displayItem,
              category: "item"
            };
          }),
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
      special_defense: Math.max(0, Number(P.get_special_defense?.() ?? 0)),
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
      buffs: buildStatusInfoDescriptionList(P),

      // ===== 式神 =====
      shikigami: P.shikigami_effects?.map(s =>
        s.rounds !== undefined
          ? `${s.name}（残り${s.rounds}T）`
          : s.name
      ) ?? [],

      // ===== 人形（人形使い）=====
      doll: (P.job === "人形使い" && P.doll)
        ? {
            durability: P.doll.durability,
            max_durability: P.doll.max_durability,
            is_broken: P.doll.is_broken,
            is_rampage: !!P.doll.is_rampage,
            rampage_rounds: Number(P.doll.rampage_rounds ?? 0),
            charge: Number(P.doll.charge ?? 0),
            attack: P.doll.is_broken ? 0 : P.getDollAttack(),
            defense: P.getDollDefense(),
            costumes: P.doll.costumes ?? {}
          }
        : null,
      summoner: buildSummonerStatus(P)
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
        special_defense: Math.max(0, Number(self.get_special_defense?.() ?? 0)),
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
      archer_buff: getArcherExtraBuffSummary(self),
      archer_buffs: getArcherExtraBuffEntries(self),
      archer_no_consume_rounds: self.archer_no_consume_rounds ?? 0,
      archer_no_consume_permanent: !!self.archer_no_consume_permanent,
      archer_pierce_rounds: self.archer_pierce_rounds ?? (self.archer_next_pierce ? 1 : 0),
      skill_sealed: isPlayerSkillSealed(self),
      skill_sealed_turns: getSkillSealTurnsForStatus(self),
      skill_sealed_rounds: getSkillSealTurnsForStatus(self),

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
              is_rampage: !!self.doll.is_rampage,
              rampage_rounds: Number(self.doll.rampage_rounds ?? 0),
              charge: Number(self.doll.charge ?? 0),
              charge_need: DOLL_CHARGE_COST,
              pending_charge_ready: !!self.doll.pending_charge_ready,
              attack: self.doll.is_broken ? 0 : self.getDollAttack(),
              defense: self.getDollDefense(),
              costumes: self.doll.costumes ?? {},
            }
          : null,
        summoner: buildSummonerStatus(self),

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
        special_defense: Math.max(0, Number(enemy.get_special_defense?.() ?? 0)),
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
      archer_buff: getArcherExtraBuffSummary(enemy),
      archer_buffs: getArcherExtraBuffEntries(enemy),
      archer_no_consume_rounds: enemy.archer_no_consume_rounds ?? 0,
      archer_no_consume_permanent: !!enemy.archer_no_consume_permanent,
      archer_pierce_rounds: enemy.archer_pierce_rounds ?? (enemy.archer_next_pierce ? 1 : 0),
      skill_sealed: isPlayerSkillSealed(enemy),
      skill_sealed_turns: getSkillSealTurnsForStatus(enemy),
      skill_sealed_rounds: getSkillSealTurnsForStatus(enemy),

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
              is_rampage: !!enemy.doll.is_rampage,
              rampage_rounds: Number(enemy.doll.rampage_rounds ?? 0),
              charge: Number(enemy.doll.charge ?? 0),
              charge_need: DOLL_CHARGE_COST,
              pending_charge_ready: !!enemy.doll.pending_charge_ready,
              attack: enemy.doll.is_broken ? 0 : enemy.getDollAttack(),
              defense: enemy.getDollDefense(),
              costumes: enemy.doll.costumes ?? {},
            }
          : null,
        summoner: buildSummonerStatus(enemy),

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
    ターン開始通知
    ========================================================= */
  sendRoundInfo() {

    if (this.ended) return;
    const actorTurn = this.getPlayerTurnCount(this.current);
    const enemyTurn = this.getPlayerTurnCount(this.enemy);

    // ---------------------------------
    // 手番表示
    // ---------------------------------
    safeSend(this.current, {
      type: "your_turn",
      msg: `▶ あなたのターン（${actorTurn}T）`,
      self_turn: actorTurn,
      enemy_turn: enemyTurn,
      actor_turn: actorTurn
    });

    safeSend(this.enemy, {
      type: "wait_turn",
      msg: `⏳ 相手のターン（相手${actorTurn}T）`,
      self_turn: enemyTurn,
      enemy_turn: actorTurn,
      actor_turn: actorTurn
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
    for (let i = 0; i < hits && target.hp > 0 && actor.hp > 0; i += 1) {
      const raw = Math.max(1, Math.floor(Number(actor.getActualAttack?.() ?? actor.get_total_attack()) * multiplier));
      const targetType = this.getDamageTargetType(target);
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
      this.sendDamageEvent(target, dealt, kind, targetType, {
        show_zero: true,
        sequence_index: i,
        sequence_total: hits,
      });
      this.applyDojoDurandalCounter(target, actor, dealt);
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
        desc = "1Tの間、防御力を3倍にする。";
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
      else if (action === "c") {
        title = "こそ泥";
        const stolen = stealDojoGoblinItem(target);
        if (stolen) {
          desc = `${stolen.sourceName ?? target.name ?? "相手"} から${stolen.itemKind ?? "持ち物"}「${stolen.itemName ?? "持ち物"}」を盗んだ！`;
          logs = [`${actor.name} は ${desc}`];
        } else {
          desc = "盗める物がなかった！";
          logs = [`${actor.name} は盗みを試みたが、盗める物がなかった！`];
        }
      }
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
      if (action === "a") { title = "毒胞子"; desc = "毒で継続ダメージを与える。"; const poisonPower = 4 + Math.floor(Number(actor.dojoStage ?? 1) / 8); dojoAddPoison(target, poisonPower, 3, "毒"); logs = [`${target.name} は毒胞子を受けた！ お互いのターン終了時に${poisonPower}ダメージ（3T）`]; }
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
    if (actor.hp <= 0) {
      const winnerKey = actor === this.P1 ? "p2" : "p1";
      this.finishBattle(winnerKey);
      return true;
    }
    if (target.hp <= 0) {
      const winnerKey = actor === this.P1 ? "p1" : "p2";
      this.finishBattle(winnerKey);
      return true;
    }
    this.endRound();
    return true;
  }

  requestSummonerSkill1Choices(ws, actor) {
    if (ws !== this.current) {
      this.sendError("❌ 今はあなたのターンではありません。", ws);
      return false;
    }
    if (!isSummonerPlayer(actor)) {
      this.sendError("❌ 召喚士専用スキルです。", ws);
      return false;
    }
    const choices = getSummonerEggChoices(actor);
    if (!choices.length) {
      this.sendPopup("契約できる竜の卵がありません。", ws, 2400);
      this.sendError("❌ 契約できる竜の卵がありません。", ws);
      return false;
    }
    safeSend(ws, { type: "summoner_skill1_choices", choices });
    return true;
  }

  requestSummonerSkill2Choices(ws, actor) {
    if (ws !== this.current) {
      this.sendError("❌ 今はあなたのターンではありません。", ws);
      return false;
    }
    if (!isSummonerPlayer(actor)) {
      this.sendError("❌ 召喚士専用スキルです。", ws);
      return false;
    }
    const choices = getSummonerGrowthTargets(actor);
    if (!choices.length) {
      this.sendPopup("成長させられる卵/竜がいません。", ws, 2400);
      this.sendError("❌ 成長させられる卵/竜がいません。", ws);
      return false;
    }
    safeSend(ws, { type: "summoner_skill2_choices", choices });
    return true;
  }

  switchSummonerFront(ws, actor, type) {
    if (!isSummonerPlayer(actor)) return false;
    if (ws !== this.current) {
      this.sendError("❌ 竜の切り替えは自分のターンのみ可能です。", ws);
      return false;
    }
    const dragon = getSummonerDragon(actor, type);
    if (!dragon || dragon.stage === "egg") {
      this.sendPopup("前衛に出せる竜ではありません。", ws, 2200);
      this.sendError("❌ 前衛に出せる竜ではありません。", ws);
      return false;
    }
    const state = ensureSummonerState(actor);
    state.front = dragon.type;
    this.sendBuffVisualEvent(actor);
    this.sendBattle(`${actor.name} は前衛竜を ${dragon.name} に切り替えた。`);
    this.sendStatusInfo(ws, actor);
    this.sendSimpleStatusBoth();
    return true;
  }

  getSummonerEffectEntries(actor, { forceAllFront = false } = {}) {
    const state = ensureSummonerState(actor);
    if (!state) return [];
    normalizeSummonerFront(actor);
    const resonance = forceAllFront || Number(state.resonance_turns ?? 0) > 0;
    return (state.dragons ?? [])
      .filter(dragon => dragon && dragon.stage !== "egg")
      .map(dragon => ({
        dragon,
        role: resonance || String(state.front ?? "") === String(dragon.type ?? "") ? "front" : "back",
      }));
  }

  getSummonerTiamatDamage(dragon, role) {
    if (!dragon || dragon.type !== "tiamat") return 0;
    if (dragon.stage === "adult") return role === "front" ? 18 : 8;
    if (dragon.stage === "juvenile") return role === "front" ? 10 : 5;
    return 0;
  }

  getSummonerTiamatEffectiveDamage(target, dragon, role) {
    const damage = this.getSummonerTiamatDamage(dragon, role);
    if (damage <= 0) return 0;
    if (dragon?.stage !== "juvenile") return damage;
    const defense = Math.max(0, Number(target?.get_total_defense?.() ?? 0));
    return Math.max(0, damage - Math.floor(defense * 0.5));
  }

  applySummonerNidhoggEffect(actor, target, dragon, role) {
    if (!dragon || dragon.type !== "nidhogg" || dragon.stage === "egg") return false;
    let poisonPower = 0;
    let poisonTurns = 0;
    let atkDown = 0;
    let atkDownTurns = 0;
    if (dragon.stage === "adult" && role === "front") {
      poisonPower = 3;
      poisonTurns = 3;
      atkDown = 2;
      atkDownTurns = 3;
    } else if (dragon.stage === "adult") {
      poisonPower = 2;
      poisonTurns = 2;
    } else if (dragon.stage === "juvenile" && role === "front") {
      poisonPower = 2;
      poisonTurns = 2;
    } else {
      poisonPower = 1;
      poisonTurns = 2;
    }

    target.dot_effects ??= [];
    target.dot_effects.push({
      name: "毒",
      power: poisonPower,
      turns: poisonTurns,
      rounds: poisonTurns,
      source: "ニーズヘッグ",
      uid: crypto.randomUUID(),
    });

    if (atkDown > 0) {
      target.active_buffs ??= [];
      target.active_buffs.push({
        type: "攻撃力低下",
        power: atkDown,
        rounds: atkDownTurns,
        duration: atkDownTurns,
        source: "ニーズヘッグ",
        uid: crypto.randomUUID(),
        is_debuff: true,
      });
      this.sendBattle(`ニーズヘッグの呪毒！ ${target.name} に毒${poisonPower}（${poisonTurns}T）と攻撃力-${atkDown}（${atkDownTurns}T）`);
    } else {
      this.sendBattle(`ニーズヘッグの毒牙！ ${target.name} に毒${poisonPower}（${poisonTurns}T）`);
    }
    this.sendSkillEffectEvent(target, "summoner_nidhogg_target", this.getDamageTargetType(target));
    return true;
  }

  resolveSummonerAfterAction(actor, target, { forceAllFront = false } = {}) {
    if (!isSummonerPlayer(actor) || !target || target.hp <= 0 || actor.hp <= 0) return false;
    const entries = this.getSummonerEffectEntries(actor, { forceAllFront });
    let changed = false;

    for (const { dragon, role } of entries) {
      if (target.hp <= 0 || actor.hp <= 0) break;
      if (dragon.type === "tiamat") {
        const damage = this.getSummonerTiamatEffectiveDamage(target, dragon, role);
        if (damage > 0) {
          const targetType = this.getDamageTargetType(target);
          this.sendSkillEffectEvent(target, "summoner_tiamat_target", targetType);
          const dealt = target.take_damage(damage, true, actor, true);
          this.sendDamageEvent(target, dealt, "pursuit", targetType, {
            show_zero: true,
            action_source: "summoner_tiamat",
          });
          const pierceText = dragon.stage === "juvenile" ? "防御50%無視" : "防御無視";
          this.sendBattle(`ティアマトの追撃！ ${target.name} に${pierceText}${dealt}ダメージ！`);
          changed = true;
        }
      } else if (dragon.type === "nidhogg") {
        changed = this.applySummonerNidhoggEffect(actor, target, dragon, role) || changed;
      }
    }

    if (changed) {
      this.sendStatusInfo(actor === this.P1 ? this.p1 : this.p2, actor);
      this.sendStatusInfo(target === this.P1 ? this.p1 : this.p2, target);
      this.sendSimpleStatusBoth();
    }
    return changed;
  }

  progressSummonerTurnEnd(actor) {
    const state = ensureSummonerState(actor);
    if (!state) return false;
    let changed = false;
    normalizeSummonerFront(actor);
    for (const dragon of state.dragons ?? []) {
      if (!dragon) continue;
      if (dragon.stage === "egg") {
        dragon.hatch_turns_remaining = Math.max(0, Number(dragon.hatch_turns_remaining ?? SUMMONER_HATCH_TURNS) - 1);
        changed = true;
        if (dragon.hatch_turns_remaining <= 0) {
          evolveSummonerDragon(actor, dragon, "juvenile");
          this.sendBattle(`${actor.name} の ${dragon.name} の卵が孵化した！`);
        }
      } else if (dragon.stage === "juvenile") {
        const isFront = String(state.front ?? "") === String(dragon.type ?? "");
        const add = isFront ? 2 : 1;
        dragon.growth = Math.min(SUMMONER_GROWTH_MAX, Number(dragon.growth ?? 0) + add);
        changed = true;
        if (dragon.growth >= SUMMONER_GROWTH_MAX) {
          evolveSummonerDragon(actor, dragon, "adult");
          this.sendBattle(`${actor.name} の ${dragon.name} が成体へ成長した！`);
        }
      }
    }
    if (Number(state.resonance_turns ?? 0) > 0) {
      state.resonance_turns = Math.max(0, Number(state.resonance_turns ?? 0) - 1);
      changed = true;
    }
    if (changed) this.sendSimpleStatusBoth();
    return changed;
  }

  performSummonerSkillAttack(actor, target) {
    const dmg = actor.getActualAttack();
    const targetType = this.getDamageTargetType(target);
    const dealt = target.take_damage(dmg, false, actor);
    this.sendDamageEvent(target, dealt, "normal", targetType, {
      show_zero: true,
      normal_attack: true,
      action_source: "summoner_skill3_attack",
    });
    if (dealt > 0) this.sendSfxEvent("attack");
    this.applyDojoMuramasaDrain(actor, dealt);
    this.applyDojoDurandalCounter(target, actor, dealt);
    this.sendBattle(`竜脈解放の一撃！ ${target.name} に ${dealt} ダメージ！`);
    return dealt;
  }

  async useSummonerSkill(wsPlayer, actor, target, num) {
    const stype = `summoner_${num}`;
    const skillDef = this.getSkillDefForActor(actor, stype, num);
    const requiredLevel = Number(skillDef?.min_level ?? num);
    if (actor.level < requiredLevel) {
      this.sendError(`❌ スキル${num} は Lv${requiredLevel} で解放されます！`, wsPlayer);
      this.skill_lock = false;
      return false;
    }
    if (isPlayerSkillSealed(actor)) {
      this.sendPopup(SKILL_SEALED_POPUP_MESSAGE, wsPlayer, 2600);
      this.sendError("❌ スキルは封印されている…！", wsPlayer);
      this.skill_lock = false;
      return false;
    }
    if (actor.used_skill_set?.has(stype)) {
      this.sendError("❌ このスキルはすでに使用済みです！", wsPlayer);
      this.skill_lock = false;
      return false;
    }

    if (num === 1) {
      const type = String(actor.pending_summoner_egg_type ?? "");
      const choices = getSummonerEggChoices(actor);
      let picked = choices.find(choice => choice.type === type);
      if (!picked && !wsPlayer?.isBot) {
        this.sendPopup("契約する卵を選び直してください。", wsPlayer, 2400);
        this.skill_lock = false;
        return false;
      }
      picked ??= choices[0];
      if (!picked) {
        this.sendPopup("契約できる竜の卵がありません。", wsPlayer, 2400);
        this.skill_lock = false;
        return false;
      }
      const result = addSummonerEgg(actor, picked.type);
      if (!result?.ok) {
        this.sendPopup(result?.reason ?? "竜の卵を取得できません。", wsPlayer, 2400);
        this.skill_lock = false;
        return false;
      }
      actor.pending_summoner_egg_type = null;
      actor.used_skill_set.add(stype);
      this.sendSkill(this.buildSkillActivationLog(actor, skillDef, stype, num));
      this.sendSkillEffectEvents(actor, target, stype);
      this.sendBattle(`${actor.name} は ${result.dragon.name} の卵と契約した。`);
      this.resolveSummonerAfterAction(actor, target);
    } else if (num === 2) {
      const requested = String(actor.pending_summoner_growth_type ?? "");
      const targets = getSummonerGrowthTargets(actor);
      let picked = targets.find(choice => choice.type === requested);
      if (!picked && !wsPlayer?.isBot) {
        this.sendPopup("成長させる卵/竜を選び直してください。", wsPlayer, 2400);
        this.skill_lock = false;
        return false;
      }
      picked ??= targets[0];
      if (!picked) {
        this.sendPopup("成長させられる卵/竜がいません。", wsPlayer, 2400);
        this.skill_lock = false;
        return false;
      }
      const result = advanceSummonerGrowthStage(actor, picked.type);
      if (!result?.ok) {
        this.sendPopup(result?.reason ?? "成長促進できません。", wsPlayer, 2400);
        this.skill_lock = false;
        return false;
      }
      actor.pending_summoner_growth_type = null;
      actor.used_skill_set.add(stype);
      this.sendSkill(this.buildSkillActivationLog(actor, skillDef, stype, num));
      this.sendSkillEffectEvents(actor, target, stype);
      this.sendBattle(`${actor.name} は ${result.dragon.name} を ${getSummonerStageLabel(result.dragon.stage)} へ成長させた。`);
      this.resolveSummonerAfterAction(actor, target);
    } else if (num === 3) {
      const state = ensureSummonerState(actor);
      if (!state || !state.dragons.some(dragon => dragon?.stage !== "egg")) {
        this.sendPopup("竜脈解放には孵化済みの竜が必要です。", wsPlayer, 2400);
        this.skill_lock = false;
        return false;
      }
      state.resonance_turns = 2;
      actor.used_skill_set.add(stype);
      this.sendSkill(this.buildSkillActivationLog(actor, skillDef, stype, num));
      this.sendSkillEffectEvents(actor, target, stype);
      this.performSummonerSkillAttack(actor, target);
      this.resolveSummonerAfterAction(actor, target, { forceAllFront: true });
    } else {
      this.sendError("❌ 未対応の召喚士スキルです。", wsPlayer);
      this.skill_lock = false;
      return false;
    }

    this.updateHP();
    this.sendItemList(wsPlayer, actor);
    this.sendStatusInfo(wsPlayer, actor);
    this.sendSimpleStatusBoth();

    this.skill_lock = false;
    if (actor.hp <= 0) {
      this.finishBattle(actor === this.P1 ? "p2" : "p1");
      return true;
    }
    if (target.hp <= 0) {
      this.finishBattle(actor === this.P1 ? "p1" : "p2");
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

    // 自分のターン以外は行動不可
    if (wsPlayer !== this.current) {
      this.sendError("❌ 今はあなたのターンではありません。", wsPlayer);
      return;
    }

    const actor = wsPlayer === this.p1 ? this.P1 : this.P2;
    const target = wsPlayer === this.p1 ? this.P2 : this.P1;

    if (this.matchType === "dojo" && actor.isDojoEnemy) {
      this.handleDojoEnemyAction(actor, target);
      return;
    }

    // ★ バフターン処理（正しい位置）
    if (actor.process_buffs) actor.process_buffs();

    if (action === "矢なしターン終了") {
      if (actor.job !== "弓兵") {
        this.sendError("❌ この行動は弓兵のみ使用できます。", wsPlayer);
        return;
      }
      if (actor.has_usable_arrow?.()) {
        this.sendError("❌ 矢が装備されています。攻撃またはスキルを選択してください。", wsPlayer);
        return;
      }
      this.sendBattle(`🏹 ${actor.name} は矢がないため行動を見送った。`);
      this.sendPopup("矢が装備されていないためターンを終了しました。", wsPlayer, 2200);
      this.sendItemList(wsPlayer, actor);
      this.sendSimpleStatusBoth();
      this.endRound();
      return;
    }

    /* ---------- 攻撃 ---------- */
    if (action === "攻撃") {

      // ★ 弓兵は矢攻撃を使用
      if (actor.job === "弓兵") {
        if (!this.resolveArcherArrowAttack(actor, target, wsPlayer)) return;

      } else {
        const dmg = actor.getActualAttack();
        const targetType = this.getDamageTargetType(target);
        const dealt = target.take_damage(dmg, false, actor);
        
      // ============================
      // ★ UI用：ダメージ演出送信
      // ============================
        this.sendDamageEvent(target, dealt, "normal", targetType, { show_zero: true, normal_attack: true });
        if (dealt > 0) {
          this.sendSfxEvent("attack");
        }
        this.applyDojoMuramasaDrain(actor, dealt);
        this.applyDojoDurandalCounter(target, actor, dealt);


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

          for (let i = 0; i < extraAttackCount && target.hp > 0 && actor.hp > 0; i += 1) {
            const extraDamage = actor.getActualAttack();
            const extraTargetType = this.getDamageTargetType(target);
            const extraDealt = target.take_damage(extraDamage, ignoreExtraDef, actor, true);
            this.sendDamageEvent(target, extraDealt, "pursuit", extraTargetType, {
              show_zero: true,
              sequence_index: i,
              sequence_total: extraAttackCount,
            });
            this.applyDojoMuramasaDrain(actor, extraDealt);
            this.applyDojoDurandalCounter(target, actor, extraDealt);
            this.sendBattle(`🪆 人形の追加攻撃！ ${extraDealt}ダメージ！`);
          }
        }


      }



      // ★ 烏天狗の追撃（内部トリガー基準）
      if (actor.hp > 0 && actor.karasu_tengu_triggers > 0) {
        const logs = actor.trigger_karasu_tengu(target) ?? [];
        logs.forEach((dmg2, index) => {
          if (actor.hp <= 0 || target.hp <= 0) return;
          this.sendSkill(`🐦 烏天狗の追撃！ ${dmg2}ダメージ！`);

          // ============================
          // ★ UI用：烏天狗追撃ダメージ演出
          // ============================
          this.sendDamageEvent(target, dmg2, "pursuit", this.getDamageTargetType(target), {
            show_zero: true,
            sequence_index: index,
            sequence_total: logs.length,
          });
          this.applyDojoMuramasaDrain(actor, dmg2);
          this.applyDojoDurandalCounter(target, actor, dmg2);

        });

      }

      this.resolveSummonerAfterAction(actor, target);



      this.updateHP();

      // 勝敗チェック
      if (actor.hp <= 0) {
        const winnerKey = actor === this.P1 ? "p2" : "p1";
        this.finishBattle(winnerKey);
        return;
      }
      if (target.hp <= 0) {
        const winnerKey = actor === this.P1 ? "p1" : "p2";
        this.finishBattle(winnerKey);
        return;
      }

      this.endRound();
      return;
    }

    /* ---------- スキル（失敗ならターン消費しない） ---------- */
    if (
      /^スキル[1-5]$/.test(String(action)) &&
      actor.job !== 9 &&
      Number(actor.job) !== 9
    ) {

      const num = Number(action.replace("スキル", ""));
      const success = await this.useSkill(wsPlayer, actor, target, num);

      // ★ 失敗なら：ここで終了（ターン交代しない・使用済みにもならない）
      if (!success) return;

      // 成功時のみ：勝敗チェックとターン終了は useSkill 内でやる（※下の修正版に合わせる）
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

      if (actor.job === "召喚士") {
        return await this.useSummonerSkill(wsPlayer, actor, target, num);
      }

      // ★ 人形使いは Player._use_doll_skill に直接委譲
      if (actor.job === "人形使い") {

        const stype = `doll_${num}`;
        const skillDef = this.getSkillDefForActor(actor, stype, num);

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
        this.sendSkill(this.buildSkillActivationLog(actor, skillDef, stype, num));
        
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
      "召喚士": "summoner",
      "狂人": "mad",
    }[job];

    const stype = `${prefix}_${num}`;
    const skillDef = this.getSkillDefForActor(actor, stype, num);

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

    if (actor.job === "戦士" && (stype === "warrior_4" || stype === "warrior_5") && this.matchType !== "dojo") {
      this.sendError("❌ スキル4・5は達人への道限定です。", wsPlayer);
      this.skill_lock = false;
      return false;
    }

    // -------- 1) レベルチェック（最優先） --------
    const requiredLevel = Number(skillDef?.min_level ?? num);
    if (actor.level < requiredLevel) {
      this.sendError(`❌ スキル${num} は Lv${requiredLevel} で解放されます！`, wsPlayer);
      this.skill_lock = false;
      return false;
    }

    const trailNodes = new Set((actor.dojoTrailNodes || []).map(Number));
    if (actor.job === "戦士" && stype === "warrior_4" && !trailNodes.has(55)) {
      this.sendError("❌ スキル4は右端の5個目の大軌跡で解放されます！", wsPlayer);
      this.skill_lock = false;
      return false;
    }
    if (actor.job === "戦士" && stype === "warrior_5" && !trailNodes.has(60)) {
      this.sendError("❌ スキル5は右端の10個目の大軌跡で解放されます！", wsPlayer);
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
    if (isPlayerSkillSealed(actor)) {
      this.sendPopup(SKILL_SEALED_POPUP_MESSAGE, wsPlayer, 2600);
      this.sendError("❌ スキルは封印されている…！", wsPlayer);
      this.skill_lock = false;
      return false;
    }

    if (
      actor.job === "弓兵" &&
      (stype === "archer_1" || stype === "archer_2" || stype === "archer_3") &&
      !actor.has_usable_arrow?.()
    ) {
      this.sendPopup("矢が装備されていないため攻撃できません。", wsPlayer, 2200);
      this.sendError("❌ 矢が装備されていないため攻撃できません。", wsPlayer);
      this.skill_lock = false;
      return false;
    }

    // -------- 4) スキル関数実行（★ async 対応が本体） --------
    const method = `_use_${prefix}_skill`;
    const fn = actor[method];

    if (!fn) {
      this.sendError(`❌ ${this.getSkillDisplayName(skillDef, stype, num)} はまだ実装されていません。`, wsPlayer);
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

    // Dojo special weapon: every skill hit pierces normal defense.
    const forcePierceSkill = !!actor.has_dojo_pierce_weapon?.();
    const originalTargetTakeDamage = target?.take_damage
      ? target.take_damage.bind(target)
      : null;
    const skillDamageRecords = [];
    if (originalTargetTakeDamage) {
      target.take_damage = (raw, ignoreDef = false, attacker = null, isExtraAttack = false) => {
        const targetType =
          target.job === "人形使い" &&
          target.doll &&
          !target.doll.is_broken
            ? "doll"
            : "body";
        const dealt = originalTargetTakeDamage(
          raw,
          forcePierceSkill ? true : ignoreDef,
          attacker ?? actor,
          isExtraAttack
        );
        const dealtAmount = Math.max(0, Number(dealt ?? 0));
        if (Number.isFinite(dealtAmount)) {
          skillDamageRecords.push({
            dealt: dealtAmount,
            targetType,
            statusPatch: this.buildLiveStatusPatch(target),
          });
        }
        return dealt;
      };
    }

    // ★ async / sync 両対応：Promise なら await する
    let ok;
    try {
      ok = fn.call(actor, stype, target);
      if (ok && typeof ok.then === "function") {
        ok = await ok;
      }
    } finally {
      if (originalTargetTakeDamage) {
        target.take_damage = originalTargetTakeDamage;
      }
    }

    if (!ok) {
      this.sendError(`❌ ${this.getSkillDisplayName(skillDef, stype, num)} は発動できませんでした。`, wsPlayer);
      this.skill_lock = false;
      return false; // ★ 失敗を返す（ターン消費させない）
    }
    this.sendSkill(this.buildSkillActivationLog(actor, skillDef, stype, num));

    const afterActorAttackBuff = Number(actor.get_attack_buff_total?.() ?? 0);
    const afterTargetAttackBuff = Number(target.get_attack_buff_total?.() ?? 0);
    const actorAttackBuffIncreased = afterActorAttackBuff > beforeActorAttackBuff;
    const attackBuffIncreased =
      actorAttackBuffIncreased ||
      afterTargetAttackBuff > beforeTargetAttackBuff;
    const afterActorDefBuff = Number(actor.get_def_buff_total?.() ?? 0) + Number(actor.barrier ?? 0);
    const afterTargetDefBuff = Number(target.get_def_buff_total?.() ?? 0) + Number(target.barrier ?? 0);
    const actorDefBuffIncreased = afterActorDefBuff > beforeActorDefBuff;
    const defBuffIncreased =
      actorDefBuffIncreased ||
      afterTargetDefBuff > beforeTargetDefBuff;
    const hasSkillDamage =
      skillDamageRecords.length > 0 ||
      beforeHpActor > actor.hp ||
      beforeHpTarget > target.hp ||
      (beforeDollTarget != null &&
        target.doll &&
        Number(beforeDollTarget) > Number(target.doll.durability ?? 0));
    const dojoSkillDamageBonus =
      this.matchType === "dojo" &&
      actor.job === "戦士" &&
      String(stype).startsWith("warrior_")
        ? Math.max(0, Number(actor.get_dojo_skill_damage_bonus?.() ?? 0))
        : 0;
    if (hasSkillDamage && dojoSkillDamageBonus > 0) {
      this.sendSkill(`軌跡効果：戦士スキルダメージ +${dojoSkillDamageBonus}`);
      this.sendBattle(`軌跡効果で ${actor.name} の戦士スキルダメージ +${dojoSkillDamageBonus} が適用された。`);
    }
    const hasSelfBuffWithDamage = hasSkillDamage && (actorAttackBuffIncreased || actorDefBuffIncreased);
    const skillEffectEvents = this.getSkillEffectEvents(actor, target, stype, beforeHpActor);
    const selfSkillEffectEvents = skillEffectEvents.filter(event => event.player === actor);
    const attackSkillEffectEvents = skillEffectEvents.filter(event => event.player !== actor);

    if (hasSelfBuffWithDamage) {
      this.sendSkillEffectEventList(selfSkillEffectEvents);
    }
    if (hasSkillDamage && actorAttackBuffIncreased) {
      this.sendBuffVisualEvent(actor, "powerup");
    }
    if (hasSkillDamage && actorDefBuffIncreased) {
      this.sendBuffVisualEvent(actor, "defup");
    }

    if (hasSelfBuffWithDamage) {
      await wait(760);
      this.sendSkillEffectEventList(attackSkillEffectEvents);
    } else {
      this.sendSkillEffectEventList(skillEffectEvents);
    }

    // ============================
    // ★ ダメージイベント送信（スキル成功後に差分を見る）
    //   - 通常攻撃と同じ赤表示にするため kind は "normal"
    // ============================
    const damagedActor = beforeHpActor - actor.hp;
    if (damagedActor > 0) {
      this.sendDamageEvent(actor, damagedActor, "normal", "body");
    }

    const damagedTarget = beforeHpTarget - target.hp;
    if (skillDamageRecords.length > 0) {
      for (let index = 0; index < skillDamageRecords.length; index += 1) {
        const record = skillDamageRecords[index];
        this.sendDamageEvent(
          target,
          record.dealt,
          skillDamageRecords.length > 1 ? "pursuit" : "normal",
          record.targetType,
          {
            show_zero: true,
            sequence_index: index,
            sequence_total: skillDamageRecords.length,
            status_patch: record.statusPatch,
            ...(stype === "warrior_2" ? { hit_sfx: "warrior2" } : {}),
          }
        );
      }
    } else if (damagedTarget > 0) {
      this.sendDamageEvent(
        target,
        damagedTarget,
        "normal",
        "body",
        stype === "warrior_2" ? { hit_sfx: "warrior2" } : {}
      );
    }

    // 人形へのダメージ（HPが減らないケース）
    if (beforeDollTarget != null && target.doll) {
      const afterDollTarget = target.doll.durability ?? 0;
      const damagedDoll = beforeDollTarget - afterDollTarget;
      if (damagedDoll > 0) {
        const alreadySentRecordedDamage = skillDamageRecords.length > 0;
        const dollRecords = skillDamageRecords.filter(record => record.targetType === "doll");
        if (!alreadySentRecordedDamage && dollRecords.length > 0) {
          for (let index = 0; index < dollRecords.length; index += 1) {
            const record = dollRecords[index];
            this.sendDamageEvent(
              target,
              record.dealt,
              dollRecords.length > 1 ? "pursuit" : "normal",
              "doll",
              {
                sequence_index: index,
                sequence_total: dollRecords.length,
                status_patch: record.statusPatch,
              }
            );
          }
        } else if (!alreadySentRecordedDamage) {
          this.sendDamageEvent(target, damagedDoll, "normal", "doll");
        }
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

    if (skillDamageRecords.length > 0) {
      for (const record of skillDamageRecords) {
        this.applyDojoMuramasaDrain(actor, record?.dealt);
        this.applyDojoDurandalCounter(target, actor, record?.dealt);
      }
    } else {
      this.applyDojoMuramasaDrain(actor, damagedTarget);
      this.applyDojoDurandalCounter(target, actor, damagedTarget);
    }

    this.sendSkillResultSummary(actor, target, {
      skillDamageRecords,
      damagedActor,
      damagedTarget,
      healedActor,
      healedTarget,
      actorAttackBuffDelta: afterActorAttackBuff - beforeActorAttackBuff,
      actorDefBuffDelta: afterActorDefBuff - beforeActorDefBuff,
      targetAttackBuffDelta: afterTargetAttackBuff - beforeTargetAttackBuff,
      targetDefBuffDelta: afterTargetDefBuff - beforeTargetDefBuff,
    });

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

    if (prefix === "thief") {
      this.sendThiefStealPopup(actor);
    }

    this.sendItemList(wsPlayer, actor);
    const targetWsForItems = target === this.P1 ? this.p1 : target === this.P2 ? this.p2 : null;
    if (prefix === "thief" && targetWsForItems) {
      this.sendItemList(targetWsForItems, target);
    }

    if (actor.job === "弓兵" && (stype === "archer_1" || stype === "archer_2" || stype === "archer_3")) {
      if (!this.resolveArcherArrowAttack(actor, target, wsPlayer, { label: "通常攻撃" })) {
        this.skill_lock = false;
        return false;
      }
    }

    // 弓兵・陰陽師の追加処理（成功時のみ）

// ★ 烏天狗の追撃は handleAction 側でのみ処理する
// （ここでは何もしない）


    this.updateHP();

    if (actor.hp <= 0) {
      const winner = actor === this.P1 ? "p2" : "p1";
      this.finishBattle(winner);
      this.skill_lock = false;
      return true;
    }

    if (target.hp <= 0) {
      const winner = actor === this.P1 ? "p1" : "p2";
      this.finishBattle(winner);
      this.skill_lock = false;
      return true;
    }

    this.skill_lock = false;
    this.endRound(); // ★ 成功した時だけターン消費
    return true;
  }

  resolveArcherArrowAttack(actor, target, wsPlayer, { label = "攻撃" } = {}) {
    const arrowAttack = actor.trigger_arrow_attack(target, { consume: true });
    if (!arrowAttack?.ok) {
      this.sendPopup("矢が装備されていないため攻撃できません。", wsPlayer, 2200);
      this.sendError("❌ 矢が装備されていないため攻撃できません。", wsPlayer);
      const actorWs = actor === this.P1 ? this.p1 : actor === this.P2 ? this.p2 : wsPlayer;
      if (actorWs) this.sendItemList(actorWs, actor);
      this.sendSimpleStatusBoth();
      return false;
    }

    const results = arrowAttack.results ?? [];
    const arrowVisualTotal = Math.max(1, results.length);
    const distinctArrowSlots = new Set(results.map(r => r?.slot).filter(Boolean)).size;
    const arrowBaseCountRaw = Number(arrowAttack.arrow_count ?? distinctArrowSlots ?? 1);
    const arrowBaseCount = Math.max(1, Number.isFinite(arrowBaseCountRaw) ? arrowBaseCountRaw : (distinctArrowSlots || 1));
    const arrowRepeatRaw = Number(arrowAttack.repeat ?? Math.ceil(arrowVisualTotal / arrowBaseCount));
    const arrowRepeatCount = Math.max(1, Number.isFinite(arrowRepeatRaw) ? arrowRepeatRaw : 1);
    const arrowSequenceId = `arrow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const arrowEffectSequence = results.map(r => String(r?.effect ?? "normal"));
    for (let index = 0; index < results.length && actor.hp > 0; index += 1) {
      const r = results[index];
      const remainText = r.consumed
        ? `（残り${r.remaining}本）`
        : (r.noConsume ? "（矢消費なし）" : "");
      const actionLabel = r.extraAttack ? "追撃" : label;

      this.sendBattle(
        `🏹 ${actor.name} の${actionLabel}（${r.name}）！ ${r.dealt}ダメージ${remainText}`,
        { action_source: "arrow", sequence_index: index, sequence_total: results.length }
      );

      this.sendDamageEvent(
        target,
        r.dealt,
        r.extraAttack ? "pursuit" : "normal",
        r.targetType ?? "body",
        {
          show_zero: true,
          action_source: "arrow",
          source_player: actor === this.P1 ? "p1" : "p2",
          normal_attack: !r.extraAttack && label === "攻撃",
          sequence_index: index,
          sequence_total: results.length,
          arrow_rain: true,
          arrow_sequence_id: arrowSequenceId,
          arrow_rain_index: index,
          arrow_rain_total: arrowVisualTotal,
          arrow_base_count: arrowBaseCount,
          arrow_repeat_count: arrowRepeatCount,
          arrow_repeat_index: Number(r.repeatIndex ?? Math.floor(index / arrowBaseCount)),
          arrow_index: Number(r.arrowIndex ?? (index % arrowBaseCount)),
          arrow_slot: r.slot ?? "",
          arrow_name: r.name ?? "",
          arrow_effect: r.effect ?? "normal",
          arrow_effect_sequence: arrowEffectSequence,
          hit_sfx: "arrow",
          status_patch: this.buildLiveStatusPatch(target, r.statusSnapshot ?? {}),
        }
      );
      this.applyDojoMuramasaDrain(actor, r.dealt);
      this.applyDojoDurandalCounter(target, actor, r.dealt);
    }

    this.decrementArcherAttackBuffs(actor);

    const actorWs = actor === this.P1 ? this.p1 : actor === this.P2 ? this.p2 : wsPlayer;
    if (actorWs) this.sendItemList(actorWs, actor);
    this.sendSimpleStatusBoth();
    return true;
  }

  decrementArcherAttackBuffs(actor) {
    actor.archer_pierce_rounds = 0;
    actor.archer_next_pierce = false;
  }

  decrementArcherTurnStartBuffs(actor) {
    let changed = false;
    if (Number(actor.archer_no_consume_rounds ?? 0) > 0) {
      actor.archer_no_consume_rounds -= 1;
      changed = true;
      if (actor.archer_no_consume_rounds <= 0) {
        actor.archer_no_consume_rounds = 0;
        this.sendSystem("🏹 無尽射撃の効果が終了しました");
      }
    }

    const hadExtraBuffs = getArcherExtraBuffEntries(actor).length > 0;
    const expiredExtraBuffs = typeof actor.tick_archer_extra_buffs === "function"
      ? actor.tick_archer_extra_buffs()
      : 0;
    if (hadExtraBuffs) changed = true;
    if (expiredExtraBuffs > 0) {
      this.sendSystem(expiredExtraBuffs === 1
        ? "🏹 追撃効果が終了しました"
        : `🏹 追撃効果が${expiredExtraBuffs}個終了しました`);
    }
    if (changed) this.sendSimpleStatusBoth();
    return changed;
  }

  isTurnEndDebuff(buff) {
    const type = String(buff?.type ?? "");
    return (
      type === "攻撃力低下" ||
      type === "防御力低下" ||
      type === "スキル封印" ||
      buff?.is_debuff === true ||
      buff?.debuff === true
    );
  }

  decrementDebuffsEndOfTurn(player) {
    if (!player) return;

    const tickList = (list) => {
      if (!Array.isArray(list) || list.length === 0) return [];
      return list
        .map(d => {
          const nextTurns = Number(d.rounds ?? d.duration ?? 0) - 1;
          return { ...d, rounds: nextTurns, duration: nextTurns };
        })
        .filter(d => Number(d.rounds ?? d.duration ?? 0) > 0);
    };

    player.freeze_debuffs = tickList(player.freeze_debuffs);
    player.defense_debuffs = tickList(player.defense_debuffs);

    if (Array.isArray(player.active_buffs) && player.active_buffs.length > 0) {
      const next = [];
      for (const b of player.active_buffs) {
        if (!this.isTurnEndDebuff(b) || b.permanent || b.unremovable || b.passive) {
          next.push({ ...b });
          continue;
        }
        const nextTurns = Number(b.duration ?? b.rounds ?? 0) - 1;
        if (nextTurns > 0) {
          next.push({ ...b, duration: nextTurns, rounds: nextTurns });
        }
      }
      player.active_buffs = next;
    }

    if (!player.active_buffs?.some(b => b.type === "スキル封印")) {
      player.skill_sealed = false;
    }
  }





  /* =========================================================
     DOT処理（鬼火など）
     ========================================================= */
  applyDots(turnEndedPlayer = null) {
    const players = [
      { P: this.P1, ws: this.p1 },
      { P: this.P2, ws: this.p2 }
    ];

    for (const { P } of players) {
      if (!P.dot_effects) continue;
      const consumeDuration = !turnEndedPlayer || P === turnEndedPlayer;

      const remain = [];

      for (const dot of P.dot_effects) {
        const turnsBefore = Number(dot.turns ?? dot.rounds ?? dot.duration ?? 0);
        if (turnsBefore <= 0) continue;

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


        if (consumeDuration) {
          // ★ DOT継続Tは、付与されている本人のターン終了時だけ減少
          dot.turns = turnsBefore - 1;

          // 表示側が rounds を参照していても崩れないように同期
          if (dot.rounds != null) dot.rounds = dot.turns;

          if (dot.turns > 0) remain.push(dot);
        } else {
          remain.push(dot);
        }

      }

      P.dot_effects = remain;
    }

    this.updateHP();

    // DOTで決着した場合
    if (this.P1.hp <= 0 || this.P2.hp <= 0) {
      if (this.ended) return true;

      let result;
      if (this.P1.hp > this.P2.hp) result = "p1";
      else if (this.P2.hp > this.P1.hp) result = "p2";
      else result = "draw";

      this.finishBattle(result);
      return true;
    }

    return false;
  }


  /* =========================================================
     対戦終了処理（勝敗 & EXP / コイン補填）
     ========================================================= */
  finishBattle(result) {
    if (this.ended) return;
    this.ended = true;
    this.result = result;

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
    const buildResultDetailPayload = (ws, selfPlayer, enemyPlayer) => ({
        type: "battle_result_detail",
        result: resultForWs(ws),
        matchType: this.matchType,
        selfName: selfPlayer?.name || "",
        selfJob: selfPlayer?.job || "",
        enemyName: enemyPlayer?.name || "",
        enemyJob: enemyPlayer?.job || "",
        rating: resultDetailByWs.get(ws) || { ranked: false, reason: "none" }
    });
    const sendResultDetail = (ws, selfPlayer, enemyPlayer) => {
      if (!ws || ws.isBot) return;
      safeSend(ws, buildResultDetailPayload(ws, selfPlayer, enemyPlayer));
    };
    sendResultDetail(this.p1, this.P1, this.P2);
    sendResultDetail(this.p2, this.P2, this.P1);

    // ============================
    // ★ 対戦終了イベント（UI演出用）
    //   レート詳細を同梱し、勝利画面の表示時に確実にRATE CHANGEを描画できるようにする。
    // ============================
    const sendBattleEnd = (ws, selfPlayer, enemyPlayer) => {
      if (!ws) return;
      const detail = buildResultDetailPayload(ws, selfPlayer, enemyPlayer);
      safeSend(ws, {
        type: "battle_end",
        result: detail.result,
        matchType: detail.matchType,
        selfName: detail.selfName,
        selfJob: detail.selfJob,
        enemyName: detail.enemyName,
        enemyJob: detail.enemyJob,
        rating: detail.rating
      });
    };
    sendBattleEnd(this.p1, this.P1, this.P2);
    sendBattleEnd(this.p2, this.P2, this.P1);


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

    if (this.matchType === "dojo") {
      this.ended = true;
      const humanWs = this.p1?.isBot ? this.p2 : this.p1;
      if (disconnectedWs === humanWs) {
        // 達人への道は戦闘開始直前の待機画面をチェックポイントとして残す。
        // 通信切断だけでは挑戦失敗扱いにせず、再接続時に保存データから復帰させる。
        return;
      }
      safeSend(humanWs, {
        type: "dojo_error",
        msg: "達人への道の戦闘が中断されました。保存データから再開できます。"
      });
      return;
    }

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
     ターン終了処理
     ========================================================= */
  endRound() { // ★ 修正（旧 endTurn）
    this.skill_lock = false;
    this.action_resolving = false;

    if (this.ended) return;

    const actor = this.current === this.p1 ? this.P1 : this.P2;

    // ターン終了時：毒/鬼火は両者ぶんダメージ、残りTは付与されている本人の終了時だけ減少
    if (this.applyDots(actor)) return;

    // デバフの継続Tは、付与されている本人のターン終了時に減少
    this.decrementDebuffsEndOfTurn(actor);
    this.progressSummonerTurnEnd(actor);
    this.sendSimpleStatusBoth();

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


    // ターン交代
    [this.current, this.enemy] = [this.enemy, this.current];
    this.round++; // ★ 修正（旧 this.turn++）

    // ★ 次のターン開始処理（ここでコイン配布）
    this.startRound(); // ★ 修正（旧 startTurn）

    // コイン同期
    safeSend(this.p1, { type: "coin_info", coins: this.P1.coins });
    safeSend(this.p2, { type: "coin_info", coins: this.P2.coins });

    // ★ sendRoundInfo は startRound() の末尾で送っているため、ここでは二重送信しない

  this.scheduleCpuTurn(350);
    
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
      items: P.shop_items.map(it => applyDojoNormalItemEffectBonusForPlayer(P, it))
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
const DOJO_TRAIL_DURANDAL_ICON = "Assets/dojo/trail-icons/durandal-special.png";
const DOJO_TRAIL_MURAMASA_ICON = "Assets/dojo/trail-icons/muramasa-special.png";
const DOJO_TRAIL_HP_ICON = "Assets/dojo/trail-icons/hp-up.png";
const DOJO_TRAIL_SLOT_ICON = "Assets/dojo/trail-icons/aegis.png";
const DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON = "Assets/dojo/trail-icons/equipment-slot-small.png";
const DOJO_TRAIL_EQUIP_SLOT_MAJOR_1_ICON = "Assets/dojo/trail-icons/equipment-slot-major-1.png";
const DOJO_TRAIL_EQUIP_SLOT_MAJOR_2_ICON = "Assets/dojo/trail-icons/equipment-slot-major-2.png";
const DOJO_TRAIL_ITEM_SLOT_SMALL_ICON = "Assets/dojo/trail-icons/item-slot-small.png";
const DOJO_TRAIL_ITEM_ATTACK_MAJOR_ICON = "Assets/dojo/trail-icons/item-attack-major.png";
const DOJO_TRAIL_ITEM_DOUBLE_MAJOR_ICON = "Assets/dojo/trail-icons/item-double-major.png";
const DOJO_TRAIL_SKILL_DAMAGE_SMALL_ICON = "Assets/dojo/trail-icons/skill-damage-small.png";
const DOJO_TRAIL_SKILL_4_MAJOR_ICON = "Assets/dojo/trail-icons/skill-4-major.png";
const DOJO_TRAIL_SKILL_5_MAJOR_ICON = "Assets/dojo/trail-icons/skill-5-major.png";
const DOJO_TRAIL_COIN_GAIN_SMALL_ICON = "Assets/dojo/trail-icons/coin-gain-small.png";
const DOJO_TRAIL_COIN_SHOP_ATTACK_MAJOR_ICON = "Assets/dojo/trail-icons/coin-shop-attack-major.png";
const DOJO_TRAIL_COIN_SPENT_ATTACK_MAJOR_ICON = "Assets/dojo/trail-icons/coin-spent-attack-major.png";
const DOJO_TRAIL_DROP_RATE_SMALL_ICON = "Assets/dojo/trail-icons/drop-rate-small.png";
const DOJO_TRAIL_DROP_GUARANTEED_MAJOR_ICON = "Assets/dojo/trail-icons/drop-guaranteed-major.png";
const DOJO_TRAIL_DROP_RARE_MAJOR_ICON = "Assets/dojo/trail-icons/drop-rare-major.png";
const DOJO_SPECIAL_INVINCIBLE_ICON = "Assets/item_icons/dojo_invincible_potion.png";
const DOJO_SPECIAL_GROWTH_ELIXIR_ICON = "Assets/item_icons/dojo_growth_elixir.png";
const DOJO_SPECIAL_DEFENSE_ICON = "Assets/item_icons/dojo_special_defense_shield.png";
const DOJO_SPECIAL_PIERCE_WEAPON_ICON = "Assets/item_icons/dojo_pierce_weapon.png";
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
  30: { name: "生命泉の大軌跡", effect_text: "最大HPが40上昇し、毎ターンHPが2回復する。", icon: DOJO_TRAIL_HP_ICON }
};

const DOJO_TRAIL_FOURTH_COLUMN_EFFECTS = {
  31: { name: "コイン獲得量 +10%", effect_text: "達人への道のコイン獲得量が10%上がる。", icon: DOJO_TRAIL_COIN_GAIN_SMALL_ICON },
  32: { name: "コイン獲得量 +10%", effect_text: "達人への道のコイン獲得量が10%上がる。", icon: DOJO_TRAIL_COIN_GAIN_SMALL_ICON },
  33: { name: "コイン獲得量 +10%", effect_text: "達人への道のコイン獲得量が10%上がる。", icon: DOJO_TRAIL_COIN_GAIN_SMALL_ICON },
  34: { name: "コイン獲得量 +10%", effect_text: "達人への道のコイン獲得量が10%上がる。", icon: DOJO_TRAIL_COIN_GAIN_SMALL_ICON },
  35: { name: "商才の大軌跡", effect_text: "ショップでアイテムを購入すると攻撃力装備★1も入手する。", icon: DOJO_TRAIL_COIN_SHOP_ATTACK_MAJOR_ICON },
  36: { name: "コイン獲得量 +10%", effect_text: "達人への道のコイン獲得量が10%上がる。", icon: DOJO_TRAIL_COIN_GAIN_SMALL_ICON },
  37: { name: "コイン獲得量 +10%", effect_text: "達人への道のコイン獲得量が10%上がる。", icon: DOJO_TRAIL_COIN_GAIN_SMALL_ICON },
  38: { name: "コイン獲得量 +10%", effect_text: "達人への道のコイン獲得量が10%上がる。", icon: DOJO_TRAIL_COIN_GAIN_SMALL_ICON },
  39: { name: "コイン獲得量 +10%", effect_text: "達人への道のコイン獲得量が10%上がる。", icon: DOJO_TRAIL_COIN_GAIN_SMALL_ICON },
  40: { name: "蓄財の大軌跡", effect_text: `達人への道で消費したコイン${DOJO_TRAIL_COIN_SPENT_ATTACK_STEP}枚につき攻撃力が1上昇する。`, icon: DOJO_TRAIL_COIN_SPENT_ATTACK_MAJOR_ICON }
};

const DOJO_TRAIL_DROP_COLUMN_EFFECTS = {
  41: { name: "ドロップ率 +10%", effect_text: "達人への道のアイテム・装備ドロップ率が10%上がる。", icon: DOJO_TRAIL_DROP_RATE_SMALL_ICON },
  42: { name: "ドロップ率 +10%", effect_text: "達人への道のアイテム・装備ドロップ率が10%上がる。", icon: DOJO_TRAIL_DROP_RATE_SMALL_ICON },
  43: { name: "ドロップ率 +10%", effect_text: "達人への道のアイテム・装備ドロップ率が10%上がる。", icon: DOJO_TRAIL_DROP_RATE_SMALL_ICON },
  44: { name: "ドロップ率 +10%", effect_text: "達人への道のアイテム・装備ドロップ率が10%上がる。", icon: DOJO_TRAIL_DROP_RATE_SMALL_ICON },
  45: { name: "宝箱の大軌跡", effect_text: "勝利時、アイテムまたは装備が必ず1つドロップする。", icon: DOJO_TRAIL_DROP_GUARANTEED_MAJOR_ICON },
  46: { name: "上級ドロップ率アップ", effect_text: "★2・★3のアイテム/装備が出やすくなる。", icon: DOJO_TRAIL_DROP_RATE_SMALL_ICON },
  47: { name: "上級ドロップ率アップ", effect_text: "★2・★3のアイテム/装備が出やすくなる。", icon: DOJO_TRAIL_DROP_RATE_SMALL_ICON },
  48: { name: "上級ドロップ率アップ", effect_text: "★2・★3のアイテム/装備が出やすくなる。", icon: DOJO_TRAIL_DROP_RATE_SMALL_ICON },
  49: { name: "上級ドロップ率アップ", effect_text: "★2・★3のアイテム/装備が出やすくなる。", icon: DOJO_TRAIL_DROP_RATE_SMALL_ICON },
  50: { name: "秘宝の大軌跡", effect_text: "勝利時、アイテム1種と装備1種が必ずドロップ。さらに特殊アイテム5%、特殊装備5%の抽選が発生する。", icon: DOJO_TRAIL_DROP_RARE_MAJOR_ICON }
};

const DOJO_TRAIL_SEVENTH_COLUMN_EFFECTS = {
  61: { name: "装備・特殊装備持ち込み枠 +1", effect_text: "達人への道の装備持ち込み枠と特殊装備持ち込み枠が1増える。", icon: DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON },
  62: { name: "装備・特殊装備持ち込み枠 +1", effect_text: "達人への道の装備持ち込み枠と特殊装備持ち込み枠が1増える。", icon: DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON },
  63: { name: "装備・特殊装備持ち込み枠 +1", effect_text: "達人への道の装備持ち込み枠と特殊装備持ち込み枠が1増える。", icon: DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON },
  64: { name: "装備・特殊装備持ち込み枠 +1", effect_text: "達人への道の装備持ち込み枠と特殊装備持ち込み枠が1増える。", icon: DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON },
  65: { name: "聖剣デュランダルの大軌跡", effect_text: "特殊装備デュランダルを入手する。基礎防御力+5。装備中にダメージを受けると、自身の攻撃力と防御力の合計の半分だけ防御貫通の反撃ダメージを与える。", icon: DOJO_TRAIL_DURANDAL_ICON },
  66: { name: "装備・特殊装備枠 +1", effect_text: "装備できる装備枠と特殊装備枠が1増える。", icon: DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON },
  67: { name: "装備・特殊装備枠 +1", effect_text: "装備できる装備枠と特殊装備枠が1増える。", icon: DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON },
  68: { name: "装備・特殊装備枠 +1", effect_text: "装備できる装備枠と特殊装備枠が1増える。", icon: DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON },
  69: { name: "装備・特殊装備枠 +1", effect_text: "装備できる装備枠と特殊装備枠が1増える。", icon: DOJO_TRAIL_EQUIP_SLOT_SMALL_ICON },
  70: { name: "妖刀ムラサメの大軌跡", effect_text: "特殊装備ムラサメを入手する。基礎攻撃力+10。装備中、相手にダメージを与えた時、そのダメージの1/10だけHPを回復する。", icon: DOJO_TRAIL_MURAMASA_ICON }
};

const DOJO_TRAIL_SKILL_COLUMN_EFFECTS = {
  51: { name: "全スキルダメージ +5", effect_text: "戦士の全スキルダメージが5上昇する。", icon: DOJO_TRAIL_SKILL_DAMAGE_SMALL_ICON },
  52: { name: "全スキルダメージ +5", effect_text: "戦士の全スキルダメージが5上昇する。", icon: DOJO_TRAIL_SKILL_DAMAGE_SMALL_ICON },
  53: { name: "全スキルダメージ +5", effect_text: "戦士の全スキルダメージが5上昇する。", icon: DOJO_TRAIL_SKILL_DAMAGE_SMALL_ICON },
  54: { name: "全スキルダメージ +5", effect_text: "戦士の全スキルダメージが5上昇する。", icon: DOJO_TRAIL_SKILL_DAMAGE_SMALL_ICON },
  55: { name: "剛勇覚醒の大軌跡", effect_text: "戦士スキル4「剛勇覚醒」を解放する。レベル3で使用可能。5T攻撃力+20後、通常攻撃を行う。", icon: DOJO_TRAIL_SKILL_4_MAJOR_ICON },
  56: { name: "全スキルダメージ +10", effect_text: "戦士の全スキルダメージが10上昇する。", icon: DOJO_TRAIL_SKILL_DAMAGE_SMALL_ICON },
  57: { name: "全スキルダメージ +10", effect_text: "戦士の全スキルダメージが10上昇する。", icon: DOJO_TRAIL_SKILL_DAMAGE_SMALL_ICON },
  58: { name: "全スキルダメージ +10", effect_text: "戦士の全スキルダメージが10上昇する。", icon: DOJO_TRAIL_SKILL_DAMAGE_SMALL_ICON },
  59: { name: "全スキルダメージ +10", effect_text: "戦士の全スキルダメージが10上昇する。", icon: DOJO_TRAIL_SKILL_DAMAGE_SMALL_ICON },
  60: { name: "覇断一閃の大軌跡", effect_text: "戦士スキル5「覇断一閃」を解放する。レベル3で使用可能。防御無視の通常攻撃を行い、攻撃力アップバフ1種類につき威力が10上昇する。", icon: DOJO_TRAIL_SKILL_5_MAJOR_ICON }
};

const DOJO_TRAIL_ITEM_COLUMN_EFFECTS = {
  71: { name: "アイテム持ち込み枠 +1", effect_text: "達人への道のアイテム持ち込み枠が1増える。", icon: DOJO_TRAIL_ITEM_SLOT_SMALL_ICON },
  72: { name: "アイテム持ち込み枠 +1", effect_text: "達人への道のアイテム持ち込み枠が1増える。", icon: DOJO_TRAIL_ITEM_SLOT_SMALL_ICON },
  73: { name: "アイテム持ち込み枠 +1", effect_text: "達人への道のアイテム持ち込み枠が1増える。", icon: DOJO_TRAIL_ITEM_SLOT_SMALL_ICON },
  74: { name: "アイテム持ち込み枠 +1", effect_text: "達人への道のアイテム持ち込み枠が1増える。", icon: DOJO_TRAIL_ITEM_SLOT_SMALL_ICON },
  75: { name: "闘志の秘薬", effect_text: "アイテム使用時に基礎攻撃力が上昇する（達人への道挑戦中は永続、挑戦終了時のみリセット）。", icon: DOJO_TRAIL_ITEM_ATTACK_MAJOR_ICON },
  76: { name: "通常アイテム効果 +1", effect_text: "攻撃力・防御力・HPの通常アイテムの効果量が1上昇する。", icon: DOJO_TRAIL_ITEM_ATTACK_MAJOR_ICON },
  77: { name: "通常アイテム効果 +1", effect_text: "攻撃力・防御力・HPの通常アイテムの効果量が1上昇する。", icon: DOJO_TRAIL_ITEM_ATTACK_MAJOR_ICON },
  78: { name: "通常アイテム効果 +1", effect_text: "攻撃力・防御力・HPの通常アイテムの効果量が1上昇する。", icon: DOJO_TRAIL_ITEM_ATTACK_MAJOR_ICON },
  79: { name: "通常アイテム効果 +1", effect_text: "攻撃力・防御力・HPの通常アイテムの効果量が1上昇する。", icon: DOJO_TRAIL_ITEM_ATTACK_MAJOR_ICON },
  80: { name: "万能の秘薬", effect_text: "アイテム使用時に効果が2回発動する。", icon: DOJO_TRAIL_ITEM_DOUBLE_MAJOR_ICON }
};

const DOJO_TRAIL_MAJOR_ICON_OVERRIDES = {
  5: DOJO_TRAIL_MAJOR_05_ICON,
  15: DOJO_TRAIL_MAJOR_15_ICON,
  25: DOJO_TRAIL_MAJOR_25_ICON,
  30: DOJO_TRAIL_MAJOR_30_ICON,
  35: DOJO_TRAIL_COIN_SHOP_ATTACK_MAJOR_ICON,
  40: DOJO_TRAIL_COIN_SPENT_ATTACK_MAJOR_ICON,
  45: DOJO_TRAIL_DROP_GUARANTEED_MAJOR_ICON,
  50: DOJO_TRAIL_DROP_RARE_MAJOR_ICON,
  55: DOJO_TRAIL_SKILL_4_MAJOR_ICON,
  60: DOJO_TRAIL_SKILL_5_MAJOR_ICON,
  65: DOJO_TRAIL_DURANDAL_ICON,
  70: DOJO_TRAIL_MURAMASA_ICON
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

function createDojoDurandal() {
  return {
    uid: crypto.randomUUID(),
    name: "デュランダル",
    is_equip: true,
    equip_type: "dojo_special",
    dojo_special_effect: "durandal",
    defense_bonus: 5,
    icon_src: DOJO_TRAIL_DURANDAL_ICON,
    effect_text: "基礎防御力+5。装備中にダメージを受けると、自身の攻撃力と防御力の合計の半分だけ防御貫通の反撃ダメージを与える。"
  };
}

function createDojoMuramasa() {
  return {
    uid: crypto.randomUUID(),
    name: "ムラサメ",
    is_equip: true,
    equip_type: "dojo_special",
    dojo_special_effect: "muramasa",
    attack_bonus: 10,
    icon_src: DOJO_TRAIL_MURAMASA_ICON,
    effect_text: "基礎攻撃力+10。装備中、相手にダメージを与えた時、そのダメージの1/10だけHPを回復する。"
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

function createDojoInvinciblePotion() {
  return {
    uid: crypto.randomUUID(),
    name: "無敵の霊薬",
    star: 3,
    is_equip: false,
    is_dojo_special_item: true,
    dojo_special_item_effect: "invincible",
    effect_type: "DOJO_INVINCIBLE",
    rounds: 2,
    price: 0,
    icon_src: DOJO_SPECIAL_INVINCIBLE_ICON,
    effect_text: "2Tの間、受けるダメージを0にする。"
  };
}

function createDojoGrowthElixir() {
  return {
    uid: crypto.randomUUID(),
    name: "成長の戦薬",
    star: 3,
    is_equip: false,
    is_dojo_special_item: true,
    dojo_special_item_effect: "attack_growth",
    effect_type: "DOJO_ATTACK_GROWTH",
    power: 2,
    price: 0,
    icon_src: DOJO_SPECIAL_GROWTH_ELIXIR_ICON,
    effect_text: "使用後、ステージクリアまで毎ターン攻撃力+2。"
  };
}

function createDojoSpecialDefenseEquip() {
  return {
    uid: crypto.randomUUID(),
    name: "不穿の守護盾",
    star: 3,
    is_equip: true,
    equip_type: "dojo_special",
    dojo_special_effect: "special_defense",
    special_defense: 10,
    price: 0,
    icon_src: DOJO_SPECIAL_DEFENSE_ICON,
    effect_text: "特殊防御+10。防御貫通でも貫通されない防御を得る。"
  };
}

function createDojoPierceWeapon() {
  return {
    uid: crypto.randomUUID(),
    name: "穿界の魔剣",
    star: 3,
    is_equip: true,
    equip_type: "dojo_special",
    dojo_special_effect: "pierce_weapon",
    price: 0,
    icon_src: DOJO_SPECIAL_PIERCE_WEAPON_ICON,
    effect_text: "装備中、通常攻撃とスキルがすべて防御貫通になる。"
  };
}

function createRandomDojoSpecialItem() {
  return Math.random() < 0.5 ? createDojoInvinciblePotion() : createDojoGrowthElixir();
}

function createRandomDojoSpecialEquip() {
  return Math.random() < 0.5 ? createDojoSpecialDefenseEquip() : createDojoPierceWeapon();
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
  const effect = DOJO_TRAIL_LEFT_COLUMN_EFFECTS[id] ?? DOJO_TRAIL_SECOND_COLUMN_EFFECTS[id] ?? DOJO_TRAIL_THIRD_COLUMN_EFFECTS[id] ?? DOJO_TRAIL_FOURTH_COLUMN_EFFECTS[id] ?? DOJO_TRAIL_DROP_COLUMN_EFFECTS[id] ?? DOJO_TRAIL_SEVENTH_COLUMN_EFFECTS[id] ?? DOJO_TRAIL_SKILL_COLUMN_EFFECTS[id] ?? DOJO_TRAIL_ITEM_COLUMN_EFFECTS[id] ?? DOJO_TRAIL_SMALL_EFFECTS[(id - 1) % DOJO_TRAIL_SMALL_EFFECTS.length];
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
    skillDamageBonus: getDojoTrailSkillDamageBonus(state),
    coinGainPercent: getDojoTrailCoinGainPercent(state),
    dropRateBonusPercent: getDojoTrailDropRateBonusPercent(state),
    rareDropBonusCount: getDojoTrailRareDropBonusCount(state),
    guaranteedDrop: hasDojoTrailGuaranteedDrop(state),
    doubleGuaranteedDrop: hasDojoTrailDoubleGuaranteedDrop(state),
    total: DOJO_TRAIL_NODE_COUNT,
    nodes: DOJO_TRAIL_NODES.map(node => ({ ...node, unlocked: unlocked.has(node.id) }))
  };
}

function getDojoTrailAttackBonus(state) {
  const unlocked = new Set((state?.trailNodes || []).map(Number));
  let bonus = Number(state?.trailAttackGrowth ?? 0) + Number(state?.trailItemAttackGrowth ?? 0);
  for (const id of [1, 2, 3, 4]) if (unlocked.has(id)) bonus += 1;
  for (const id of [6, 7, 8, 9]) if (unlocked.has(id)) bonus += 2;
  if (unlocked.has(40)) {
    bonus += Math.max(0, Math.floor(Number(state?.trailCoinSpent ?? 0) / DOJO_TRAIL_COIN_SPENT_ATTACK_STEP));
  }
  return bonus;
}

function getDojoTrailCoinGainPercent(state) {
  const unlocked = new Set((state?.trailNodes || []).map(Number));
  let percent = 0;
  for (const id of [31, 32, 33, 34, 36, 37, 38, 39]) if (unlocked.has(id)) percent += 10;
  return percent;
}

function getDojoTrailDropRateBonusPercent(state) {
  const unlocked = new Set((state?.trailNodes || []).map(Number));
  let percent = 0;
  for (const id of [41, 42, 43, 44]) if (unlocked.has(id)) percent += 10;
  return percent;
}

function getDojoTrailRareDropBonusCount(state) {
  const unlocked = new Set((state?.trailNodes || []).map(Number));
  let count = 0;
  for (const id of [46, 47, 48, 49]) if (unlocked.has(id)) count += 1;
  return count;
}

function hasDojoTrailGuaranteedDrop(state) {
  const unlocked = new Set((state?.trailNodes || []).map(Number));
  return unlocked.has(45) || unlocked.has(50);
}

function hasDojoTrailDoubleGuaranteedDrop(state) {
  const unlocked = new Set((state?.trailNodes || []).map(Number));
  return unlocked.has(50);
}

function getDojoTrailSkillDamageBonus(state) {
  const source = state instanceof Set ? [...state] : (state?.trailNodes || []);
  const unlocked = new Set(source.map(Number));
  let bonus = 0;
  for (const id of [51, 52, 53, 54]) if (unlocked.has(id)) bonus += 5;
  for (const id of [56, 57, 58, 59]) if (unlocked.has(id)) bonus += 10;
  return bonus;
}

function getDojoTrailCoinGainDetail(run, amount) {
  const base = Math.max(0, Math.floor(Number(amount ?? 0)));
  const percent = getDojoTrailCoinGainPercent(ensureDojoRunTrailState(run));
  if (percent <= 0 || base <= 0) {
    return { amount: base, base, bonus: 0, percent };
  }
  const bonus = Math.max(1, Math.floor(base * percent / 100));
  return { amount: base + bonus, base, bonus, percent };
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
  for (const id of [71, 72, 73, 74]) if (unlocked.has(id)) itemCarry += 1;
  for (const id of [61, 62, 63, 64]) {
    if (!unlocked.has(id)) continue;
    equipmentCarry += 1;
    specialCarry += 1;
  }
  for (const id of [66, 67, 68, 69]) {
    if (!unlocked.has(id)) continue;
    equipmentEquip += 1;
    specialEquip += 1;
  }
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

const DOJO_NORMAL_ITEM_EFFECT_BONUS_NODES = [76, 77, 78, 79];
const DOJO_NORMAL_ITEM_EFFECT_TYPES = new Set(["攻撃力", "防御力", "HP"]);

function getDojoNormalItemEffectBonusFromNodes(nodes = []) {
  const nodeList = Array.isArray(nodes)
    ? nodes
    : (nodes instanceof Set || (nodes && typeof nodes[Symbol.iterator] === "function" && typeof nodes !== "string"))
      ? Array.from(nodes)
      : [];
  const unlocked = new Set(nodeList.map(Number));
  return DOJO_NORMAL_ITEM_EFFECT_BONUS_NODES.reduce(
    (sum, id) => sum + (unlocked.has(id) ? 1 : 0),
    0
  );
}

function getDojoNormalItemEffectBonusForPlayer(player) {
  return getDojoNormalItemEffectBonusFromNodes(player?.dojoTrailNodes ?? []);
}

function isDojoNormalConsumableItem(item) {
  if (!item || typeof item !== "object") return false;
  if (item.is_equip || item.is_arrow || item.is_doll_costume) return false;
  if (item.equip_type) return false;
  if (item.is_mage_item || item.effect_type === "MANA") return false;
  if (item.is_onmyoji_item || item.is_doll_item || item.is_mad_special_item) return false;
  if (item.is_priest_item || item.is_dojo_special_item) return false;
  return DOJO_NORMAL_ITEM_EFFECT_TYPES.has(item.effect_type);
}

function formatDojoNormalItemEffectText(item, power) {
  const effectType = item?.effect_type;
  const duration = Number(item?.duration ?? 0);
  if (effectType === "HP") return `HP +${power} (即時)`;
  if (effectType === "攻撃力") return `攻撃力 +${power}${duration > 0 ? ` / ${duration}T` : ""}`;
  if (effectType === "防御力") return `防御力 +${power}${duration > 0 ? ` / ${duration}T` : ""}`;
  return item?.effect_text ?? "";
}

function applyDojoNormalItemEffectBonus(item, bonus = 0) {
  const boost = Math.max(0, Number(bonus ?? 0));
  if (boost <= 0 || !isDojoNormalConsumableItem(item)) return item;
  const basePower = Number(item._dojo_base_power ?? item.power ?? 0);
  if (!Number.isFinite(basePower)) return item;
  const power = basePower + boost;
  return {
    ...item,
    power,
    _dojo_base_power: basePower,
    dojo_item_effect_bonus: boost,
    effect_text: formatDojoNormalItemEffectText(item, power),
  };
}

function applyDojoNormalItemEffectBonusForPlayer(player, item) {
  return applyDojoNormalItemEffectBonus(item, getDojoNormalItemEffectBonusForPlayer(player));
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

function hasDojoDurandal(player) {
  const lists = [
    player?.dojoStorage?.special,
    player?.special_inventory,
    player?.special_equipment ? [player.special_equipment] : [],
    player?.extra_special_equipments
  ];
  return lists.some(list => (list || []).some(it => it?.dojo_special_effect === "durandal" || it?.name === "デュランダル"));
}

function hasDojoMuramasa(player) {
  const lists = [
    player?.dojoStorage?.special,
    player?.special_inventory,
    player?.special_equipment ? [player.special_equipment] : [],
    player?.extra_special_equipments
  ];
  return lists.some(list => (list || []).some(it => it?.dojo_special_effect === "muramasa" || it?.name === "ムラサメ"));
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

function addDojoDurandalToStorage(player) {
  if (!player || hasDojoDurandal(player)) return false;
  addUniqueDojoStorage(player, "special", createDojoDurandal());
  return true;
}

function addDojoMuramasaToStorage(player) {
  if (!player || hasDojoMuramasa(player)) return false;
  addUniqueDojoStorage(player, "special", createDojoMuramasa());
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
  const dropRateBonusPercent = getDojoTrailDropRateBonusPercent(state);
  const rareDropBonusCount = getDojoTrailRareDropBonusCount(state);
  player._dojoTrailAttackBonusApplied = attackBonus;
  player._dojoTrailDefenseBonusApplied = defenseBonus;
  player._dojoTrailMaxHpBonusApplied = maxHpBonus;
  player._dojoTrailRoundRegen = hasDojoTrailRoundRegen(state) ? 2 : 0;
  player._dojoTrailCoinGainPercent = coinGainPercent;
  player._dojoTrailCoinSpent = Math.max(0, Number(state?.trailCoinSpent ?? 0));
  player._dojoTrailDropRateBonusPercent = dropRateBonusPercent;
  player._dojoTrailRareDropBonusCount = rareDropBonusCount;
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
  if ((state?.trailNodes || []).map(Number).includes(65)) addDojoDurandalToStorage(player);
  if ((state?.trailNodes || []).map(Number).includes(70)) addDojoMuramasaToStorage(player);
  

  // 達人への道：アイテム関連のノード情報を初期化
  player.dojoTrailNodes = (state?.trailNodes || []).map(Number);
  player.dojoItemAttackBuff = Number(state?.trailItemAttackGrowth ?? 0);
  player.dojoNormalItemEffectBonus = getDojoNormalItemEffectBonusFromNodes(player.dojoTrailNodes);
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
  return {
    item: pick.item,
    sourceName: target?.name ?? "相手",
    itemName: pick.item?.name ?? "持ち物",
    itemKind: pick.key === "equipment_inventory" ? "装備" : "アイテム"
  };
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
  player.defense_debuffs = [];
  player.archer_buff = null;
  player.archer_buffs = [];
  player.archer_no_consume_rounds = 0;
  player.archer_no_consume_permanent = false;
  player.archer_pierce_rounds = 0;
  player.archer_next_pierce = false;
  player.dojo_invincible_rounds = 0;
  player.dojo_attack_growth_active = false;
  player.dojo_attack_growth_per_round = 0;
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
  if (!item) return null;
  ensureDojoInventoryState(player);
  const key = dojoStorageKey(category);
  if (!key) return null;
  if (!item.uid) item.uid = crypto.randomUUID();
  const list = player.dojoStorage[key];
  if (key === "special" && isArrowItem(item)) {
    const existing = list.find(x =>
      isArrowItem(x) &&
      getArrowStackKey(x) === getArrowStackKey(item) &&
      String(x?.uid ?? "") !== String(item.uid ?? "")
    );
    if (existing) return mergeArrowAmmo(existing, item);
  }
  if (!list.some(x => String(x?.uid) === String(item.uid))) {
    list.push(item);
  }
  return item;
}

function addItemToDojoStorage(player, item) {
  if (!item) return null;
  if (item.is_arrow || item.equip_type === "arrow" || item.equip_type === "mage_equip" || item.equip_type === "alchemist_unique" || item.equip_type === "dojo_special" || item.is_doll_costume) {
    return addUniqueDojoStorage(player, "special", item);
  } else if (item.is_equip) {
    return addUniqueDojoStorage(player, "equipment", item);
  }
  return addUniqueDojoStorage(player, "items", item);
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

  if (star1 >= NORMAL_EQUIP_MAX_STAR) {
    safeSend(ws, { type: "popup", msg: `装備合成の最大レベルは${NORMAL_EQUIP_MAX_STAR}です。`, ms: 2400 });
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

function findDojoStorageEquipCombinePair(equipment = []) {
  const seen = new Map();
  for (const item of equipment ?? []) {
    if (!item?.is_equip || item.equip_type !== "normal") continue;
    if (Number(item.star ?? 1) >= NORMAL_EQUIP_MAX_STAR) continue;
    const key = `${Number(item.star ?? 1)}::${String(item.equip_category ?? item.effect_type ?? "")}`;
    const prev = seen.get(key);
    if (prev) return [prev, item];
    seen.set(key, item);
  }
  return null;
}

function autoCombineDojoStorageEquips(ws, { notifyEmpty = false } = {}) {
  if (!ws?.player) return 0;
  const P = ws.player;
  ensureDojoInventoryState(P);
  let count = 0;
  let lastEquip = null;

  for (let guard = 0; guard < 100; guard++) {
    const storage = Array.isArray(P.dojoStorage?.equipment) ? P.dojoStorage.equipment : [];
    const pair = findDojoStorageEquipCombinePair(storage);
    if (!pair) break;

    const [eq1, eq2] = pair;
    const id1 = String(eq1?.uid ?? "");
    const id2 = String(eq2?.uid ?? "");
    if (!id1 || !id2 || id1 === id2) break;

    const nextEquip = upgradeEquipStar({
      ...eq1,
      uid: crypto.randomUUID(),
    });

    P.dojoStorage.equipment = storage.filter(it => String(it?.uid) !== id1 && String(it?.uid) !== id2);
    P.dojoStorage.equipment.push(nextEquip);
    P.dojoLoadout.equipment = (P.dojoLoadout.equipment ?? [])
      .map(String)
      .filter(uid => uid !== id1 && uid !== id2);
    count += 1;
    lastEquip = nextEquip;
  }

  if (count > 0) {
    safeSend(ws, {
      type: "popup",
      msg: count === 1
        ? `${lastEquip?.name ?? "装備"} を自動合成しました`
        : `${count}回、自動合成しました`,
      ms: 2200
    });
  } else if (notifyEmpty) {
    safeSend(ws, { type: "popup", msg: "合成できる装備はありません。", ms: 1800 });
  }

  return count;
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

  if (previousLoadout && typeof previousLoadout === "object") {
    for (const key of ["items", "equipment", "special"]) {
      const available = new Set((player.dojoStorage[key] ?? []).map(it => String(it?.uid)));
      const limit = Math.max(1, Number(player.dojoCarrySlots?.[key] ?? 1));
      player.dojoLoadout[key] = (previousLoadout[key] ?? [])
        .map(String)
        .filter(uid => available.has(uid))
        .slice(0, limit);
    }
  }
  pruneDojoLoadout(player);
  delete player._dojoSelectedLoadoutBeforeBattle;
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
  const displayItems = (player.dojoStorage.items ?? []).map(it => applyDojoNormalItemEffectBonusForPlayer(player, it));
  const displayLoadout = {
    ...(player.dojoLoadout ?? { items: [], equipment: [], special: [] }),
    items: (player.dojoLoadout?.items ?? []).map(it => applyDojoNormalItemEffectBonusForPlayer(player, it)),
  };
  return {
    stage: Number(run?.stage ?? 1),
    maxStage: 30,
    jobName: run?.jobName ?? player?.job ?? "戦士",
    hp: Math.max(1, Number(player?.hp ?? 0)),
    max_hp: Number(player?.max_hp ?? 0),
    attack: player?.doll ? (player.doll.is_broken ? 0 : player.getDollAttack()) : Number(player?.get_total_attack?.() ?? player?.attack ?? 0),
    defense: player?.doll ? (player.doll.is_broken ? 0 : player.getDollDefense()) : Number(player?.get_total_defense?.() ?? player?.defense ?? 0),
    specialDefense: Math.max(0, Number(player?.get_special_defense?.() ?? 0)),
    trailBuffs,
    level: Number(player?.level ?? 1),
    exp: currentExp,
    next_level_exp: nextExp,
    next_level_remaining: nextExp == null ? 0 : Math.max(0, Number(nextExp) - currentExp),
    coins: Number(player?.coins ?? 0),
    items: displayItems,
    equipment: player.dojoStorage.equipment,
    special: player.dojoStorage.special,
    loadout: displayLoadout,
    carrySlots: player.dojoCarrySlots,
    equipSlots: player.dojoEquipSlots ?? { equipment: 1, special: 1 },
    trail: buildDojoTrailView(wsOrAccountId, run?.jobName ?? player?.job ?? "戦士"),
    lastDrops: run?.lastDrops ?? [],
    highestStage: Number(run?.highestStage ?? 0),
    cleared: !!run?.cleared
  };
}

function getDojoRewardGenerationLevel(baseLevel, rareBonusCount = 0) {
  const base = Math.max(1, Math.min(3, Number(baseLevel ?? 1)));
  const bonus = Math.max(0, Number(rareBonusCount ?? 0));
  let level = base;
  if (bonus > 0 && Math.random() < Math.min(0.48, bonus * 0.12)) {
    level = Math.max(level, 2);
  }
  if (bonus > 0 && Math.random() < Math.min(0.24, bonus * 0.06)) {
    level = 3;
  }
  return level;
}

function createDojoRewardItem(level) {
  const item = generateOneShopItem(level);
  item.uid = crypto.randomUUID();
  return item;
}

function createDojoRewardEquip(level) {
  for (let i = 0; i < 12; i++) {
    const candidate = generateEquipmentForLevel(level);
    if (!isCoinEquipment(candidate)) {
      candidate.uid = crypto.randomUUID();
      return candidate;
    }
  }
  const fallback = generateEquipmentForLevel(level);
  fallback.uid = crypto.randomUUID();
  return fallback;
}

function pushDojoItemDrop(drops, level) {
  const item = createDojoRewardItem(level);
  drops.push({ type: "item", name: item.name, item });
  return item;
}

function pushDojoEquipDrop(drops, level) {
  const eq = createDojoRewardEquip(level);
  drops.push({ type: "equip", name: eq.name, item: eq });
  return eq;
}

function pushDojoRandomItemOrEquipDrop(drops, level) {
  return Math.random() < 0.55
    ? pushDojoEquipDrop(drops, level)
    : pushDojoItemDrop(drops, level);
}

function generateDojoDrops(run, player) {
  const stage = Number(run?.stage ?? 1);
  const kind = getDojoStageKind(stage);
  if (kind === "final_boss") return [];
  const baseCoinAmount = randInt(5, 20);
  const coinGain = getDojoTrailCoinGainDetail(run, baseCoinAmount);
  const coinDrop = {
    type: "coin",
    name: "コイン",
    amount: coinGain.amount,
    base_amount: coinGain.base,
    trail_bonus_amount: coinGain.bonus,
    trail_bonus_percent: coinGain.percent
  };
  const drops = [
    coinDrop,
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

  const trailState = ensureDojoRunTrailState(run);
  const isBoss = kind === "boss" || kind === "mid_boss";
  const baseDropRate = isBoss ? 0.55 : 0.28;
  const dropRateBonus = getDojoTrailDropRateBonusPercent(trailState);
  const rareBonusCount = getDojoTrailRareDropBonusCount(trailState);
  const dropRate = Math.min(1, baseDropRate + (dropRateBonus / 100));
  const baseLevel = isBoss ? 3 : 1;

  const rollLevel = () => getDojoRewardGenerationLevel(baseLevel, rareBonusCount);
  let itemEquipDropCount = 0;

  if (Math.random() < dropRate) {
    pushDojoRandomItemOrEquipDrop(drops, rollLevel());
    itemEquipDropCount += 1;
  }

  if (hasDojoTrailDoubleGuaranteedDrop(trailState)) {
    pushDojoItemDrop(drops, rollLevel());
    pushDojoEquipDrop(drops, rollLevel());
    itemEquipDropCount += 2;

    const specialRoll = Math.random();
    if (specialRoll < 0.05) {
      const specialItem = createRandomDojoSpecialItem();
      drops.push({ type: "item", name: specialItem.name, item: specialItem });
    } else if (specialRoll < 0.10) {
      const specialEquip = createRandomDojoSpecialEquip();
      drops.push({ type: "special", name: specialEquip.name, item: specialEquip });
    }
  } else if (hasDojoTrailGuaranteedDrop(trailState) && itemEquipDropCount <= 0) {
    pushDojoRandomItemOrEquipDrop(drops, rollLevel());
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
    special_defense: Math.max(0, Number(player?.get_special_defense?.() ?? player?.special_defense ?? 0)),
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

function saveDojoWaitingCheckpoint(ws) {
  if (!ws?.dojoRun || ws.dojoRun.waiting !== true) return;
  saveCurrentDojoRun(ws);
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
  const items = ensureDojoPrepShop(ws).map(it => applyDojoNormalItemEffectBonusForPlayer(ws?.player, it));
  safeSend(ws, {
    type: "dojo_shop_list",
    items
  });
}

function startDojoStage(humanWS) {
  const run = humanWS.dojoRun;
  if (!run || !humanWS.player) return;
  run.waiting = true;
  saveCurrentDojoRun(humanWS);
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
    ...buildMatchStartPayload(humanWS.player, botWS.player, {
      mode: "dojo",
    }),
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
  saveDojoWaitingCheckpoint(ws);
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
    const endMode = m.mode === "clear" ? "clear" : m.mode === "abandon" ? "abandon" : "save";
    if (ws.dojoRun && ws.accountId) {
      const cleared = endMode === "clear" || !!ws.dojoRun.cleared;
      if (endMode === "save" && !cleared) {
        saveCurrentDojoRun(ws);
      } else {
        clearSavedDojoRun({ accountId: ws.accountId, job: ws.dojoRun.jobName ?? "戦士" });
      }
      recordDojoProgress({
        accountId: ws.accountId,
        job: ws.dojoRun.jobName,
        stage: Number(ws.dojoRun.stage ?? 1),
        cleared
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
      if (
        (unlockedIds.has(10) && addDojoExcaliburToStorage(ws.player)) ||
        (unlockedIds.has(20) && addDojoAegisToStorage(ws.player)) ||
        (unlockedIds.has(65) && addDojoDurandalToStorage(ws.player)) ||
        (unlockedIds.has(70) && addDojoMuramasaToStorage(ws.player))
      ) {
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
    const storedItem = addItemToDojoStorage(P, item) || item;
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
    safeSend(ws, { type: "dojo_purchased_item", item: applyDojoNormalItemEffectBonusForPlayer(P, storedItem) });
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

  if (m.type === "dojo_auto_combine_equips") {
    if (!ws.dojoRun || !ws.player || ws.dojoRun.waiting !== true) return;
    const count = autoCombineDojoStorageEquips(ws, { notifyEmpty: !!m.notify_empty });
    if (count > 0) {
      saveCurrentDojoRun(ws);
    }
    sendDojoWaiting(ws);
    return;
  }

  const match = ws.currentMatch;
  if (!match || match.matchType !== "dojo") return;
  const P = ws.player;
  if (match.ended) return;

  if (await handleSummonerClientMessage(match, ws, P, m)) return;

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
    const self = ws === match.p1 ? match.P1 : match.P2;
    const enemy = self === match.P1 ? match.P2 : match.P1;
    match.sendStatusDetail(ws, self, enemy, m.target === "enemy" ? "enemy" : "self");
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
  if (m.type === "skill4") await match.useSkill(ws, P, P.opponent, 4);
  if (m.type === "skill5") await match.useSkill(ws, P, P.opponent, 5);
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
  applyCpuAiRank(cpuPlayer, cpuJobKey, humanWS.player.cpu_ai_rank);
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

    if (await handleSummonerClientMessage(match, sock, P, m)) return;

    // ---------- 人形使い：スキルUI系 ----------
    if (m.type === "request_doll_skill1") {
      if (sock !== match.current) {
        match.sendError("❌ 今はあなたのターンではありません。", sock);
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
        match.sendError("❌ 今はあなたのターンではありません。", sock);
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
        match.sendError("❌ 今はあなたのターンではありません。", sock);
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
      const self = sock === match.p1 ? match.P1 : match.P2;
      const enemy = self === match.P1 ? match.P2 : match.P1;
      match.sendStatusDetail(
        sock,
        self,
        enemy,
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

  safeSend(humanWS, buildMatchStartPayload(humanWS.player, botWS.player));
  match.sendInitialStatusSnapshot();

  match.scheduleCpuTurn(900);
}

function createTutorialShopList() {
  return [
    {
      uid: crypto.randomUUID(),
      name: "訓練用回復薬",
      star: 1,
      effect_type: "HP",
      power: 30,
      duration: 0,
      price: 5,
      effect_text: "HP +30",
      is_equip: false,
      tutorial_item: true,
      tutorial_shop_target: "item"
    },
    {
      uid: crypto.randomUUID(),
      name: "訓練用攻撃装備",
      star: 1,
      is_equip: true,
      equip_type: "normal",
      equip_category: "攻撃力",
      effect_type: "攻撃力",
      power: 3,
      price: 5,
      effect_text: "攻撃力 +3",
      tutorial_item: true,
      tutorial_shop_target: "equip",
      tutorial_no_equip_prompt: true
    },
    {
      uid: crypto.randomUUID(),
      name: "訓練用攻撃装備",
      star: 1,
      is_equip: true,
      equip_type: "normal",
      equip_category: "攻撃力",
      effect_type: "攻撃力",
      power: 3,
      price: 5,
      effect_text: "攻撃力 +3",
      tutorial_item: true,
      tutorial_no_equip_prompt: true
    },
    {
      uid: crypto.randomUUID(),
      name: "訓練用防御装備",
      star: 1,
      is_equip: true,
      equip_type: "normal",
      equip_category: "防御力",
      effect_type: "防御力",
      power: 2,
      price: 5,
      effect_text: "防御力 +2",
      tutorial_item: true,
      tutorial_no_equip_prompt: true
    },
    {
      uid: crypto.randomUUID(),
      name: "訓練用攻撃薬",
      star: 1,
      effect_type: "攻撃力",
      power: 3,
      duration: 2,
      price: 5,
      effect_text: "攻撃力 +3 / 2T",
      is_equip: false,
      tutorial_item: true
    }
  ];
}

function isTutorialShopList(items) {
  if (!Array.isArray(items)) return false;
  const hasForcedItem = items.some(item => item?.tutorial_shop_target === "item");
  const hasForcedEquip = items.some(item => item?.tutorial_shop_target === "equip");
  return hasForcedItem && hasForcedEquip && items.every(item => item?.tutorial_item === true);
}

function ensureTutorialShopList(player) {
  if (!player) return [];
  if (!isTutorialShopList(player.shop_items)) {
    player.shop_items = createTutorialShopList();
  }
  return player.shop_items;
}

function startTutorialMatch(humanWS) {
  const botWS = createBotSocket();
  const human = humanWS.player;
  human.turn_order = "first";
  human.coins = Math.max(Number(human.coins ?? 0), 80);
  human.exp = 0;
  human.shop_items = createTutorialShopList();

  const enemy = new Player("訓練用スライム", 1);
  enemy.job = "訓練用スライム";
  enemy.max_hp = 120;
  enemy.hp = 120;
  enemy.base_attack = 16;
  enemy.base_defense = 4;
  enemy.coins = 0;
  enemy.isDojoEnemy = true;
  enemy.dojoEnemyId = "slime";
  enemy.dojoEnemyImage = "Assets/dojo/enemies/slime.png";
  enemy.dojoEnemyScale = 1.0;
  botWS.player = enemy;

  const match = new Match(humanWS, botWS);
  match.matchType = "tutorial";
  humanWS.currentMatch = match;
  botWS.currentMatch = match;
  human.shop_items = createTutorialShopList();
  match.sendItemList(humanWS, human);
  safeSend(humanWS, { type: "coin_info", coins: human.coins });

  const handleTutorialMessage = async (raw2) => {
    const m = JSON.parse(raw2.toString());
    const sock = humanWS;
    const P = match.P1;
    if (match.ended) return;

    if (m.type === "action") {
      await match.handleAction(sock, m.action);
      return;
    }
    if (m.type === "request_status_detail") {
      const self = sock === match.p1 ? match.P1 : match.P2;
      const enemy = self === match.P1 ? match.P2 : match.P1;
      match.sendStatusDetail(sock, self, enemy, m.target === "enemy" ? "enemy" : "self");
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
      safeSend(sock, { type: "shop_list", items: ensureTutorialShopList(P) });
      return;
    }
    if (m.type === "buy_item") {
      ensureTutorialShopList(P);
      match.buyItem(sock, m.index);
      return;
    }
    if (m.type === "shop_reroll") {
      safeSend(sock, { type: "shop_list", items: ensureTutorialShopList(P) });
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

  humanWS.on("message", handleTutorialMessage);

  safeSend(humanWS, buildMatchStartPayload(humanWS.player, botWS.player, {
    mode: "tutorial",
    tutorial: true,
    enemy_job: "訓練用スライム"
  }));
  match.sendInitialStatusSnapshot();
  match.scheduleCpuTurn(900);
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

function isNormalEquipmentItem(item) {
  return !!item?.is_equip && item.equip_type === "normal";
}

function isCpuCoinEquip(item) {
  return isNormalEquipmentItem(item) && (
    item.effect_type === "coin_per_turn" ||
    item.equip_category === "coin" ||
    Number(item.coin_per_turn ?? item.coin ?? 0) > 0
  );
}

function getCpuCoinEquipValue(item) {
  if (!item) return 0;
  return Number(item.power ?? item.coin_per_turn ?? item.coin ?? 0);
}

function isCpuAttackEquip(item) {
  const type = String(item?.effect_type ?? item?.equip_category ?? "");
  return type.includes("攻撃") || type.toUpperCase().includes("ATK");
}

function isCpuDefenseEquip(item) {
  const type = String(item?.effect_type ?? item?.equip_category ?? "");
  return type.includes("防御") || type.toUpperCase().includes("DEF");
}

function countCpuAlchemistCoinEquips(P) {
  const equips = [
    P?.equipment,
    ...((P?.extra_equipments ?? []).filter(Boolean)),
    ...((P?.equipment_inventory ?? []).filter(Boolean)),
  ];
  return equips.filter(isCpuCoinEquip).length;
}

function getCpuAlchemistEnemyEquipBias(enemyJob, item) {
  const enemy = String(enemyJob ?? "");
  const attack = isCpuAttackEquip(item);
  const defense = isCpuDefenseEquip(item);
  if (["戦士", "狂人", "弓兵", "召喚士"].includes(enemy)) {
    if (defense) return 1900;
    if (attack) return 650;
  }
  if (["騎士", "僧侶", "錬金術師"].includes(enemy)) {
    if (attack) return 1800;
    if (defense) return 500;
  }
  if (["魔導士", "陰陽師", "盗賊"].includes(enemy)) {
    if (attack) return 1200;
    if (defense) return 900;
  }
  return 0;
}

function isCpuOnmyojiTalisman(item) {
  return !!item && (
    item.is_onmyoji_item === true ||
    item.effect_type === "ONMYOJI_TALISMAN"
  );
}

function countCpuOnmyojiTalismans(P) {
  return (P?.items ?? []).filter(isCpuOnmyojiTalisman).length;
}

function countCpuPositiveBuffs(P) {
  return (P?.active_buffs ?? []).filter(b => {
    if (!b) return false;
    if (b.unremovable || b.passive) return false;
    if (b.is_debuff || b.debuff) return false;
    const type = String(b.type ?? b.name ?? "");
    if (type.includes("低下") || type.includes("毒") || type.includes("封印")) return false;
    return true;
  }).length;
}

function countCpuPoisonDots(P) {
  const dots = (P?.dot_effects ?? []).filter(d => {
    const key = `${d?.name ?? ""} ${d?.type ?? ""} ${d?.source ?? ""}`.toLowerCase();
    return key.includes("毒") || key.includes("poison");
  }).length;
  const buffs = (P?.active_buffs ?? []).filter(b => {
    const key = `${b?.name ?? ""} ${b?.type ?? ""}`.toLowerCase();
    return key.includes("毒") || key.includes("poison");
  }).length;
  return dots + buffs;
}

function countCpuRemovableDebuffs(P) {
  const active = (P?.active_buffs ?? []).filter(b => {
    if (!b || b.unremovable || b.passive) return false;
    const type = String(b.type ?? b.name ?? "");
    return b.is_debuff || b.debuff || type.includes("低下") || type.includes("封印") || type.includes("毒");
  }).length;
  const freezes = Array.isArray(P?.freeze_debuffs) ? P.freeze_debuffs.length : 0;
  const defs = Array.isArray(P?.defense_debuffs) ? P.defense_debuffs.length : 0;
  return active + freezes + defs + countCpuPoisonDots(P);
}

function getCpuOnmyojiTalismanScore(P, item) {
  if (!isCpuOnmyojiTalisman(item)) return -Infinity;
  const w = CPU_AI_WEIGHTS.onmyoji ?? {};
  const rankBonus = item.shikigami_rank === "high"
    ? Number(w.highRankBonus ?? 1700)
    : Number(w.lowRankBonus ?? 750);
  const hpRate = Number(P?.hp ?? 0) / Math.max(1, Number(P?.max_hp ?? 1));
  const enemy = P?.opponent;
  const enemyHpRate = Number(enemy?.hp ?? 0) / Math.max(1, Number(enemy?.max_hp ?? 1));
  const enemyJobKey = getCpuJobKeyByName(enemy?.job);
  const name = String(item.shikigami_name ?? item.name ?? "");
  const enemyBuffs = countCpuPositiveBuffs(enemy);
  const poisonDots = countCpuPoisonDots(P);
  const debuffs = countCpuRemovableDebuffs(P);
  let score = Number(w.baseTalismanScore ?? 6800) + rankBonus;
  if (hpRate < 0.45) score += item.shikigami_rank === "high"
    ? Number(w.lowHpHighRankBonus ?? 1800)
    : Number(w.lowHpLowRankBonus ?? 700);
  if (enemyHpRate < 0.5) score += item.shikigami_rank === "high"
    ? Number(w.enemyLowHpHighRankBonus ?? 1200)
    : Number(w.enemyLowHpLowRankBonus ?? 450);
  if (name.includes("猫又")) {
    if (enemyJobKey === 5) score += Number(w.catVsMageBonus ?? 5200);
    if (enemyJobKey === 8 || isCpuSummonerJobName(enemy?.job)) score += Number(w.catVsArcherOrSummonerBonus ?? 900);
    if (enemyHpRate < 0.7) score += Number(w.catEnemyDamagedBonus ?? 650);
  } else if (name.includes("九尾")) {
    if (enemyBuffs >= 2) score += Number(w.kyuubiManyBuffsBonus ?? 5200) + enemyBuffs * Number(w.kyuubiPerBuffBonus ?? 750);
    else if (enemyBuffs === 1) score += Number(w.kyuubiOneBuffBonus ?? 1700);
    if (enemyJobKey === 5 || enemyJobKey === 10) score += Number(w.kyuubiVsMageOrMadBonus ?? 900);
  } else if (name.includes("白龍")) {
    if (poisonDots >= 2) score += Number(w.whiteDragonTwoPoisonBonus ?? 7200);
    else if (poisonDots === 1) score += Number(w.whiteDragonOnePoisonBonus ?? 3600);
    if (debuffs >= 2) score += Number(w.whiteDragonManyDebuffBonus ?? 2600);
    if (enemyJobKey === 8 && poisonDots > 0) score += Number(w.whiteDragonVsArcherPoisonBonus ?? 2800);
    if (hpRate < 0.65) score += Number(w.whiteDragonLowHpBonus ?? 2200);
  } else if (name.includes("玄武")) {
    if ([1, 8, 10].includes(enemyJobKey)) score += Number(w.genbuVsPhysicalBonus ?? 1250);
  } else if (name.includes("烏天狗")) {
    if ([1, 5, 8, 10].includes(enemyJobKey)) score += Number(w.tenguVsThreatBonus ?? 950);
  } else if (name.includes("鬼火")) {
    if (enemyHpRate > 0.55) score += Number(w.onibiHealthyEnemyBonus ?? 800);
  }
  return score;
}

function getCpuNormalEquipMaxSlots(P, match = null) {
  if (match?.matchType !== "dojo") return 1;
  return Math.max(1, Number(P?.dojoEquipSlots?.equipment ?? 1));
}

function getCpuNormalEquipCount(P) {
  let count = 0;
  if (P?.equipment) count += 1;
  if (Array.isArray(P?.extra_equipments)) {
    count += P.extra_equipments.filter(Boolean).length;
  }
  return count;
}

function isCpuDollChargeCostume(item) {
  return !!item?.is_doll_costume && item.effect_type === "CHARGE";
}

function isCpuDollRepairItem(item) {
  return !!item?.is_doll_item;
}

function getCpuDollBoroboroCostumeCount(P, { chargeOnly = false } = {}) {
  if (!P?.doll?.costumes) return 0;
  return Object.values(P.doll.costumes).filter(costume => {
    if (!costume || costume.condition !== "boroboro") return false;
    if (chargeOnly && !isCpuDollChargeCostume(costume)) return false;
    return true;
  }).length;
}

function getCpuDollChargeCostumeCount(P, { includeInventory = false, healthyOnly = true } = {}) {
  if (!P?.doll) return 0;
  const costumes = Object.values(P.doll.costumes ?? {});
  if (includeInventory) costumes.push(...(P.special_inventory ?? []).filter(it => it?.is_doll_costume));
  return costumes.filter(costume => {
    if (!isCpuDollChargeCostume(costume)) return false;
    if (healthyOnly && (costume.is_broken || costume.condition === "boroboro")) return false;
    return true;
  }).length;
}

function getCpuDollRepairItemCount(P) {
  return (P?.items ?? []).filter(isCpuDollRepairItem).length;
}

function getCpuDollCostumeScore(P, item) {
  if (!item?.is_doll_costume) return -Infinity;
  const current = P?.doll?.costumes?.[item.part] ?? null;
  const equippedChargeCount = getCpuDollChargeCostumeCount(P, { includeInventory: false });
  const ownedChargeCount = getCpuDollChargeCostumeCount(P, { includeInventory: true });
  const star = Number(item.star ?? 1);
  let score = star * 140 + Number(item.attack ?? 0) * 8 + Number(item.defense ?? 0) * 8;

  if (isCpuDollChargeCostume(item)) {
    if (equippedChargeCount <= 0 && !isCpuDollChargeCostume(current)) score += 13000;
    else if (equippedChargeCount < 2 && !isCpuDollChargeCostume(current)) score += 7200;
    else if (ownedChargeCount < 2) score += 4600;
    else if (ownedChargeCount < 3 && Number(P?.turn_count ?? 0) <= 5 && Number(P?.coins ?? 0) >= 18) score += 1100;
    else if (ownedChargeCount >= 3) score -= 1600;
  }

  if (current) {
    score -= Number(current.star ?? 1) * 120;
    score -= Number(current.attack ?? 0) * 7 + Number(current.defense ?? 0) * 7;
    if (current.condition === "boroboro" || current.is_broken) score += 2200;
    if (isCpuDollChargeCostume(current) && !isCpuDollChargeCostume(item)) score -= 6200;
  }

  return score;
}

function isBetterDollCostumeForCpu(P, item, current) {
  if (!item?.is_doll_costume) return false;
  if (!current) return true;
  const turn = Number(P?.turn_count ?? 0);
  const chargeEquipped = getCpuDollChargeCostumeCount(P, { includeInventory: false });
  const itemIsCharge = isCpuDollChargeCostume(item);
  const currentIsCharge = isCpuDollChargeCostume(current);

  if (itemIsCharge) {
    if (!currentIsCharge && chargeEquipped < 2) return true;
    if (currentIsCharge) return Number(item.star ?? 1) > Number(current.star ?? 1);
    return turn <= 5 && chargeEquipped < 3 && Number(item.star ?? 1) >= Number(current.star ?? 1) + 2;
  }

  if (currentIsCharge) return false;
  if (current.condition === "boroboro" || current.is_broken) return true;
  if (turn > 5) return false;
  if (Number(item.star ?? 1) < Number(current.star ?? 1) + 2) return false;
  return getCpuDollCostumeScore(P, item) > getCpuDollCostumeScore(P, current) + 80;
}

function pickCpuDollCostumeEquipCandidate(P, candidates) {
  if (!P?.doll || P.doll.is_broken) return null;
  const scored = (candidates ?? [])
    .filter(it => it?.is_doll_costume)
    .filter(it => isBetterDollCostumeForCpu(P, it, P.doll?.costumes?.[it.part] ?? null))
    .map(it => ({ item: it, score: getCpuDollCostumeScore(P, it) }))
    .filter(entry => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.item ?? null;
}

function getCpuEquipScore(item) {
  const atk = Number(item?.power ?? item?.atk ?? item?.equip_power ?? 0);
  const def = Number(item?.def ?? 0);
  const star = Number(item?.star ?? 0);
  return atk + def + star * 0.01;
}

function getCpuEquipScoreForPlayer(P, item) {
  let score = getCpuEquipScore(item);
  const jobKey = getCpuJobKeyByName(P?.job);
  if (jobKey === 4 && isCpuCoinEquip(item)) {
    score += 100 + getCpuCoinEquipValue(item) * 20;
    if (Number(P?.level ?? 1) < 3) score += 35;
  }
  if (jobKey === 6 && isCpuCoinEquip(item)) {
    score += 85 + getCpuCoinEquipValue(item) * 18;
  }
  return score;
}

function isBetterEquipForCpu(P, newItem, currentItem) {
  if (!currentItem) return true;
  const jobKey = getCpuJobKeyByName(P?.job);
  if ((jobKey === 4 || jobKey === 6) && (isCpuCoinEquip(newItem) || isCpuCoinEquip(currentItem))) {
    return getCpuEquipScoreForPlayer(P, newItem) > getCpuEquipScoreForPlayer(P, currentItem);
  }
  return isBetterEquip(newItem, currentItem);
}

function pickCpuNormalEquipCandidate(P, match = null) {
  const candidates = (P?.equipment_inventory ?? []).filter(isNormalEquipmentItem);
  if (candidates.length === 0) return null;

  const maxSlots = getCpuNormalEquipMaxSlots(P, match);
  const equippedCount = getCpuNormalEquipCount(P);
  if (equippedCount < maxSlots) {
    return candidates.reduce((best, item) =>
      !best || getCpuEquipScoreForPlayer(P, item) > getCpuEquipScoreForPlayer(P, best) ? item : best
    , null);
  }

  return candidates.find(it => isBetterEquipForCpu(P, it, P.equipment)) ?? null;
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
  const key = getArrowStackKey(it);
  if (key.includes("poison")) return 7;
  if (key.includes("def_down") || key.includes("defdown")) return 5;
  if (key.includes("freeze")) return 4;
  if (key.includes("counter")) return 3;
  if (key.includes("normal")) return 1;

  // 名前ベース（ARROW_DATA の name に依存）
  if (it.name?.includes("毒")) return 5;
  if (it.name?.includes("防御低下")) return 4;
  if (it.name?.includes("氷結")) return 3;
  if (it.name?.includes("反撃")) return 2;

  return 1; // 普通の矢
}

function isCpuPoisonArrow(it) {
  if (!isArrowItem(it)) return false;
  const key = getArrowStackKey(it);
  return key.includes("poison") || String(it.name ?? "").includes("毒");
}

function isCpuArcherNoConsumeActive(P) {
  return !!P?.archer_no_consume_permanent || Number(P?.archer_no_consume_rounds ?? 0) > 0;
}

function getCpuEquippedArrows(P) {
  return [P?.arrow, P?.arrow2].filter(isArrowItem);
}

function getCpuOwnedArrows(P, { includeEquipped = true } = {}) {
  if (!P) return [];
  normalizePlayerArrowStorage(P);
  const list = includeEquipped ? getCpuEquippedArrows(P) : [];
  list.push(...((P.arrow_inventory ?? []).filter(isArrowItem)));
  return list;
}

function scoreCpuOwnedArrowForEquip(P, arrow, { archerSkill2Used = false, penalizeAlreadyEquipped = true } = {}) {
  if (!isArrowItem(arrow) || getArrowAmmoCount(arrow) <= 0) return -Infinity;
  const equipped = getCpuEquippedArrows(P);
  const equippedKeys = new Set(equipped.map(getArrowStackKey));
  const key = getArrowStackKey(arrow);
  let score = getArrowPriority(arrow) * 1000 + getArrowAmmoCount(arrow) * 20;
  if (archerSkill2Used && Number(P?.arrow_slots ?? 1) >= 2) {
    const hasPoison = equipped.some(isCpuPoisonArrow);
    if (!hasPoison && isCpuPoisonArrow(arrow)) score += 9000;
    if (hasPoison && !isCpuPoisonArrow(arrow) && !equippedKeys.has(key)) score += 5200;
    if (equipped.length < 2 && !equippedKeys.has(key)) score += 3600;
  }
  if (penalizeAlreadyEquipped && equippedKeys.has(key)) score -= 5000;
  return score;
}

// =========================================================
// ★ CPU用：人形スキル2のHP消費量自動決定
// =========================================================
function isCpuJob(P, jobKey) {
  return !!P && P.job === JOB_TEMPLATE?.[jobKey]?.name;
}

function isCpuArcherJob(P) {
  return isCpuJob(P, 8) || P?.job === "弓兵";
}

function isCpuMageJob(P) {
  return isCpuJob(P, 5) || P?.job === "魔導士";
}

function getCpuArrowAmmoTotal(P, { includeInventory = true } = {}) {
  if (!P) return 0;
  normalizePlayerArrowStorage(P);
  const arrows = [P.arrow, P.arrow2];
  if (includeInventory) arrows.push(...(P.arrow_inventory ?? []));
  return arrows
    .filter(isArrowItem)
    .reduce((sum, it) => sum + Math.max(0, getArrowAmmoCount(it)), 0);
}

function getCpuArrowEquipSlot(P, candidate = null) {
  if (!P?.arrow) return 1;
  if ((P.arrow_slots ?? 1) >= 2 && !P.arrow2) return 2;
  if ((P.arrow_slots ?? 1) >= 2 && P.arrow && P.arrow2) {
    if (isArrowItem(candidate)) {
      const wantsPoison = isCpuPoisonArrow(candidate);
      if (wantsPoison && !isCpuPoisonArrow(P.arrow)) return 1;
      if (wantsPoison && !isCpuPoisonArrow(P.arrow2)) return 2;
    }
    return getArrowPriority(P.arrow) <= getArrowPriority(P.arrow2) ? 1 : 2;
  }
  return 1;
}

function getCpuBestShopArrow(P, { urgent = false, state = null } = {}) {
  if (!P) return null;
  if (isCpuArcherNoConsumeActive(P)) return null;
  const coins = Number(P.coins ?? 0);
  const equipped = getCpuEquippedArrows(P);
  const ownedKeys = new Set(getCpuOwnedArrows(P).map(getArrowStackKey));
  const hasPoison = state?.hasPoisonArrow ?? equipped.some(isCpuPoisonArrow);
  const archerSkill2Used = state?.archerSkill2Used ?? hasCpuUsedSkill(P, "archer_2");
  const needsSecond =
    state?.needsArcherSecondArrow ??
    (archerSkill2Used && Number(P.arrow_slots ?? 1) >= 2 && equipped.length < 2);
  const needsPoison = state?.needsArcherPoisonArrow ?? (archerSkill2Used && !hasPoison);
  const lowEquippedPriority = equipped.length
    ? Math.min(...equipped.map(getArrowPriority))
    : 0;

  const candidates = (P.shop_items ?? [])
    .filter(it => it && !(it.sold_out || it.soldOut || it.shop_sold_out))
    .filter(isArrowItem)
    .filter(it => Number(it.price ?? 0) <= coins)
    .map(it => {
      const key = getArrowStackKey(it);
      const ownedSame = ownedKeys.has(key);
      let score = getArrowPriority(it) * 1000 - Number(it.price ?? 0) * 4;
      if (needsPoison && isCpuPoisonArrow(it)) score += 12000;
      if (needsSecond && !ownedSame) score += 6200;
      if (archerSkill2Used && !isCpuPoisonArrow(it) && hasPoison && !ownedSame) score += 3400;
      if (urgent) score += 4200;
      if (ownedSame && !urgent && !state?.needsArrowShop) score -= 4200;
      if (!urgent && equipped.length >= Number(P.arrow_slots ?? 1) && getArrowPriority(it) <= lowEquippedPriority) {
        score -= 5000;
      }
      return { item: it, score };
    })
    .filter(entry => Number.isFinite(entry.score) && entry.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      getArrowPriority(b.item) - getArrowPriority(a.item) ||
      Number(a.item?.price ?? 0) - Number(b.item?.price ?? 0)
    );

  return candidates[0]?.item ?? null;
}

function canCpuRerollAndStillAffordArrow(P) {
  const minArrowPrice = Math.min(
    ...Object.values(ARROW_DATA ?? {}).map(it => Number(it?.price ?? Infinity))
  );
  return Number(P?.coins ?? 0) >= minArrowPrice + 5;
}

function isCpuHealItem(item) {
  return item?.effect_type === "HP";
}

function isCpuPriestRegenItem(item) {
  return !!item?.is_priest_item && item.priest_effect === "regen";
}

function isCpuPriestBlessingAttackItem(item) {
  return !!item?.is_priest_item && item.priest_effect === "blessing_attack";
}

function isCpuPriestBlessingHealItem(item) {
  return !!item?.is_priest_item && item.priest_effect === "blessing_heal";
}

function isCpuPriestSkill3Ready(state) {
  const blessing = Number(state?.blessingCount ?? 0);
  const enemyHpRate = Number(state?.enemyHpRate ?? 1);
  const hpRate = Number(state?.hpRate ?? 1);
  if (Number(state?.level ?? 1) < 3 || !state?.canSkill3) return false;
  if (blessing >= 18) return true;
  if (blessing >= 12 && enemyHpRate <= 0.42) return true;
  if (blessing >= 14 && hpRate >= 0.72 && enemyHpRate <= 0.62) return true;
  return false;
}

function getCpuPriestRegenRounds(P) {
  return Math.max(
    0,
    ...((P?.active_buffs ?? [])
      .filter(b =>
        b?.type === "継続回復" &&
        String(b?.source ?? b?.name ?? "") === "聖なる香"
      )
      .map(b => Number(b.rounds ?? b.duration ?? 0)))
  );
}

function getCpuPriestRegenItemCount(P) {
  return (P?.items ?? []).filter(isCpuPriestRegenItem).length;
}

function isCpuUsableInventoryItem(item) {
  if (!item) return false;
  if (item.is_equip) return false;
  if (item.is_arrow || item.equip_type === "arrow") return false;
  if (item.equip_type === "mage_equip" || item.equip_type === "alchemist_unique") return false;
  if (item.is_doll_costume) return false;
  return true;
}

function countCpuStoredConsumables(P) {
  return (P?.items ?? []).filter(isCpuUsableInventoryItem).length;
}

function hasCpuUsedSkill(P, key) {
  return !!P?.used_skill_set?.has?.(key);
}

function getCpuShopCountThisTurn(P) {
  if (!P) return 0;
  return Number(P._cpuShopTurn ?? -1) === Number(P.turn_count ?? 0)
    ? Number(P._cpuShopCount ?? 0)
    : 0;
}

function markCpuShopAction(P) {
  if (!P) return;
  const turn = Number(P.turn_count ?? 0);
  if (Number(P._cpuShopTurn ?? -1) !== turn) {
    P._cpuShopTurn = turn;
    P._cpuShopCount = 0;
  }
  P._cpuShopCount = Number(P._cpuShopCount ?? 0) + 1;
}

function getCpuNormalEquipCombineKey(item) {
  if (!isNormalEquipmentItem(item)) return "";
  return `${Number(item.star ?? 1)}:${String(item.equip_category ?? item.effect_type ?? "")}`;
}

function pickCpuNormalEquipCombinePair(P) {
  if (getCpuJobKeyByName(P?.job) !== 7) return null;
  const entries = [
    ...(P?.equipment ? [{ item: P.equipment, source: "equipped" }] : []),
    ...((P?.equipment_inventory ?? []).map(item => ({ item, source: "inventory" }))),
  ].filter(entry =>
    isNormalEquipmentItem(entry.item) &&
    Number(entry.item?.star ?? 1) < NORMAL_EQUIP_MAX_STAR &&
    entry.item?.uid
  );

  const groups = new Map();
  for (const entry of entries) {
    const key = getCpuNormalEquipCombineKey(entry.item);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }

  let best = null;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) =>
      getCpuEquipScoreForPlayer(P, a.item) - getCpuEquipScoreForPlayer(P, b.item)
    );
    const pair = [list[0], list[1]];
    const score =
      Number(pair[0].item.star ?? 1) * 100 -
      (pair[0].source === "equipped" || pair[1].source === "equipped" ? 30 : 0) +
      getCpuEquipScoreForPlayer(P, pair[0].item) +
      getCpuEquipScoreForPlayer(P, pair[1].item);
    if (!best || score > best.score) {
      best = { uid1: pair[0].item.uid, uid2: pair[1].item.uid, score };
    }
  }

  return best ? { uid1: best.uid1, uid2: best.uid2 } : null;
}

function pickCpuAlchemistFusionUids(P) {
  if (getCpuJobKeyByName(P?.job) !== 7 || !P?.getAlchemistFusionCandidates) return [];
  return P.getAlchemistFusionCandidates()
    .filter(entry => entry?.obj?.uid)
    .map(entry => ({
      uid: String(entry.obj.uid),
      score: getCpuEquipScoreForPlayer(P, entry.obj) + Number(entry.obj.star ?? 1) * 18,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(entry => entry.uid);
}

function getCpuLevelPlan(P) {
  const level = Number(P?.level ?? 1);
  const nextExp = LEVEL_REQUIREMENTS[level] ?? null;
  const exp = Number(P?.exp ?? 0);
  const coins = Number(P?.coins ?? 0);
  if (nextExp == null || level >= 3) {
    return {
      level,
      exp,
      nextExp: null,
      shortage: 0,
      canByExp: false,
      canByCoins: false,
      canNow: false,
    };
  }
  const shortage = Math.max(0, Number(nextExp) - exp);
  return {
    level,
    exp,
    nextExp: Number(nextExp),
    shortage,
    canByExp: shortage <= 0,
    canByCoins: shortage > 0 && coins >= shortage,
    canNow: shortage <= 0 || coins >= shortage,
  };
}

const CPU_DOLL_LEVEL3_COIN_MIN_EXP = 12;
const CPU_DOLL_BURST_THREAT_JOB_KEYS = new Set([1, 5, 10]);

function isCpuDollLevel3CoinPushReady(P) {
  const levelPlan = getCpuLevelPlan(P);
  return (
    levelPlan.level === 2 &&
    levelPlan.exp >= CPU_DOLL_LEVEL3_COIN_MIN_EXP &&
    hasCpuUsedSkill(P, "doll_2") &&
    !hasCpuUsedSkill(P, "doll_3")
  );
}

function isCpuDollBurstThreatJob(jobName) {
  return CPU_DOLL_BURST_THREAT_JOB_KEYS.has(getCpuJobKeyByName(jobName));
}

function isCpuSummonerJobName(jobName) {
  return String(jobName ?? "") === String(JOB_TEMPLATE?.[9]?.name ?? "召喚士");
}

function getCpuSummonerDragonList(P) {
  if (!isCpuSummonerJobName(P?.job)) return [];
  return ensureSummonerState(P)?.dragons ?? [];
}

function getCpuSummonerStateData(P) {
  const dragons = getCpuSummonerDragonList(P);
  const eggs = dragons.filter(d => d?.stage === "egg");
  const juveniles = dragons.filter(d => d?.stage === "juvenile");
  const adults = dragons.filter(d => d?.stage === "adult");
  const feedCount = (P?.items ?? []).filter(item => item?.is_summoner_feed).length;
  return {
    dragons,
    dragonCount: dragons.length,
    eggCount: eggs.length,
    juvenileCount: juveniles.length,
    adultCount: adults.length,
    hasNonEgg: juveniles.length + adults.length > 0,
    needsGrowth: eggs.length + juveniles.length > 0,
    feedCount,
  };
}

function pickCpuSummonerEggType(P) {
  const owned = getSummonerOwnedTypes(P);
  const enemyJobKey = getCpuJobKeyByName(P?.opponent?.job);
  const priority = enemyJobKey === 1 || enemyJobKey === 5 || enemyJobKey === 10
    ? ["fafnir", "tiamat", "nidhogg"]
    : enemyJobKey === 3 || enemyJobKey === 7
      ? ["nidhogg", "tiamat", "fafnir"]
      : ["tiamat", "nidhogg", "fafnir"];
  return priority.find(type => !owned.has(type)) ??
    SUMMONER_DRAGON_TYPES.find(type => !owned.has(type)) ??
    null;
}

function pickCpuSummonerGrowthType(P) {
  const dragons = getCpuSummonerDragonList(P);
  const nonEgg = dragons.filter(d => d?.stage === "juvenile");
  if (nonEgg.length) {
    nonEgg.sort((a, b) =>
      Number(b.growth ?? 0) - Number(a.growth ?? 0) ||
      ["tiamat", "nidhogg", "fafnir"].indexOf(String(a.type)) -
      ["tiamat", "nidhogg", "fafnir"].indexOf(String(b.type))
    );
    return nonEgg[0]?.type ?? null;
  }
  const eggs = dragons.filter(d => d?.stage === "egg");
  if (eggs.length) {
    eggs.sort((a, b) =>
      Number(a.hatch_turns_remaining ?? SUMMONER_HATCH_TURNS) -
      Number(b.hatch_turns_remaining ?? SUMMONER_HATCH_TURNS)
    );
    return eggs[0]?.type ?? null;
  }
  return null;
}

function pickCpuSummonerFeedTargetType(P) {
  const dragons = getCpuSummonerDragonList(P).filter(d => d && d.stage === "juvenile");
  if (!dragons.length) return null;
  const front = ensureSummonerState(P)?.front ?? null;
  dragons.sort((a, b) => {
    const aFront = String(a.type) === String(front) ? 1 : 0;
    const bFront = String(b.type) === String(front) ? 1 : 0;
    const aProgress = Number(a.growth ?? 0);
    const bProgress = Number(b.growth ?? 0);
    return bFront - aFront || bProgress - aProgress;
  });
  return dragons[0]?.type ?? null;
}

function pickCpuSummonerFrontType(P) {
  const dragons = getCpuSummonerDragonList(P).filter(d => d?.stage !== "egg");
  if (!dragons.length) return null;
  const enemy = P?.opponent ?? null;
  const enemyHpRate = Number(enemy?.hp ?? 0) / Math.max(1, Number(enemy?.max_hp ?? 1));
  const hpRate = Number(P?.hp ?? 0) / Math.max(1, Number(P?.max_hp ?? 1));
  const enemyJobKey = getCpuJobKeyByName(enemy?.job);
  const has = type => dragons.find(d => d.type === type) ?? null;
  if ((enemyHpRate < 0.45 || dragons.some(d => d.stage === "adult" && d.type === "tiamat")) && has("tiamat")) return "tiamat";
  if ((hpRate < 0.58 || enemyJobKey === 1 || enemyJobKey === 5 || enemyJobKey === 10) && has("fafnir")) return "fafnir";
  if (has("nidhogg")) return "nidhogg";
  return dragons.find(d => d.stage === "adult")?.type ?? dragons[0]?.type ?? null;
}

function prepareCpuSummonerAction(P, action = null) {
  if (!isCpuSummonerJobName(P?.job)) return false;
  const state = ensureSummonerState(P);
  if (!state) return false;
  const front = pickCpuSummonerFrontType(P);
  if (front) state.front = front;
  if (action?.type === "skill" && Number(action.id ?? 0) === 1) {
    P.pending_summoner_egg_type = pickCpuSummonerEggType(P);
  } else if (action?.type === "skill" && Number(action.id ?? 0) === 2) {
    P.pending_summoner_growth_type = pickCpuSummonerGrowthType(P);
  }
  return true;
}

function getCpuItemUseScore(P, item) {
  if (!isCpuUsableInventoryItem(item)) return -Infinity;
  const jobKey = getCpuJobKeyByName(P?.job);
  const hpRate = Number(P?.hp ?? 0) / Math.max(1, Number(P?.max_hp ?? 1));
  if (isCpuHealItem(item) && Number(P?.hp ?? 0) >= Number(P?.max_hp ?? 0)) return -Infinity;

  if (jobKey === 3 && item.is_priest_item) {
    const blessing = Math.max(0, Number(P?.blessing_count ?? 0));
    const enemy = P?.opponent ?? null;
    const enemyHpRate = Number(enemy?.hp ?? 0) / Math.max(1, Number(enemy?.max_hp ?? 1));
    const usedSkill3 = hasCpuUsedSkill(P, "priest_3");
    if (isCpuPriestRegenItem(item)) {
      const regenRounds = getCpuPriestRegenRounds(P);
      if (regenRounds <= 0) return 10800;
      if (regenRounds <= 3) return 8600;
      if (hpRate < 0.62) return 5200;
      return -Infinity;
    }
    if (!usedSkill3) return -Infinity;
    if (isCpuPriestBlessingHealItem(item)) {
      if (blessing >= 20 && hpRate < 0.58) return 9000;
      if (blessing >= 24 && hpRate < 0.78) return 4300;
      return -Infinity;
    }
    if (isCpuPriestBlessingAttackItem(item)) {
      if (blessing >= 18 || (blessing >= 10 && enemyHpRate < 0.38)) return 5600 + blessing * 80;
      return -Infinity;
    }
    return -Infinity;
  }

  if (jobKey === 10 && item.is_mad_special_item) {
    const selfDamage = Number(item.self_damage ?? item.power ?? 0);
    const hasGuts = !!P?.madman_guts;
    if (!hasGuts && Number(P?.hp ?? 0) <= selfDamage + 2) return -Infinity;
    const mad = buildMadStateData(P);
    return (mad?.is_mad ? 5200 : 9800) + selfDamage * 80;
  }

  if (jobKey === 6 && isCpuOnmyojiTalisman(item)) {
    return getCpuOnmyojiTalismanScore(P, item);
  }

  if (jobKey === 9 && isCpuSummonerJobName(P?.job) && item.is_summoner_feed) {
    const summoner = getCpuSummonerStateData(P);
    if (summoner.juvenileCount <= 0) return -Infinity;
    const targetType = pickCpuSummonerFeedTargetType(P);
    if (!targetType) return -Infinity;
    const target = getSummonerDragon(P, targetType);
    const nearEvolution = SUMMONER_GROWTH_MAX - Number(target?.growth ?? 0) <= SUMMONER_FEED_GROWTH;
    return 7200 + (nearEvolution ? 2600 : 0) + Math.max(0, 3 - summoner.adultCount) * 600;
  }

  if (jobKey === 9 && !isCpuSummonerJobName(P?.job) && isCpuDollRepairItem(item)) {
    if (!P?.doll) return -Infinity;
    const boroboroCount = getCpuDollBoroboroCostumeCount(P);
    const boroboroChargeCount = getCpuDollBoroboroCostumeCount(P, { chargeOnly: true });
    if (P.doll.is_broken) return 11000;
    const dollRate =
      Number(P.doll.durability ?? 0) /
      Math.max(1, Number(P.doll.max_durability ?? 1));
    const burstThreat = isCpuDollBurstThreatJob(P?.opponent?.job);
    const earlyUseLine = burstThreat ? 0.92 : 0.9;
    if (dollRate < 0.5) return 11800 + boroboroCount * 650;
    if (dollRate < 0.72) return 9800 + boroboroCount * 600;
    if (dollRate < 0.82) return 8400 + boroboroCount * 520;
    if (dollRate < earlyUseLine) return (burstThreat ? 7600 : 6200) + boroboroCount * 460;
    if (boroboroChargeCount > 0) return 7200 + boroboroChargeCount * 900;
    if (boroboroCount > 0) return 4400 + boroboroCount * 500;
    return -Infinity;
  }

  if (isCpuHealItem(item)) {
    const power = Number(item.power ?? item.heal ?? 0);
    if (hpRate < 0.35) return 9200 + power * 35;
    if (hpRate < 0.6) return 6200 + power * 25;
    if (hpRate < 0.78) return 2600 + power * 12;
    return 350 + power;
  }

  if (item.effect_type === "攻撃力" || item.effect_type === "ATK") return 2200 + Number(item.power ?? 0) * 40;
  if (item.effect_type === "防御力" || item.effect_type === "DEF") return 1900 + Number(item.power ?? 0) * 35;
  return 1000 + Number(item.power ?? 0) * 10;
}

function pickCpuUsableItemCandidate(P) {
  const candidates = (P?.items ?? [])
    .filter(isCpuUsableInventoryItem)
    .map(item => ({ item, score: getCpuItemUseScore(P, item) }))
    .filter(entry => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.item ?? null;
}

function shouldCpuHoldUsableItem(state) {
  const jobKey = getCpuJobKeyByName(state?.job);
  const danger = Number(state?.hpRate ?? 1) < 0.35;
  const lethalThreat = Number(state?.enemyAttack ?? 0) >= Number(state?.hp ?? 0);
  if (
    jobKey === 3 &&
    state?.usableItem?.is_priest_item &&
    !state?.usableItemIsPriestRegen &&
    !state?.priestSkill3Used
  ) {
    return true;
  }
  if (jobKey === 4 && !state?.thiefSkill3Used && !danger && !lethalThreat) {
    return true;
  }
  return false;
}

function shouldCpuLevelUpEarly(state) {
  if (!state?.canLevelUpNow) return false;
  if (state.canLevelUpByExp) return true;

  const jobKey = getCpuJobKeyByName(state?.job);
  const level = Number(state?.level ?? 1);
  const exp = Number(state?.exp ?? 0);
  const itemCount = Number(state?.thiefItemCount ?? 0);
  const hpRate = Number(state?.hpRate ?? 1);
  const shortage = Number(state?.levelShortage ?? 0);
  const coins = Number(state?.coins ?? 0);
  if (shortage <= 0 || coins < shortage || level >= 3) return false;

  if (jobKey === 4) {
    if (hpRate < 0.65) return true;
    if (level === 1) return exp >= 14 && coins - shortage >= 3;
    if (level === 2) return exp >= 18 || itemCount >= 2 || hpRate < 0.82;
  }

  if (jobKey === 10) {
    if (hpRate < 0.58) return true;
    if (level === 1) return exp >= 12 && coins - shortage >= 0;
    if (level === 2) return exp >= 14 || coins - shortage >= 8;
  }

  if (jobKey === 8) {
    if (level === 1) return exp >= 10 || coins - shortage >= 0 || hpRate < 0.7;
    if (level === 2) return hpRate < 0.45 || exp >= 18;
  }

  if (jobKey === 9 && isCpuSummonerJobName(state?.job)) {
    if (level === 1) {
      return Number(state?.summonerDragonCount ?? 0) > 0 || exp >= 10 || coins - shortage >= 4;
    }
    if (level === 2) {
      return (
        Number(state?.summonerAdultCount ?? 0) > 0 ||
        (Number(state?.summonerJuvenileCount ?? 0) > 0 && exp >= 10) ||
        exp >= 16 ||
        hpRate < 0.48
      );
    }
  }

  if (jobKey === 9 && !isCpuSummonerJobName(state?.job)) {
    const dollRate = Number(state?.dollDurabilityRate ?? 1);
    const repairCount = Number(state?.dollRepairItemCount ?? 0);
    const chargeCount = Number(state?.dollChargeEquippedCount ?? 0);
    const spareCoins = coins - shortage;
    if (level === 1) {
      if (dollRate < 0.5 && repairCount <= 0 && spareCoins < 15) return false;
      if (chargeCount >= 1) return true;
      return exp >= 10 || (Number(state?.turnCount ?? 0) >= 4 && spareCoins >= 18);
    }
    if (level === 2) {
      if (dollRate < 0.42 || hpRate < 0.4) return false;
      if (exp < CPU_DOLL_LEVEL3_COIN_MIN_EXP) return false;
      if (state?.dollSkill2Used && (repairCount > 0 || dollRate >= 0.68)) return true;
      if (state?.dollSkill2Used && dollRate >= 0.5 && Number(state?.turnCount ?? 0) >= 7) return true;
      return exp >= 18 && (repairCount > 0 || dollRate >= 0.68);
    }
  }

  if (jobKey === 7) {
    const equipCount = Number(state?.alchemistEquipCount ?? 0);
    const spareCoins = coins - shortage;
    if (level === 1) return exp >= 11 || (equipCount >= 3 && spareCoins >= 0) || hpRate < 0.72;
    if (level === 2) return exp >= 13 || Number(state?.alchemistFusionReady ? 1 : 0) > 0 || equipCount >= 3 || hpRate < 0.58;
  }

  return false;
}

function isThiefSkill3Ready(state) {
  if (!state?.canSkill3 || state?.thiefSkill3Used) return false;
  const itemCount = Number(state?.thiefItemCount ?? 0);
  return (
    itemCount >= 2 ||
    Number(state?.hpRate ?? 1) < 0.45 ||
    Number(state?.enemyHpRate ?? 1) < 0.35 ||
    Number(state?.turnCount ?? 0) >= 9
  );
}

function isDollSkill3Ready(state) {
  if (!state?.canSkill3 || state?.dollSkill3Used || state?.dollBroken) return false;
  const dollRate = Number(state?.dollDurabilityRate ?? 1);
  const hpRate = Number(state?.hpRate ?? 1);
  const repairCount = Number(state?.dollRepairItemCount ?? 0);
  const enemyHpRate = Number(state?.enemyHpRate ?? 1);
  const chargeCount = Number(state?.dollChargeEquippedCount ?? 0);
  const burstThreat = isCpuDollBurstThreatJob(state?.enemyJob);
  if (chargeCount <= 0) return false;
  if (!state?.dollSkill2Used && enemyHpRate > 0.32) return false;
  if (
    state?.dollChargeBoostPart &&
    enemyHpRate > 0.28 &&
    !(
      burstThreat &&
      state?.dollSkill2Used &&
      repairCount > 0 &&
      dollRate >= 0.74 &&
      hpRate >= 0.5
    )
  ) {
    return false;
  }
  if (enemyHpRate < 0.28 && dollRate >= 0.6) return true;
  if (repairCount <= 0) return false;
  if (burstThreat && state?.dollSkill2Used && dollRate >= 0.74 && hpRate >= 0.5) return true;
  if (state?.dollSkill2Used && dollRate >= 0.82 && hpRate >= 0.55) return true;
  return dollRate >= 0.86 && hpRate >= 0.58;
}

function getCpuShopScore(P, item, state = null) {
  if (!item || item.sold_out || item.soldOut || item.shop_sold_out) return -Infinity;
  const price = Number(item.price ?? 0);
  const coins = Number(P?.coins ?? 0);
  if (price > coins) return -Infinity;

  const jobKey = getCpuJobKeyByName(P?.job);
  if (![3, 4, 6, 7, 8, 9, 10].includes(jobKey)) return 0;

  let score = 1000 - price * 2;
  if (jobKey === 3) {
    const blessing = Math.max(0, Number(state?.blessingCount ?? P?.blessing_count ?? 0));
    const regenCount = Number(state?.priestRegenItemCount ?? getCpuPriestRegenItemCount(P));
    const regenRounds = Number(state?.priestRegenRounds ?? getCpuPriestRegenRounds(P));
    const usedSkill3 = hasCpuUsedSkill(P, "priest_3");
    if (isCpuPriestRegenItem(item)) {
      score += 12800 + Math.max(0, 2 - regenCount) * 950;
      if (regenRounds <= 0) score += 3600;
      else if (regenRounds <= 3) score += 2200;
    } else if (isCpuPriestBlessingHealItem(item)) {
      if (!usedSkill3) return -Infinity;
      score += blessing >= 20 ? 2400 : 350;
    } else if (isCpuPriestBlessingAttackItem(item)) {
      if (!usedSkill3) return -Infinity;
      score += blessing >= 14 ? 2300 : 300;
    } else if (isCpuHealItem(item)) {
      score += Number(state?.hpRate ?? 1) < 0.72 ? 3600 : 900;
    } else if (isNormalEquipmentItem(item)) {
      if (isCpuDefenseEquip(item)) score += 5200 + Number(item.star ?? 1) * 180;
      else score += isCpuCoinEquip(item) ? 900 : 900;
    }
  } else if (jobKey === 4) {
    const levelPlan = getCpuLevelPlan(P);
    if (isCpuCoinEquip(item)) score += 9600 + getCpuCoinEquipValue(item) * 360;
    else if (isCpuUsableInventoryItem(item)) score += 6500 + Math.max(0, 3 - Number(state?.thiefItemCount ?? 0)) * 900;
    else if (isNormalEquipmentItem(item)) score += 1800;
    if (!isCpuCoinEquip(item) && levelPlan.level < 3 && levelPlan.shortage > 0 && coins - price < levelPlan.shortage) {
      score -= 2800;
    }
  } else if (jobKey === 6) {
    const talismanCount = countCpuOnmyojiTalismans(P);
    const hasCoinEquip = isCpuCoinEquip(P?.equipment);
    if (isCpuCoinEquip(item)) score += (hasCoinEquip ? 1800 : 9200) + getCpuCoinEquipValue(item) * 320;
    else if (isCpuOnmyojiTalisman(item)) {
      const w = CPU_AI_WEIGHTS.onmyoji ?? {};
      score += getCpuOnmyojiTalismanScore(P, item) + Math.max(0, 3 - talismanCount) * Number(w.shopMissingTalismanBonus ?? 900);
    }
    else if (isCpuUsableInventoryItem(item)) score += 1600;
    else if (isNormalEquipmentItem(item)) score += 1200;
  } else if (jobKey === 7) {
    const equipCount = Number(state?.alchemistEquipCount ?? 0);
    const levelPlan = getCpuLevelPlan(P);
    if (isNormalEquipmentItem(item)) {
      const star = Number(item.star ?? 1);
      if (isCpuCoinEquip(item)) {
        const coinCount = Number(state?.alchemistCoinEquipCount ?? countCpuAlchemistCoinEquips(P));
        if (coinCount >= 1 || Number(state?.turnCount ?? 0) > 4) return -Infinity;
        score += 4700 + getCpuCoinEquipValue(item) * 260 + star * 80;
      } else {
        score += 6900 + Math.max(0, 6 - equipCount) * 780 + star * 140;
        score += getCpuAlchemistEnemyEquipBias(state?.enemyJob, item);
      }
      if (
        levelPlan.level < 3 &&
        levelPlan.shortage > 0 &&
        coins - price < levelPlan.shortage
      ) {
        score -= levelPlan.level === 2 ? 3300 : 1800;
      }
    } else if (item.equip_type === "alchemist_unique") {
      score += 5200;
    } else if (isCpuUsableInventoryItem(item)) {
      score += 1100;
    }
  } else if (jobKey === 8) {
    const hasPoison = !!state?.hasPoisonArrow;
    const needSecond = !!state?.needsArcherSecondArrow;
    const beforeInfiniteArrows = !state?.archerNoConsumeActive && !state?.archerSkill3Used;
    const earlySetup = Number(state?.turnCount ?? 0) <= 5 || Number(state?.level ?? 1) < 3;
    if (isArrowItem(item)) {
      if (!beforeInfiniteArrows) return -Infinity;
      const key = getArrowStackKey(item);
      const ownedSame = getCpuOwnedArrows(P).some(arrow => getArrowStackKey(arrow) === key);
      score += 7000 + getArrowPriority(item) * 650;
      if (!hasPoison && isCpuPoisonArrow(item)) score += 7200;
      if (needSecond && !ownedSame) score += 4600;
      if (state?.archerSkill2Used && hasPoison && !isCpuPoisonArrow(item) && !ownedSame) score += 2600;
      if (ownedSame && !state?.needsArrowShop) score -= 3600;
    } else if (isCpuUsableInventoryItem(item)) {
      if (beforeInfiniteArrows) return -Infinity;
      score += 700;
    } else if (isNormalEquipmentItem(item)) {
      if (beforeInfiniteArrows) {
        if (!isCpuCoinEquip(item) || !earlySetup) return -Infinity;
        score += 3800 + getCpuCoinEquipValue(item) * 320;
      } else {
        score += isCpuCoinEquip(item) ? 1200 : 700;
      }
    } else if (beforeInfiniteArrows) {
      return -Infinity;
    }
  } else if (jobKey === 9) {
    if (isCpuSummonerJobName(P?.job)) {
      const summoner = getCpuSummonerStateData(P);
      const ownedCount = Number(state?.summonerDragonCount ?? summoner.dragonCount);
      const adultCount = Number(state?.summonerAdultCount ?? summoner.adultCount);
      const feedCount = Number(state?.summonerFeedCount ?? summoner.feedCount);
      if (item.is_summoner_egg) {
        if (ownedCount >= 3) return -Infinity;
        score += 11200 + Math.max(0, 3 - ownedCount) * 900;
        if (item.summoner_dragon_type === pickCpuSummonerEggType(P)) score += 1600;
      } else if (item.is_summoner_feed) {
        if (summoner.juvenileCount <= 0) return -Infinity;
        score += 7400 + Math.max(0, 2 - feedCount) * 1000 + Math.max(0, 2 - adultCount) * 600;
      } else if (isCpuCoinEquip(item) && Number(state?.turnCount ?? 0) <= 4 && ownedCount < 2) {
        score += 1400 + getCpuCoinEquipValue(item) * 160;
      } else {
        return -Infinity;
      }
      return score;
    }
    const chargeEquipped = Number(state?.dollChargeEquippedCount ?? 0);
    const chargeOwned = Number(state?.dollChargeOwnedCount ?? 0);
    const repairCount = Number(state?.dollRepairItemCount ?? 0);
    const dollHpRate = Number(state?.dollDurabilityRate ?? 1);
    const keepRepairCoins = Math.max(0, coins - price) >= 15;
    const levelPlan = getCpuLevelPlan(P);
    const savingForSkill3 =
      isCpuDollLevel3CoinPushReady(P) &&
      levelPlan.shortage > 0 &&
      coins - price < levelPlan.shortage;
    const emergencyRepairBuy = repairCount <= 0 || dollHpRate < 0.5;
    if (isCpuDollRepairItem(item)) {
      if (repairCount <= 0) score += 12800 + (dollHpRate < 0.9 ? 2400 : 0);
      else if (dollHpRate < 0.65) score += 9800;
      else if (dollHpRate < 0.9) score += 6800;
      else score += 4300;
      if (savingForSkill3 && repairCount > 0 && dollHpRate >= 0.9) score -= 5200;
    } else if (item.is_doll_costume) {
      if (savingForSkill3 && chargeEquipped > 0 && !emergencyRepairBuy) score -= 6200;
      if (isCpuDollChargeCostume(item)) {
        if (chargeEquipped <= 0) score += 10800;
        else if (chargeOwned < 2 && keepRepairCoins) score += 6200;
        else if (chargeOwned < 3 && Number(state?.turnCount ?? 0) <= 5 && keepRepairCoins) score += 1600;
        else score -= 900;
        score += Number(item.star ?? 1) * 140;
      } else if (state?.dollBroken || chargeEquipped <= 0) {
        score += 1800 + Number(item.star ?? 1) * 100;
      } else if (Number(state?.turnCount ?? 0) <= 3 && keepRepairCoins) {
        score += 650 + Number(item.star ?? 1) * 80;
      } else {
        score -= 1400;
      }
    } else if (isCpuUsableInventoryItem(item)) {
      score += 700;
    }
  } else if (jobKey === 10) {
    if (item.is_mad_special_item) score += 9800 + Number(item.self_damage ?? item.power ?? 0) * 140;
    else if (isCpuHealItem(item)) score += Number(state?.hpRate ?? 1) < 0.75 ? 8800 : 4400;
    else if (isCpuUsableInventoryItem(item)) score += 2600;
    else if (isNormalEquipmentItem(item)) score += isCpuCoinEquip(item) ? 900 : 1600;
  }

  const style = state?.aiStyle ?? P?.cpu_ai_style ?? "balanced";
  if (style === "aggro") {
    if (item.effect_type === "攻撃力" || item.effect_type === "ATK" || isArrowItem(item) || item.is_mad_special_item) score += 750;
    else if (!state?.needsArrowShop) score -= 450;
  } else if (style === "survival") {
    if (isCpuHealItem(item) || isCpuPriestRegenItem(item) || isCpuDollRepairItem(item)) score += 1100;
    if (item.effect_type === "防御力" || item.effect_type === "DEF") score += 650;
  } else if (style === "economy") {
    if (isCpuCoinEquip(item)) score += 1600;
    else if (isNormalEquipmentItem(item)) score += 850;
    else if (item.equip_type === "alchemist_unique") score += 900;
  } else if (style === "combo") {
    if (
      item.is_onmyoji_item ||
      item.is_doll_costume ||
      item.is_summoner_egg ||
      item.is_summoner_feed ||
      item.is_mad_special_item ||
      item.equip_type === "alchemist_unique" ||
      isArrowItem(item)
    ) {
      score += 1000;
    } else if (isCpuUsableInventoryItem(item)) {
      score += 500;
    }
  }

  return score;
}

function pickCpuShopPurchase(P, shopCandidates, state = null) {
  const jobKey = getCpuJobKeyByName(P?.job);
  if (![3, 4, 6, 7, 8, 9, 10].includes(jobKey)) {
    return shopCandidates[Math.floor(Math.random() * shopCandidates.length)] ?? null;
  }
  const scored = shopCandidates
    .map(item => ({ item, score: getCpuShopScore(P, item, state) }))
    .filter(entry => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score || Number(a.item?.price ?? 0) - Number(b.item?.price ?? 0));
  return scored[0]?.item ?? null;
}

function cpuTryLevelUp(match, ws) {
  const P = ws?.player;
  if (!P || Number(P.level ?? 1) >= 3) return false;

  const auto = P.try_level_up_auto?.();
  if (auto?.auto) {
    match?.sendSystem?.(`📘 ${P.name} は EXP により Lv${P.level} にアップ！（攻撃+${auto.inc ?? 0}）`);
  } else {
    const res = P.try_level_up_with_coins?.();
    if (!res?.success) return false;
    match?.sendSystem?.(`💰 ${P.name} はコインを使って Lv${P.level} にアップ！（攻撃+${res.inc ?? 0}）`);
  }

  safeSend(ws, {
    type: "level_info",
    level: P.level,
    canLevelUp: P.can_level_up?.() ?? false
  });
  match?.sendSimpleStatusBoth?.();
  return true;
}

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
function canUseCpuSkill(P, id, match = null) {
  let key;
  const skillDef = (JOB_SKILLS?.[P.job] ?? [])[id - 1] ?? null;
  if (!skillDef) return false;

  if (isCpuSummonerJobName(P?.job)) {
    key = `summoner_${id}`;
    if (id === 1 && getSummonerEggChoices(P).length <= 0) return false;
    if (id === 2 && getSummonerGrowthTargets(P).length <= 0) return false;
    if (id === 3 && !getCpuSummonerStateData(P).hasNonEgg) return false;
  }

  // ★ CPU：人形使いスキル2はHP条件を満たす時のみ使用可
  if (P.job === "人形使い" && id === 2) {
    const cost = decideCpuDollSkill2Cost(P);
    if (!cost) return false;
  }

  if (key) {
    // 召喚士など、上で個別に key を決めた職業
  } else if (P.job === "人形使い") {
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
    key = skillDef.type || `${prefix}_${id}`;
  }

  if (P.skill_sealed) return false;

  if (P.job === "戦士" && (key === "warrior_4" || key === "warrior_5")) {
    if (match && match.matchType !== "dojo") return false;
    const trailNodes = new Set((P.dojoTrailNodes || []).map(Number));
    if (key === "warrior_4" && !trailNodes.has(55)) return false;
    if (key === "warrior_5" && !trailNodes.has(60)) return false;
  }

  // 使用済み
  if (!(P.job === "魔導士" && (key === "mage_2" || key === "mage_3")) && P.used_skill_set?.has(key)) return false;

  // レベル不足
  const requiredLevel = Number(skillDef.min_level ?? id);
  if (P.level < requiredLevel) return false;

  // 魔導士マナ
  if (P.job === "魔導士") {
    if (id === 2 && P.mana < 30) return false;
    if (id === 3 && P.mana < 60) return false;
  }

  if (P.job === "弓兵" && (id === 1 || id === 2) && !P.has_usable_arrow?.()) {
    return false;
  }

  if (isCpuArcherJob(P) && id === 1 && !hasCpuUsedSkill(P, "archer_2")) {
    return false;
  }

  if (isCpuArcherJob(P) && (id === 1 || id === 2) && !P.has_usable_arrow?.()) {
    return false;
  }

  return true;
}

function canCpuUseDollCharge(P) {
  if (P?.job !== "人形使い" || !P.doll || P.doll.is_broken) return false;
  if (Array.isArray(P.pending_doll_charge_choices) && P.pending_doll_charge_choices.length > 0) {
    return true;
  }
  return Number(P.doll.charge ?? 0) >= DOLL_CHARGE_COST;
}

function getCpuDollChargeCostumeBoostPart(P) {
  if (!P?.doll?.costumes) return null;
  const candidates = Object.entries(P.doll.costumes)
    .filter(([, costume]) =>
      isCpuDollChargeCostume(costume) &&
      (Number(costume?.star ?? 1) < 8 || costume?.condition === "boroboro" || costume?.is_broken)
    )
    .map(([part, costume]) => {
      const star = Number(costume?.star ?? 1);
      let score = 10000;
      if (costume?.condition === "boroboro" || costume?.is_broken) score += 3000;
      score += Math.max(0, 8 - star) * 220;
      return { part, score };
    })
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.part ?? null;
}

function pickCpuDollChargePart(P) {
  const chargePart = getCpuDollChargeCostumeBoostPart(P);
  if (chargePart) return chargePart;

  const parts = Object.entries(P?.doll?.costumes ?? {})
    .filter(([, costume]) => !!costume && Number(costume?.star ?? 1) < 8)
    .map(([part, costume]) => {
      let score = 100;
      if (isCpuDollChargeCostume(costume)) score += 6200 + Math.max(0, 8 - Number(costume.star ?? 1)) * 80;
      if (costume?.condition === "boroboro" || costume?.is_broken) score += 2600;
      if (costume?.effect_type === "ATK" && Number(P?.opponent?.hp ?? 9999) < 45) score += 1400;
      if (costume?.effect_type === "DEF" && Number(P?.doll?.durability ?? 100) < 45) score += 800;
      return { part, score };
    })
    .sort((a, b) => b.score - a.score);
  return parts[0]?.part ?? null;
}

function pickCpuDollChargeChoice(P, choices) {
  const list = Array.isArray(choices) ? choices : [];
  if (!list.length) return null;

  const durabilityRate =
    Number(P?.doll?.durability ?? 0) /
    Math.max(1, Number(P?.doll?.max_durability ?? 1));
  const enemyHpRate =
    Number(P?.opponent?.hp ?? 0) /
    Math.max(1, Number(P?.opponent?.max_hp ?? 1));
  const rampage = !!P?.doll?.is_rampage;
  const rampageRounds = Number(P?.doll?.rampage_rounds ?? 0);
  const chargeBoostPart = getCpuDollChargeCostumeBoostPart(P);
  const hasExtraAttackChoice = list.some(choice => choice?.key === "extra_attack");
  const burstThreat = isCpuDollBurstThreatJob(P?.opponent?.job);
  const repairCount = getCpuDollRepairItemCount(P);
  const urgentDurability = durabilityRate < (repairCount > 0 ? 0.68 : 0.8);
  const cautiousDurability = burstThreat && repairCount <= 0 && durabilityRate < 0.84;

  const scored = list.map(choice => {
    let score = 100;
    if (choice?.key === "costume_boost") {
      if (!rampage && chargeBoostPart) {
        if (urgentDurability) score += 4200;
        else if (cautiousDurability) score += 9000;
        else score += 24000;
      } else if (!rampage && pickCpuDollChargePart(P)) score += cautiousDurability ? 1500 : 4200;
      else score += 600;
    } else if (choice?.key === "heal_durability") {
      if (!rampage) {
        if (urgentDurability) score += 26000;
        else if (cautiousDurability) score += 18000;
        else score += chargeBoostPart ? 7600 : 15000;
      } else if (!hasExtraAttackChoice && (durabilityRate < 0.82 || rampageRounds <= 1)) {
        score += 15000;
      } else if (durabilityRate < 0.5) {
        score += 5200;
      }
      if (durabilityRate < 0.45) score += 5200;
      else if (durabilityRate < 0.7) score += 2100;
    } else if (choice?.key === "extra_attack") {
      if (rampage) {
        score += 26000;
        score += enemyHpRate < 0.45 ? 5200 : enemyHpRate < 0.75 ? 2600 : 1200;
      } else {
        score -= 9000;
      }
    } else if (choice?.key === "base_atk_up") {
      score += rampage ? 3600 : 1200;
      if (!rampage && (chargeBoostPart || durabilityRate < 0.82)) score -= 2400;
    } else if (choice?.key === "gain_coins") {
      score += !rampage && !chargeBoostPart && Number(P?.coins ?? 0) < 15 ? 1800 : 250;
    }
    return { choice, score };
  }).sort((a, b) => b.score - a.score);

  return scored[0]?.choice ?? list[0] ?? null;
}

function cpuUseDollCharge(match, ws) {
  const P = ws?.player;
  if (!match || !canCpuUseDollCharge(P)) return false;

  if (match.hasPendingDollCharge?.(P)) {
    const choices = Array.isArray(P.pending_doll_charge_choices)
      ? P.pending_doll_charge_choices
      : [];
    const picked = pickCpuDollChargeChoice(P, choices);
    if (!picked?.key) return false;
    const part = picked.key === "costume_boost" ? pickCpuDollChargePart(P) : null;
    return !!match.resolveDollChargeChoice?.(ws, P, picked.key, part);
  }

  const requested = !!match.requestDollChargeChoices?.(ws, P);
  if (requested && match.hasPendingDollCharge?.(P)) {
    return cpuUseDollCharge(match, ws);
  }
  return requested;
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
  let alchemistCoinEquipCount = 0;

  if (P.job === "錬金術師") {
    alchemistCoinEquipCount = countCpuAlchemistCoinEquips(P);
    if (
      P.equipment &&
      P.equipment.equip_type !== "mage_equip" &&
      P.equipment.equip_type !== "alchemist_unique"
    ) {
      alchemistEquipCount++;
    }

    for (const eq of P.extra_equipments ?? []) {
      if (
        eq.equip_type !== "mage_equip" &&
        eq.equip_type !== "alchemist_unique"
      ) {
        alchemistEquipCount++;
      }
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
  const canUseConsumableThisTurn = Number(P.item_use_count ?? 0) < 2;
  const usableItem = canUseConsumableThisTurn ? pickCpuUsableItemCandidate(P) : null;
  /*
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
  */

  const hasHealItem = (P.items ?? []).some(it =>
    it &&
    !it.is_equip &&
    !it.is_arrow &&
    it.equip_type !== "arrow" &&
    it.equip_type !== "mage_equip" &&
    it.equip_type !== "alchemist_unique" &&
    !it.is_doll_costume &&
    it.effect_type === "HP"
  );


  // =========================
  // ★ CPU用：装備候補選定（returnの前）
  // =========================
  const normalEquipMaxSlots = getCpuNormalEquipMaxSlots(P, match);
  const normalEquipCount = getCpuNormalEquipCount(P);
  const hasCoinEquip =
    isCpuCoinEquip(P?.equipment) ||
    (Array.isArray(P?.extra_equipments) && P.extra_equipments.some(isCpuCoinEquip));
  const equipCandidate = pickCpuNormalEquipCandidate(P, match);

  // =========================
  // ★ CPU用：特殊装備候補（性能が上がる場合のみ）
  // =========================
  let specialCandidate =
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

  if (getCpuJobKeyByName(P?.job) === 9 && !isCpuSummonerJobName(P?.job)) {
    const dollCandidate = pickCpuDollCostumeEquipCandidate(P, P.special_inventory ?? []);
    specialCandidate = dollCandidate;
  }

  // =========================
  // ★ CPU用：矢の装備候補（優先度ルール確定版）
  // =========================
  let arrowCandidate = null;
  const isArcherCpu = isCpuArcherJob(P);
  const isMageCpu = isCpuMageJob(P);
  const equippedArrowAmmo = isArcherCpu
    ? getCpuArrowAmmoTotal(P, { includeInventory: false })
    : 0;
  const totalArrowAmmo = isArcherCpu
    ? getCpuArrowAmmoTotal(P, { includeInventory: true })
    : 0;
  const archerSkill2Used = isArcherCpu && hasCpuUsedSkill(P, "archer_2");
  const archerSkill1Used = isArcherCpu && hasCpuUsedSkill(P, "archer_1");
  const archerSkill3Used = isArcherCpu && hasCpuUsedSkill(P, "archer_3");

  if (isArcherCpu) {

    const inv = (P.arrow_inventory ?? [])
      .filter(it => it && (it.is_arrow || it.equip_type === "arrow"));

    const equipped = getCpuEquippedArrows(P);
    const equippedKeys = new Set(equipped.map(getArrowStackKey));
    const scored = inv
      .filter(it => !equippedKeys.has(getArrowStackKey(it)))
      .map(it => ({
        item: it,
        score: scoreCpuOwnedArrowForEquip(P, it, { archerSkill2Used }),
      }))
      .filter(entry => Number.isFinite(entry.score));

    scored.sort((a, b) =>
      b.score - a.score ||
      getArrowPriority(b.item) - getArrowPriority(a.item) ||
      Number(a.item?.price ?? 0) - Number(b.item?.price ?? 0)
    );

    const bestOwned = scored[0]?.item ?? null;
    if (bestOwned) {
      if (!P.arrow) {
        arrowCandidate = bestOwned;
      } else if (P.arrow_slots >= 2 && !P.arrow2) {
        arrowCandidate = bestOwned;
      } else if (P.arrow && P.arrow_slots < 2) {
        if (getArrowPriority(bestOwned) > getArrowPriority(P.arrow)) {
          arrowCandidate = bestOwned;
        }
      } else if (P.arrow && P.arrow2) {
        const lowEquipped = getArrowPriority(P.arrow) <= getArrowPriority(P.arrow2) ? P.arrow : P.arrow2;
        if (scoreCpuOwnedArrowForEquip(P, bestOwned, { archerSkill2Used }) >
            scoreCpuOwnedArrowForEquip(P, lowEquipped, { archerSkill2Used, penalizeAlreadyEquipped: false }) + 400) {
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

  const madState = buildMadStateData(P);
  const levelPlan = getCpuLevelPlan(P);
  const thiefItemCount = countCpuStoredConsumables(P);
  const equippedArrows = isArcherCpu ? [P.arrow, P.arrow2].filter(isArrowItem) : [];
  const archerArrowSlots = isArcherCpu ? Number(P.arrow_slots ?? 1) : 0;
  const archerNoConsumeActive = isArcherCpu && isCpuArcherNoConsumeActive(P);
  const equippedArrowKeys = new Set(equippedArrows.map(getArrowStackKey));
  const hasDistinctEquippedArrows = equippedArrowKeys.size >= Math.min(2, archerArrowSlots);
  const hasPoisonArrow = equippedArrows.some(isCpuPoisonArrow);
  const hasOwnedPoisonArrow = isArcherCpu && [
    P.arrow,
    P.arrow2,
    ...((P.arrow_inventory ?? []).filter(Boolean)),
  ].some(isCpuPoisonArrow);
  const needsArcherSecondArrow =
    isArcherCpu &&
    archerSkill2Used &&
    archerArrowSlots >= 2 &&
    equippedArrows.length < 2;
  const needsArcherPoisonArrow =
    isArcherCpu &&
    archerSkill2Used &&
    !hasPoisonArrow;
  const needsArcherArrowPrep =
    isArcherCpu &&
    archerSkill2Used &&
    !archerNoConsumeActive &&
    (needsArcherSecondArrow || needsArcherPoisonArrow || !hasDistinctEquippedArrows);
  const archerIdealSkill1Setup =
    isArcherCpu &&
    archerSkill2Used &&
    hasPoisonArrow &&
    (archerArrowSlots < 2 || (equippedArrows.length >= 2 && hasDistinctEquippedArrows));
  const dollDurability = Number(P?.doll?.durability ?? 0);
  const dollMaxDurability = Number(P?.doll?.max_durability ?? 0);
  const dollDurabilityRate = P?.doll
    ? dollDurability / Math.max(1, dollMaxDurability)
    : 1;
  const dollChargeEquippedCount = getCpuDollChargeCostumeCount(P, { includeInventory: false });
  const dollChargeOwnedCount = getCpuDollChargeCostumeCount(P, { includeInventory: true });
  const dollChargeBoostPart = getCpuDollChargeCostumeBoostPart(P);
  const dollRepairItemCount = getCpuDollRepairItemCount(P);
  const summonerState = getCpuSummonerStateData(P);
  const summonerPreferredFront = pickCpuSummonerFrontType(P);
  const summonerTiamat = getSummonerDragon(P, "tiamat");
  const summonerTiamatRole = summonerTiamat?.stage === "adult" || summonerTiamat?.stage === "juvenile"
    ? (P.isSummonerResonanceActive?.() ? "front" : (String(summonerPreferredFront ?? "") === "tiamat" ? "front" : "back"))
    : null;
  const summonerTiamatDamageEstimate = !summonerTiamatRole
    ? 0
    : summonerTiamat?.stage === "adult"
      ? (summonerTiamatRole === "front" ? 18 : 8)
      : Math.max(0, (summonerTiamatRole === "front" ? 10 : 5) - Math.floor(Number(E?.get_total_defense?.() ?? E?.defense ?? 0) * 0.5));
  const priestRegenRounds = getCpuPriestRegenRounds(P);
  const priestRegenItemCount = getCpuPriestRegenItemCount(P);
  const combineEquipPair = pickCpuNormalEquipCombinePair(P);
  const alchemistFusionUids = pickCpuAlchemistFusionUids(P);

  return {
    hpRate: P.hp / P.max_hp,
    enemyHpRate: E.hp / E.max_hp,
    hp: Number(P.hp ?? 0),
    maxHp: Number(P.max_hp ?? 0),
    enemyHp: Number(E.hp ?? 0),
    enemyMaxHp: Number(E.max_hp ?? 0),
    attack: Number(P.get_total_attack?.() ?? P.attack ?? 0),
    defense: Number(P.get_total_defense?.() ?? P.defense ?? 0),
    enemyAttack: Number(E.get_total_attack?.() ?? E.attack ?? 0),
    enemyDefense: Number(E.get_total_defense?.() ?? E.defense ?? 0),

    coins: P.coins,
    job: P.job,
    enemyJob: E.job,
    aiLevel: normalizeCpuAiLevel(P.cpu_ai_level) ?? 5,
    aiStyle: P.cpu_ai_style ?? pickCpuAiStyle("auto", getCpuJobKeyByName(P.job)),
    aiStyleLabel: P.cpu_ai_style_label ?? CPU_AI_STYLE_LABEL[P.cpu_ai_style] ?? CPU_AI_STYLE_LABEL.balanced,
    level: levelPlan.level,
    exp: levelPlan.exp,
    nextLevelExp: levelPlan.nextExp,
    levelShortage: levelPlan.shortage,
    canLevelUpByExp: levelPlan.canByExp,
    canLevelUpByCoins: levelPlan.canByCoins,
    canLevelUpNow: levelPlan.canNow,
    turnCount: Number(P.turn_count ?? 0),
    shopCountThisTurn: getCpuShopCountThisTurn(P),
    isArcher: isArcherCpu,
    isMage: isMageCpu,
    thiefItemCount,
    blessingCount: Math.max(0, Number(P.blessing_count ?? 0)),
    priestRegenRounds,
    priestRegenItemCount,
    priestSkill3Used: hasCpuUsedSkill(P, "priest_3"),
    usableItemIsPriestRegen: isCpuPriestRegenItem(usableItem),
    onmyojiTalismanCount: countCpuOnmyojiTalismans(P),
    onmyojiUsableTalismanScore: isCpuOnmyojiTalisman(usableItem) ? getCpuOnmyojiTalismanScore(P, usableItem) : 0,
    thiefSkill3Used: hasCpuUsedSkill(P, "thief_3"),
    madIsMad: !!madState?.is_mad,
    madRemaining: Number(madState?.remaining ?? 0),
    madGutsActive: !!P.madman_guts,
    madRageActive: !!P.madman_rage_active,
    madSkill3Used: hasCpuUsedSkill(P, "mad_3"),
    usableItemIsHeal: isCpuHealItem(usableItem),
    usableItemIsMadSpecial: !!usableItem?.is_mad_special_item,
    mana: Number(P.mana ?? 0),
    manaMax: Number(P.mana_max ?? 0),
    equippedArrowAmmo,
    totalArrowAmmo,
    needsArrowShop:
      isArcherCpu &&
      !archerNoConsumeActive &&
      (equippedArrowAmmo <= 0 || totalArrowAmmo <= 1 || needsArcherArrowPrep),
    archerSkill1Used,
    archerSkill2Used,
    archerSkill3Used,
    archerArrowSlots,
    archerNoConsumeActive,
    equippedArrowCount: equippedArrows.length,
    hasDistinctEquippedArrows,
    hasPoisonArrow,
    hasOwnedPoisonArrow,
    needsArcherSecondArrow,
    needsArcherPoisonArrow,
    needsArcherArrowPrep,
    archerIdealSkill1Setup,
    
    alchemistEquipCount,   // ★ これを追加
    alchemistCoinEquipCount,

    alchemistSkill1Used: hasCpuUsedSkill(P, "alchemist_1"),
    alchemistSkill2Used: hasCpuUsedSkill(P, "alchemist_2"),
    alchemistSkill3Used: hasCpuUsedSkill(P, "alchemist_3"),
    alchemistFusionReady: alchemistFusionUids.length >= 3,
    alchemistFusionUids,
    hasCombineEquip: !!combineEquipPair,
    combineEquipPair,

    usableItem,
    hasUsableItem: !!usableItem,
    hasHealItem,
    canDollCharge: canCpuUseDollCharge(P),
    dollBroken: !!P?.doll?.is_broken,
    dollIsRampage: !!P?.doll?.is_rampage,
    dollCharge: Number(P?.doll?.charge ?? 0),
    dollDurability,
    dollMaxDurability,
    dollDurabilityRate,
    dollChargeEquippedCount,
    dollChargeOwnedCount,
    dollChargeBoostPart,
    dollRepairItemCount,
    dollSkill1Used: hasCpuUsedSkill(P, "doll_1"),
    dollSkill2Used: hasCpuUsedSkill(P, "doll_2"),
    dollSkill3Used: hasCpuUsedSkill(P, "doll_3"),
    summonerDragonCount: summonerState.dragonCount,
    summonerEggCount: summonerState.eggCount,
    summonerJuvenileCount: summonerState.juvenileCount,
    summonerAdultCount: summonerState.adultCount,
    summonerHasNonEgg: summonerState.hasNonEgg,
    summonerNeedsGrowth: summonerState.needsGrowth,
    summonerFeedCount: summonerState.feedCount,
    summonerPreferredFront,
    summonerTiamatDamageEstimate,
    summonerSkill1Used: hasCpuUsedSkill(P, "summoner_1"),
    summonerSkill2Used: hasCpuUsedSkill(P, "summoner_2"),
    summonerSkill3Used: hasCpuUsedSkill(P, "summoner_3"),


    // ★ ここが重要
    hasEquip: normalEquipCount >= normalEquipMaxSlots,
    hasCoinEquip,
    equipItem: equipCandidate,
    normalEquipCount,
    normalEquipMaxSlots,

    hasSpecialEquip: !!specialCandidate,
    specialEquip: specialCandidate,
    specialAlreadyEquipped,

    arrowEquip: arrowCandidate,
    hasArrowEquip: !!arrowCandidate,

    canBuy:
      (P.coins ?? 0) >= 5 &&
      Array.isArray(P.shop_items) &&
      P.shop_items.length > 0,
    shopHasDollRepairItem: (P.shop_items ?? []).some(it =>
      !(it?.sold_out || it?.soldOut || it?.shop_sold_out) &&
      isCpuDollRepairItem(it) &&
      Number(it?.price ?? 0) <= Number(P?.coins ?? 0)
    ),
    shopHasSummonerEgg: (P.shop_items ?? []).some(it =>
      !(it?.sold_out || it?.soldOut || it?.shop_sold_out) &&
      it?.is_summoner_egg &&
      Number(it?.price ?? 0) <= Number(P?.coins ?? 0)
    ),
    shopHasSummonerFeed: (P.shop_items ?? []).some(it =>
      !(it?.sold_out || it?.soldOut || it?.shop_sold_out) &&
      it?.is_summoner_feed &&
      Number(it?.price ?? 0) <= Number(P?.coins ?? 0)
    ),

    canSkill1: canUseCpuSkill(P, 1, match),
    canSkill2: canUseCpuSkill(P, 2, match),
    canSkill3: canUseCpuSkill(P, 3, match),
    canSkill4: canUseCpuSkill(P, 4, match),
    canSkill5: canUseCpuSkill(P, 5, match),

  };

}


function applyCpuAiMistake(action, state) {
  const aiLevel = normalizeCpuAiLevel(state?.aiLevel) ?? 5;
  const rate = CPU_AI_MISTAKE_RATE[aiLevel] ?? CPU_AI_MISTAKE_RATE[5];
  if (!action || rate <= 0 || Math.random() >= rate) return action;

  const candidates = [{ type: "attack" }];
  if (state?.hasUsableItem) candidates.push({ type: "use_item" });
  if (state?.canDollCharge) candidates.push({ type: "doll_charge" });
  if (state?.hasArrowEquip) candidates.push({ type: "arrow" });
  if (state?.hasSpecialEquip) candidates.push({ type: "special" });
  if (state?.hasCombineEquip) candidates.push({ type: "combine_equip" });
  if (!state?.hasEquip && state?.equipItem) candidates.push({ type: "equip" });
  if (state?.canLevelUpNow) candidates.push({ type: "level_up" });
  if (state?.canBuy) candidates.push({ type: "shop" });
  if (state?.canSkill1) candidates.push({ type: "skill", id: 1 });
  if (state?.canSkill2) candidates.push({ type: "skill", id: 2 });
  if (state?.canSkill3) candidates.push({ type: "skill", id: 3 });
  if (state?.canSkill4) candidates.push({ type: "skill", id: 4 });
  if (state?.canSkill5) candidates.push({ type: "skill", id: 5 });

  const different = candidates.filter(it =>
    it.type !== action.type || Number(it.id ?? 0) !== Number(action.id ?? 0)
  );
  const pool = different.length ? different : candidates;
  return pool[Math.floor(Math.random() * pool.length)] ?? action;
}

function summarizeCpuActionItem(item) {
  if (!item) return null;
  return {
    uid: item.uid ?? null,
    name: item.name ?? null,
    price: item.price ?? null,
    category: item.category ?? null,
    equipType: item.equip_type ?? null,
    isArrow: !!(item.is_arrow || item.equip_type === "arrow"),
    arrowEffect: item.effect ?? item.arrow_effect ?? null,
    arrowCount: item.arrows_remaining ?? item.arrow_count ?? null,
    isOnmyojiTalisman: isCpuOnmyojiTalisman(item),
    shikigamiName: item.shikigami_name ?? null,
    shikigamiRank: item.shikigami_rank ?? null,
    isSummonerEgg: !!item.is_summoner_egg,
    summonerDragonType: item.summoner_dragon_type ?? null,
    isSummonerFeed: !!item.is_summoner_feed,
    isDollCostume: !!item.is_doll_costume,
    dollPart: item.part ?? null,
    dollEffectType: item.effect_type ?? null,
    star: item.star ?? null,
  };
}

function getCpuDecisionItemForLog(action, state) {
  if (action?.item) return action.item;
  if (!state) return null;
  if (action?.type === "use_item") return state.usableItem;
  if (action?.type === "equip") return state.equipItem;
  if (action?.type === "special") return state.specialEquip;
  if (action?.type === "arrow") return state.arrowEquip;
  return null;
}

function recordCpuSimDecision(match, ws, action, state, phase) {
  if (!match?.cpuSimLog || !ws?.player || !action) return;
  const actor = ws.player;
  const enemy = actor.opponent;
  const item = getCpuDecisionItemForLog(action, state);
  const summonerFront = isCpuSummonerJobName(actor.job)
    ? String(ensureSummonerState(actor)?.front ?? "")
    : "";
  const summonerFrontDragon = summonerFront
    ? getSummonerDragon(actor, summonerFront)
    : null;
  match.cpuSimLog.push({
    turn: Number(actor.turn_count ?? 0),
    phase,
    actor: actor.job,
    aiLevel: actor.cpu_ai_level ?? null,
    aiStyle: actor.cpu_ai_style ?? null,
    action: action.type,
    skill: action.id ?? null,
    score: action.score ?? null,
    reason: action.reason ?? "",
    item: summarizeCpuActionItem(item),
    hp: Number(actor.hp ?? 0),
    enemyHp: Number(enemy?.hp ?? 0),
    enemyJob: enemy?.job ?? null,
    summonerFront: summonerFront || null,
    summonerFrontStage: summonerFrontDragon?.stage ?? null,
  });
}

function getCpuJobKeyByName(jobName) {
  const found = Object.entries(JOB_TEMPLATE ?? {})
    .find(([, def]) => def?.name === jobName);
  return found ? Number(found[0]) : 0;
}

function estimateCpuAttackDamage(state, multiplier = 1) {
  const atk = Number(state?.attack ?? 0) * multiplier;
  const def = Number(state?.enemyDefense ?? 0);
  return Math.max(1, Math.round(atk - def));
}

function getCpuActionDamageEstimate(action, state) {
  if (!action) return 0;
  if (action.type === "attack") return estimateCpuAttackDamage(state, 1);
  if (action.type !== "skill") return 0;

  const id = Number(action.id ?? 0);
  const jobKey = getCpuJobKeyByName(state?.job);
  if (jobKey === 1) return id === 1 ? estimateCpuAttackDamage(state, 1.5) : estimateCpuAttackDamage(state, 1.15);
  if (jobKey === 2) return id === 3 ? estimateCpuAttackDamage(state, 1.35) : estimateCpuAttackDamage(state, 1.05);
  if (jobKey === 3) return id === 2 ? 0 : estimateCpuAttackDamage(state, id === 3 ? 1.25 : 1);
  if (jobKey === 4) return id === 2 ? estimateCpuAttackDamage(state, 1.45) : estimateCpuAttackDamage(state, 1.05);
  if (jobKey === 5) {
    if (id === 2) return 30 + Math.floor(Number(state?.mana ?? 0) * 0.1);
    if (id === 3) return Math.max(30, Number(state?.mana ?? 0) - 30);
    return 0;
  }
  if (jobKey === 8) return 0;
  if (jobKey === 9 && isCpuSummonerJobName(state?.job)) {
    const pursuit = Number(state?.summonerTiamatDamageEstimate ?? 0);
    if (id === 3) return estimateCpuAttackDamage(state, 1) + pursuit;
    return pursuit;
  }
  if (jobKey === 9) return id === 2 ? estimateCpuAttackDamage(state, 1.4) : estimateCpuAttackDamage(state, 1.05);
  if (jobKey === 10) return estimateCpuAttackDamage(state, id === 3 ? 1.6 : 1.15);
  return estimateCpuAttackDamage(state, 1.1);
}

function buildCpuScoredCandidates(state) {
  const candidates = [];
  const push = (action, score, reason) => {
    if (!action) return;
    candidates.push({ ...action, score, reason });
  };

  const hpRate = Number(state?.hpRate ?? 1);
  const enemyHpRate = Number(state?.enemyHpRate ?? 1);
  const enemyHp = Number(state?.enemyHp ?? 0);
  const danger = hpRate < 0.35;
  const lethalThreat = Number(state?.enemyAttack ?? 0) >= Number(state?.hp ?? 0);

  if (state?.hasArrowEquip) push({ type: "arrow" }, state?.equippedArrowAmmo <= 0 ? 9300 : 3800, "arrow_ready");
  if (state?.canBuy) push({ type: "shop" }, state?.needsArrowShop ? 9000 : 900 + (1 - hpRate) * 900, "shop_value");
  if (state?.hasUsableItem) push({ type: "use_item" }, danger || lethalThreat ? 8200 : 900, "item_survive");
  if (state?.canDollCharge) push({ type: "doll_charge" }, danger ? 7600 : 2400, "doll_charge");
  if (state?.hasSpecialEquip) push({ type: "special" }, 1600 + Number(state?.aiLevel ?? 5) * 80, "special_equip");
  if (state?.hasCombineEquip) push({ type: "combine_equip" }, 2100, "combine_equip");
  if (!state?.hasEquip && state?.equipItem) push({ type: "equip" }, 1400, "equip");

  const baseAttack = { type: "attack" };
  push(baseAttack, 500 + getCpuActionDamageEstimate(baseAttack, state) * 70 + (enemyHpRate < 0.25 ? 700 : 0), "attack");

  for (let id = 1; id <= 5; id++) {
    if (!state?.[`canSkill${id}`]) continue;
    const action = { type: "skill", id };
    const damage = getCpuActionDamageEstimate(action, state);
    let score = 850 + damage * 95 + id * 20;
    if (damage >= enemyHp) score += 12000;
    push(action, score, `skill_${id}`);
  }

  return candidates;
}

function applyJobCpuScores(candidates, state) {
  const jobKey = getCpuJobKeyByName(state?.job);
  const add = (type, id, score, reason) => {
    for (const c of candidates) {
      if (c.type === type && Number(c.id ?? 0) === Number(id ?? 0)) {
        c.score += score;
        c.reason = `${c.reason}+${reason}`;
      }
    }
  };

  if (jobKey === 1) {
    if (Number(state?.enemyHpRate ?? 1) < 0.35) add("skill", 1, 1700, "warrior_finish");
    add("skill", 2, Number(state?.hpRate ?? 1) < 0.55 ? 1200 : 450, "warrior_buff");
  } else if (jobKey === 2) {
    if (Number(state?.hpRate ?? 1) < 0.45) add("skill", 2, 1800, "knight_guard");
    add("skill", 1, 550, "knight_pressure");
  } else if (jobKey === 3) {
    const blessing = Number(state?.blessingCount ?? 0);
    const regenRounds = Number(state?.priestRegenRounds ?? 0);
    const regenItemCount = Number(state?.priestRegenItemCount ?? 0);
    if (regenItemCount <= 0 && regenRounds <= 4) add("shop", 0, regenRounds <= 0 ? 7600 : 4800, "priest_buy_holy_incense");
    if (state?.usableItemIsPriestRegen) add("use_item", 0, regenRounds <= 0 ? 8200 : 5200, "priest_use_holy_incense");
    add("skill", 1, Number(state?.hpRate ?? 1) < 0.78 ? 6200 : 5200, "priest_blessing_regen");
    add("skill", 2, Number(state?.hpRate ?? 1) < 0.72 ? 6000 : 4800, "priest_cleanse_regen");
    if (isCpuPriestSkill3Ready(state)) {
      add("skill", 3, 3600 + blessing * 110, "priest_blessing_burst");
    } else {
      add("skill", 3, -7200, "priest_save_blessing");
    }
  } else if (jobKey === 4) {
    const itemCount = Number(state?.thiefItemCount ?? 0);
    if (!state?.thiefSkill3Used) {
      add("shop", 0, itemCount < 3 ? 3400 : 1200, "thief_stock_items");
      add("equip", 0, 1800, "thief_coin_equip");
      add("skill", 1, itemCount < 2 ? 1050 : 350, "thief_steal_setup");
      add("skill", 2, itemCount >= 2 || Number(state?.enemyHpRate ?? 1) < 0.5 ? 1300 : 250, "thief_item_scaling");
      if (isThiefSkill3Ready(state)) {
        add("skill", 3, 5200 + itemCount * 1400, "thief_shadow_burst_ready");
      } else {
        add("skill", 3, -4200, "thief_wait_for_items");
      }
    } else {
      if (Number(state?.enemyHpRate ?? 1) < 0.45) add("skill", 2, 1500, "thief_burst");
      add("skill", 1, 500, "thief_cleanup_steal");
    }
  } else if (jobKey === 5) {
    const mana = Number(state?.mana ?? 0);
    const manaMax = Number(state?.manaMax ?? 0);
    if (manaMax > 0 && mana >= manaMax) {
      add("skill", 3, 5200, "mage_spend_full_mana");
      add("skill", 2, 2600, "mage_spend_mana");
    } else if (mana >= 90) {
      add("skill", 3, 3000, "mage_big_burst");
    } else if (mana < 30) {
      add("skill", 1, 3200, "mage_charge");
    } else {
      add("skill", 2, 1200, "mage_burst");
    }
  } else if (jobKey === 6) {
    const w = CPU_AI_WEIGHTS.onmyoji ?? {};
    add("equip", 0, 1900, "onmyoji_coin_equip");
    add("shop", 0, Number(state?.onmyojiTalismanCount ?? 0) < 2
      ? Number(w.actionShopFewTalismansScore ?? 4400)
      : Number(w.actionShopEnoughTalismansScore ?? 2100), "onmyoji_buy_talismans");
    if (state?.hasUsableItem) {
      add("use_item", 0, Math.max(
        Number(w.actionUseItemMinimumScore ?? 2600),
        Number(state?.onmyojiUsableTalismanScore ?? 0) - Number(w.actionUseItemScoreOffset ?? 4200)
      ), "onmyoji_use_talisman");
    }
    add("skill", 1, 650, "onmyoji_summon");
    if (Number(state?.enemyHpRate ?? 1) < 0.45) add("skill", 3, 1300, "onmyoji_control");
  } else if (jobKey === 7) {
    if (!state?.alchemistSkill1Used) add("skill", 1, 11000, "alchemist_open_skill1");
    if ((state?.alchemistEquipCount ?? 0) < 5) add("shop", 0, 3900, "alchemist_materials");
    if (state?.hasCombineEquip) add("combine_equip", 0, 2800, "alchemist_combine");
    if (state?.alchemistFusionReady && !state?.alchemistSkill3Used) add("skill", 3, 5600, "alchemist_synthesize");
    if ((state?.alchemistEquipCount ?? 0) >= 2 && !state?.alchemistSkill2Used) add("skill", 2, 1800, "alchemist_upgrade_materials");
  } else if (jobKey === 8) {
    if (Number(state?.level ?? 1) < 2) add("shop", 0, Number(state?.equippedArrowAmmo ?? 0) <= 0 ? 2800 : -700, "archer_reach_level2");
    if (Number(state?.equippedArrowAmmo ?? 0) <= 0 && !state?.archerNoConsumeActive) add("shop", 0, 6200, "archer_no_arrow");
    if (state?.canSkill2 && !state?.archerSkill2Used) add("skill", 2, 8600, "archer_skill2_first");
    if (state?.archerSkill2Used) {
      if (state?.needsArcherArrowPrep) add("shop", 0, 7200, "archer_two_arrows_poison");
      add("arrow", 0, state?.needsArcherArrowPrep ? 6200 : 1800, "archer_equip_two_arrows");
      if (state?.canSkill1 && !state?.archerSkill1Used) {
        add("skill", 1, state?.archerIdealSkill1Setup ? 7800 : -6200, "archer_skill1_poison_pair");
      }
      if (state?.canSkill3 && !state?.archerSkill3Used) {
        add("skill", 3, state?.archerSkill1Used || state?.archerNoConsumeActive ? 5200 : 900, "archer_infinite_arrows");
      }
    } else {
      add("skill", 1, -9000, "archer_hold_skill1");
    }
  } else if (jobKey === 9) {
    if (isCpuSummonerJobName(state?.job)) {
      if (state?.canSkill1 && !state?.summonerSkill1Used && Number(state?.summonerDragonCount ?? 0) < 3) {
        add("skill", 1, Number(state?.turnCount ?? 0) <= 2 ? 18000 : 9000, "summoner_first_contract");
        add("shop", 0, 3600, "summoner_buy_first_egg");
      }
      if (Number(state?.summonerDragonCount ?? 0) < 3 && state?.shopHasSummonerEgg) {
        add("shop", 0, 6200 + Math.max(0, 3 - Number(state?.summonerDragonCount ?? 0)) * 900, "summoner_collect_eggs");
      }
      if (state?.canSkill2 && Number(state?.summonerAdultCount ?? 0) <= 0) {
        add("skill", 2, Number(state?.summonerEggCount ?? 0) > 0 ? 7200 : 5600, "summoner_accelerate_growth");
      }
      if (state?.summonerNeedsGrowth && state?.shopHasSummonerFeed) {
        add("shop", 0, Number(state?.summonerFeedCount ?? 0) <= 0 ? 4800 : 1800, "summoner_buy_feed");
      }
      if (state?.hasUsableItem && Number(state?.summonerFeedCount ?? 0) > 0) {
        add("use_item", 0, 5600, "summoner_use_feed");
      }
      if (state?.canSkill3 && state?.summonerHasNonEgg) {
        const ready = Number(state?.summonerAdultCount ?? 0) > 0 || Number(state?.enemyHpRate ?? 1) < 0.62 || Number(state?.turnCount ?? 0) >= 7;
        add("skill", 3, ready ? 6200 : -1800, "summoner_resonance");
      }
      add("attack", 0, Number(state?.summonerTiamatDamageEstimate ?? 0) * 120, "summoner_pursuit_attack");
      return candidates;
    }
    const dollRate = Number(state?.dollDurabilityRate ?? 1);
    const repairCount = Number(state?.dollRepairItemCount ?? 0);
    const chargeCount = Number(state?.dollChargeEquippedCount ?? 0);
    const burstThreat = isCpuDollBurstThreatJob(state?.enemyJob);
    const repairStockWindow =
      Number(state?.turnCount ?? 0) <= (burstThreat ? 8 : 5);
    if (Number(state?.turnCount ?? 0) <= 1 && !state?.dollSkill1Used) {
      add("skill", 1, 15000, "doll_open_repair_kit");
      add("shop", 0, -5000, "doll_no_shop_before_open_skill1");
      add("doll_charge", 0, -5000, "doll_no_charge_before_open_skill1");
    }
    if (chargeCount <= 0) {
      add("shop", 0, Number(state?.turnCount ?? 0) <= 5 ? 4200 : 900, "doll_need_charge_costume");
      add("special", 0, 5200, "doll_equip_charge_costume");
      add("doll_charge", 0, 2600, "doll_boost_charge_costume");
    } else if (chargeCount < 2) {
      add("shop", 0, Number(state?.turnCount ?? 0) <= 4 && Number(state?.coins ?? 0) >= 35 ? 900 : -900, "doll_second_charge_if_affordable");
      add("special", 0, 2200, "doll_second_charge_equip");
      add("doll_charge", 0, 1900, "doll_charge_rotation");
    }
    if (Number(state?.level ?? 1) < 2) {
      add("shop", 0, -1200, "doll_save_for_level2");
      add("skill", 1, Number(state?.dollRepairItemCount ?? 0) <= 0 ? 700 : -900, "doll_repair_kit_once");
    }
    if (state?.canSkill2 && !state?.dollSkill2Used) {
      add("skill", 2, 6800, "doll_early_tailor");
    }
    if (state?.canSkill3) {
      add("skill", 3, isDollSkill3Ready(state) ? 6800 : -7000, "doll_rampage_safe_timing");
    }
    if (state?.dollIsRampage && state?.canDollCharge) {
      add("doll_charge", 0, 7200, "doll_rampage_extra_attack");
    }
    if (
      repairCount <= 0 &&
      state?.shopHasDollRepairItem &&
      (chargeCount > 0 || Number(state?.turnCount ?? 0) >= 3) &&
      (repairStockWindow || dollRate < 0.9)
    ) {
      add("shop", 0, burstThreat ? 5200 : 4200, "doll_keep_repair_ticket");
    }
    if (dollRate < (burstThreat ? 0.92 : 0.9) || (repairCount <= 0 && dollRate < 0.88)) {
      add("shop", 0, dollRate < 0.62 ? 3600 : repairCount <= 0 ? 2400 : 650, "doll_keep_repair_kit");
      add("use_item", 0, dollRate < 0.78 ? 5200 : 3600, "doll_repair_high");
    }
    if (Number(state?.enemyHpRate ?? 1) < 0.45 && Number(state?.hpRate ?? 1) > 0.45) {
      add("skill", 2, 2500, "doll_lethal_push");
      add("doll_charge", 0, 1500, "doll_attack_charge");
    } else if (Number(state?.hpRate ?? 1) > 0.62) {
      add("skill", 2, 1200, "doll_hp_cost_safe");
    }
  } else if (jobKey === 10) {
    add("shop", 0, 2600, "mad_item_stock");
    if (state?.usableItemIsMadSpecial) add("use_item", 0, 6200, "mad_special_item");
    if (state?.usableItemIsHeal && Number(state?.hpRate ?? 1) < 0.75) add("use_item", 0, 3600, "mad_heal_item");
    if (!state?.madSkill3Used && state?.canSkill3) add("skill", 3, 9000, "mad_guts_early");
    if (state?.madIsMad) {
      if (Number(state?.enemyHpRate ?? 1) < 0.55) add("skill", 3, 2200, "mad_finish");
      add("skill", 2, 3100, "mad_buff_after_madness");
      add("skill", 1, 2300, "mad_pressure_after_madness");
    } else {
      add("skill", 1, -5200, "mad_hold_skill_before_madness");
      add("skill", 2, -4800, "mad_hold_buff_before_madness");
    }
  }

  return candidates;
}

function applyOpponentCpuScores(candidates, state) {
  const enemyJobKey = getCpuJobKeyByName(state?.enemyJob);
  const hpRate = Number(state?.hpRate ?? 1);
  const enemyHpRate = Number(state?.enemyHpRate ?? 1);
  const addType = (type, score, reason) => {
    for (const c of candidates) {
      if (c.type === type) {
        c.score += score;
        c.reason = `${c.reason}+${reason}`;
      }
    }
  };
  const addSkill = (id, score, reason) => {
    for (const c of candidates) {
      if (c.type === "skill" && Number(c.id ?? 0) === Number(id ?? 0)) {
        c.score += score;
        c.reason = `${c.reason}+${reason}`;
      }
    }
  };

  if (enemyJobKey === 2) {
    addType("skill", 650, "vs_knight_need_pressure");
    if (enemyHpRate < 0.45) addType("attack", 700, "vs_knight_finish");
  } else if (enemyJobKey === 3) {
    addType("skill", 900, "vs_priest_burst_before_heal");
    if (enemyHpRate < 0.55) addType("attack", 550, "vs_priest_close");
  } else if (enemyJobKey === 5) {
    addType("skill", 850, "vs_mage_race");
    if (hpRate < 0.45) addType("use_item", 850, "vs_mage_survive_burst");
  } else if (enemyJobKey === 7) {
    addType("shop", -450, "vs_alchemist_tempo");
    addType("skill", 600, "vs_alchemist_pressure");
  } else if (enemyJobKey === 8) {
    addType("skill", 500, "vs_archer_pressure");
    if (hpRate < 0.5) addType("use_item", 650, "vs_archer_survive");
  } else if (enemyJobKey === 9) {
    if (isCpuSummonerJobName(state?.enemyJob)) {
      addType("skill", 650, "vs_summoner_pressure");
      addType("attack", 420, "vs_summoner_before_dragons");
    } else {
      addType("skill", 650, "vs_doll_break_or_burst");
      addSkill(2, 350, "vs_doll_mid_skill");
    }
  } else if (enemyJobKey === 10) {
    addType("attack", 450, "vs_mad_stable_damage");
    if (hpRate < 0.5) addType("use_item", 700, "vs_mad_survive");
  }

  return candidates;
}

function applyCpuStyleScores(candidates, state) {
  const style = state?.aiStyle ?? "balanced";
  const jobKey = getCpuJobKeyByName(state?.job);
  const hpRate = Number(state?.hpRate ?? 1);
  const enemyHpRate = Number(state?.enemyHpRate ?? 1);
  const addType = (type, score, reason) => {
    for (const c of candidates) {
      if (c.type === type) {
        c.score += score;
        c.reason = `${c.reason}+${reason}`;
      }
    }
  };
  const addSkill = (id, score, reason) => {
    for (const c of candidates) {
      if (c.type === "skill" && Number(c.id ?? 0) === Number(id ?? 0)) {
        c.score += score;
        c.reason = `${c.reason}+${reason}`;
      }
    }
  };

  if (style === "aggro") {
    addType("attack", enemyHpRate < 0.45 ? 1150 : 450, "style_aggro_attack");
    addType("skill", enemyHpRate < 0.55 ? 1200 : 750, "style_aggro_skill");
    if (hpRate > 0.42) addType("use_item", -450, "style_aggro_less_item");
  } else if (style === "survival") {
    if (hpRate < 0.72) addType("use_item", 1800, "style_survival_item");
    if (hpRate < 0.65) addType("shop", 900, "style_survival_shop");
    addType("attack", hpRate < 0.5 ? -650 : -150, "style_survival_safe");
    if (jobKey === 2) addSkill(2, 1200, "style_survival_guard");
    if (jobKey === 3) {
      addSkill(1, 950, "style_survival_regen");
      addSkill(2, 850, "style_survival_cleanse");
    }
  } else if (style === "economy") {
    addType("shop", 1250, "style_economy_shop");
    addType("equip", 900, "style_economy_equip");
    addType("special", 650, "style_economy_special");
    addType("combine_equip", 1150, "style_economy_combine");
    if (hpRate > 0.45) addType("attack", -300, "style_economy_delay");
  } else if (style === "combo") {
    addType("skill", 650, "style_combo_skill");
    addType("special", 900, "style_combo_special");
    addType("doll_charge", 1200, "style_combo_charge");
    addType("combine_equip", 950, "style_combo_combine");
    if (hpRate > 0.48) addType("attack", -350, "style_combo_not_plain_attack");
    addSkill(3, 850, "style_combo_big_skill");
  }

  return candidates;
}

function isCpuScoredActionAllowed(action, state) {
  const jobKey = getCpuJobKeyByName(state?.job);
  if (jobKey === 3 && action?.type === "skill" && Number(action.id ?? 0) === 3) {
    return isCpuPriestSkill3Ready(state);
  }
  if (jobKey === 4 && action?.type === "skill" && Number(action.id ?? 0) === 3) {
    return isThiefSkill3Ready(state);
  }
  if (
    jobKey === 10 &&
    !state?.madIsMad &&
    action?.type === "skill" &&
    (Number(action.id ?? 0) === 1 || Number(action.id ?? 0) === 2)
  ) {
    return false;
  }
  if (
    jobKey === 8 &&
    action?.type === "skill" &&
    Number(action.id ?? 0) === 1 &&
    !state?.archerSkill2Used
  ) {
    return false;
  }
  if (
    jobKey === 8 &&
    action?.type === "skill" &&
    Number(action.id ?? 0) === 1 &&
    !state?.archerSkill1Used &&
    state?.needsArcherArrowPrep &&
    !state?.archerIdealSkill1Setup
  ) {
    return false;
  }
  if (
    jobKey === 8 &&
    action?.type === "skill" &&
    Number(action.id ?? 0) === 3 &&
    !state?.archerSkill1Used &&
    !state?.archerNoConsumeActive
  ) {
    return false;
  }
  if (
    jobKey === 9 &&
    action?.type === "skill" &&
    Number(action.id ?? 0) === 3
  ) {
    if (isCpuSummonerJobName(state?.job)) {
      return !!state?.summonerHasNonEgg;
    }
    return isDollSkill3Ready(state);
  }
  return true;
}

function decideCpuScoredAction(state) {
  const aiLevel = normalizeCpuAiLevel(state?.aiLevel) ?? 5;
  if (aiLevel < 6) return null;

  const candidates = applyCpuStyleScores(
    applyOpponentCpuScores(
      applyJobCpuScores(buildCpuScoredCandidates(state), state),
      state
    ),
    state
  )
    .filter(c =>
      (c.type === "skill" || c.type === "attack") &&
      Number.isFinite(Number(c.score)) &&
      isCpuScoredActionAllowed(c, state)
    );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Number(b.score) - Number(a.score));

  const top = candidates[0];
  if (aiLevel >= 9) return top;

  const windowSize = aiLevel >= 8 ? 2 : 3;
  const pool = candidates.slice(0, windowSize);
  return pool[Math.floor(Math.random() * pool.length)] ?? top;
}


function decideCpuAction(state) {
  const jobKey = getCpuJobKeyByName(state?.job);

  if (jobKey === 7 && state.canSkill1 && !state.alchemistSkill1Used) {
    return { type: "skill", id: 1 };
  }

  if (jobKey === 9 && isCpuSummonerJobName(state?.job)) {
    if (state.hasUsableItem && state.usableItem?.is_summoner_feed && !shouldCpuHoldUsableItem(state)) {
      return { type: "use_item" };
    }
    if (state.canSkill1 && !state.summonerSkill1Used && Number(state.summonerDragonCount ?? 0) < 3) {
      return { type: "skill", id: 1 };
    }
    if (shouldCpuLevelUpEarly(state)) {
      return { type: "level_up" };
    }
    if (
      state.canBuy &&
      Number(state.shopCountThisTurn ?? 0) < 2 &&
      state.shopHasSummonerEgg &&
      Number(state.summonerDragonCount ?? 0) < 3
    ) {
      return { type: "shop" };
    }
    if (
      state.canSkill2 &&
      (
        Number(state.summonerEggCount ?? 0) > 0 ||
        (Number(state.summonerJuvenileCount ?? 0) > 0 && Number(state.summonerAdultCount ?? 0) <= 0)
      )
    ) {
      return { type: "skill", id: 2 };
    }
    if (
      state.canBuy &&
      Number(state.shopCountThisTurn ?? 0) < 2 &&
      state.shopHasSummonerFeed &&
      state.summonerNeedsGrowth &&
      Number(state.summonerFeedCount ?? 0) < 2
    ) {
      return { type: "shop" };
    }
    if (
      state.canSkill3 &&
      state.summonerHasNonEgg &&
      (
        Number(state.summonerAdultCount ?? 0) > 0 ||
        Number(state.enemyHpRate ?? 1) < 0.62 ||
        Number(state.turnCount ?? 0) >= 7
      )
    ) {
      return { type: "skill", id: 3 };
    }
    const scored = decideCpuScoredAction(state);
    if (scored && (scored.type === "skill" || scored.type === "attack")) return scored;
    if (state.canSkill1 && Number(state.summonerDragonCount ?? 0) < 3) return { type: "skill", id: 1 };
    return { type: "attack" };
  }

  if (
    jobKey === 9 &&
    Number(state.turnCount ?? 0) <= 1 &&
    state.canSkill1 &&
    !state.dollSkill1Used
  ) {
    return { type: "skill", id: 1 };
  }

  // =========================
  // 1) 準備行動（ターン非消費）
  // =========================

  if (state.hasArrowEquip) {
    return { type: "arrow" };
  }

  if (
    jobKey === 8 &&
    state.canBuy &&
    Number(state.shopCountThisTurn ?? 0) < 1 &&
    state.needsArcherArrowPrep
  ) {
    return { type: "shop" };
  }

  if (
    state.canBuy &&
    state.needsArrowShop &&
    (jobKey !== 8 || Number(state.shopCountThisTurn ?? 0) < 1)
  ) {
    return { type: "shop" };
  }

  // 回復（HPが減っていて、回復アイテムを持っている）
  if (state.hasUsableItem && !shouldCpuHoldUsableItem(state)) {
    return { type: "use_item" };
  }

  if (jobKey === 9 && shouldCpuLevelUpEarly(state)) {
    return { type: "level_up" };
  }

  if (
    jobKey === 9 &&
    state.canBuy &&
    Number(state?.shopCountThisTurn ?? 0) < 1 &&
    Number(state?.dollRepairItemCount ?? 0) <= 0 &&
    state?.shopHasDollRepairItem &&
    Number(state?.dollChargeEquippedCount ?? 0) > 0 &&
    (
      Number(state?.dollDurabilityRate ?? 1) < 0.92 ||
      Number(state?.turnCount ?? 0) <= (isCpuDollBurstThreatJob(state?.enemyJob) ? 8 : 5)
    )
  ) {
    return { type: "shop" };
  }

  if (state.canDollCharge) {
    return { type: "doll_charge" };
  }

  if (shouldCpuLevelUpEarly(state)) {
    return { type: "level_up" };
  }

  if (jobKey === 7 && state.hasCombineEquip) {
    return { type: "combine_equip" };
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

  if (
    jobKey === 3 &&
    state.canBuy &&
    Number(state.shopCountThisTurn ?? 0) < 1 &&
    Number(state.priestRegenItemCount ?? 0) <= 0 &&
    Number(state.priestRegenRounds ?? 0) <= 3
  ) {
    return { type: "shop" };
  }

  if (
    jobKey === 6 &&
    state.canBuy &&
    (Number(state.onmyojiTalismanCount ?? 0) < 2 || !state.hasEquip)
  ) {
    return { type: "shop" };
  }

  if (
    jobKey === 7 &&
    state.canBuy &&
    Number(state.alchemistEquipCount ?? 0) < 5
  ) {
    return { type: "shop" };
  }

  if (
    jobKey === 9 &&
    state.canBuy &&
    Number(state.shopCountThisTurn ?? 0) < 1 &&
    !(
      Number(state.level ?? 1) === 2 &&
      state.dollSkill2Used &&
      !state.dollSkill3Used &&
      Number(state.levelShortage ?? 0) > 0 &&
      Number(state.dollChargeEquippedCount ?? 0) > 0 &&
      Number(state.dollDurabilityRate ?? 1) >= 0.5 &&
      Number(state.dollRepairItemCount ?? 0) > 0
    ) &&
    (
      (Number(state.dollChargeEquippedCount ?? 0) <= 0 && Number(state.turnCount ?? 0) <= 5) ||
      (Number(state.dollChargeOwnedCount ?? 0) < 2 && Number(state.coins ?? 0) >= 35 && Number(state.turnCount ?? 0) <= 4) ||
      (
        Number(state.dollRepairItemCount ?? 0) <= 0 &&
        state.shopHasDollRepairItem &&
        (Number(state.dollChargeEquippedCount ?? 0) > 0 || Number(state.turnCount ?? 0) >= 3) &&
        (
          Number(state.dollDurabilityRate ?? 1) < 0.9 ||
          Number(state.turnCount ?? 0) <= (isCpuDollBurstThreatJob(state?.enemyJob) ? 8 : 5)
        )
      ) ||
      Number(state.dollDurabilityRate ?? 1) < 0.58
    )
  ) {
    return { type: "shop" };
  }

  // ショップ（“必要があるときだけ”行く：まだ整ってない要素がある時）
  // ※ ここが「shop連打」になりにくいポイント
  if (
    jobKey !== 3 &&
    jobKey !== 9 &&
    state.canBuy &&
    (jobKey !== 8 || Number(state.shopCountThisTurn ?? 0) < 1) &&
    (
      jobKey !== 8 ||
      state.archerNoConsumeActive ||
      state.needsArrowShop ||
      state.needsArcherArrowPrep ||
      (Number(state.turnCount ?? 0) <= 5 && !state.hasCoinEquip)
    ) &&
    (
      !state.hasEquip ||              // 装備なし
      state.hasSpecialEquip ||        // 特殊をまだ付けたい
      (state.hpRate < 0.7 && !state.hasHealItem) // 回復したいのにアイテムが無い
    )
  ) {
    return { type: "shop" };
  }

  // =========================
  // 2) 消費行動（ターン消費）
  // =========================
  if (jobKey === 8) {
    if (!state.archerSkill2Used) {
      if (state.canSkill2) return { type: "skill", id: 2 };
      return { type: "attack" };
    }
    if (state.canSkill1 && !state.archerSkill1Used && state.archerIdealSkill1Setup) {
      return { type: "skill", id: 1 };
    }
    if (state.canSkill3 && !state.archerSkill3Used && (state.archerSkill1Used || state.archerNoConsumeActive)) {
      return { type: "skill", id: 3 };
    }
  }

  const scoredAction = decideCpuScoredAction(state);
  if (scoredAction && (scoredAction.type === "skill" || scoredAction.type === "attack")) {
    return scoredAction;
  }

  if (jobKey === 10 && !state.madIsMad) {
    if (state.canSkill3 && !state.madSkill3Used) return { type: "skill", id: 3 };
    return { type: "attack" };
  }

  if (jobKey === 9) {
    if (state.dollIsRampage && state.canDollCharge) {
      return { type: "doll_charge" };
    }
    if (state.canSkill2 && !state.dollSkill2Used && Number(state.hpRate ?? 1) > 0.35) {
      return { type: "skill", id: 2 };
    }
    if (state.canSkill3) {
      if (isDollSkill3Ready(state)) return { type: "skill", id: 3 };
      return { type: "attack" };
    }
  }

  if (jobKey === 7) {
    if (state.canSkill1 && !state.alchemistSkill1Used) return { type: "skill", id: 1 };
    if (state.canSkill3 && state.alchemistFusionReady && !state.alchemistSkill3Used) return { type: "skill", id: 3 };
    if (state.canSkill2 && !state.alchemistSkill2Used && Number(state.alchemistEquipCount ?? 0) >= 2) return { type: "skill", id: 2 };
  }

  if (state.isMage && state.manaMax > 0 && state.mana >= state.manaMax) {
    if (state.canSkill3) return { type: "skill", id: 3 };
    if (state.canSkill2) return { type: "skill", id: 2 };
  }

  if (state.isMage && state.mana >= 90 && state.canSkill3) {
    return { type: "skill", id: 3 };
  }

  if (state.canSkill4) return { type: "skill", id: 4 };
  if (state.canSkill5) return { type: "skill", id: 5 };

  // =========================
  // ★ 錬金術師：合成不能なら即攻撃（無限防止）
  // =========================
  if (
    jobKey === 7 &&
    state.canSkill3 &&
    !state.alchemistFusionReady
  ) {
    return { type: "attack" };
  }

  // =========================
  // ★ 錬金術師：三重合成は装備3つ以上ある時だけ
  // =========================
  if (
    state.canSkill3 &&
    (jobKey !== 4 || isThiefSkill3Ready(state)) &&
    (jobKey !== 3 || isCpuPriestSkill3Ready(state)) &&
    (jobKey !== 8 || state.archerSkill1Used || state.archerNoConsumeActive) &&
    (jobKey !== 9 || isDollSkill3Ready(state)) &&
    (
      jobKey !== 7 ||
      state.alchemistFusionReady
    )
  ) {
    return { type: "skill", id: 3 };
  }

  if (state.canSkill2) return { type: "skill", id: 2 };
  if (state.canSkill1) return { type: "skill", id: 1 };

  return { type: "attack" };
}

async function cpuConsumeTurnAction(match, ws) {
  const P = ws?.player;
  prepareCpuSummonerAction(P, { type: "attack" });
  if (P?.job === "弓兵" && !P.has_usable_arrow?.()) {
    await match.handleAction(ws, "矢なしターン終了");
    return;
  }

  await match.handleAction(ws, "攻撃");
}

// =========================================================
// ★ 開発用：CPU行動を1手だけ実行（UIなし）
// =========================================================
async function cpuStep(match, ws) {
  const state = analyzeCpuState(match, ws);
  const action = applyCpuAiMistake(decideCpuAction(state), state);
  recordCpuSimDecision(match, ws, action, state, "auto_step");

  const P = ws.player;
  prepareCpuSummonerAction(P, action);

  // 準備行動は1回だけ
  if (action.type === "use_item" && state.usableItem) {
    const used = cpuUseItemDirect(match, ws, state.usableItem);
    const consumesTurn = used && state.usableItem.consumes_turn === true;
    if (consumesTurn) match.endRound();
    return consumesTurn;
  }

  if (action.type === "equip" && state.equipItem) {
    match.useItem(ws, state.equipItem.uid, "equip");
    return false;
  }

  if (action.type === "doll_charge") {
    cpuUseDollCharge(match, ws);
    return false;
  }

  if (action.type === "level_up") {
    cpuTryLevelUp(match, ws);
    return false;
  }

  if (action.type === "combine_equip" && state.combineEquipPair) {
    match.combineNormalEquips(ws, state.combineEquipPair.uid1, state.combineEquipPair.uid2);
    return false;
  }

  if (action.type === "special" && state.specialEquip) {
    match.useItem(ws, state.specialEquip.uid, "special");
    return false;
  }

  if (action.type === "arrow" && state.arrowEquip) {
    const slot = getCpuArrowEquipSlot(P, state.arrowEquip);
    match.useItem(ws, state.arrowEquip.uid, "arrow", slot);
    return false;
  }

  if (action.type === "shop") {
    match.openShop(ws);
    markCpuShopAction(P);
    const urgentArrowNeed = isCpuArcherJob(P) && !P.has_usable_arrow?.();
    let preferredArrow = getCpuBestShopArrow(P, { urgent: urgentArrowNeed, state });
    const rerollForArrow =
      isCpuArcherJob(P) &&
      (urgentArrowNeed || state.needsArrowShop || state.needsArcherArrowPrep) &&
      getCpuShopCountThisTurn(P) <= 1 &&
      canCpuRerollAndStillAffordArrow(P);
    if (!preferredArrow && rerollForArrow) {
      match.shopReroll(ws);
      preferredArrow = getCpuBestShopArrow(P, { urgent: urgentArrowNeed, state });
    }
    if (preferredArrow) {
      const idx = P.shop_items.findIndex(x => x.uid === preferredArrow.uid);
      if (idx >= 0) {
        match.buyItem(ws, idx);
        recordCpuSimDecision(match, ws, { type: "buy_item", item: preferredArrow, reason: "shop_preferred_arrow" }, state, "resolved");
      }
    } else if (isCpuArcherJob(P) && (state.needsArrowShop || state.needsArcherArrowPrep)) {
      return false;
    } else {
      const shopCandidates = (P.shop_items ?? []).filter(it =>
        !(it?.sold_out || it?.soldOut || it?.shop_sold_out)
      );
      const picked = pickCpuShopPurchase(P, shopCandidates, state);
      const idx = picked ? P.shop_items.findIndex(x => x.uid === picked.uid) : -1;
      if (idx >= 0) {
        match.buyItem(ws, idx);
        recordCpuSimDecision(match, ws, { type: "buy_item", item: picked, reason: "shop_purchase" }, state, "resolved");
      }
    }
    return false;
  }

  // ===== 消費行動 =====
  if (action.type === "skill") {
    if (getCpuJobKeyByName(P?.job) === 7 && Number(action.id ?? 0) === 3) {
      P.pending_alchemist_selection = pickCpuAlchemistFusionUids(P);
    }

    if (P.job === "人形使い" && action.id === 2) {
      const cost = decideCpuDollSkill2Cost(P);
      if (!cost) {
        await cpuConsumeTurnAction(match, ws);
        return true;
      }
      P.pending_hp_cost = cost;
    }

    await match.handleAction(ws, "スキル" + action.id);
    return true;
  }

  await cpuConsumeTurnAction(match, ws);
  return true;
}

async function autoPlayerTurn(match, ws) {
  if (!match || !ws || match.ended || match.current !== ws) return;
  if (match._playerAutoThinking) return;

  match._playerAutoThinking = true;
  try {
    const prepLimit = Math.max(4, getCpuNormalEquipMaxSlots(ws.player, match) + 4);
    for (let i = 0; i < prepLimit; i++) {
      if (match.ended || match.current !== ws) return;
      const consumedTurn = await cpuStep(match, ws);
      if (consumedTurn || match.ended || match.current !== ws) return;
      if (!match.simulate) await new Promise(r => setTimeout(r, 220));
    }

    if (!match.ended && match.current === ws) {
      await cpuConsumeTurnAction(match, ws);
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
// ★ CPU AI：ターン処理（1ターンで準備→最後に消費）
// =========================================================
export async function maybeCpuTurn(match) {
  if (match.ended) return;
  if (!match.current?.isBot) return;

  const now = Date.now();
  if (match._cpuThinking) {
    if (now - Number(match._cpuThinkingAt ?? 0) < 12000) return;
    console.warn("[CPU] stale thinking lock reset");
    match._cpuThinking = false;
  }
  match._cpuThinking = true;
  match._cpuThinkingAt = now;

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
      match._cpuThinkingAt = 0;
    }
  }


  try {
    // =========================
    // 準備行動フェーズ（最大3回）
    // =========================
    const MAX_PREP = 4;

    for (let k = 0; k < MAX_PREP; k++) {
      if (match.ended) return;
      if (match.current !== botWS) return; // 手番が変わったら中止

      const state = analyzeCpuState(match, botWS);
      const action = applyCpuAiMistake(decideCpuAction(state), state);

      // 「消費行動」になったら準備終了→この後に実行する
      if (action.type === "skill" || action.type === "attack") {
        break;
      }
      recordCpuSimDecision(match, botWS, action, state, "prep");
      prepareCpuSummonerAction(P, action);

      if (!(await waitCpuThink(match, botWS, "考え中"))) return;

      switch (action.type) {

        case "use_item":
          if (state.usableItem) {
            const used = cpuUseItemDirect(match, botWS, state.usableItem);
            if (used) didSomething = true;

            // ★ ターン消費アイテムのみターンを終了（修理キットは手動操作と同じ非ターン消費）
            if (
              used &&
              state.usableItem.consumes_turn === true
            ) {
              match.endRound();
              return;
            }
          }
          break;

        case "doll_charge":
          if (cpuUseDollCharge(match, botWS)) {
            didSomething = true;
          }
          break;

        case "level_up":
          if (cpuTryLevelUp(match, botWS)) {
            didSomething = true;
          }
          break;

        case "combine_equip":
          if (state.combineEquipPair) {
            match.combineNormalEquips(botWS, state.combineEquipPair.uid1, state.combineEquipPair.uid2);
            didSomething = true;
          }
          break;


        // =========================
        // ★ 矢装備（正しい独立ケース）
        // =========================
        case "arrow":
          if (state.arrowEquip) {
            const slot = getCpuArrowEquipSlot(P, state.arrowEquip);

            match.useItem(
              botWS,
              state.arrowEquip.uid,
              "arrow",
              slot
            );
            didSomething = true;
          }
          break;

        case "equip":
          if (state.equipItem) {
            match.useItem(botWS, state.equipItem.uid, "equip");
            didSomething = true;
          }
          break;

        case "special":

          // ============================
          // ★ 人形使い：人形が壊れている時は装備行動をしない
          // ============================
          if (P.job === "人形使い" && (!P.doll || P.doll.is_broken)) {
            // 無効な準備行動を避けるため、必ず消費行動にフォールバック
            await cpuConsumeTurnAction(match, botWS);
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
            didSomething = true;
          }
          break;







        case "shop": {
          match.openShop(botWS);

          const P = botWS.player;
          markCpuShopAction(P);
          const urgentArrowNeed = isCpuArcherJob(P) && !P.has_usable_arrow?.();
          let preferredArrow = getCpuBestShopArrow(P, { urgent: urgentArrowNeed, state });
          const rerollForArrow =
            isCpuArcherJob(P) &&
            (urgentArrowNeed || state.needsArrowShop || state.needsArcherArrowPrep) &&
            getCpuShopCountThisTurn(P) <= 1 &&
            canCpuRerollAndStillAffordArrow(P);
          if (!preferredArrow && rerollForArrow) {
            match.shopReroll(botWS);
            didSomething = true;
            preferredArrow = getCpuBestShopArrow(P, { urgent: urgentArrowNeed, state });
          }
          if (preferredArrow) {
            const idx = P.shop_items.findIndex(x => x.uid === preferredArrow.uid);
            if (idx >= 0) {
              match.buyItem(botWS, idx);
              recordCpuSimDecision(match, botWS, { type: "buy_item", item: preferredArrow, reason: "shop_preferred_arrow" }, state, "resolved");
              didSomething = true;
              break;
            }
          }
          if (isCpuArcherJob(P) && (state.needsArrowShop || state.needsArcherArrowPrep)) {
            break;
          }


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
              if (isCpuDollChargeCostume(it)) {
                const chargeEquipped = getCpuDollChargeCostumeCount(P, { includeInventory: false });
                const chargeOwned = getCpuDollChargeCostumeCount(P, { includeInventory: true });
                const keepRepairCoins = Number(P.coins ?? 0) - Number(it.price ?? 0) >= 15;
                if (chargeEquipped <= 0 && !(list ?? []).some(isCpuDollChargeCostume)) return true;
                if (chargeOwned < 2 && keepRepairCoins) return true;
                if (chargeOwned < 3 && Number(P.turn_count ?? 0) <= 5 && keepRepairCoins) return true;
              }
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
            const it = pickCpuShopPurchase(P, shopCandidates, state);
            if (!it) break;
            const idx = P.shop_items.findIndex(x => x.uid === it.uid);
            if (idx >= 0) {
              match.buyItem(botWS, idx);
              recordCpuSimDecision(match, botWS, { type: "buy_item", item: it, reason: "shop_purchase" }, state, "resolved");
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
    // =========================
    // 最後に消費行動（必ず1回）
    // =========================
    if (match.ended) return;
    if (match.current !== botWS) return;

    const finalState = analyzeCpuState(match, botWS);
    let finalAction = applyCpuAiMistake(decideCpuAction(finalState), finalState);
    if (finalAction.type !== "skill" && finalAction.type !== "attack") {
      finalAction = { type: "attack", reason: "fallback_after_prep" };
    }
    recordCpuSimDecision(match, botWS, finalAction, finalState, "final");
    prepareCpuSummonerAction(botWS.player, finalAction);
    if (!(await waitCpuThink(
      match,
      botWS,
      finalAction.type === "skill" ? "スキルを考え中" : "攻撃を考え中",
      finalAction.type === "attack" ? CPU_ATTACK_ONLY_MIN_MS : CPU_THINK_MIN_MS,
      finalAction.type === "attack" ? CPU_ATTACK_ONLY_MAX_MS : CPU_THINK_MAX_MS
    ))) return;

    if (finalAction.type === "skill") {

      const P = botWS.player;

      if (getCpuJobKeyByName(P?.job) === 7 && Number(finalAction.id ?? 0) === 3) {
        P.pending_alchemist_selection = pickCpuAlchemistFusionUids(P);
      }

      // ★ スキル封印・使用不可なら即攻撃に切り替える
      if (P.skill_sealed || !canUseCpuSkill(P, finalAction.id, match)) {
        await cpuConsumeTurnAction(match, botWS);
        return;
      }


      // =========================
      // ★ CPU用：人形スキル2のHP自動指定
      // =========================
      if (P.job === "人形使い" && finalAction.id === 2) {
        const cost = decideCpuDollSkill2Cost(P);
        if (!cost) {
          await cpuConsumeTurnAction(match, botWS);
          return;
        }
        P.pending_hp_cost = cost; // ★ ここが核心
      }

      if (!canUseCpuSkill(P, finalAction.id, match)) {
        await cpuConsumeTurnAction(match, botWS);
        return;
      }

      await match.handleAction(
        botWS,
        "スキル" + finalAction.id
      );
      return;
    }




    // デフォルトは攻撃
    await cpuConsumeTurnAction(match, botWS);
    return;

  } finally {
    match._cpuThinking = false;
    match._cpuThinkingAt = 0;
  }
}

function getCliArgValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => String(arg).startsWith(prefix));
  return found ? String(found).slice(prefix.length) : fallback;
}

function pickCpuSimJobKey(value) {
  const keys = Object.keys(JOB_TEMPLATE ?? {}).map(Number).filter(Number.isFinite);
  if (!keys.length) return 1;
  const raw = value == null || value === "" || value === "random"
    ? null
    : Number(value);
  if (raw && JOB_TEMPLATE?.[raw]) return raw;
  return keys[Math.floor(Math.random() * keys.length)];
}

function createCpuSimSocket(name, jobKey, aiLevel, aiStyle = "auto") {
  const ws = createBotSocket();
  ws.matchType = "cpu-sim";
  ws.cpuKind = "sim";
  ws.player = new Player(name, jobKey);
  applyCpuAiRank(ws.player, jobKey, aiLevel, aiStyle);
  return ws;
}

async function runSingleCpuSimBattle({ jobA, jobB, levelA, levelB, styleA = "auto", styleB = "auto", turnOrder = "random", maxSteps = 260 } = {}) {
  const p1 = createCpuSimSocket("CPU-A", jobA, levelA, styleA);
  const p2 = createCpuSimSocket("CPU-B", jobB, levelB, styleB);
  p1.player.turn_order = turnOrder;

  const match = new Match(p1, p2);
  match.simulate = true;
  match.devMode = true;
  match.cpuSimLog = [];
  match.start();
  const firstSide = match.current === p1 ? "p1" : "p2";

  for (let step = 0; step < maxSteps && !match.ended; step++) {
    if (!match.current?.isBot) break;
    await maybeCpuTurn(match);
  }

  if (!match.ended) {
    match.finishBattle("draw");
  }

  return {
    result: match.result ?? "draw",
    first: firstSide,
    turns: Math.max(Number(match.P1.turn_count ?? 0), Number(match.P2.turn_count ?? 0)),
    p1: {
      job: match.P1.job,
      aiLevel: match.P1.cpu_ai_level,
      aiStyle: match.P1.cpu_ai_style,
      hp: match.P1.hp,
    },
    p2: {
      job: match.P2.job,
      aiLevel: match.P2.cpu_ai_level,
      aiStyle: match.P2.cpu_ai_style,
      hp: match.P2.hp,
    },
    firstJob: firstSide === "p1" ? match.P1.job : match.P2.job,
    secondJob: firstSide === "p1" ? match.P2.job : match.P1.job,
    decisions: match.cpuSimLog,
  };
}

function summarizeCpuSim(results) {
  const summary = {
    matches: results.length,
    p1Wins: 0,
    p2Wins: 0,
    draws: 0,
    averageTurns: 0,
    sameJobMatches: 0,
    differentJobMatches: 0,
    byTurnOrder: {},
    byJob: {},
    byJobOpponent: {},
    matchupHighlights: {},
    byAiLevel: {},
    byAiStyle: {},
    summonerFrontPerformance: {
      byPrimaryFront: {},
      byFinalActionFront: {},
    },
  };

  const addBucket = (bucket, key, won, turns) => {
    const rec = bucket[key] ?? { games: 0, wins: 0, losses: 0, draws: 0, turns: 0 };
    rec.games++;
    rec.turns += turns;
    if (won === true) rec.wins++;
    else if (won === false) rec.losses++;
    else rec.draws++;
    rec.winRate = rec.games ? Number((rec.wins / rec.games).toFixed(3)) : 0;
    rec.averageTurns = rec.games ? Number((rec.turns / rec.games).toFixed(2)) : 0;
    bucket[key] = rec;
  };
  const addSampleBucket = (bucket, key, won) => {
    const rec = bucket[key] ?? { samples: 0, wins: 0, losses: 0, draws: 0, winRate: 0 };
    rec.samples++;
    if (won === true) rec.wins++;
    else if (won === false) rec.losses++;
    else rec.draws++;
    rec.winRate = rec.samples ? Number((rec.wins / rec.samples).toFixed(3)) : 0;
    bucket[key] = rec;
  };

  const DOLL_JOB = "人形使い";
  const SUMMONER_JOB = "召喚士";
  const makeChoiceBucket = () => ({ total: 0, byChoice: {}, share: {} });
  const makeOutcomeChoiceSet = () => ({
    all: makeChoiceBucket(),
    wins: makeChoiceBucket(),
    losses: makeChoiceBucket(),
    draws: makeChoiceBucket(),
    preRampage: {
      all: makeChoiceBucket(),
      wins: makeChoiceBucket(),
      losses: makeChoiceBucket(),
      draws: makeChoiceBucket(),
    },
    rampage: {
      all: makeChoiceBucket(),
      wins: makeChoiceBucket(),
      losses: makeChoiceBucket(),
      draws: makeChoiceBucket(),
    },
  });
  const addChoice = (bucket, choice) => {
    const key = String(choice || "unknown");
    bucket.total++;
    bucket.byChoice[key] = (bucket.byChoice[key] ?? 0) + 1;
  };
  const addOutcomeChoice = (set, choice, outcome, isRampage) => {
    addChoice(set.all, choice);
    addChoice(set[outcome], choice);
    const phase = isRampage ? set.rampage : set.preRampage;
    addChoice(phase.all, choice);
    addChoice(phase[outcome], choice);
  };
  const finalizeChoiceBucket = (bucket) => {
    bucket.share = {};
    for (const [choice, count] of Object.entries(bucket.byChoice)) {
      bucket.share[choice] = bucket.total ? Number((count / bucket.total).toFixed(3)) : 0;
    }
    return bucket;
  };
  const finalizeOutcomeChoiceSet = (set) => {
    finalizeChoiceBucket(set.all);
    finalizeChoiceBucket(set.wins);
    finalizeChoiceBucket(set.losses);
    finalizeChoiceBucket(set.draws);
    finalizeChoiceBucket(set.preRampage.all);
    finalizeChoiceBucket(set.preRampage.wins);
    finalizeChoiceBucket(set.preRampage.losses);
    finalizeChoiceBucket(set.preRampage.draws);
    finalizeChoiceBucket(set.rampage.all);
    finalizeChoiceBucket(set.rampage.wins);
    finalizeChoiceBucket(set.rampage.losses);
    finalizeChoiceBucket(set.rampage.draws);
    return set;
  };

  summary.dollChargeChoices = {
    job: DOLL_JOB,
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    turns: 0,
    winRate: 0,
    averageTurns: 0,
    choices: makeOutcomeChoiceSet(),
    byOpponent: {},
  };

  for (const r of results) {
    if (r.result === "p1") summary.p1Wins++;
    else if (r.result === "p2") summary.p2Wins++;
    else summary.draws++;
    summary.averageTurns += Number(r.turns ?? 0);
    if (r.p1.job === r.p2.job) summary.sameJobMatches++;
    else summary.differentJobMatches++;

    const firstWon = r.result === "draw" ? null : r.result === r.first;
    const secondWon = r.result === "draw" ? null : r.result !== r.first;
    addBucket(summary.byTurnOrder, "first", firstWon, r.turns);
    addBucket(summary.byTurnOrder, "second", secondWon, r.turns);

    addBucket(summary.byJob, r.p1.job, r.result === "p1" ? true : r.result === "p2" ? false : null, r.turns);
    addBucket(summary.byJob, r.p2.job, r.result === "p2" ? true : r.result === "p1" ? false : null, r.turns);
    summary.byJobOpponent[r.p1.job] ??= {};
    summary.byJobOpponent[r.p2.job] ??= {};
    addBucket(summary.byJobOpponent[r.p1.job], r.p2.job, r.result === "p1" ? true : r.result === "p2" ? false : null, r.turns);
    addBucket(summary.byJobOpponent[r.p2.job], r.p1.job, r.result === "p2" ? true : r.result === "p1" ? false : null, r.turns);
    addBucket(summary.byAiLevel, String(r.p1.aiLevel), r.result === "p1" ? true : r.result === "p2" ? false : null, r.turns);
    addBucket(summary.byAiLevel, String(r.p2.aiLevel), r.result === "p2" ? true : r.result === "p1" ? false : null, r.turns);
    addBucket(summary.byAiStyle, String(r.p1.aiStyle ?? "unknown"), r.result === "p1" ? true : r.result === "p2" ? false : null, r.turns);
    addBucket(summary.byAiStyle, String(r.p2.aiStyle ?? "unknown"), r.result === "p2" ? true : r.result === "p1" ? false : null, r.turns);

    for (const side of ["p1", "p2"]) {
      if (r?.[side]?.job !== SUMMONER_JOB) continue;
      const won = r.result === "draw" ? null : r.result === side;
      const frontCounts = {};
      for (const decision of r.decisions ?? []) {
        if (decision?.actor !== SUMMONER_JOB || decision?.phase !== "final" || !decision?.summonerFront) continue;
        const front = String(decision.summonerFront);
        frontCounts[front] = (frontCounts[front] ?? 0) + 1;
        addSampleBucket(summary.summonerFrontPerformance.byFinalActionFront, front, won);
      }
      const primaryFront = Object.entries(frontCounts)
        .sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0) || String(a[0]).localeCompare(String(b[0])))
        [0]?.[0] ?? "none";
      addBucket(summary.summonerFrontPerformance.byPrimaryFront, primaryFront, won, r.turns);
    }

    const dollSide = r.p1.job === DOLL_JOB ? "p1" : r.p2.job === DOLL_JOB ? "p2" : null;
    if (dollSide) {
      const opponentJob = dollSide === "p1" ? r.p2.job : r.p1.job;
      const outcome = r.result === "draw" ? "draws" : r.result === dollSide ? "wins" : "losses";
      const dollSummary = summary.dollChargeChoices;
      dollSummary.games++;
      dollSummary[outcome]++;
      dollSummary.turns += Number(r.turns ?? 0);

      const opponentSummary = dollSummary.byOpponent[opponentJob] ?? {
        games: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        turns: 0,
        winRate: 0,
        averageTurns: 0,
        choices: makeOutcomeChoiceSet(),
      };
      opponentSummary.games++;
      opponentSummary[outcome]++;
      opponentSummary.turns += Number(r.turns ?? 0);

      for (const decision of r.decisions ?? []) {
        if (decision?.action !== "doll_charge_choice" || decision.actor !== DOLL_JOB) continue;
        addOutcomeChoice(dollSummary.choices, decision.choice, outcome, Boolean(decision.dollRampage));
        addOutcomeChoice(opponentSummary.choices, decision.choice, outcome, Boolean(decision.dollRampage));
      }
      dollSummary.byOpponent[opponentJob] = opponentSummary;
    }
  }

  summary.averageTurns = summary.matches
    ? Number((summary.averageTurns / summary.matches).toFixed(2))
    : 0;
  summary.dollChargeChoices.winRate = summary.dollChargeChoices.games
    ? Number((summary.dollChargeChoices.wins / summary.dollChargeChoices.games).toFixed(3))
    : 0;
  summary.dollChargeChoices.averageTurns = summary.dollChargeChoices.games
    ? Number((summary.dollChargeChoices.turns / summary.dollChargeChoices.games).toFixed(2))
    : 0;
  finalizeOutcomeChoiceSet(summary.dollChargeChoices.choices);
  for (const opponentSummary of Object.values(summary.dollChargeChoices.byOpponent)) {
    opponentSummary.winRate = opponentSummary.games
      ? Number((opponentSummary.wins / opponentSummary.games).toFixed(3))
      : 0;
    opponentSummary.averageTurns = opponentSummary.games
      ? Number((opponentSummary.turns / opponentSummary.games).toFixed(2))
      : 0;
    finalizeOutcomeChoiceSet(opponentSummary.choices);
  }
  for (const [job, opponents] of Object.entries(summary.byJobOpponent)) {
    const entries = Object.entries(opponents)
      .map(([opponent, rec]) => ({ opponent, ...rec }))
      .sort((a, b) =>
        Number(b.winRate ?? 0) - Number(a.winRate ?? 0) ||
        Number(b.games ?? 0) - Number(a.games ?? 0) ||
        String(a.opponent).localeCompare(String(b.opponent), "ja")
      );
    summary.matchupHighlights[job] = {
      best: entries.slice(0, 3),
      worst: entries.slice().reverse().slice(0, 3),
    };
  }
  return summary;
}

function buildCpuSimSchedule({ matchCount, jobAArg, jobBArg, levelA, levelB, styleA, styleB, distinctJobs, roundRobin, repeats }) {
  if (roundRobin) {
    const keys = Object.keys(JOB_TEMPLATE ?? {}).map(Number).filter(Number.isFinite);
    const schedule = [];
    for (const jobA of keys) {
      for (const jobB of keys) {
        if (jobA === jobB) continue;
        for (let i = 0; i < repeats; i++) {
          schedule.push({ jobA, jobB, levelA, levelB, styleA, styleB, turnOrder: "first" });
          schedule.push({ jobA, jobB, levelA, levelB, styleA, styleB, turnOrder: "second" });
        }
      }
    }
    return schedule;
  }

  const schedule = [];
  for (let i = 0; i < matchCount; i++) {
    const jobA = pickCpuSimJobKey(jobAArg);
    let jobB = pickCpuSimJobKey(jobBArg);
    if (distinctJobs) {
      for (let guard = 0; guard < 20 && String(jobA) === String(jobB); guard++) {
        jobB = pickCpuSimJobKey(jobBArg);
      }
    }
    schedule.push({ jobA, jobB, levelA, levelB, styleA, styleB, turnOrder: "random" });
  }
  return schedule;
}

async function runCpuSimBatchFromCli() {
  const matchCount = Math.max(1, Math.min(5000, Number(getCliArgValue("cpu-sim", "100")) || 100));
  const jobAArg = getCliArgValue("cpu-sim-job-a", "random");
  const jobBArg = getCliArgValue("cpu-sim-job-b", "random");
  const levelA = normalizeCpuAiLevel(getCliArgValue("cpu-sim-level-a", getCliArgValue("cpu-sim-level", "10"))) ?? 10;
  const levelB = normalizeCpuAiLevel(getCliArgValue("cpu-sim-level-b", getCliArgValue("cpu-sim-level", "10"))) ?? 10;
  const styleA = getCliArgValue("cpu-sim-style-a", getCliArgValue("cpu-sim-style", "auto"));
  const styleB = getCliArgValue("cpu-sim-style-b", getCliArgValue("cpu-sim-style", "auto"));
  const outFile = getCliArgValue("cpu-sim-out", "tmp/cpu-ai-sim-log.json");
  const distinctJobs = process.argv.includes("--cpu-sim-distinct-jobs");
  const roundRobin = process.argv.includes("--cpu-sim-round-robin");
  const repeats = Math.max(1, Math.min(20, Number(getCliArgValue("cpu-sim-repeats", "3")) || 3));

  const results = [];
  const verbose = process.argv.includes("--cpu-sim-verbose");
  const originalLog = console.log;
  const originalWarn = console.warn;
  if (!verbose) {
    console.log = () => {};
    console.warn = () => {};
  }
  try {
    const schedule = buildCpuSimSchedule({
      matchCount,
      jobAArg,
      jobBArg,
      levelA,
      levelB,
      styleA,
      styleB,
      distinctJobs,
      roundRobin,
      repeats,
    });
    for (const item of schedule) {
      results.push(await runSingleCpuSimBattle(item));
    }
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  const payload = {
    createdAt: new Date().toISOString(),
    options: { matchCount, jobA: jobAArg, jobB: jobBArg, levelA, levelB, styleA, styleB, distinctJobs, roundRobin, repeats },
    summary: summarizeCpuSim(results),
    results,
  };

  const resolved = path.resolve(process.cwd(), outFile);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, JSON.stringify(payload, null, 2), "utf8");
  console.log(`[CPU_SIM] wrote ${resolved}`);
  console.log(JSON.stringify(payload.summary, null, 2));
}






/* =========================================================
   接続処理
   ========================================================= */
wss.on("connection", (ws) => {
  clients.add(ws);
  console.log("接続: クライアント");

  ws.on("close", () => {
    const m = ws.currentMatch;
    if (ws.matchType === "dojo" && ws.dojoRun && ws.player && ws.accountId && (!m || !m.ended)) {
      try {
        saveCurrentDojoRun(ws);
      } catch (e) {
        console.warn("[DOJO] save on close failed:", e);
      }
    }
    clients.delete(ws);

    // 待機キューから除外
    if (waitingPlayer === ws) waitingPlayer = null;

    const rc = ws.roomCode;
    if (rc && waitingRooms.get(rc) === ws) {
      waitingRooms.delete(rc);
    }

    // 進行中の試合があれば、切断側の敗北で即終了
    if (m && !m.ended) {
      m.handleDisconnect(ws);
    }
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "battle_ready") {
      ws.currentMatch?.markBattleReady?.(ws);
      return;
    }

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

    if (msg.type === "join_tutorial") {
      const accountId = msg.account_id ? String(msg.account_id) : null;
      ws.accountId = accountId;
      ws.matchType = "tutorial";
      ws.cpuKind = "tutorial";

      let name = msg.name;
      if (accountId) {
        const acc = getOrCreateAccount(accountId);
        if (acc?.name) name = acc.name;
      }

      const player = attachPlayerProfile(new Player(name || "Player", 1), msg.profile);
      player.turn_order = "first";
      ws.player = player;
      startTutorialMatch(ws);
      return;
    }

    if (ws.matchType === "cpu" || ws.matchType === "tutorial") {
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
      ws.player.cpu_ai_rank = msg.cpu_ai_rank ?? msg.cpu_rank ?? "random";
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

      safeSend(p1, buildMatchStartPayload(p1.player, p2.player));
      safeSend(p2, buildMatchStartPayload(p2.player, p1.player));
      match.sendInitialStatusSnapshot();

      // 既存の対人戦と同じメッセージ処理を流用するため、
      // この後の join_random と同じ処理ブロックに落とす必要がある。
      // → ここでは専用ハンドラを設定して return する。

      const handlePlayerMessage = async (sock, raw2) => {
        const m = JSON.parse(raw2.toString());
        const P = sock === p1 ? match.P1 : match.P2;

        if (await handleSummonerClientMessage(match, sock, P, m)) return;

        // 以下、join_random の共通ハンドラと同等（必要分のみ）
        if (m.type === "request_doll_skill1") {
          if (sock !== match.current) {
            match.sendError("❌ 今はあなたのターンではありません。", sock);
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
            match.sendError("❌ 今はあなたのターンではありません。", sock);
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
            match.sendError("❌ 今はあなたのターンではありません。", sock);
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
            match.sendError("❌ 今はあなたのターンではありません。", sock);
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
            match.sendError("❌ 今はあなたのターンではありません。", sock);
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
          const self = sock === match.p1 ? match.P1 : match.P2;
          const enemy = self === match.P1 ? match.P2 : match.P1;
          match.sendStatusDetail(
            sock,
            self,
            enemy,
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
        safeSend(p1, buildMatchStartPayload(p1.player, p2.player));
        safeSend(p2, buildMatchStartPayload(p2.player, p1.player));
        match.sendInitialStatusSnapshot();

        // =====================================
        // 共通メッセージハンドラ（正）
        // =====================================
        const handlePlayerMessage = async (sock, raw2) => {
          const m = JSON.parse(raw2.toString());
          const P = sock === p1 ? match.P1 : match.P2;
          if (await handleSummonerClientMessage(match, sock, P, m)) return;
          // ================================
          // 人形使い：スキル1 入口（部位選択UI）
          // ================================
          if (m.type === "request_doll_skill1") {

            // 自分のターン以外は不可
            if (sock !== match.current) {
              match.sendError("❌ 今はあなたのターンではありません。", sock);
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
              match.sendError("❌ 今はあなたのターンではありません。", sock);
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
              match.sendError("❌ 今はあなたのターンではありません。", sock);
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
              match.sendError("❌ 今はあなたのターンではありません。", sock);
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
              match.sendError("❌ 今はあなたのターンではありません。", sock);
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
              match.sendError("❌ 今はあなたのターンではありません。", sock);
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

if (RUN_CPU_SIM) {
  setImmediate(async () => {
    let exitCode = 0;
    try {
      await runCpuSimBatchFromCli();
    } catch (err) {
      exitCode = 1;
      console.error("[CPU_SIM] failed", err);
    } finally {
      try { wss.close(); } catch {}
      try {
        server.close(() => process.exit(exitCode));
        setTimeout(() => process.exit(exitCode), 1000).unref?.();
      } catch {
        process.exit(exitCode);
      }
    }
  });
}
