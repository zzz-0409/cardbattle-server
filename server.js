// （import 群は変更なし）
import WebSocket, { WebSocketServer } from "ws";
import { Player } from "./player.js";
import { LEVEL_REQUIREMENTS, JOB_TEMPLATE, ARROW_DATA, createDollCostume, DOLL_COSTUME_PARTS, DOLL_COSTUME_TYPES } from "./constants.js";
import crypto from "crypto";
import { generateOneShopItem } from "./item.js";
import { generateEquipmentForLevel } from "./equip.js";
import { MAGE_EQUIPS } from "./equip.js";
import { getMageSlot } from "./player.js";
import { MAGE_MANA_ITEMS } from "./mage_items.js";
import http from "http";



// デバッグログ ON/OFF
const DEBUG = true;

const clients = new Set();

function safeSend(ws, payload) {
  if (!ws) return;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
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
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("Listening on port", PORT);
});

let waitingPlayer = null;


/* =========================================================
   Match クラス（1試合分）
   ========================================================= */
class Match {
  constructor(p1, p2) {
    this.p1 = p1;
    this.p2 = p2;

    this.skill_lock = false;

    this.P1 = p1.player;
    this.P2 = p2.player;

    // ★ ラウンドカウンタ
    this.round = 1;

    this.current = p1;
    this.enemy = p2;

    this.ended = false;

    this.start();
  }


// ---------------------------------------------------------
// ステータス更新（攻撃・防御・バフ・式神）
// ---------------------------------------------------------
  sendStatusInfo(ws, actor) {

      const payload = {
          type: "status_info",
          attack: actor.get_total_attack(),
          defense: actor.get_total_defense(),
          buffs: actor.getBuffDescriptionList(),
      };
      
      // ★ 人形使い：人形情報を送信
      if (actor.job === "人形使い" && actor.doll) {
          payload.doll = {
              durability: actor.doll.durability,
              max_durability: actor.doll.max_durability,
              is_broken: actor.doll.is_broken
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
    safeSend(this.p1, { type: "battle_log", msg });
    safeSend(this.p2, { type: "battle_log", msg });
  }

  sendSkill(msg) {
    safeSend(this.p1, { type: "skill_log", msg });
    safeSend(this.p2, { type: "skill_log", msg });
  }

  sendSystem(msg) {
    safeSend(this.p1, { type: "system_log", msg });
    safeSend(this.p2, { type: "system_log", msg });
  }

  sendError(msg, ws = null) {
    if (ws) {
      safeSend(ws, { type: "error_log", msg });
    } else {
      safeSend(this.p1, { type: "error_log", msg });
      safeSend(this.p2, { type: "error_log", msg });
    }
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

    this.sendRoundInfo(); // ★ 変更（旧 sendTurnInfo）
  }

  // ★ 変更（旧 startTurn）
  startRound() {

    const actorWS = this.current;
    const actor = (actorWS === this.p1 ? this.P1 : this.P2);

    this.sendItemList(actorWS, actor);

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

    // ▼ 魔導士装備パッシブ
    actor.apply_mage_equip_effects();

    // ================================
    // ★ 人形使い：暴走ラウンド進行（ラウンド開始時）
    // ================================
    if (
      (actor.job === "人形使い" || Number(actor.job) === 9) &&
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
        actor.take_damage(20, true);
        const enemy = actorWS === this.p1 ? this.P2 : this.P1;
        enemy.take_damage(20, true);


        // 人形破壊・暴走解除
        actor.doll.is_broken = true;
        actor.doll.is_rampage = false;

        this.sendSystem("🪆 人形は完全に破壊された…");
      }
    }

    // ================================
    // ★ 人形使い：耐久リジェネ（ラウンド開始時）
    // ================================
    if (
      (actor.job === "人形使い" || Number(actor.job) === 9) &&
      actor.applyDollRegen &&
      !actor.doll?.is_rampage   // ★ 暴走中は回復しない
    ) {
      actor.applyDollRegen();
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
  }


  // ----------------------------------------
  // ★ オンラインショップ生成（オフライン版完全準拠）
  // ----------------------------------------
  generateShopList(P) {
    const list = [];
    const level = P.level;

    for (let i = 0; i < 5; i++) {
      let entry = null;
      const r = Math.random() * 100;

      // ================================
      // 人形使い：衣装＋修理キットのみ
      // ================================
      if (Number(P.job) === 9 || P.job === "人形使い") {

        // 25%：修理キット
        if (Math.random() < 0.25) {
          entry = {
            uid: crypto.randomUUID(),
            name: "修理キット",
            price: 12,
            is_doll_item: true,
            effect_text: "人形の耐久を回復／破壊時は復活（1T無敵）"
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
        if (r < 70) {
          const pool = MAGE_EQUIPS;
          entry = { ...pool[Math.floor(Math.random() * pool.length)] };
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

      // 他職：50% 装備、50% アイテム
      entry = (r < 50)
        ? generateEquipmentForLevel(level)
        : generateOneShopItem(level);

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

    } else if (item.is_equip) {
        // 通常装備
        P.equipment_inventory.push(item);

    } else {
        // 通常アイテム
        P.items.push(item);
    }

    // 再購入不可に
    P.shop_items.splice(index, 1);


    // ------------------------------
    // ★ コイン更新＋アイテム一覧更新
    // ------------------------------
    safeSend(wsPlayer, {
      type: "coin_info",
      coins: P.coins
    });

    this.sendItemList(wsPlayer, P);

    this.sendSystem(`🛒 ${P.name} は ${item.name} を購入した！`);

    // ★ ラウンドは終了しない
  }

  // ---------------------------------------------------------
  // ショップ再更新（コイン支払い）
  // ---------------------------------------------------------
  shopReroll(wsPlayer) {
    const actor = (wsPlayer === this.p1 ? this.P1 : this.P2);

    const cost = 10;
    if (actor.coins < cost) {
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
      this.sendError("❌ アイテムが見つかりません。", wsPlayer);
      return;
    }


    // ============================
    // 0) 矢装備（slot 指定対応・即時UI更新）
    // ============================
    if (action === "arrow" && (item.is_arrow || item.equip_type === "arrow")) {

        const equipSlot = slot ?? 1; // デフォルト slot1

        if (equipSlot === 2 && P.arrow_slots >= 2) {
            // ---- slot2 装備 ----
            if (P.arrow2) {
                P.arrow_inventory.push(P.arrow2);
            }
            P.arrow2 = item;
        } else {
            // ---- slot1 装備 ----
            if (P.arrow) {
                P.arrow_inventory.push(P.arrow);
            }
            P.arrow = item;
        }

        // インベントリから削除
        P[source] = P[source].filter(x => x.uid !== uid);

        this.sendSystem(`🏹 ${P.name} が ${item.name} を装備！（slot${equipSlot}）`);


        this.sendItemList(wsPlayer, P);

        // ★ ステータス即時反映（攻撃力・効果）
        this.sendStatusInfo(wsPlayer, P);

        // ★ 簡易ステ（ここ）
        this.sendSimpleStatusBoth();

        return; // ★ ここで必ず終了
    }







    // ============================
    // 3) 通常装備（攻撃/防御/コインUP）
    // ============================
    else if (
      action === "equip" &&
      item.is_equip &&
      item.equip_type === "normal"
    ) {
        if (P.equipment) {
            P.equipment_inventory.push(P.equipment);
        }

        P.equipment = item;
        P[source] = P[source].filter(x => x.uid !== uid);
                // ★ 使用後、所持アイテムを再送
        this.sendItemList(wsPlayer, P);

        this.sendSystem(`⚔ ${P.name} が ${item.name} を装備！`);
    }



    // ============================
    // 4) 魔導士装備（杖/本/指輪/ローブ）
    // ============================
    else if (action === "special" && item.equip_type === "mage_equip") {

        // ★ 魔導士装備の slot は自動判定（getMageSlot）
        const slot = getMageSlot(item);


      // 既存装備を戻す
      if (P.mage_equips[slot]) {
        P.special_inventory.push(P.mage_equips[slot]);
      }

      // 装備
      P.mage_equips[slot] = item;

      // 削除
      P[source] = P[source].filter(x => x.uid !== uid);


      // パッシブ再計算
      if (P.recalc_mage_passives) P.recalc_mage_passives();

      this.sendSystem(`🔮 ${P.name} が ${item.name} を装備！（${slot}）`);
    }
    // ============================
    // 4.5) 錬金術師 特殊装備
    // ============================
    else if (action === "special" && item.equip_type === "alchemist_unique") {

        // 既存の錬金特殊装備があれば戻す
        if (P.alchemist_equip) {
            P.special_inventory.push(P.alchemist_equip);
        }

        // ★ 専用スロットに装備
        P.alchemist_equip = item;

        // inventory から削除
        P[source] = P[source].filter(x => x.uid !== uid);

        this.sendSystem(`⚗ ${P.name} が ${item.name} を装備！`);
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

        if (!P.doll.costumes || !P.doll.costumes[part]) {
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

        this.sendSystem(
          `🪆 ${P.name} は ${part} の衣装を装備した！`
        );

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
      Number(P.job) === 9
    ) {
        // ★ 暴走中は修理キット使用不可
        if (P.doll?.is_rampage) {
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

        if (!P.doll.is_broken) {
            const before = P.doll.durability;
            P.doll.durability = Math.min(
                P.doll.max_durability,
                P.doll.durability + 20
            );
            this.sendSystem(
              `🔧 修理キット使用：人形耐久 ${before} → ${P.doll.durability}`
            );
        } else {
            P.doll.is_broken = false;
            P.doll.durability = 15;
            P.doll.revive_guard_rounds = 1;
            this.sendSystem(
              "🔧 人形を修理し、戦闘に復帰させた！（1T無敵）"
            );
        }

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

      // オフライン版と同じ入口
      if (P.apply_item) {
        P.apply_item(item);
      }
      // ★ ここを追加
      this.sendSystem(`🧪 ${P.name} が ${item.name} を使用した！`);
      // インベントリから削除
      P[source] = P[source].filter(x => x.uid !== uid);

      // UI 更新
      this.sendItemList(wsPlayer, P);
      this.sendStatusInfo(wsPlayer, P);
      this.sendSimpleStatusBoth();

      return; // ★ ここで必ず終了
    }

    // ============================
    // HP回復アイテム
    // ============================
    if (action === "use" && item.effect_type === "HP") {
        const before = P.hp;
        P.hp = Math.min(P.max_hp, P.hp + item.power);
        this.sendSystem(
          `💖 ${P.name} のHPが ${P.hp - before} 回復した！`
        );

        this.updateHP();
        P[source] = P[source].filter(x => x.uid !== uid);

        this.sendItemList(wsPlayer, P);
        this.sendStatusInfo(wsPlayer, P);
        this.sendSimpleStatusBoth();
        return;
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
      safeSend(wsPlayer, {
        type: "item_list",
        items: [
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

    safeSend(ws, {
      type: "status_detail",
      side,

      level: P.level,
      exp: P.exp,
      next_exp: LEVEL_REQUIREMENTS[P.level] ?? null,

      buffs: P.getBuffDescriptionList(),
      debuffs: [],

      equipment: P.equipment ? P.equipment.name : "なし",
      special: P.alchemist_equip?.name ?? null,

      arrows: {
        slot1: P.arrow?.name ?? null,
        slot2: P.arrow2?.name ?? null
      },

      mana: P.job === "魔導士"
        ? { now: P.mana, max: P.mana_max }
        : null,

      shikigami: P.shikigami_effects?.map(s =>
        s.rounds != null
          ? `${s.name}（${s.rounds}R）`
          : s.name
      ) ?? []
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
  // =========================================================
  // ★ 簡易ステータス即時同期（自分＋相手）
  // =========================================================
  sendSimpleStatusBoth() {
    const send = (ws, self, enemy) => {
      // 自分
      safeSend(ws, {
        type: "status_simple",
        side: "self",
        hp: self.hp,
        max_hp: self.max_hp,
        attack: self.get_total_attack(),
        defense: self.get_total_defense(),
        coins: self.coins,
        level: self.level,
        mana: self.job === "魔導士" ? self.mana : null,
        mana_max: self.job === "魔導士" ? self.mana_max : null,
      });

      // 相手
      safeSend(ws, {
        type: "status_simple",
        side: "enemy",
        hp: enemy.hp,
        max_hp: enemy.max_hp,
        attack: enemy.get_total_attack(),
        defense: enemy.get_total_defense(),
        coins: enemy.coins,
        level: enemy.level,
        mana: enemy.job === "魔導士" ? enemy.mana : null,
        mana_max: enemy.job === "魔導士" ? enemy.mana_max : null,
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
    // ★ 各プレイヤーに「自分の」状態を送る
    // ---------------------------------
      const sendSelfStatus = (ws, self) => {
      // ★ 簡易ステータス（自分用）
      safeSend(ws, {
        type: "status_simple",
        side: "self",
        hp: self.hp,
        max_hp: self.max_hp,
        attack: self.get_total_attack(),
        defense: self.get_total_defense(),
        coins: self.coins,
        level: self.level,
        mana: self.job === "魔導士" ? self.mana : null,
        mana_max: self.job === "魔導士" ? self.mana_max : null,
      });


      // ★ 簡易ステータス（相手用）
      const enemy = (self === this.P1) ? this.P2 : this.P1;
      safeSend(ws, {
        type: "status_simple",
        side: "enemy",
        hp: enemy.hp,
        max_hp: enemy.max_hp,
        attack: enemy.get_total_attack(),
        defense: enemy.get_total_defense(),
        coins: enemy.coins,
        level: enemy.level,
        mana: enemy.job === "魔導士" ? enemy.mana : null,
        mana_max: enemy.job === "魔導士" ? enemy.mana_max : null,
      });
      this.sendItemList(ws, self);
      


      // レベル
      safeSend(ws, {
        type: "level_info",
        level: self.level,
        canLevelUp: self.can_level_up()
      });

      // EXP
      safeSend(ws, {
        type: "exp_info",
        exp: self.exp
      });

      // アイテム
      const inv   = self.inventory || [];
      const eqInv = self.equipment_inventory || [];
      const spInv = self.special_inventory || [];
      const arInv = self.arrow_inventory || [];




      // 魔力
      if (self.job === "魔導士") {
        safeSend(ws, {
          type: "mana_info",
          mana: self.mana,
          mana_max: self.mana_max
        });
      } else {
        safeSend(ws, { type: "mana_hide" });
      }

      // ★ ステータス（ここが核心）
      safeSend(ws, {
        type: "status_info",
        attack: self.get_total_attack(),
        defense: self.get_total_defense(),
        buffs: self.getBuffDescriptionList(),
        arrow_slots: self.arrow_slots ?? 1,
        shikigami: self.shikigami_effects.map(s =>
          s.rounds !== undefined
            ? `${s.name}（残り${s.rounds}R）`
            : `${s.name}`
        )
      });
    };


    // 自分には自分の式神を送る
    sendSelfStatus(this.p1, this.P1);
    sendSelfStatus(this.p2, this.P2);
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
        // ★ 人形使いは人形で攻撃（壊れていれば本体）
        const dmg =
          (actor.job === "人形使い" && actor.doll && !actor.doll.is_broken)
            ? actor.getDollAttack()
            : actor.get_total_attack();

        const dealt = target.take_damage(dmg, false, actor);


        this.sendBattle(
          actor.job === "人形使い" && actor.doll && !actor.doll.is_broken
            ? `🪆 人形の攻撃！ ${dealt}ダメージ！`
            : `🗡 ${actor.name} の攻撃！ ${dealt}ダメージ！`
        );
      }


      // ★ 烏天狗（既存仕様）
      const tengu = actor.shikigami_effects?.find(
        e => e.name === "烏天狗" && e.triggers > 0
      );
      if (tengu) {
        const logs = actor.trigger_karasu_tengu(target);
        logs.forEach(dmg2 => {
          this.sendSkill(`🐦 烏天狗の追撃！ ${dmg2}ダメージ！`);
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
      actor.job !== "人形使い" &&
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

    const job = actor.job;
    const prefix = {
      "戦士": "warrior",
      "騎士": "knight",
      "僧侶": "priest",
      "盗賊": "thief",
      "魔導士": "mage",
      "陰陽師": "onmyoji",
      "錬金術師": "alchemist",
      "弓兵": "archer"
    }[job];

    const stype = `${prefix}_${num}`;
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

    // ★ 式神召喚後にステータス更新（即時表示）
    if (prefix === "onmyoji") {
      this.sendStatusInfo(wsPlayer, actor);
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

    // 弓兵・陰陽師の追加処理（成功時のみ）

    if (prefix === "onmyoji") {
      const logs = actor.trigger_karasu_tengu(target);
      logs.forEach(dmg => this.sendSkill(`🐦 烏天狗の追撃！ ${dmg}ダメージ！`));
    }

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
        target.hp = Math.max(0, target.hp - dot.power);

        this.sendBattle(
          `🔥 ${target.name} は ${dot.name} により ${dot.power} ダメージ！（防御無視）`
        );

        dot.turns--; // ★ DOT用 turns：触らない
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

    if (winner && loser) {

      // 勝者 / 敗者

    } else {
      // 引き分け
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


  /* =========================================================
     ラウンド終了処理
     ========================================================= */
  endRound() { // ★ 修正（旧 endTurn）
    this.skill_lock = false;

    if (this.ended) return;

    const actor = this.current === this.p1 ? this.P1 : this.P2;
    const target = this.current === this.p1 ? this.P2 : this.P1;

    // ★ EXP +10（既存仕様を維持）
    actor.exp = (actor.exp ?? 0) + 10;

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

    // ============================
    // 人形使い：DUR 回復（ラウンド終了時）
    // ============================
    if (actor.job === "人形使い" && actor.applyDollRegen) {
      const before = actor.doll?.durability;
      actor.applyDollRegen();
      const after = actor.doll?.durability;

      if (before != null && after != null && after > before) {
        this.sendSystem(
          `🪆 人形の耐久が ${before} → ${after} に回復した`
        );
      }
    }


    // ラウンド交代
    [this.current, this.enemy] = [this.enemy, this.current];
    this.round++; // ★ 修正（旧 this.turn++）

    // ★ 次のラウンド開始処理（ここでコイン配布）
    this.startRound(); // ★ 修正（旧 startTurn）

    // コイン同期
    safeSend(this.p1, { type: "coin_info", coins: this.P1.coins });
    safeSend(this.p2, { type: "coin_info", coins: this.P2.coins });

    this.sendRoundInfo(); // ★ 修正（旧 sendTurnInfo）
  }

  // ---------- ★修正版：ショップを開く ----------
  openShop(wsPlayer) {
    const P = (wsPlayer === this.p1 ? this.P1 : this.P2);

    // ★ ショップを開いても中身を更新しない
    // P.shop_items は startRound() と reroll だけが変更する

    safeSend(wsPlayer, {
      type: "shop_list",
      items: P.shop_items
    });
  }

}


/* =========================================================
   接続処理
   ========================================================= */
wss.on("connection", (ws) => {
  clients.add(ws);
  console.log("接続: クライアント");

  ws.on("close", () => clients.delete(ws));

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    /* ---------- JOIN ---------- */
    // ---------------------------------------------------------
    // 接続: join
    // ---------------------------------------------------------
    if (msg.type === "join") {

        const name = msg.name;
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
          msg: `🔗 対戦開始！相手：${p2.playerName}`
        });
        safeSend(p2, {
          type: "system_log",
          msg: `🔗 対戦開始！相手：${p1.playerName}`
        });

        const match = new Match(p1, p2);

        // =====================================
        // 共通メッセージハンドラ（正）
        // =====================================
        const handlePlayerMessage = async (sock, raw2) => {
          const m = JSON.parse(raw2.toString());
          const P = sock === p1 ? match.P1 : match.P2;
          // ================================
          // 人形使い：スキル1 入口（着せ替え）
          // ================================
          if (m.type === "request_doll_skill1") {

            console.log("[SERVER] use_doll_skill1 received:", m);

            // 自分のラウンド以外は不可
            if (sock !== match.current) {
              match.sendError("❌ 今はあなたのラウンドではありません。", sock);
              return;
            }

            // 職業チェック
            if (P.job !== "人形使い" && Number(P.job) !== 9) {
              match.sendError("❌ 人形使い専用スキルです。", sock);
              return;
            }

            // 1試合1回制限
            if (P.used_skill_set?.has("doll_1")) {
              match.sendError("❌ このスキルはすでに使用済みです。", sock);
              return;
            }

            // ★ 部位選択UIを要求
            safeSend(sock, {
              type: "request_doll_part_select"
            });

            return;
          }

          // ================================
          // 人形使い：スキル1 確定（着せ替え）
          // ================================
          if (m.type === "use_doll_skill1") {
            console.log("[DEBUG] doll skill1 part =", m.part);
            console.log("[DEBUG] costumes =", P.doll.costumes);

            // 自分のラウンド以外は不可
            if (sock !== match.current) {
              match.sendError("❌ 今はあなたのラウンドではありません。", sock);
              return;
            }

            if (!P.doll) {
              match.sendError("❌ 人形が存在しません。", sock);
              return;
            }

            // 仮衣装データ初期化
            if (!P.doll.costumes) {
              P.doll.costumes = {
                head: { star: 1 },
                body: { star: 1 },
                leg:  { star: 1 },
                foot: { star: 1 }
              };
            }

            const c = P.doll.costumes[m.part];

            if (!c) {
              match.sendError("❌ 不正な部位です。", sock);
              return;
            }

            if (c.star >= 4) {
              match.sendError("❌ これ以上強化できません。", sock);
              return;
            }

            c.star += 1;
            P.used_skill_set.add("doll_1");

            match.sendSystem(
              `🪆 ${P.name} は ${m.part} を強化した！（★${c.star}）`
            );

            match.sendStatusInfo(sock, P);
            match.sendSimpleStatusBoth();
            match.endRound();
            return;
          }
          // ================================
          // 人形使い：スキル2（生命縫合）
          // ================================
          if (m.type === "use_doll_skill2") {

            // 自分のラウンド以外は不可
            if (sock !== match.current) {
              match.sendError("❌ 今はあなたのラウンドではありません。", sock);
              return;
            }

            // スキル2使用済み
            if (P.used_skill_set?.has("doll_2")) {
              match.sendError("❌ このスキルは既に使用済みです。", sock);
              return;
            }

            if (!P.doll) {
              match.sendError("❌ 人形が存在しません。", sock);
              return;
            }

            if (P.doll.is_broken) {
              match.sendError("❌ 人形が破壊されている間は使用できません。", sock);
              return;
            }

            const hpCost = Number(m.hpCost);

            // 10の倍数 / 10〜100
            if (!Number.isFinite(hpCost) || hpCost % 10 !== 0 || hpCost < 10 || hpCost > 100) {
              match.sendError("❌ HPは10の倍数（10〜100）で指定してください。", sock);
              return;
            }

            // HP0不可（HP - hpCost >= 1）
            if (P.hp - hpCost < 1) {
              match.sendError("❌ HP0にはできません（HPが足りません）。", sock);
              return;
            }

            // 適用：人形耐久 + (hpCost/2)
            const gain = Math.floor(hpCost / 2);
            const beforeHp = P.hp;
            const beforeDur = P.doll.durability;

            P.hp -= hpCost;
            P.doll.durability = Math.min(P.doll.max_durability, P.doll.durability + gain);

            P.used_skill_set.add("doll_2");

            match.sendSkill(
              `🧵 ${P.name} は生命縫合！ HP-${hpCost}（${beforeHp}→${P.hp}） / 人形耐久+${gain}（${beforeDur}→${P.doll.durability}）`
            );

            match.updateHP?.();               // あるなら呼ぶ
            match.sendStatusInfo(sock, P);
            match.sendSimpleStatusBoth();

            match.endRound();
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

              if (!P.doll || P.doll.is_broken) {
                  match.sendError("❌ 人形が壊れています。", sock);
                  return;
              }

              if (P.doll.durability < 10) {
                  match.sendError("❌ 耐久力が足りません。", sock);
                  return;
              }

              // 発動
              P.doll.durability = Math.floor(P.doll.durability / 2);
              P.doll.is_rampage = true;
              P.doll.rampage_rounds = 3;

              P.used_skill_set.add("doll_3");

              match.sendSystem(
                  `🪆 ${P.name} の人形が暴走した！`
              );

              match.sendStatusInfo(sock, P);
              match.sendSimpleStatusBoth();
              match.endRound();
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
          // ★ 詳細ステータス要求（新規）
          // ================================
          if (m.type === "request_status_detail") {

            const self = (sock === match.p1 ? match.P1 : match.P2);
            const enemy = (self === match.P1 ? match.P2 : match.P1);

            const target =
              m.target === "enemy" ? enemy : self;
            // ===== 装備一覧生成 =====
            const equipmentList = [];

            // 通常装備
            if (target.equipment) {
              equipmentList.push(`通常装備：${target.equipment.name}`);
            }

            // 錬金術師装備
            if (target.alchemist_equip) {
              equipmentList.push(`錬金装備：${target.alchemist_equip.name}`);
            }

            // 弓兵の矢
            if (target.arrow) {
              equipmentList.push(`矢(slot1)：${target.arrow.name}`);
            }
            if (target.arrow2) {
              equipmentList.push(`矢(slot2)：${target.arrow2.name}`);
            }

            // ★ 魔導士装備（ここが追加点）
            if (target.mage_equips) {
              for (const [slot, eq] of Object.entries(target.mage_equips)) {
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

            safeSend(sock, {
              type: "status_detail",
              side: m.target,

              hp: target.hp,
              max_hp: target.max_hp,
              attack: target.get_total_attack(),
              defense: target.get_total_defense(),
              coins: target.coins,
              level: target.level,
              exp: target.exp,

              mana: target.job === "魔導士" ? target.mana : null,
              mana_max: target.job === "魔導士" ? target.mana_max : null,

              equipment: equipmentList,   // ← ★ ここ

              buffs: target.getBuffDescriptionList?.() ?? [],

              shikigami: target.shikigami_effects?.map(s =>
                s.rounds !== undefined
                  ? `${s.name}（残り${s.rounds}R）`
                  : s.name
              ) ?? []
            });


            return;
          }



          // ---------- アイテム / 装備 使用 ----------
          if (m.type === "use_item") {
              match.useItem(sock, m.item_id, m.action, m.slot);
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
              match.sendError("❌ EXPもコインも足りません。", sock);
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
                canCoins: false
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

