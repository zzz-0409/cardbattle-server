// ============================================
// engine.js（ラウンドR / ターンT 完全対応版）
// ============================================

import { Player } from "./player.js";
import { buyFromShop, generateShop } from "./shop.js";
import { ARROW_DATA, JOB_TEMPLATE, COIN_PER_TURN_BASE } from "./constants.js";
import { LEVEL_REQUIREMENTS, LEVEL_ATTACK_INCREASE } from "./constants.js";


// ============================================
// ショップメニュー
// ============================================
async function openShopMenu(player, io) {

    if (!player.shop_list) {
        player.shop_list = generateShop(player);
    }

    let list = player.shop_list;

    while (true) {
        io.log("\n=== 🛒 ショップ ===");
        list.forEach((item, i) => {
            let price = item.price ?? 0;
            let priceText = `価格:${price}`;

            if (player.job === "錬金術師" &&
                item.is_equip &&
                item.equip_type !== "alchemist_unique") {

                const discounted = Math.max(1, Math.floor(price * 0.8));
                priceText = `価格: ~${price} → ${discounted}`;
            }

            io.log(`${i + 1}: ${item.name} ${priceText} | ${item.effect_text ?? ""}`);
        });

        io.log("\n0: 戻る");
        io.log("9: ショップ更新（2コイン）");

        const cmd = (await io.input("番号入力: ")).trim();

        if (cmd === "0") return;

        if (cmd === "9") {
            if (player.coins < 2) {
                io.log("コインが足りません（必要:2）");
                continue;
            }
            player.coins -= 2;
            io.log("🔄 ショップを更新しました！（2コイン消費）");

            player.shop_list = generateShop(player);
            list = player.shop_list;
            continue;
        }

        if (!/^\d+$/.test(cmd)) {
            io.log("数字で入力してください。");
            continue;
        }

        const idx = parseInt(cmd, 10) - 1;

        if (idx < 0 || idx >= list.length) {
            io.log("無効な番号です。");
            continue;
        }

        const result = await buyFromShop(player, list[idx], io);

        if (result.success) {
            io.log(result.message);
            list.splice(idx, 1);
            player.shop_list = list;
        } else {
            io.log(result.message);
        }
    }
}


// ============================================
// DOT（旧方式）→ 後で turn_dot / round_dot 分離予定
// ============================================
export function applyDotEffects(player, io) {
    if (!player.dot_effects || player.dot_effects.length === 0) return 0;

    let total = 0;

    for (let i = player.dot_effects.length - 1; i >= 0; i--) {
        const eff = player.dot_effects[i];

        // ★ turns が正しい T 仕様
        const dmg = player.take_damage(eff.power, true);
        total += dmg;

        io.log?.(`🔥 ${eff.name} の継続ダメージ！ ${eff.power} ダメージ`);

        eff.turns -= 1;

        if (eff.turns <= 0) {

            // ★ DOTリストから削除
            player.dot_effects.splice(i, 1);

            // ★ 式神一覧から鬼火を削除（同名の式神を除去）
            if (player.shikigami_effects) {
                player.shikigami_effects = player.shikigami_effects.filter(
                    s => !(s.name === "鬼火")
                );
            }
        }
    }  // ← ★ for の閉じカッコはここ

    return total;   // ← ★ return は for の外
}




// ============================================
// 氷結デバフ（ラウンド消費）
// ============================================
export function processFreezeDebuffs(player, io) {
    if (!player.freeze_debuffs || player.freeze_debuffs.length === 0) return;

    for (let i = player.freeze_debuffs.length - 1; i >= 0; i--) {
        const fd = player.freeze_debuffs[i];
        fd.rounds -= 1;   // ★ rounds に統一
        if (fd.rounds <= 0) {
            player.freeze_debuffs.splice(i, 1);
        }
    }

    if (player.freeze_debuffs.length === 0) {
        io.log?.("❄ 氷結効果が消えた！");
    }
}



