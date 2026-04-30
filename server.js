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
  recordMatchResult,
  recordMatchResultNoRating,
  recordCpuMatchResult,
  importJobRecordBackup
} from "./account_store.js";

// =========================================================
// ★ dev / simulate 判定（本番影響なし）
// =========================================================
export const DEV_MODE = process.argv.includes("--dev-ai");



// デバッグログ ON/OFF
const DEBUG = true;

const clients = new Set();

function safeSend(ws, payload) {
  if (!ws) return;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
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

    default:
      return null;
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
      price: 12,
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
  // API: change name (cooldown 7d)
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

    this.P1 = p1.player;
    this.P2 = p2.player;
    // ★ ここ！！（この直後）
    this.P1.opponent = this.P2;
    this.P2.opponent = this.P1;
    this.P1.match = this;
    this.P2.match = this;

    // ==============================
    // ★ マッチ種別（random / room / cpu）
    // ==============================
    this.matchType = p1.matchType || p2.matchType || "random";

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
        buffs: actor.getBuffDescriptionList(),

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
              ? "衣装を1つ選び、星を1上げる。さらに装備中の全衣装の星を1上げる"
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
            ? `衣装を ${level} 個選び、ぼろぼろなら修理、通常なら星を1上げる`
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
    const blocked = new Set((excluded ?? []).map(String));
    return Object.entries(actor.doll?.costumes ?? {})
      .filter(([part, costume]) => !!costume && !blocked.has(String(part)) && Number(costume?.star ?? 1) < 8)
      .map(([p, costume]) => ({
        key: p,
        label: { head: "帽子", body: "服", leg: "ズボン", foot: "靴" }[p] ?? p,
        name: costume?.name ?? "衣装",
        condition: costume?.condition ?? "normal",
        star: Number(costume?.star ?? 1),
      }));
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
            : Math.min(level, availableParts.length),
        };
        this.sendDollChargeCostumeSelect(wsPlayer, actor);
        return true;
      }

      const costume = actor.doll.costumes?.[part];
      if (!costume || selectedParts.includes(String(part)) || Number(costume?.star ?? 1) >= 8) {
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
      const remainingParts = this.buildDollChargeParts(actor, nextSelectedParts);
      const remaining = Math.max(
        0,
        Math.min(level, nextSelectedParts.length + remainingParts.length) - nextSelectedParts.length
      );

      if (remaining > 0) {
        actor.pending_doll_charge_context = {
          level,
          selectedParts: nextSelectedParts,
          remaining,
        };
        this.sendPopup(`衣装を強化した！ あと ${remaining} 個選択してください。`, wsPlayer, 1800);
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




    // ▼ コイン配布
    const bonus = actor.get_coin_bonus_per_round();
    actor.coins += (10 + bonus);

    if (actor.job === "人形使い" && actor.doll) {
      actor.doll.charge = Number(actor.doll.charge ?? 0) + Number(actor.get_doll_charge_per_round?.() ?? 0);
      if (Number(actor.doll.charge ?? 0) >= DOLL_CHARGE_COST) {
        actor.doll.pending_charge_ready = true;
      }
    }

    // ▼ 魔導士装備パッシブ
    const beforeHp = actor.hp;

    actor.apply_mage_equip_effects();

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

    for (let i = 0; i < 5; i++) {
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
            price: 25,
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
    return list;
  }

  // ---------- ★ショップを開く ----------
  openShop(wsPlayer) {
      const P = (wsPlayer === this.p1 ? this.P1 : this.P2);

      // ★更新禁止：ここでは何もしない
      // generateShopList を絶対に呼ばない！

      // ★ 既存の在庫をそのまま渡すだけ
      safeSend(wsPlayer, { 
          type: "shop_list",
          items: P.shop_items
      });
  }


  // ---------- ★購入処理（完全版） ----------
  buyItem(wsPlayer, index) {
   
    const P = (wsPlayer === this.p1 ? this.P1 : this.P2);

    if (!P.shop_items || !P.shop_items[index]) {
      this.sendError("❌ 商品が存在しません。", wsPlayer);
      return;
    }
    

    // 取り出し（コピー）
    const item = { ...P.shop_items[index] };

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

    // 再購入不可に
    P.shop_items.splice(index, 1);

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
      if (this.hasPendingDollCharge(P)) {
        this.sendPopup("チャージ効果を選択してください。", wsPlayer, 2500);
        this.sendError("❌ 先にチャージ効果を選択してください。", wsPlayer);
        this.resendPendingDollCharge(wsPlayer, P);
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
        P.item_use_count += 1;

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
          ...P.special_inventory.map(it => ({
            uid: it.uid,
            ...it,
            category: "special"
          })),
          ...equippedSpecialItems,
          ...P.arrow_inventory.map(it => ({
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
      buffs: P.getBuffDescriptionList?.() ?? [],

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

        mana: self.job === "魔導士" ? self.mana : null,
        mana_max: self.job === "魔導士" ? self.mana_max : null,
        


        arrow_slots: self.arrow_slots ?? 1,
        damage_taken_last_round: self.damage_taken_last_round ?? 0,
        damage_taken_last_turn: self.damage_taken_last_turn ?? 0,
        archer_buff: self.archer_buff ?? null,
        archer_pierce_rounds: self.archer_pierce_rounds ?? (self.archer_next_pierce ? 1 : 0),

        // ★ 必ず配列に正規化
        equipment: Array.isArray(self.equipment)
          ? self.equipment
          : (self.equipment ? [self.equipment] : []),


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

        mana: enemy.job === "魔導士" ? enemy.mana : null,
        mana_max: enemy.job === "魔導士" ? enemy.mana_max : null,

        arrow_slots: enemy.arrow_slots ?? 1,
        damage_taken_last_round: enemy.damage_taken_last_round ?? 0,
        damage_taken_last_turn: enemy.damage_taken_last_turn ?? 0,
        archer_buff: enemy.archer_buff ?? null,
        archer_pierce_rounds: enemy.archer_pierce_rounds ?? (enemy.archer_next_pierce ? 1 : 0),

        // ★ 必ず配列に正規化
        equipment: Array.isArray(enemy.equipment)
          ? enemy.equipment
          : (enemy.equipment ? [enemy.equipment] : []),


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



   

  /* =========================================================
     行動処理
     ========================================================= */
  async handleAction(wsPlayer, action) {
    if (this.ended) {
      this.sendSystem("⚠ この対戦はすでに終了しています。");
      return;
    }

    // 自分のラウンド以外は行動不可
    if (wsPlayer !== this.current) {
      this.sendError("❌ 今はあなたのラウンドではありません。", wsPlayer);
      return;
    }

    const actor = wsPlayer === this.p1 ? this.P1 : this.P2;
    const target = wsPlayer === this.p1 ? this.P2 : this.P1;

    if (this.hasPendingDollCharge(actor)) {
      this.sendPopup("チャージ効果を選択してください。", wsPlayer, 2500);
      this.sendError("❌ 先にチャージ効果を選択してください。", wsPlayer);
      this.resendPendingDollCharge(wsPlayer, actor);
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

    const afterActorAttackBuff = Number(actor.get_attack_buff_total?.() ?? 0);
    const afterTargetAttackBuff = Number(target.get_attack_buff_total?.() ?? 0);
    if (afterActorAttackBuff > beforeActorAttackBuff || afterTargetAttackBuff > beforeTargetAttackBuff) {
      this.sendSfxEvent("powerup");
    }
    const afterActorDefBuff = Number(actor.get_def_buff_total?.() ?? 0) + Number(actor.barrier ?? 0);
    const afterTargetDefBuff = Number(target.get_def_buff_total?.() ?? 0) + Number(target.barrier ?? 0);
    if (afterActorDefBuff > beforeActorDefBuff || afterTargetDefBuff > beforeTargetDefBuff) {
      this.sendSfxEvent("defup");
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

    if (isBotMatch) {
      // CPU戦：人間側のみ
      const humanWs = this.p1?.isBot ? this.p2 : this.p1;
      const humanAcc = humanWs?.accountId;
      const humanJob = (humanWs === this.p1) ? this.P1.job : this.P2.job;

      // ★ CPU戦ボタンで開始した対戦は戦績/レートに反映しない
      // ★ ランダム対戦の自動CPU（cpuKind === "auto"）のみ反映する
      if (humanAcc && humanWs?.cpuKind === "auto") {
        let r = "draw";
        if (result === "p1" && humanWs === this.p1) r = "win";
        else if (result === "p2" && humanWs === this.p2) r = "win";
        else if (result === "p1" || result === "p2") r = "lose";

        recordCpuMatchResult({
          accountId: String(humanAcc),
          job: humanJob,
          result: r,
          kFactor: 16
        });
      }

    } else if (accId1 && accId2) {
      let r = "draw";
      if (result === "p1") r = "A";
      else if (result === "p2") r = "B";

      if (isRoomMatch) {
        // ★ ルーム対戦は戦績/レートに一切反映しない
      } else {
        recordMatchResult({
          accountIdA: String(accId1),
          jobA: this.P1.job,
          accountIdB: String(accId2),
          jobB: this.P2.job,
          result: r,
          kFactor: 32
        });
      }
    }


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

    if (this.ended) return;

    const actor = this.current === this.p1 ? this.P1 : this.P2;
    const target = this.current === this.p1 ? this.P2 : this.P1;

    // ★ 最大レベル未満の時だけ毎ターン EXP +5
    if ((LEVEL_REQUIREMENTS[actor.level] ?? null) != null) {
      actor.exp = (actor.exp ?? 0) + 5;
    }

    // 自動レベルアップ判定
    const res = actor.try_level_up_auto ? actor.try_level_up_auto() : null;

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
    if (this.hasPendingDollCharge(P)) {
      this.sendPopup("チャージ効果を選択してください。", wsPlayer, 2500);
      this.sendError("❌ 先にチャージ効果を選択してください。", wsPlayer);
      this.resendPendingDollCharge(wsPlayer, P);
      return;
    }

    // ★ ショップを開いても中身を更新しない
    // P.shop_items は startRound() と reroll だけが変更する

    safeSend(wsPlayer, {
      type: "shop_list",
      items: P.shop_items
    });
  }

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
export async function cpuStep(match, ws) {
  const state = analyzeCpuState(match, ws);
  const action = decideCpuAction(state);

  const P = ws.player;

  // 準備行動は1回だけ
  if (action.type === "use_item" && state.usableItem) {
    cpuUseItemDirect(match, ws, state.usableItem);
    return state.usableItem.consumes_turn === true; // ラウンド消費アイテムのみ true
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
          let shopCandidates = [...(P.shop_items ?? [])];
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
        await new Promise(r => setTimeout(r, 1000));
      }

    }
    // ============================
    // ★ 準備行動で何も起きなかった場合は強制攻撃（無限防止）
    // ============================
    if (!didSomething) {
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

      const player = new Player(name, jobKey);
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

      ws.player = new Player(name, jobKey);

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
        const player = new Player(name, jobKey);

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

