// ============================================
// shop.js（完全版）
// ============================================

import { generateEquipmentForLevel } from "./equip.js";
import { generateOneShopItem } from "./item.js";
import { ARROW_DATA, JOB_TEMPLATE } from "./constants.js";


function generateRandomArrow() {
    const keys = Object.keys(ARROW_DATA);
    const k = keys[Math.floor(Math.random() * keys.length)];
    return {
        ...ARROW_DATA[k],
        is_equip: true,      // ★ 必須！これがないと矢は装備扱いされない
        is_arrow: true,      // 矢判定用
        equip_type: "arrow", // 念のため明示（ARROW_DATA にあるが保険）
    };
}


function getMageEquipPool() {
    return [
        {
            name: "魔導士の杖",
            price: 15,
            is_equip: true,
            equip_type: "mage_equip",
            mana_gain: 2,
            coin_per_turn: 3,
            effect_text: "毎ラウンド魔力+2 / コイン+3",
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
}

import { 
    MAGE_EQUIPS,
    MAGE_MANA_ITEMS,
    DOLL_REPAIR_KIT
} from "./constants.js";

export function generateShop(player) {
console.log("SHOP job =", player.job, typeof player.job);

    // =========================================
    // 人形使い専用ショップ（最優先）
    // =========================================
    if (player.job === "人形使い") {

        const list = [];
        for (let i = 0; i < 5; i++) {
            list.push(DOLL_REPAIR_KIT);
        }
        return list;
    }


    const list = [];

    for (let i = 0; i < 5; i++) {
        let entry = null;
        const r = Math.random() * 100;

        if (player.job === "弓兵") {
            if (r < 70) entry = generateRandomArrow();
            else entry = Math.random() < 0.5
                ? generateEquipmentForLevel(player.level)
                : generateOneShopItem(player.level);
            list.push(entry);
            continue;
        }

        if (player.job === "魔導士") {
            if (r < 70) {
                const pool = getMageEquipPool();
                entry = pool[Math.floor(Math.random() * pool.length)];
            } else {
                const r2 = Math.random();
                if (r2 < 0.5) {
                    const pool = MAGE_MANA_ITEMS;
                    entry = pool[Math.floor(Math.random() * pool.length)];
                } else {
                    entry = Math.random() < 0.5
                        ? generateEquipmentForLevel(player.level)
                        : generateOneShopItem(player.level);
                }
            }
            list.push(entry);
            continue;
        }

        entry = (r < 50)
            ? generateEquipmentForLevel(player.level)
            : generateOneShopItem(player.level);

        list.push(entry);
    }

    return list;
}



export async function buyFromShop(player, item, io) {
  let price = item.price ?? 0;

  // ① まず割引を適用する
  if (
    player.job === "錬金術師" &&
    item.is_equip &&
    item.equip_type !== "alchemist_unique"
  ) {
    price = Math.max(1, Math.floor(price * 0.8));
  }

  // ② 割引後の価格で所持コインチェック
  if (player.coins < price) {
    return { success: false, message: `コイン不足（必要:${price}）` };
  }

  // ③ 支払い（割引後の金額）
  player.coins -= price;


// ================================
// 買ったものの振り分け
// ================================
item.uid = crypto.randomUUID();

if (item.is_equip) {

  // ▼ 弓兵の矢（装備するかどうか聞く）
  if (item.equip_type === "arrow" || item.is_arrow) {

    if (io) {
      const ans = await io.input(`🏹 ${item.name} を装備しますか？ (y/n): `);

      // === YES：装備 ===
      if (ans.trim().toLowerCase() === "y") {

        // ★ slot1 が空
        if (!player.arrow) {
          player.arrow = item;
          io.log(`🏹 ${item.name} を slot1 に装備しました！`);
        }

        // ★ slot2 が空
        else if (player.arrow_slots >= 2 && !player.arrow2) {
          player.arrow2 = item;
          io.log(`🏹 ${item.name} を slot2 に装備しました！`);
        }

        // ★ slot1, slot2 が埋まっている → 交換選択
        else {
          io.log("\nスロットが満杯です。交換しますか？");
          io.log(`1: slot1（${player.arrow.name}）`);

          if (player.arrow_slots >= 2)
            io.log(`2: slot2（${player.arrow2.name}）`);

          io.log("0: キャンセル");

          const sel = (await io.input("番号入力: ")).trim();

          if (sel === "1") {
            player.arrow_inventory.push(player.arrow);
            player.arrow = item;
            io.log(`🏹 ${item.name} を slot1 に装備しました！`);
          }
          else if (sel === "2" && player.arrow_slots >= 2) {
            player.arrow_inventory.push(player.arrow2);
            player.arrow2 = item;
            io.log(`🏹 ${item.name} を slot2 に装備しました！`);
          }
          else {
            io.log("交換はキャンセルされました。特殊枠に入れます。");
            player.arrow_inventory.push(item);
          }
        }

      } // ★ 「YESブロック」の終了

      // === NO：装備しない → 特殊枠へ ===
      else {
        player.arrow_inventory.push(item);
        io.log(`📦 ${item.name} を特殊装備枠に入れました。`);
      }

    } // ★ io ブロック終了

    return { success: true, message: `${item.name} を購入しました！` };
  } // ★ arrow ブロック終了

  // ▼ 魔導士専用装備
  else if (item.equip_type === "mage_equip") {
    player.special_inventory.push(item);
    io?.log?.(`🔮 ${item.name} を特殊装備枠に追加しました！`);
  }

  // ▼ 通常装備
  else {
    player.equipment_inventory = player.equipment_inventory || [];
    player.equipment_inventory.push(item);
    io?.log?.(`🛡 装備を追加：${item.name}`);
  }
}
// ★★★ ここを必ず追加 ★★★
// is_equip = false → 消費アイテム
if (!item.is_equip) {
    player.items.push(item);
    io?.log?.(`💊 アイテムを追加：${item.name}`);
}

return { success: true, message: `${item.name} を購入しました！` };

}