// ============================================
// 反撃矢ボーナス
// ============================================
export function calculateCounterBonus(player) {
    const base = player.damage_taken_last_turn ?? 0;
    return Math.floor(base * 0.5);
}

export function applyCounterBonusToArrows(player) {
    const bonus = calculateCounterBonus(player);
    if (bonus <= 0) return;

    const applyBonus = (arrow) => {
        if (!arrow) return;
        if (arrow.effect === "counter") {
            arrow.temp_bonus = bonus;
        }
    };

    applyBonus(player.arrow);
    applyBonus(player.arrow2);
}

export function clearArrowTempBonus(player) {
    if (player.arrow && player.arrow.temp_bonus) delete player.arrow.temp_bonus;
    if (player.arrow2 && player.arrow2.temp_bonus) delete player.arrow2.temp_bonus;
}


// ============================================
// 魔導士装備：毎ラウンド効果
// ============================================
export function processMageEquipEffects(player, io) {
    if (!player || player.job !== "魔導士") return;
    if (!player.mage_equips) return;

    let manaGain = 0;
    let extraCoins = 0;
    let regenHP = 0;

    for (const eq of Object.values(player.mage_equips)) {
        if (!eq) continue;

        manaGain  += eq.mana_gain     ?? 0;
        extraCoins += eq.coin_per_turn ?? 0;
        regenHP   += eq.regen_hp      ?? 0;
    }

    if (manaGain > 0) {
        const before = player.mana;
        player.mana = Math.min(player.mana_max, player.mana + manaGain);
        io.log?.(`🔮 装備効果で魔力 +${manaGain} (${before}→${player.mana})`);
    }

    if (extraCoins > 0) {
        player.coins += extraCoins;
        io.log?.(`💰 装備効果でコイン +${extraCoins}`);
    }

    if (regenHP > 0) {
        const before = player.hp;
        player.hp = Math.min(player.max_hp, player.hp + regenHP);
        io.log?.(`❤️ 装備効果でHP +${regenHP} (${before}→${player.hp})`);
    }
}
// ============================================
// ステータス確認
// ============================================
export function showBothStatus(player, opponent, io) {
  io.log("=== ステータス確認 ===");
  io.log(`[${player.name}]`);
  io.log(`HP: ${player.hp} / ${player.max_hp}`);
  io.log(`ATK: ${player.get_total_attack()}`);
  io.log(`DEF: ${player.get_total_defense()}`);
  io.log(`コイン: ${player.coins}`);
  io.log(`EXP: ${player.exp}`);
  io.log(`レベル: ${player.level}`);
  if (player.equipment) {
    io.log(
      `装備: ${player.equipment.name} (★${player.equipment.star ?? "?"}) / 効果: ${player.equipment.effect_text}`
    );
  } else {
    io.log("装備: なし");
  }

  io.log("-------------------------");
  io.log(`[${opponent.name}]`);
  io.log(`HP: ${opponent.hp} / ${opponent.max_hp}`);
  io.log(`ATK: ${opponent.get_total_attack()}`);
  io.log(`DEF: ${opponent.get_total_defense()}`);
  io.log(`レベル: ${opponent.level}`);
  if (opponent.equipment) {
    io.log(
      `装備: ${opponent.equipment.name} (★${opponent.equipment.star ?? "?"}) / 効果: ${opponent.equipment.effect_text}`
    );
  } else {
    io.log("装備: なし");
  }
}


// ============================================
// 先攻・後攻決定
// ============================================
export function decideOrder(p1, p2, io) {
  const arr = [p1, p2];
  if (Math.random() < 0.5) {
    // そのまま
  } else {
    arr.reverse();
  }
  io.log?.(`🎲 先攻: ${arr[0].name} / 後攻: ${arr[1].name}`);
  return arr;
}


// ============================================
// メイン：バトルループ
// ============================================
export async function battleLoop(p1, p2, io) {

  // リセット
  for (const pl of [p1, p2]) {
    pl.mana = pl.mana ?? 0;
    pl.used_skill_set = pl.used_skill_set ?? new Set();
    pl.used_skill_set.clear();

    pl.skill_sealed = false;
    pl.barrier = 0;

    pl.dot_effects = pl.dot_effects ?? [];
    pl.freeze_debuffs = pl.freeze_debuffs ?? [];

    pl.damage_taken_last_T = 0;
    pl.damage_taken_this_T = 0;
  }

  let [first, second] = decideOrder(p1, p2, io);
  const players = [first, second];

  // ▼ ラウンド・ターン（行動数）初期化
  let battle_round = 1;   // R1 から開始
  let battle_turn  = 0;   // 各行動で +1 される（T 表記用）

  p1.shop_generated_at_round = -1;
  p2.shop_generated_at_round = -1;


  // ============================================
  // バトル継続ループ
  // ============================================
  while (p1.hp > 0 && p2.hp > 0) {

    for (let idx = 0; idx < 2; idx++) {

      const current  = players[idx];
      const opponent = players[1 - idx];

      // ★ ラウンド開始（先攻 idx === 0 のときだけ）
      if (idx === 0) {
        io.log(`\n===== 🕒 ラウンド ${battle_round} 開始 =====`);
      }

      // 毎ラウンド自動ショップ生成
      current.shop_list = generateShop(current);

      // レベル毎ショップ（旧仕様互換）
      if (typeof current.generateShopForLevel === "function") {
        current.shop = current.generateShopForLevel(current.level, current.job);
      }

      current.reset_used_items_counter?.();
      opponent.reset_used_items_counter?.();

      // 魔導士装備効果
      processMageEquipEffects(current, io);

      // コイン配布（毎ラウンド）
      let coinGain =
        COIN_PER_TURN_BASE + (current.job_data?.coin_per_turn_bonus ?? 0);

      if (current.equipment && current.equipment.equip_category === "coin") {
        coinGain += current.equipment.equip_power ?? 0;
      }

      let appliedCoin = coinGain;

      // 先攻 1 行動目はコイン 0
      if (battle_turn === 0 && current === first) {
        appliedCoin = 0;
      }

      current.coins += appliedCoin;
      io.log?.(
        `${current.name} はラウンド開始でコイン +${appliedCoin} → ${current.coins}`
      );

      // EXP +10
      current.exp = (current.exp ?? 0) + 10;
      io.log?.(`📘 EXP +10 → 現在EXP:${current.exp}`);

      // 自動レベルアップ
      let lvup = current.try_level_up_auto(io);
      while (lvup && current.level < 3) {
        if (!current.try_level_up_auto(io)) break;
      }


      // ============================================
      // 行動選択フェーズ
      // ============================================
      let endedTurn = false;

      while (!endedTurn && p1.hp > 0 && p2.hp > 0) {

        current.show_status?.(io);

        io.log(
          `\n行動を選択:\n` +
            `1: 攻撃  2: スキル  3: レベルアップ  4: アイテム使用  5: ショップ\n` +
            `6: 装備管理  7: ステータス確認  8: バトルログ  0: ギブアップ`
        );

        const cmd = (await io.input("番号入力: ")).trim();

        if (!["0","1","2","3","4","5","6","7","8"].includes(cmd)) {
          io.log("無効な入力です。");
          continue;
        }


        // ====================================
        // 0: ギブアップ
        // ====================================
        if (cmd === "0") {
          io.log(`${current.name} はギブアップした！`);
          current.hp = 0;
          endedTurn = true;
          break;
        }


        // ====================================
        // 1: 攻撃
        // ====================================
        if (cmd === "1") {

          io.log("DEBUG: 攻撃処理に入りました");

          const atkTotal = current.get_total_attack();
          const defTotal = opponent.get_total_defense();



          if (current.job === "弓兵") {
            applyCounterBonusToArrows(current);
          }

          const dmg = opponent.take_damage(atkTotal, false);

          io.log(`${current.name} の攻撃！ 攻撃:${atkTotal} 防御:${defTotal}`);

          // 陰陽師：烏天狗追撃
          if (typeof current.trigger_karasu_tengu === "function") {
            const tenguList = current.trigger_karasu_tengu(opponent);
            if (Array.isArray(tenguList)) {
              for (const dmg of tenguList) {
                io.log(`🐦 烏天狗の追撃！ ${dmg} ダメージ`);
              }
            }
          }

          // 弓兵：追撃
          if (current.job === "弓兵" && typeof current.trigger_arrow_attack === "function") {
              const results = current.trigger_arrow_attack(opponent) ?? [];
              for (const r of results) {
                  io.log(`🏹 弓兵の追撃（${r.name}）！ ${r.dealt} ダメージ`
                    + (r.isCrit ? " (会心)" : "")
                    + (r.pierce ? " (防御貫通)" : "")
                  );
              }
              clearArrowTempBonus(current);

              // ★ デバッグ
              io.log(`DEBUG BEFORE rounds = ${current.archer_buff?.rounds}`);

              if (current.archer_buff && current.archer_buff.rounds > 0) {
                  current.archer_buff.rounds -= 1;
              }

              io.log(`DEBUG AFTER rounds = ${current.archer_buff?.rounds}`);

              if (current.archer_buff && current.archer_buff.rounds <= 0) {
                  current.archer_buff = null;
                  io.log("🏹 追撃効果が終了しました");
              }
          }



          endedTurn = true;
        }


        // ====================================
        // 2: スキル
        // ====================================
        else if (cmd === "2") {

          const result = await current.choose_and_use_skill(opponent, io);

          if (result === true) {

            if (typeof current.trigger_karasu_tengu === "function") {
              const tenguList = current.trigger_karasu_tengu(opponent);
              if (Array.isArray(tenguList)) {
                for (const dmg of tenguList) {
                  io.log(`🐦 烏天狗の追撃！ ${dmg} ダメージ`);
                }
              }
            }

            endedTurn = true;

          } else {
            io.log("スキルが失敗しました。別の行動を選んでください。");
            endedTurn = false;
          }
        }


        // ====================================
        // 3: レベルアップ
        // ====================================
        else if (cmd === "3") {

          const req = LEVEL_REQUIREMENTS[current.level];

          if (current.level >= 3) {
            io.log("これ以上レベルアップできません。");
            endedTurn = false;
            continue;
          }

          const need = req - current.exp;

          if (need <= 0) {
            current.exp -= req;
            current.level += 1;

            const inc = LEVEL_ATTACK_INCREASE[current.level] ?? 0;
            if (inc > 0) {
              current.base_attack += inc;
              io.log(`🆙 ${current.name} は Lv${current.level} に上がった！（攻撃 +${inc}）`);
            } else {
              io.log(`🆙 ${current.name} は Lv${current.level} に上がった！`);
            }

            endedTurn = false;
            continue;
          }

          io.log(
            `必要EXP: ${req} / 現在EXP: ${current.exp}\n不足EXP: ${need}（必要コイン ${need}）`
          );

          const ans = (await io.input(`${need} コインを消費してレベルアップしますか？ (y/n): `))
            .trim()
            .toLowerCase();

          if (ans === "y") {
            const ok = current.try_level_up_with_coins(io);
            if (!ok) io.log("レベルアップに失敗しました。");
          } else {
            io.log("キャンセルしました。");
          }

          endedTurn = false;
        }


        // ====================================
        // 4: アイテム使用
        // ====================================
        else if (cmd === "4") {

          if (current.can_use_item && !current.can_use_item()) {
            io.log("このラウンドはもうアイテムを使えません。");
            continue;
          }

          if (!current.items || current.items.length === 0) {
            io.log("所持アイテムがありません。");
            continue;
          }

          io.log("\n--- 所持アイテム ---");
          current.items.forEach((it, i) => {
            const tag = it.is_equip ? " (装備)" : "";
            io.log(`${i + 1}: ${it.name}${tag} | 効果: ${it.effect_text}`);
          });
          io.log("0: キャンセル");

          const c = (await io.input("使用するアイテム番号: ")).trim();
          if (c === "0") continue;
          if (!/^\d+$/.test(c)) {
            io.log("数字で入力してください。");
            continue;
          }

          const ii = parseInt(c, 10) - 1;
          if (ii < 0 || ii >= current.items.length) {
            io.log("無効な番号です。");
            continue;
          }

          const chosen = current.items.splice(ii, 1)[0];
          current.apply_item(chosen, io);
          endedTurn = false;
        }


        // ====================================
        // 5: ショップ
        // ====================================
        else if (cmd === "5") {
          await openShopMenu(current, io);
          endedTurn = false;
        }


        // ====================================
        // 6: 装備管理
        // ====================================
        else if (cmd === "6") {
          if (typeof current.manage_equipment === "function") {
            await current.manage_equipment(io);
          } else {
            io.log("装備管理機能は未実装です。");
          }
          endedTurn = false;
        }


        // ====================================
        // 7: ステータス確認
        // ====================================
        else if (cmd === "7") {
          showBothStatus(current, opponent, io);
          endedTurn = false;
        }


        // ====================================
        // 8: バトルログ
        // ====================================
        else if (cmd === "8") {
          if (io.showLogPage) {
            let page = 0;
            while (true) {
              const res = await io.showLogPage(page);
              if (res == null) break;
              page = res;
            }
          } else {
            io.log("バトルログ機能は未実装です。");
          }
          endedTurn = false;
        }

      } // ← while (!endedTurn)

      if (p1.hp <= 0 || p2.hp <= 0) break;

      // ============================================
      // ★ 行動後：ターン(T) を +1
      // ============================================
      battle_turn += 1;

      // ラウンド表示（行動後に必ず出す）
      if (idx === 0) {
        io.log(`▶ ${current.name} の行動完了（R${battle_round} / T${battle_turn}）`);
      } else {
        io.log(`⏳ ${current.name} の行動完了（R${battle_round} / T${battle_turn}）`);
      }
      // ============================================
      // ★ ラウンド終了処理（各プレイヤーの行動後）
      // ============================================

      // 自分側の DOT（旧仕様）
      applyDotEffects(current, io);

      // 被ダメ履歴更新（反撃矢用）
      const base = this.damage_taken_last_T ?? 0;
      current.damage_taken_this_T = 0;

      // 相手側 DOT
      applyDotEffects(opponent, io);

      // スキル封印状態更新
      if (
        current.active_buffs?.some(b => b.type === "スキル封印") ||
        opponent.active_buffs?.some(b => b.type === "スキル封印")
      ) {
        current.skill_sealed  = current.active_buffs.some(b => b.type === "スキル封印");
        opponent.skill_sealed = opponent.active_buffs.some(b => b.type === "スキル封印");
      } else {
        current.skill_sealed  = false;
        opponent.skill_sealed = false;
      }


      // 氷結デバフ：R 消費
      processFreezeDebuffs(current, io);

      // その他バフ：R 消費
      current.decrease_buffs_end_of_round?.();

      // ============================================
      // 後攻（idx === 1）ならラウンド終了 → R+1
      // ============================================
      if (idx === 1) {
        battle_round += 1;
      }

    } // ← for idx（先攻・後攻ループ）

    if (p1.hp <= 0 || p2.hp <= 0) break;

  } // ← while バトル継続


  // ============================================
  // 勝敗決定
  // ============================================
  if (p1.hp <= 0 && p2.hp <= 0) {
    io.log("\n結果: 引き分け！");
  } else if (p1.hp <= 0) {
    io.log(`\n結果: ${p2.name} の勝利！`);
  } else {
    io.log(`\n結果: ${p1.name} の勝利！`);
  }

} // ← battleLoop 終了

