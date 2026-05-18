// player.js
// Python版 player.py をベースにした JS 版 Player（Step1: 土台＋アイテムまで）


import {
  createDollCostume,
  DOLL_COSTUME_TYPES,
  SUMMONER_DRAGON_DATA,
  SUMMONER_GROWTH_MAX,
  SUMMONER_HATCH_TURNS
} from "./constants.js";

import crypto from "crypto";

// ---------------------------------------------------------
// 魔導士装備スロット判定（Python版 get_mage_slot）
// ---------------------------------------------------------
export function getMageSlot(eq) {
    if (eq.coin_per_turn) return "staff";    // 杖
    if (eq.regen_hp)       return "ring";     // 指輪
    if (eq.def_bonus)      return "robe";     // ローブ
    return "book";                             // 古代魔導書など
}

// ---------------------------------------------------------
// 人形衣装スロット判定
// ---------------------------------------------------------
import {
    generateRandomEquip,
    upgradeEquipStar,
    createAlchemistUniqueEquip
} from "./equip.js";

import { JOB_SKILLS } from "./constants.js";

import {
    MAX_HP,
    INITIAL_ATTACK,
    INITIAL_DEFENSE,
    LEVEL_REQUIREMENTS,
    LEVEL_ATTACK_INCREASE,
    JOB_TEMPLATE,
} from "./constants.js";



// ログ関数（とりあえずコンソール出力）
function log(msg) {
  // simulate / devMode ではログを出さない
  if (globalThis?.DEV_MODE || globalThis?.SIMULATE) return;
  console.log(msg);
}

function isThiefStealableItem(item) {
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



export class Player {
    constructor(name, jobKey) {
        this.name = name;

        // 職業セット
        const jd = JOB_TEMPLATE[jobKey];
        this.job = jd.name;
        this.job_data = jd;

    
        // レベル・コイン
        this.level = 1;
        this.exp = 0;
        this.coins = jd.coin;
        // ★ レベルアップ必要コイン
        this.levelup_costs = {
            1: 30,   // Lv1 → Lv2
            2: 40    // Lv2 → Lv3
        };

        // 経験値によるレベルアップ必要EXPは constants.js の LEVEL_REQUIREMENTS を使用

        // 基本ステータス
        this.max_hp = MAX_HP;
        this.hp = MAX_HP;
        this.base_attack = INITIAL_ATTACK + jd.atk_bonus;
        this.base_defense = INITIAL_DEFENSE + jd.def_bonus;

        // 状態異常・バフ
        this.active_buffs = [];
        this.skill_sealed = false;
        this.barrier = 0;
        this.madman_guts = false;
        this.madman_no_heal = false;
        this.madman_rage_active = false;
        this.blessing_count = 0;
        this.skill_sealed_rounds = 0;   // ← これが絶対必要！

        // --- 弓兵専用フィールド ---
        this.arrow_inventory = [];   // 所持している矢
        this.arrow = null;           // slot1
        this.arrow2 = null;          // slot2

        // ★ オンライン版では常に初期値を明示
        this.arrow_slots = 1;


        this.archer_buff = null;          // 追撃バフ互換サマリ（{ rounds, extra }）
        this.archer_buffs = [];           // 追撃バフ本体（[{ rounds, extra }]）
        this.archer_pierce_rounds = 0;    // 矢追撃の防御貫通残りターン
        this.archer_next_pierce = false;  // 旧セーブ互換
        this.archer_no_consume_rounds = 0; // 矢を消費しない残りターン
        this.archer_no_consume_permanent = false;
        this.damage_taken_last_round = 0; // 前ターンダメージ → 反撃矢用


        // freeze（A方式：スタックごとに2T）
        this.freeze_debuffs = [];  // [{atkDown:2, rounds:2}, ...]
        this.defense_debuffs = []; // [{defDown:1, rounds:3}, ...]



        // アイテム・装備
        this.items = [];                 // Pythonの self.items
        this.equipment_inventory = [];   // 通常装備所持枠
        this.equipment = null;           // 通常装備（1枠）
        this.extra_equipments = [];      // 達人への道などで増えた通常装備枠

        this.used_items_this_round = 0;

        this.special_inventory = [];   // 魔導士装備・矢などの特殊装備用
        this.extra_special_equipments = []; // 達人への道などで増えた特殊装備枠
        this.pending_alchemist_selection = [];
        this.pending_doll_charge_choices = null;
        this.pending_doll_charge_option = null;
        this.dojo_invincible_rounds = 0;
        this.dojo_attack_growth_active = false;
        this.dojo_attack_growth_per_round = 0;

        // スキル使用管理
        this.used_skill_set = new Set();

        // 魔導士用
        this.mana_max = 200;
        this.mana = 0;
        this.magic_pierce = false;       // 魔導書で防御貫通

        this.mage_equips = {
            staff: null,
            ring: null,
            robe: null,
            book: null
        };

        // ショップ（職業選択後に設定される）
        this.shop = [];
        this.shop_generated_at_round = -1;
        
        this.dot_effects = [];  // 継続ダメージ（鬼火など）

        // 式神の継続効果（烏天狗など）
        this.shikigami_effects = [];
        this.last_summoned_shikigami = [];

        // ================================
        // 人形使い：人形オブジェクト
        // ================================
        this.doll = null;
        this.summoner = null;

        /* ★★★ この直後に追加 ★★★ */
        if (this.job === "人形使い") {

            const randomEffect = () =>
                DOLL_COSTUME_TYPES[Math.floor(Math.random() * DOLL_COSTUME_TYPES.length)];

            this.doll = {
                // 基礎ステータス
                base_atk: 13,
                base_def: 5,

                // 耐久力
                max_durability: 100,
                durability: 100,

                // 状態
                is_broken: false,
                is_rampage: false,
                revive_guard_rounds: 0,
                repair_kit_lock_rounds: 0,
                charge: 0,
                pending_charge_ready: false,
                extra_attacks_this_turn: 0,
                extra_attack_buff: null,
                extra_attack_ignore_def_permanent: false,
                charge_buffs: {
                    base_atk_up: { level: 1, picks: 0 },
                    extra_attack: { level: 1, picks: 0 },
                    gain_coins: { level: 1, picks: 0 },
                    heal_durability: { level: 1, picks: 0 },
                    costume_boost: { level: 1, picks: 0 },
                },

                // 初期衣装
                costumes: {
                    head: createDollCostume({
                        part: "head",
                        effect_type: randomEffect(),
                        star: 1
                    }),
                    body: createDollCostume({
                        part: "body",
                        effect_type: randomEffect(),
                        star: 1
                    }),
                    leg: createDollCostume({
                        part: "leg",
                        effect_type: randomEffect(),
                        star: 1
                    }),
                    foot: createDollCostume({
                        part: "foot",
                        effect_type: randomEffect(),
                        star: 1
                    })
                }
            };
            // ★ 人形初期衣装の共通初期化（後付け衣装と完全互換）
            for (const c of Object.values(this.doll.costumes)) {
                if (!c) continue;

                // 状態が未定義なら新品
                c.condition ??= "normal";

                // 表示名・効果文を確定させる
                this.updateCostumeDisplayName(c);
            }

        }
        if (this.job === "召喚士") {
            this.summoner = {
                front: null,
                resonance_turns: 0,
                dragons: [],
            };
        }
        // ---------------------------------------------------------
        // 狂人累積ダメージ
        // ---------------------------------------------------------
        if (this.job === "狂人"){
        this.total_damage_received = 0; // 累積被ダメージ
        }
        /* ★★★ ここまで ★★★ */

    }
       
    ensureSummonerState() {
        if (this.job !== "召喚士") return null;
        if (!this.summoner || typeof this.summoner !== "object") {
            this.summoner = {
                front: null,
                resonance_turns: 0,
                dragons: [],
            };
        }
        this.summoner.dragons = Array.isArray(this.summoner.dragons)
            ? this.summoner.dragons
            : [];
        for (const dragon of this.summoner.dragons) {
            if (!dragon || typeof dragon !== "object") continue;
            const data = SUMMONER_DRAGON_DATA[dragon.type] ?? {};
            dragon.name ??= data.name ?? "竜";
            dragon.stage ??= "egg";
            dragon.hatch_turns_remaining = Math.max(0, Number(dragon.hatch_turns_remaining ?? SUMMONER_HATCH_TURNS));
            dragon.growth = Math.max(0, Number(dragon.growth ?? 0));
            dragon.growth_max = Math.max(1, Number(dragon.growth_max ?? SUMMONER_GROWTH_MAX));
        }

        const currentFront = this.summoner.dragons.find(dragon =>
            dragon?.type === this.summoner.front &&
            dragon.stage !== "egg"
        );
        if (!currentFront) {
            const nextFront = this.summoner.dragons.find(dragon => dragon?.stage !== "egg");
            this.summoner.front = nextFront?.type ?? null;
        }
        return this.summoner;
    }

    getSummonerDragons() {
        return this.ensureSummonerState()?.dragons ?? [];
    }

    getSummonerDragon(type) {
        const key = String(type ?? "");
        return this.getSummonerDragons().find(dragon => dragon?.type === key) ?? null;
    }

    getSummonerFrontType() {
        const state = this.ensureSummonerState();
        return state?.front ?? null;
    }

    isSummonerDragonFront(type) {
        return String(this.getSummonerFrontType() ?? "") === String(type ?? "");
    }

    isSummonerResonanceActive() {
        return this.job === "召喚士" && Number(this.summoner?.resonance_turns ?? 0) > 0;
    }

    getSummonerDragonRole(dragon) {
        if (!dragon || dragon.stage === "egg") return "egg";
        if (this.isSummonerResonanceActive()) return "front";
        return this.isSummonerDragonFront(dragon.type) ? "front" : "back";
    }

    getSummonerDefenseBonus() {
        if (this.job !== "召喚士") return 0;
        let total = 0;
        for (const dragon of this.getSummonerDragons()) {
            if (!dragon || dragon.type !== "fafnir" || dragon.stage === "egg") continue;
            const role = this.getSummonerDragonRole(dragon);
            if (dragon.stage === "juvenile") {
                total += role === "front" ? 5 : 3;
            }
        }
        return total;
    }

    getSummonerSpecialDefenseBonus() {
        if (this.job !== "召喚士") return 0;
        let total = 0;
        for (const dragon of this.getSummonerDragons()) {
            if (!dragon || dragon.type !== "fafnir" || dragon.stage !== "adult") continue;
            const role = this.getSummonerDragonRole(dragon);
            total += role === "front" ? 5 : 3;
        }
        return total;
    }

    hasSummonerFafnirReflect() {
        if (this.job !== "召喚士") return false;
        return this.getSummonerDragons().some(dragon =>
            dragon?.type === "fafnir" &&
            dragon.stage === "adult" &&
            this.getSummonerDragonRole(dragon) === "front"
        );
    }


    getAlchemistFusionCandidates() {
        const candidates = [];

        if (
            this.equipment &&
            this.equipment.equip_type !== "mage_equip" &&
            this.equipment.equip_type !== "alchemist_unique"
        ) {
            candidates.push({
                origin: "equip_slot",
                index: 0,
                obj: this.equipment,
            });
        }

        this.equipment_inventory.forEach((eq, idx) => {
            if (
                eq &&
                eq.equip_type !== "mage_equip" &&
                eq.equip_type !== "alchemist_unique"
            ) {
                candidates.push({
                    origin: "inv",
                    index: idx,
                    obj: eq,
                });
            }
        });

        return candidates;
    }

    getDollBoroboroCostumeEntries() {
        if (!this.doll?.costumes) return [];

        const labels = {
            head: "帽子",
            body: "服",
            leg: "ズボン",
            foot: "靴"
        };

        return Object.entries(this.doll.costumes)
            .filter(([, costume]) => costume && costume.condition === "boroboro")
            .map(([part, costume]) => ({
                part,
                label: labels[part] ?? part,
                costume,
            }));
    }

    pickDollRepairCostumeEntry(part = null) {
        const entries = this.getDollBoroboroCostumeEntries();
        if (entries.length === 0) return null;

        const requested = String(part ?? "");
        const exact = entries.find(entry => entry.part === requested);
        if (exact) return exact;

        entries.sort((a, b) => {
            const chargeA = a.costume?.effect_type === "CHARGE" || a.costume?.effect_type === "COIN";
            const chargeB = b.costume?.effect_type === "CHARGE" || b.costume?.effect_type === "COIN";
            return Number(chargeB) - Number(chargeA) ||
                Number(b.costume?.star ?? 1) - Number(a.costume?.star ?? 1);
        });
        return entries[0];
    }

    useDollRepairKit(part = null) {
        if (!this.doll) return { ok: false };

        this.doll.costumes ??= {
            head: null,
            body: null,
            leg: null,
            foot: null
        };

        const beforeDurability = Number(this.doll.durability ?? 0);
        const maxDurability = Math.max(0, Number(this.doll.max_durability ?? beforeDurability));
        this.doll.durability = Math.min(maxDurability, beforeDurability + 20);
        this.doll.revive_guard_rounds = 0;

        const repaired = this.pickDollRepairCostumeEntry(part);
        let repairedCostume = null;
        if (repaired?.costume) {
            repaired.costume.condition = "normal";
            repaired.costume.part ??= repaired.part;
            this.updateCostumeDisplayName(repaired.costume);
            repairedCostume = {
                part: repaired.part,
                label: repaired.label,
                name: repaired.costume.name ?? "衣装"
            };
        }

        const afterDurability = Number(this.doll.durability ?? 0);
        return {
            ok: true,
            beforeDurability,
            afterDurability,
            healed: Math.max(0, afterDurability - beforeDurability),
            repairedCostume,
        };
    }

    // ---------------------------------------------------------
    // ステータス計算
    // ---------------------------------------------------------
    get_attack_buff_total() {
        let total = 0;
        for (const b of this.active_buffs) {
            if (b.type === "攻撃力") {
                total += b.power;
            } else if (b.type === "攻撃力低下") {
                total -= b.power;
            }
        }
        return total;
    }

    get_def_buff_total() {
        let total = 0;
        for (const b of this.active_buffs) {
            if (b.type === "防御力") {
                total += b.power;
            } else if (b.type === "防御力低下") {
                total -= b.power;
            }
        }
        return total;
    }

    can_receive_heal() {
        return !(this.job === "狂人" && this.madman_no_heal);
    }

    restore_hp(amount) {
        if (!this.can_receive_heal()) return 0;
        const heal = Number(amount ?? 0);
        if (heal <= 0) return 0;
        const before = this.hp;
        const healCap = this.job === "僧侶" ? 400 : this.max_hp;
        this.hp = Math.min(healCap, this.hp + heal);
        return this.hp - before;
    }

    get_total_attack() {
        let total = this.base_attack + this.get_attack_buff_total();

        // 狂人専用: スキル3強化中は累積被ダメージの 1/20 を攻撃力へ加算
        if (this.job === "狂人" && this.madman_rage_active) {
            total += Math.floor((this.total_damage_received ?? 0) / 20);
        }

        // ============================
        // 通常装備
        // ============================
        if (this.equipment?.equip_category === "攻撃力") {
            total += this.equipment.equip_power ?? this.equipment.power ?? 0;
        }
        for (const eq of this.extra_equipments ?? []) {
            if (eq?.equip_category === "攻撃力") {
                total += eq.equip_power ?? eq.power ?? 0;
            }
        }

        // ============================
        // ★ 錬金術師 特殊装備（直接参照）
        // ============================
        if (this.alchemist_equip) {
            total += this.alchemist_equip.atk ?? 0;
        }
        const dojoSpecialEquips = [
            this.special_equipment,
            ...(Array.isArray(this.extra_special_equipments) ? this.extra_special_equipments : []),
        ];
        for (const eq of dojoSpecialEquips) {
            if (!eq) continue;
            if (eq.dojo_special_effect === "excalibur" || eq.dojo_special_effect === "muramasa") {
                total += Number(eq.attack_bonus ?? (eq.dojo_special_effect === "muramasa" ? 10 : 5));
            } else if (eq.dojo_special_effect === "aegis") {
                total += Math.max(0, Number(this.get_def_buff_total?.() ?? 0));
            }
        }
        
        // ============================
        // freeze デバフ
        // ============================
        let freezeDown = 0;
        if (this.freeze_debuffs?.length) {
            for (const fd of this.freeze_debuffs) {
                freezeDown += fd.atkDown;
            }
        }
        total -= freezeDown;

        return total;
    }

    // ★ 実際に使用する攻撃力（人形 or 本体）
    getActualAttack() {
        // 人形使い：人形が生きていれば人形攻撃
        if (this.job === "人形使い" && this.doll && !this.doll.is_broken) {
            return this.getDollAttack();
        }

        // それ以外は本体攻撃
        let attack = this.get_total_attack();
        if (this.special_equipment?.dojo_special_effect === "excalibur") {
            const hasAttackBuff = Number(this.get_attack_buff_total?.() ?? 0) > 0;
            if (hasAttackBuff && !this.excalibur_attack_boost_used) {
                attack += 10;
                this.excalibur_attack_boost_used = true;
            } else if (!hasAttackBuff) {
                this.excalibur_attack_boost_used = false;
            }
        }
        return attack;
    }

    get_special_defense() {
        let total = 0;
        const equips = [
            this.special_equipment,
            ...(Array.isArray(this.extra_special_equipments) ? this.extra_special_equipments : []),
        ];
        for (const eq of equips) {
            if (!eq) continue;
            if (eq.dojo_special_effect === "special_defense") {
                total += Number(eq.special_defense ?? 10);
            }
        }
        total += Number(this.getSummonerSpecialDefenseBonus?.() ?? 0);
        return Math.max(0, total);
    }

    has_dojo_pierce_weapon() {
        const equips = [
            this.special_equipment,
            ...(Array.isArray(this.extra_special_equipments) ? this.extra_special_equipments : []),
        ];
        return equips.some(eq => !!eq && eq.dojo_special_effect === "pierce_weapon");
    }

    get_total_defense() {
        // ============================
        // 人形使い本体の防御力は人形防御に置き換えない
        // ============================        
        let total = this.base_defense + this.get_def_buff_total();

        // ============================
        // 通常装備
        // ============================
        if (this.equipment?.equip_category === "防御力") {
            total += this.equipment.equip_power ?? this.equipment.power ?? 0;
        }
        for (const eq of this.extra_equipments ?? []) {
            if (eq?.equip_category === "防御力") {
                total += eq.equip_power ?? eq.power ?? 0;
            }
        }

        // ============================
        // ★ 錬金術師 特殊装備（直接参照）
        // ============================
        if (this.alchemist_equip) {
            total += this.alchemist_equip.def ?? 0;
        }
        if (this.special_equipment?.dojo_special_effect === "aegis" || this.special_equipment?.dojo_special_effect === "durandal") {
            total += Number(this.special_equipment.defense_bonus ?? 5);
        }
        for (const eq of this.extra_special_equipments ?? []) {
            if (eq?.dojo_special_effect === "aegis" || eq?.dojo_special_effect === "durandal") {
                total += Number(eq.defense_bonus ?? 5);
            }
        }

        // ============================
        // 魔導士ローブ（既存仕様）
        // ============================
        if (this.mage_equips) {
            for (const eq of Object.values(this.mage_equips)) {
                if (eq?.def_bonus) {
                    total += eq.def_bonus;
                }
            }
        }

        if (Array.isArray(this.defense_debuffs)) {
            for (const debuff of this.defense_debuffs) {
                total -= Number(debuff?.defDown ?? debuff?.power ?? 0);
            }
        }
        total += Number(this.getSummonerDefenseBonus?.() ?? 0);

        return total;
    }

    normalize_arrow_ammo(arrow, fallback = 1) {
        if (!arrow || typeof arrow !== "object") return 0;
        const raw = Number(arrow.arrows_remaining ?? arrow.arrow_count);
        const remaining = Number.isFinite(raw)
            ? Math.max(0, Math.floor(raw))
            : Math.max(0, Math.floor(Number(fallback ?? 1)));
        arrow.arrows_remaining = remaining;
        arrow.arrow_count = remaining;
        return remaining;
    }

    get_arrow_stack_key(arrow) {
        if (!arrow || typeof arrow !== "object") return "";
        return String(arrow.effect ?? arrow.arrow_effect ?? arrow.name ?? arrow.icon_src ?? "").trim().toLowerCase();
    }

    normalize_equipped_arrow_uniqueness() {
        if (!this.arrow || !this.arrow2) return;
        if (this.get_arrow_stack_key(this.arrow) !== this.get_arrow_stack_key(this.arrow2)) return;
        const total = this.normalize_arrow_ammo(this.arrow) + this.normalize_arrow_ammo(this.arrow2);
        this.arrow.arrows_remaining = total;
        this.arrow.arrow_count = total;
        this.arrow2 = null;
    }

    get_equipped_arrow_entries() {
        const entries = [];
        this.normalize_equipped_arrow_uniqueness();
        if (this.arrow) {
            if (this.normalize_arrow_ammo(this.arrow) > 0) {
                entries.push({ slot: "arrow", item: this.arrow });
            } else {
                this.arrow = null;
            }
        }
        if (this.arrow_slots >= 2 && this.arrow2) {
            if (this.normalize_arrow_ammo(this.arrow2) > 0) {
                entries.push({ slot: "arrow2", item: this.arrow2 });
            } else {
                this.arrow2 = null;
            }
        }
        return entries;
    }

    has_usable_arrow() {
        return this.get_equipped_arrow_entries().length > 0;
    }

    normalize_archer_extra_buffs() {
        const fromArray = Array.isArray(this.archer_buffs) ? this.archer_buffs : [];
        let buffs = fromArray
            .map(buff => ({
                rounds: Math.floor(Number(buff?.rounds ?? buff?.duration ?? 0)),
                extra: Math.max(0, Math.floor(Number(buff?.extra ?? buff?.power ?? 1))),
                source: buff?.source ?? "追撃強化",
            }))
            .filter(buff => buff.rounds > 0 && buff.extra > 0);

        if (
            !Array.isArray(this.archer_buffs) &&
            buffs.length === 0 &&
            this.archer_buff &&
            Number(this.archer_buff.rounds ?? 0) > 0
        ) {
            buffs = [{
                rounds: Math.floor(Number(this.archer_buff.rounds ?? 0)),
                extra: Math.max(1, Math.floor(Number(this.archer_buff.extra ?? 1))),
                source: this.archer_buff.source ?? "追撃強化",
            }];
        }

        this.archer_buffs = buffs;
        const totalExtra = buffs.reduce((sum, buff) => sum + Math.max(0, Number(buff.extra ?? 0)), 0);
        if (totalExtra > 0) {
            this.archer_buff = {
                rounds: Math.max(...buffs.map(buff => Number(buff.rounds ?? 0))),
                extra: totalExtra,
            };
        } else {
            this.archer_buff = null;
        }
        return buffs;
    }

    add_archer_extra_buff(extra = 1, rounds = 3, source = "追撃強化") {
        this.normalize_archer_extra_buffs();
        this.archer_buffs.push({
            rounds: Math.max(1, Math.floor(Number(rounds ?? 3))),
            extra: Math.max(1, Math.floor(Number(extra ?? 1))),
            source,
        });
        this.normalize_archer_extra_buffs();
    }

    get_archer_extra_attack_count() {
        return this.normalize_archer_extra_buffs()
            .reduce((sum, buff) => sum + Math.max(0, Number(buff.extra ?? 0)), 0);
    }

    tick_archer_extra_buffs() {
        const before = this.normalize_archer_extra_buffs().length;
        this.archer_buffs = this.archer_buffs
            .map(buff => ({ ...buff, rounds: Math.floor(Number(buff.rounds ?? 0)) - 1 }))
            .filter(buff => Number(buff.rounds ?? 0) > 0 && Number(buff.extra ?? 0) > 0);
        this.archer_buff = null;
        const after = this.normalize_archer_extra_buffs().length;
        return Math.max(0, before - after);
    }

    get_archer_extra_buffs() {
        return this.normalize_archer_extra_buffs().map(buff => ({ ...buff }));
    }


    async choose_and_use_skill(opponent, io) {

        // スキル封印中
        if (this.skill_sealed) {
            io.log("❌ スキルは封印されている…！");
            return false;
        }

        const all_skills = JOB_SKILLS[this.job];
        const available = all_skills.filter(s => this.level >= s.min_level);

        // 魔導士だけ魔力表示
        if (this.job === "魔導士") {
            io.log(`\n《 魔力：${this.mana}/${this.mana_max} 》`);
        }

        io.log("\n=== 使用可能スキル ===");
        available.forEach((s, i) => {
            const used = this.used_skill_set.has(s.type) ? "(使用済)" : "";
            io.log(`${i + 1}: ${s.name} ${used}`);
            io.log(`    ${s.description ?? ""}`);
        });
        io.log("0: キャンセル");

        let skill = null;

        while (true) {
            const c = (await io.input("スキル番号: ")).trim();
            if (c === "0") return false;

            const n = Number(c);
            if (!Number.isInteger(n) || n < 1 || n > available.length) {
                io.log("無効な番号です。");
                continue;
            }

            skill = available[n - 1];
            break;
        }

        const stype = skill.type;

        // 魔導士以外 → 同じスキルは1回限り
        if (this.job !== "魔導士" && this.used_skill_set.has(stype)) {
            io.log("❌ このスキルはバトル中1回だけです。");
            return false;
        }

        // 各職業スキルへ分岐
        if (stype.startsWith("mage_")) {
            return this._use_mage_skill(stype, opponent);
        }
        if (stype.startsWith("onmyoji_")) {
            return this._use_onmyoji_skill(stype, opponent);
        }
        if (stype.startsWith("warrior_")) {
            return this._use_warrior_skill(stype, opponent);
        }
        if (stype.startsWith("knight_")) {
            return this._use_knight_skill(stype, opponent);
        }
        if (stype.startsWith("priest_")) {
            return this._use_priest_skill(stype, opponent);
        }
        if (stype.startsWith("thief_")) {
            return this._use_thief_skill(stype, opponent);
        }
        if (stype.startsWith("alchemist_")) {
            return this._use_alchemist_skill(stype);
        }
        if (stype.startsWith("archer_")) {
            return this._use_archer_skill(stype, opponent);
        }
        if (stype.startsWith("doll_")) {
            return await this._use_doll_skill(stype, opponent, io);
        }
        if (stype.startsWith("mad_")) {
            return this._use_mad_skill(stype, opponent);
        }

        io.log("未実装のスキルタイプ");
        return false;
    }


    
// ---------------------------------------------------------
// 装備管理メニュー（通常装備 / 特殊装備）
// ---------------------------------------------------------
async manage_equipment(io) {
    while (true) {
        io.log("\n=== 装備管理 ===");
        io.log("1: 通常装備");
        io.log("2: 特殊装備（魔導士装備・矢）");
        io.log("0: 戻る");

        const cmd = (await io.input("番号入力: ")).trim();

        if (cmd === "0") return;
        if (cmd === "1") {
            await this.manage_normal_equipment(io);
        } else if (cmd === "2") {
            await this.manage_special_equipment(io);
        } else {
            io.log("無効な入力です。");
        }
    }
}
   
// ---------------------------------------------------------
// 通常装備の変更（Python版完全移植）
// ---------------------------------------------------------
async manage_normal_equipment(io) {

    if (!this.equipment_inventory || this.equipment_inventory.length === 0) {
        io.log("通常装備を所持していません。");
        return;
    }

    while (true) {
        io.log("\n--- 所持装備一覧 ---");

        this.equipment_inventory.forEach((eq, i) => {
            const star = eq.star ?? "?";
            io.log(
                `${i + 1}: ${eq.name} (★${star}) / 効果: ${eq.effect_text ?? ""} / 価格: ${eq.price ?? "-"}`
            );
        });

        const choice = (await io.input("\n装備したい番号を入力（戻る=空Enter）： ")).trim();
        if (choice === "") return;

        if (!/^\d+$/.test(choice)) {
            io.log("無効な入力です。");
            continue;
        }

        const idx = Number(choice) - 1;
        if (idx < 0 || idx >= this.equipment_inventory.length) {
            io.log("存在しない番号です。");
            continue;
        }

        const newEq = this.equipment_inventory.splice(idx, 1)[0];

        // 既存装備があるなら戻す
        if (this.equipment) {
            this.equipment_inventory.push(this.equipment);
            io.log(`${this.name} の既存装備 ${this.equipment.name} を所持に戻しました。`);
        }

        this.equipment = newEq;
        io.log(`${newEq.name} を装備しました！`);
        return;
    }
}
// ---------------------------------------------------------
// 特殊装備（魔導士装備・矢）
// ---------------------------------------------------------
async manage_special_equipment(io) {
  io.log("\n=== 特殊装備の変更 ===");

  const display = [];

  // ▼ 魔導士：専用装備（special_inventory 内の mage_equip）
  if (this.job === "魔導士") {
    for (const eq of this.special_inventory) {
      if (eq.equip_type === "mage_equip") {
        display.push({ type: "mage", item: eq });
      }
    }
  }

  // ▼ 弓兵：所持矢（arrow_inventory）
  if (this.job === "弓兵") {
    for (const ar of this.arrow_inventory) {
      display.push({ type: "arrow", item: ar });
    }
  }

  if (display.length === 0) {
    io.log("特殊装備を所持していません。");
    return;
  }

  // --- 一覧表示 ---
  io.log("\n--- 特殊装備一覧 ---");
  display.forEach((d, i) => {
    io.log(`${i + 1}. ${d.item.name}`);
  });

  const choice = (await io.input("\n番号を選択 (0で戻る): ")).trim();
  if (choice === "0") return;
  if (!/^\d+$/.test(choice)) return;

  const idx = Number(choice) - 1;
  if (idx < 0 || idx >= display.length) return;

  const { type, item } = display[idx];

// -------------------------------
// 魔導士装備の装着
// -------------------------------
if (type === "mage") {
    const slot = getMageSlot(item);
    const prev = this.mage_equips[slot];

    if (prev) {
        this.special_inventory.push(prev);
    }
    this.mage_equips[slot] = item;

    this.special_inventory = this.special_inventory.filter(e => e !== item);

    io.log(`🔮 ${item.name} を ${slot} に装備しました！`);

    // ★ 装備変更後のパッシブ即時反映
    this.recalc_mage_passives();

    return;
}


// ⚠ ローカル版専用（オンラインでは未使用）
// 弓兵：矢の装着（交換対応版）

if (type === "arrow") {

  // 現在のスロット状況
  const slot1 = this.arrow ? this.arrow.name : "なし";
  const slot2 = (this.arrow_slots >= 2 && this.arrow2) ? this.arrow2.name : "なし";

  // スロット選択
  io.log("\nどのスロットに装備しますか？");
  io.log(`1: slot1（${slot1}）`);
  if (this.arrow_slots >= 2) io.log(`2: slot2（${slot2}）`);
  io.log("0: キャンセル");

  const ans = (await io.input("番号入力: ")).trim();

  if (ans === "0") return;

  if (ans === "1") {
      // slot1 が埋まっていたら inventory に戻す
      if (this.arrow) this.arrow_inventory.push(this.arrow);

      this.arrow = item;
      io.log(`🏹 ${item.name} を slot1 に装備しました`);
  }
  else if (ans === "2" && this.arrow_slots >= 2) {
      if (this.arrow2) this.arrow_inventory.push(this.arrow2);

      this.arrow2 = item;
      io.log(`🏹 ${item.name} を slot2 に装備しました`);
  }
  else {
      io.log("無効な入力です。");
      return;
  }

  // inventory から削除
  this.arrow_inventory = this.arrow_inventory.filter(a => a !== item);
  return;
}

}





    // コイン系装備の毎ターンボーナス（Python: apply_equip_coin_bonus）
    apply_equip_coin_bonus() {
        if (this.equipment) {
            if (this.equipment.effect_type === "coin_per_turn") {
                this.coins += this.equipment.power ?? 0;
            }
            if (this.equipment.equip_type === "alchemist_unique") {
                this.coins += this.equipment.coin ?? 0;
            }
        }
    }
    // ---------------------------------------------------------
    // 魔導士専用装備：毎ターン効果発動
    // ---------------------------------------------------------
    apply_mage_equip_effects() {

        if (!this.mage_equips) return;

        for (const slot of Object.keys(this.mage_equips)) {
            const eq = this.mage_equips[slot];
            if (!eq) continue;

            // 魔力回復
            if (eq.mana_gain) {
                const before = this.mana;
                this.mana = Math.min(this.mana + eq.mana_gain, this.mana_max);
                console.log(`🔮 ${eq.name}: 魔力 ${before} → ${this.mana}`);
            }

            // コイン増加（杖）
            if (eq.coin_per_turn) {
                this.coins += eq.coin_per_turn;
                console.log(`💰 ${eq.name}: コイン +${eq.coin_per_turn}`);
            }

            // HP再生（指輪）
            if (eq.regen_hp) {
                const beforeHP = this.hp;
                this.restore_hp(eq.regen_hp);
                console.log(`❤️ ${eq.name}: HP ${beforeHP} → ${this.hp}`);
            }

       
            // ★ 防御力パッシブ（ローブ：装備中永続）
            if (eq.def_bonus) {
                this.equip_def_bonus += eq.def_bonus;
                console.log(`🛡 ${eq.name}: 防御 +${eq.def_bonus}（装備中永続）`);
            }


            // 魔法防御貫通（古代魔導書）
            if (eq.magic_pierce) {
                this.magic_pierce = true;
                console.log(`📘 ${eq.name}: 魔法攻撃が防御貫通！`);
            }
        }
    }
    // ---------------------------------------------------------
    // 魔導士装備のパッシブを即時再計算（装備変更時に使用）
    // ---------------------------------------------------------
    recalc_mage_passives() {
        let hasMagicPierce = false;

        // すべての魔導士装備スロットを確認
        for (const eq of Object.values(this.mage_equips)) {
            if (!eq) continue;
            if (eq.magic_pierce) {
                hasMagicPierce = true;
            }
        }

        // 即時反映
        this.magic_pierce = hasMagicPierce;
    }

    // ---------------------------------------------------------
    // 通常装備・錬金特殊装備・魔導士装備：コイン加算
    // ---------------------------------------------------------
    get_coin_bonus_per_round() {
        let total = 0;

        // ============================
        // 通常装備
        // ============================
        if (this.equipment?.effect_type === "coin_per_turn") {
            total += this.equipment.power ?? 0;
        }
        for (const eq of this.extra_equipments ?? []) {
            if (eq?.effect_type === "coin_per_turn") {
                total += eq.power ?? 0;
            }
        }

        // ============================
        // ★ 錬金術師 特殊装備（修正点）
        // ============================
        if (this.alchemist_equip) {
            total += this.alchemist_equip.coin ?? 0;
        }

        // ============================
        // 魔導士装備
        // ============================
        if (this.mage_equips) {
            for (const eq of Object.values(this.mage_equips)) {
                if (eq?.coin_per_turn) {
                    total += eq.coin_per_turn;
                }
            }
        }

        return total;
    }

    get_doll_charge_per_round() {
        if (!this.doll?.costumes) return 0;
        if (this.doll.is_broken) return 0;

        let total = 0;
        for (const c of Object.values(this.doll.costumes)) {
            if (!c) continue;
            if (c.effect_type !== "CHARGE" && c.effect_type !== "COIN") continue;

            let value = 1 + (c.star ?? 1);
            if (c.condition === "boroboro") {
                value = Math.floor(value * 0.5);
            }
            if (this.doll.is_rampage) {
                value *= 2;
            }
            total += value;
        }
        return total;
    }



  // ================================
  // ステータス表示（最新版）
  // ================================
    // ---------------------------------------------------------
    // 烏天狗の追撃（UI：turns管理／内部：別カウンタ triggers）
    // ---------------------------------------------------------
    trigger_karasu_tengu(opponent) {

        // 内部トリガーが存在しないなら発動なし
        if (!this.karasu_tengu_triggers || this.karasu_tengu_triggers <= 0) {
            return [];
        }

        const logs = [];

        // 1回分の追撃ダメージを実行
        const raw = Math.round(this.get_total_attack() * 0.5) + 5;
        const real = opponent.take_damage(raw);

        if (typeof real === "number" && Number.isFinite(real)) {
            logs.push(Math.max(0, real));
        }

        // 内部トリガー消費
        this.karasu_tengu_triggers--;

        // UI表示用の shikigami_effects も1ターン減らす必要があるので同期
        for (const eff of this.shikigami_effects) {
            if (eff.name === "烏天狗") {
                eff.rounds = Math.max(0, eff.rounds - 1);
            }
        }

        // 表示用turnsが0になった烏天狗は削除
        this.shikigami_effects = this.shikigami_effects.filter(e => e.rounds > 0);

        return logs;
    }




// ---------------------------------------------------------
    // ダメージ処理（修正版）
    // ---------------------------------------------------------
    take_damage(raw_attack, ignore_def = false, attacker = null, isExtraAttack = false, isReflection = false) {
        let final = 0;
        let targetType = "body"; // デフォルトは本体
        if (attacker?.has_dojo_pierce_weapon?.()) {
            ignore_def = true;
        }
        if (Number(this.dojo_invincible_rounds ?? 0) > 0) {
            log(`🛡 ${this.name} は無敵でダメージを受けない！`);
            return 0;
        }
        const specialDefense = Number(this.get_special_defense?.() ?? 0);

        // =========================================
        // 1. 人形使い：人形がダメージを肩代わり
        // =========================================
        if (this.job === "人形使い" && this.doll && !this.doll.is_broken) {
            targetType = "doll";

            // 人形の防御力で計算
            const dollDef = this.getDollDefense();
            final = ignore_def
                ? Math.max(0, raw_attack - specialDefense)
                : Math.max(0, raw_attack - dollDef - specialDefense);

            this.doll.durability = Math.max(0, this.doll.durability - final);
            log(`🪆 人形が ${final} ダメージを受けた！ 耐久: ${this.doll.durability}/${this.doll.max_durability}`);

            // --- 人形破壊判定 ---
            if (this.doll.durability <= 0) {
                const hpBeforeDollBreak = this.hp;
                this.doll.is_broken = true;
                this.doll.repair_kit_lock_rounds = 2;
                log(`💥 ${this.name} の人形が破壊された！`);

                // 暴走中のペナルティ
                if (this.doll.is_rampage) {
                    this.doll.is_rampage = false;
                    log("💥 暴走中の人形が破壊された！");
                    this.hp = Math.max(0, this.hp - 40);
                    log(`💀 ${this.name} は反動で 40 ダメージを受けた！`);
                    if (this.opponent) {
                        this.opponent.take_damage?.(20, true, this);
                        log(`🔥 ${this.opponent.name} は暴走の反動で 20 ダメージ！`);
                    }
                    this.hp = hpBeforeDollBreak;
                }

                // 衣装のボロボロ処理
                for (const key of Object.keys(this.doll.costumes)) {
                    const costume = this.doll.costumes[key];
                    if (!costume) continue;
                    if (costume.condition === "boroboro") {
                        this.doll.costumes[key] = null;
                    } else {
                        costume.condition = "boroboro";
                        this.updateCostumeDisplayName(costume);
                    }
                }
                this.hp = Math.max(0, hpBeforeDollBreak - 50);
                this.match?.sendDamageEvent?.(this, Math.max(0, hpBeforeDollBreak - this.hp), "normal", "body");
                this.doll.is_rampage = false;
                this.doll.repair_kit_lock_rounds = 0;
                this.doll.revive_guard_rounds = 0;
                this.doll.pending_revive = true;
                if (this.match?.current?.player === this) {
                    this.doll.is_broken = false;
                    this.doll.pending_revive = false;
                    this.doll.durability = Math.min(Number(this.doll.max_durability ?? 50), 50);
                }
            }

            // UI送信（人形象態）
            return final;
        }

        // =========================================
        // 2. 玄武バリア（人形がいない/壊れている場合のみ）
        // =========================================
        if (this.barrier > 0) {
            log(`🛡 ${this.name} は玄武バリアで攻撃を無効化！`);
            this.barrier -= 1;
            return 0;
        }

        if (this.doll) {
            return 0;
        }

        // =========================================
        // 3. 通常ダメージ処理（本体）
        // =========================================
        // 人形が壊れている場合はダメージ2倍
        let multiplier = (this.job === "人形使い" && this.doll && this.doll.is_broken) ? 2 : 1;
        let actual_attack = raw_attack * multiplier;

        final = ignore_def
            ? Math.max(0, actual_attack - specialDefense)
            : Math.max(0, actual_attack - this.get_total_defense() - specialDefense);

        if (this.job === "狂人" && this.madman_guts && this.hp - final <= 0) {
            this.madman_guts = false;
            this.madman_no_heal = true;
            final = Math.max(0, this.hp - 10);
            this.hp = 10;
            log(`💢 ${this.name} は我慢で踏みとどまった！ HP10で耐えた！`);

            if (this.match) {
                this.match.sendPopup(`💢 ${this.name} の我慢が発動！`, null, 1800);
            }

            if (!isExtraAttack) {
                this.damage_taken_last_turn = final;
                this.last_attacker = attacker;
            }

            if (this.job === "狂人") {
                this.total_damage_received += final;
            }

            if (this.match) {
                this.match.sendDamageEvent(this, final, "guts", "body");
            }

            return final;
        }

        this.hp = Math.max(0, this.hp - final);
        log(`${this.name} は ${final} ダメージを受けた！ 残りHP: ${this.hp}/${this.max_hp}`);

        if (
            final > 0 &&
            !isReflection &&
            attacker &&
            attacker !== this &&
            this.hasSummonerFafnirReflect?.()
        ) {
            const reflectRaw = Math.max(1, Math.floor(final * 0.5));
            const reflectedTargetType = this.match?.getDamageTargetType?.(attacker) ??
                (attacker?.doll && !attacker.doll.is_broken ? "doll" : "body");
            const reflected = attacker.take_damage?.(reflectRaw, true, this, true, true) ?? 0;
            log(`🐲 ファフニールが ${reflected} ダメージを反射した！`);
            if (this.match?.queueFafnirReflectEvent) {
                this.match.queueFafnirReflectEvent(this, attacker, reflected, reflectedTargetType);
            } else if (this.match) {
                this.match.sendSkillEffectEvent?.(attacker, "summoner_fafnir_target", reflectedTargetType);
                this.match.sendBattle?.(`ファフニールの反射！ ${attacker.name} に ${reflected} ダメージ！`);
                this.match.sendDamageEvent?.(attacker, reflected, "pursuit", reflectedTargetType, {
                    show_zero: true,
                    action_source: "summoner_fafnir_reflect",
                });
            }
        }

        // 被ダメ記録
        if (!isExtraAttack) {
            this.damage_taken_last_turn = final;
            this.last_attacker = attacker;
        }

        // ★狂人の累積ダメージ更新（ここが重要！）
        if (this.job === "狂人") {
            this.total_damage_received += final;
        }

        if (
            this.job === "狂人" &&
            (this.total_damage_received ?? 0) >= 120 &&
            this.hp > 0 &&
            !this.madman_no_heal
        ) {
            const rageHeal = Math.floor(final / 5);
            if (rageHeal > 0) {
                const healed = this.restore_hp(rageHeal);
                if (healed > 0) {
                    log(`😈 狂化回復！ HP +${healed}`);
                    if (this.match) {
                        this.match.sendHealEvent(this, healed);
                    }
                }
            }
        }

        // UI送信（本体形態）
        return final;
    }


    // ---------------------------------------------------------
    // 人形：最終攻撃力取得
    // ---------------------------------------------------------
    getDollAttack() {

        // 人形が存在しない or 壊れている → 本体攻撃
        if (!this.doll || this.doll.is_broken) {
            return this.base_attack;
        }

        let atk = this.doll.base_atk;
        let bonus = 0;

        for (const c of Object.values(this.doll.costumes)) {
            if (!c) continue;
            if (c.effect_type !== "ATK") continue;

            let value = 1 + c.star * 2;

            // ★ ぼろぼろ補正
            if (c.condition === "boroboro") {
                value = Math.floor(value * 0.5);
            }

            if (this.doll.is_rampage) {
                value *= 2;
            }

            bonus += value;
        }

        return atk + bonus;
    }



    // ---------------------------------------------------------
    // 人形：最終防御力取得
    // ---------------------------------------------------------
    getDollDefense() {
        

        if (!this.doll) return 0;

        // 人形が壊れている間は防御不可
        if (this.doll.is_broken) return 0;

        let def = this.doll.base_def;
        let bonus = 0;

        for (const c of Object.values(this.doll.costumes)) {
            if (!c) continue;
            if (c.effect_type !== "DEF") continue;

            let value = 1 + c.star * 2;

            // ぼろぼろ補正
            if (c.condition === "boroboro") {
                value = Math.floor(value * 0.5);
            }
            if (this.doll.is_rampage) {
                value *= 2;
            }

            bonus += value;
        }

        return def + bonus;
    }
    // ---------------------------------------------------------
    // 人形：耐久力リジェネ適用
    // ---------------------------------------------------------
    applyDollRegen() {

        if (!this.doll) return;
        if (this.doll.is_rampage) return;

        // 壊れている間は回復しない
        if (this.doll.is_broken) return;

        let regen = 0;

        for (const c of Object.values(this.doll.costumes)) {
            if (!c) continue;
            if (c.effect_type !== "DUR") continue;

            let value = 1 + c.star;

            if (c.condition === "boroboro") {
                value = Math.max(0, value - 1);
            }

            regen += value;
        }

        if (regen > 0) {
            this.doll.durability = Math.min(
                this.doll.max_durability,
                this.doll.durability + regen
            );
        }
    }

    // ============================
    // 衣装：効果量計算（共通）
    // ============================
    getCostumeEffectValue(costume) {
        if (!costume) return 0;

        let value = 0;

        switch (costume.effect_type) {
            case "ATK":
            case "DEF":
                value = 1 + costume.star * 2;
                break;
            case "COIN":
            case "CHARGE":
                value = 1 + costume.star;
                break;
            case "DUR":
                value = 1 + costume.star;
                break;
        }

        // ぼろぼろ補正
        if (costume.condition === "boroboro") {
            if (costume.effect_type === "DUR") {
                value = Math.max(0, value - 1);
            } else {
                value = Math.floor(value * 0.5);
            }
        }

        return value;
    }
    // ============================
    // 衣装：表示名＆説明生成
    // ============================
    updateCostumeDisplayName(costume) {
        if (!costume) return;

        const starText = `★${costume.star}`;

        const effectLabel = {
            ATK: "攻撃",
            DEF: "防御",
            DUR: "耐久",
            COIN: "チャージ",
            CHARGE: "チャージ"
        }[costume.effect_type];

        const partLabel = {
            head: "帽子",
            body: "服",
            leg: "ズボン",
            foot: "靴"
        }[costume.part];

        const conditionText =
            costume.condition === "boroboro" ? "ぼろぼろの" : "";

        const value = this.getCostumeEffectValue(costume);

        // ★ 表示名（効果量は入れない）
        costume.name =
            `${starText}${conditionText}${effectLabel}${partLabel}`;

        // ★ 説明文（ここに効果を書く）
        costume.effect_text =
            (costume.effect_type === "COIN" || costume.effect_type === "CHARGE")
                ? `毎ターンチャージ +${value}`
                : `人形の${effectLabel}力 +${value}`;
    }

    // ---------------------------------------------------------
    // アイテム使用（Python: apply_item）
    // ---------------------------------------------------------
    apply_item(item) {

        // ★ 装備はバフとして扱わない（effect_type が攻撃力/防御力でも）
        if (item.is_equip) {
            return;  // 装備効果は get_total_attack / defense が処理するためここでは何もしない
        }

        // effect_type の文字列補正（安全対策）
        if (item.effect_type === "ATK") item.effect_type = "攻撃力";
        if (item.effect_type === "DEF") item.effect_type = "防御力";
        if (item.effect_type === "HP_RECOVER") item.effect_type = "HP";
        const et = item.effect_type;

        const dojoNormalItemEffectBonus = Math.max(0, Number(this.dojoNormalItemEffectBonus ?? 0));
        const isDojoNormalItem =
            dojoNormalItemEffectBonus > 0 &&
            (et === "攻撃力" || et === "防御力" || et === "HP") &&
            !item.is_equip &&
            !item.is_arrow &&
            !item.equip_type &&
            !item.is_mage_item &&
            !item.is_onmyoji_item &&
            !item.is_doll_item &&
            !item.is_doll_costume &&
            !item.is_mad_special_item &&
            !item.is_priest_item &&
            !item.is_dojo_special_item;
        if (isDojoNormalItem) {
            const basePower = Number(item._dojo_base_power ?? item.power ?? 0);
            if (Number.isFinite(basePower)) {
                item = {
                    ...item,
                    power: basePower + dojoNormalItemEffectBonus,
                    _dojo_base_power: basePower,
                    dojo_item_effect_bonus: dojoNormalItemEffectBonus,
                };
            }
        }

        if (item.is_onmyoji_item) {
            if (this.job !== "陰陽師" || !this.opponent) {
                return false;
            }

            this.last_summoned_shikigami = [item.shikigami_name];
            this._summon_shikigami(item.shikigami_name, this.opponent);
            this.used_items_this_round += 1;
            return true;
        }
        
        // ★ 魔導士専用：魔力水
        if (item.is_mage_item) {

            // 安全対策
            if (this.job !== "魔導士") {
                return false;
            }

            if (this.mana == null) this.mana = 0;
            if (this.mana_max == null) this.mana_max = 0;

            const before = this.mana;
            this.mana = Math.min(this.mana_max, this.mana + item.power);

            return true; // ★ ログは出さない
        }

        if (item.is_mad_special_item && this.job === "狂人") {
            const selfDamage = Number(item.self_damage ?? item.power ?? 0);
            const selfHeal = Number(item.self_heal ?? item.heal ?? item.power ?? 0);

            const beforeHp = this.hp;
            this.take_damage(selfDamage, true);
            const damaged = Math.max(0, beforeHp - this.hp);
            this.last_item_self_damage = damaged;

            const healed = this.restore_hp(selfHeal);
            this.last_item_self_heal = healed;
            this.used_items_this_round += 1;
            return true;
        }

        if (item.is_dojo_special_item) {
            if (item.dojo_special_item_effect === "invincible") {
                const rounds = Math.max(1, Number(item.rounds ?? 2));
                this.dojo_invincible_rounds = Math.max(Number(this.dojo_invincible_rounds ?? 0), rounds);
                this.last_item_message = `${rounds}Tの間、無敵状態になった！`;
                this.used_items_this_round += 1;
                return true;
            }

            if (item.dojo_special_item_effect === "attack_growth") {
                this.dojo_attack_growth_active = true;
                this.dojo_attack_growth_per_round = Math.max(1, Number(item.power ?? 2));
                this.last_item_message = `ステージクリアまで、毎ターン攻撃力+${this.dojo_attack_growth_per_round}`;
                this.used_items_this_round += 1;
                return true;
            }
        }


    // =========================================
    // 人形使い：修理キット
    // =========================================
    if (item.is_doll_item && this.job === "人形使い") {

        if (!this.doll) {
            return false;
        }

        const repairResult = this.useDollRepairKit();
        if (!repairResult?.ok) {
            return false;
        }
        this.last_doll_repair_result = repairResult;
        return true;
    }



        // HP回復
        if (et === "HP") {
            const heal_bonus = this.job_data ? this.job_data.heal_bonus : 0;
            const heal = item.power + heal_bonus;
            this.restore_hp(heal);
            this.used_items_this_round += 1;
            return;
        }


        // バフ（攻撃力 / 防御力）
        let duration = item.duration;
        const power = item.power;

        if (et === "防御力" && duration > 0) {
            // 仕様：防御バフは+1T
            duration += 1;
        }

        // バフ効果（攻撃力 / 防御力）
        if (et === "攻撃力" || et === "防御力") {

            // ★ 統合しない：常に「別バフ」として追加（turns 個別管理）
            this.active_buffs.push({
                type: et,
                power,
                rounds: duration,
                source: item.name ?? et,          // 表示用（任意）
                uid: crypto.randomUUID(),         // ★ 同一アイテムでも別扱いにする
            });

            log(`${this.name} の ${et} が +${power}（${duration}T）`);
            this.used_items_this_round += 1;
            return;
        }



        log(`${this.name} に ${et}+${power}（${duration}T）`);
        this.used_items_this_round += 1;
    }

    can_use_item() {
        return this.used_items_this_round < 2;
    }

    reset_used_items_counter() {
        this.used_items_this_round = 0;
    }
    
    // ---------------------------------------------------------
    // 現在の全バフ・デバフ一覧を文字列配列で返す（duration 完全統一版）
    // ---------------------------------------------------------
    getBuffDescriptionList() {
        const list = [];

        // ★ active_buffs の処理（攻撃力 / 防御力 / 低下）
        if (Array.isArray(this.active_buffs)) {
            this.active_buffs.forEach(b => {
                if (b.permanent) {
                    if (b.type === "攻撃力") {
                        list.push(`攻撃 +${b.power}`);
                    } else if (b.type === "防御力") {
                        list.push(`防御 +${b.power}`);
                    } else if (b.type === "攻撃力低下") {
                        list.push(`攻撃 -${b.power}`);
                    } else if (b.type === "防御力低下") {
                        list.push(`防御 -${b.power}`);
                    }
                    return;
                }
                const dur = b.duration ?? b.rounds ?? 0;

                if (b.type === "攻撃力") {
                    list.push(`攻撃 +${b.power}（あと${dur}T）`);
                } else if (b.type === "防御力") {
                    list.push(`防御 +${b.power}（あと${dur}T）`);
                } else if (b.type === "攻撃力低下") {
                    list.push(`攻撃 -${b.power}（あと${dur}T）`);
                } else if (b.type === "防御力低下") {
                    list.push(`防御 -${b.power}（あと${dur}T）`);
                }
            });
        }

        if (this.job === "狂人" && (this.total_damage_received ?? 0) >= 120) {
            list.push("狂化：被ダメージ後にその 1/5 回復");
        }

        if (this.job === "狂人" && this.madman_rage_active) {
            list.push(`破滅の微笑：累積被ダメージの 1/20 だけ攻撃 +${Math.floor((this.total_damage_received ?? 0) / 20)}`);
        }

        if (this.job === "狂人" && this.madman_guts) {
            list.push("我慢：致死ダメージを1回だけHP10で耐える");
        }

        // ★ 凍結デバフ（freeze_debuffs）
        if (Array.isArray(this.freeze_debuffs)) {
            this.freeze_debuffs.forEach(f => {
                list.push(`凍結：攻撃 -${f.atkDown}（あと${f.rounds ?? f.duration ?? 0}T）`);
            });
        }

        if (Array.isArray(this.dot_effects)) {
            this.dot_effects.forEach(d => {
                if (!d) return;
                const turns = d.rounds ?? d.turns ?? d.duration ?? 0;
                list.push(`${d.name ?? "継続ダメージ"}：${d.power ?? 0}ダメージ（あと${turns}T）`);
            });
        }

        if (this.job === "召喚士" && this.isSummonerResonanceActive?.()) {
            const turns = Math.max(0, Number(this.summoner?.resonance_turns ?? 0));
            const frontType = String(this.getSummonerFrontType?.() ?? "");
            const describeFrontEffect = (dragon) => {
                if (!dragon || dragon.stage === "egg") return "";
                const stageLabel = dragon.stage === "adult" ? "成体" : "幼体";
                if (dragon.type === "tiamat") {
                    const damage = dragon.stage === "adult" ? 20 : 10;
                    return `${stageLabel}前衛：行動後、防御無視${damage}ダメージ`;
                }
                if (dragon.type === "nidhogg") {
                    return dragon.stage === "adult"
                        ? `${stageLabel}前衛：行動後、3T攻撃-2と3T毒3`
                        : `${stageLabel}前衛：行動後、2T毒2`;
                }
                if (dragon.type === "fafnir") {
                    return dragon.stage === "adult"
                        ? `${stageLabel}前衛：特殊防御+5 / 被ダメージ50%反射`
                        : `${stageLabel}前衛：防御+5`;
                }
                return "";
            };
            for (const dragon of this.getSummonerDragons?.() ?? []) {
                if (!dragon || dragon.stage === "egg" || String(dragon.type ?? "") === frontType) continue;
                const effectText = describeFrontEffect(dragon);
                if (!effectText) continue;
                const name = dragon.name ?? SUMMONER_DRAGON_DATA?.[dragon.type]?.name ?? "竜";
                list.push(`竜脈解放：${name}も前衛効果（${effectText} / あと${turns}T）`);
            }
        }

        return list;
    }
    // ---------------------------------------------------------
    // 陰陽師：召喚中の式神一覧を返す
    // ---------------------------------------------------------
    getShikigamiList() {
            if (
                (!this.shikigami_effects || this.shikigami_effects.length === 0) &&
                !(this.dot_effects || []).some(d => d?.name === "鬼火")
            ) {
                return [];
            }

            const list = [];

            for (const s of this.shikigami_effects) {

                // ★ T消費（鬼火・毒など）
                const remainT = (s.turns !== undefined) ? s.turns : null;

            // ★ T消費（猫又・玄武・烏天狗など）
                const remainR = (s.rounds !== undefined) ? s.rounds : null;

                let display = 0;
                let unit = "";

                if (remainT !== null) {
                    display = remainT;
                    unit = "T";
                } else if (remainR !== null) {
                    display = remainR;
                    unit = "T";
                } else {
                    // 万が一どちらもない場合 → 0T扱い
                    display = 0;
                    unit = "T";
                }

                // ★ 修正点：s.name を使う
                list.push(`${s.name}（残り ${display}${unit}）`);
            }

            for (const dot of (this.dot_effects ?? [])) {
                if (dot?.name !== "鬼火") continue;
                const remainT = Number(dot.turns ?? dot.rounds ?? 0);
                list.push(`鬼火（残り ${remainT}T）`);
            }

            return list;
    }


    decrease_buffs_start_of_round() {
        const next = [];

        for (const b of this.active_buffs) {
            if (b.permanent) {
                next.push({ ...b });
                continue;
            }
            const isTurnEndDebuff =
                b.type === "攻撃力低下" ||
                b.type === "防御力低下" ||
                b.type === "スキル封印" ||
                b.is_debuff === true ||
                b.debuff === true;
            if (isTurnEndDebuff) {
                next.push({ ...b });
                continue;
            }
            const dur = b.duration ?? b.rounds ?? 0;
            const newDur = dur - 1;

            if (newDur > 0) {
                next.push({
                    ...b,
                    duration: newDur,
                    rounds: newDur
                });
            }
        }

        this.active_buffs = next;

        // ★スキル封印の自動解除
        if (!this.active_buffs.some(b => b.type === "スキル封印")) {
            this.skill_sealed = false;
        }
    }



    // ---------------------------------------------------------
    // 毎ターン終了：式神の残りターンを減らす
    // ---------------------------------------------------------
    decrease_shikigami_end_of_round() {

        const next = [];

        for (const s of this.shikigami_effects) {

            // ★ 烏天狗は「ターン」ではなく「残り追撃数」
            if (s.triggers !== undefined) {
                // triggers はターンごとに減らさないのでそのまま残す
                next.push(s);
                continue;
            }

            // ★ 玄武・猫又・カラス天狗など「ターンを持つ式神」
            if (s.rounds !== undefined) {
                const newTurn = s.rounds - 1;

                if (newTurn > 0) {
                    next.push({
                        ...s,
                        rounds: newTurn
                    });
                }

                // newTurn == 0 → 自然消滅
                continue;
            }

            // その他はそのまま残す
            next.push(s);
        }

        this.shikigami_effects = next;
    }

    // ---------------------------------------------------------
    // 猫又などのスキル封印ターンを減らす
    // ---------------------------------------------------------
    decrease_skill_seal() {
        if (this.skill_sealed_rounds > 0) {
            this.skill_sealed_rounds -= 1;

            if (this.skill_sealed_rounds <= 0) {
                this.skill_sealed = false;
            }
        }
    }


    // ---------------------------------------------------------
    // デバフ解除（Python: remove_debuffs）
    // ---------------------------------------------------------
    remove_debuffs() {
        const before = this.active_buffs.length;
        this.active_buffs = this.active_buffs.filter(
            b =>
                b?.unremovable ||
                b?.passive ||
                b.type !== "攻撃力低下" &&
                b.type !== "防御力低下" &&
                b.type !== "スキル封印"
        );

        const freezeRemoved = Array.isArray(this.freeze_debuffs) ? this.freeze_debuffs.length : 0;
        this.freeze_debuffs = [];

        const removed = before - this.active_buffs.length + freezeRemoved;
        if (removed > 0) {
            log(`🔔 デバフを ${removed} 個解除した。`);
        }
    }

    is_negative_buff(buff) {
        const type = String(buff?.type ?? "");
        return (
            buff?.is_debuff === true ||
            buff?.debuff === true ||
            type === "攻撃力低下" ||
            type === "防御力低下" ||
            type === "スキル封印"
        );
    }

    remove_dispellable_buffs() {
        const before = Array.isArray(this.active_buffs) ? this.active_buffs.length : 0;
        this.active_buffs = (this.active_buffs ?? []).filter(
            b => b?.unremovable || b?.passive || this.is_negative_buff(b)
        );
        return before - this.active_buffs.length;
    }

        can_level_up() {
            // 上限Lv3
            if (this.level >= 3) return false;

            const need = this.levelup_costs[this.level];
            return this.coins >= need;
        }



    // ---------------------------------------------------------
    // レベルアップ（Python: try_level_up）
    // ※ JS版では「確認入力」は呼び出し側でやる想定
    // ---------------------------------------------------------
    try_level_up_auto() {
        // 上限
        if (this.level >= 3) return false;

        const req = LEVEL_REQUIREMENTS[this.level];  // 必要EXP
        if (req == null) return false;

        // EXP が足りる → 自動レベルアップ
        if (this.exp >= req) {
            this.exp -= req;
            this.level += 1;

            const inc = LEVEL_ATTACK_INCREASE[this.level] ?? 0;
            if (inc > 0) this.base_attack += inc;

            // ★ログは server.js で送る
            return { auto: true, inc };  // 情報返す
        }

        // EXP不足 → コイン補填の可能性確認
        const shortage = req - this.exp;

        if (this.coins >= shortage) {
            // 自動では補填しない（ローカル版と同じ）
            return { auto: false, canPay: true, shortage };
        }

        return { auto: false, canPay: false };
    }

    
    try_level_up_with_coins() {
        if (this.level >= 3) return { success: false, reason: "max" };

        const req = LEVEL_REQUIREMENTS[this.level];
        const shortage = req - this.exp;

        if (shortage <= 0) {
            return { success: false, reason: "expEnough" };
        }

        if (this.coins < shortage) {
            return { success: false, reason: "noCoins" };
        }

        // コイン補填
        this.coins -= shortage;

        // レベルアップ
        this.exp = 0;
        this.level += 1;

        const inc = LEVEL_ATTACK_INCREASE[this.level] ?? 0;
        if (inc > 0) this.base_attack += inc;

        // ログは server 側で作る
        return { success: true, inc };
    }





    // ---------------------------------------------------------
    // ここから下に、次のステップで
    // ・職業別スキル
    // ・盗賊の奪う処理
    // ・陰陽師の式神
    // ・錬金術師の合成
    // ・烏天狗追撃
    // などを Python からそのまま移植していく
    // ---------------------------------------------------------

    // ---------------------------------------------------------
    // 戦士スキル（Python版完全移植）
    // ---------------------------------------------------------
    get_dojo_skill_damage_bonus() {
        const nodes = new Set((this.dojoTrailNodes || []).map(Number));
        let bonus = 0;
        for (const id of [51, 52, 53, 54]) if (nodes.has(id)) bonus += 5;
        for (const id of [56, 57, 58, 59]) if (nodes.has(id)) bonus += 10;
        return bonus;
    }

    count_attack_up_buff_types() {
        const buffs = Array.isArray(this.active_buffs) ? this.active_buffs : [];
        const keys = new Set();
        for (const buff of buffs) {
            if (String(buff?.type ?? "") !== "攻撃力") continue;
            if (Number(buff?.power ?? 0) <= 0) continue;
            keys.add(String(buff?.source ?? buff?.name ?? buff?.power ?? "攻撃力"));
        }
        return keys.size;
    }

    _use_warrior_skill(stype, opponent) {

        // スキル封印
        if (this.skill_sealed) {
            log(`${this.name} はスキル封印されている！`);
            return false;
        }

        // ---------- スキル1：パワースラッシュ ----------
        if (stype === "warrior_1") {
            const dmg = 20 + this.get_dojo_skill_damage_bonus();
            log(`💥 パワースラッシュ！ 防御無視 ${dmg} ダメージ！`);
            opponent.take_damage(dmg, true);
            this.used_skill_set.add(stype);
            return true;
        }

        // ---------- スキル2：ブレイブチャージ ----------
        if (stype === "warrior_2") {
            const dmg = 30 + this.get_dojo_skill_damage_bonus();
            log(`🔥 ブレイブチャージ！ 防御無視 ${dmg} ダメージ！`);
            opponent.take_damage(dmg, true);

            // 攻撃バフ（power=3, turns=3）
            this.active_buffs.push({
                type: "攻撃力",
                power: 3,
                rounds: 3,
                source: "ブレイブチャージ",
            });

            this.used_skill_set.add(stype);
            return true;
        }

        // ---------- スキル3：ラストブレード ----------
        if (stype === "warrior_3") {

            const base = 10;
            const extra = this.get_total_attack();  // ← これで正しい攻撃力が取れる
            const total = base + extra + this.get_dojo_skill_damage_bonus();

            log(`⚔️ ラストブレード！ 防御無視 ${total} ダメージ！`);
            opponent.take_damage(total, true);

            this.used_skill_set.add(stype);
            return true;
}

        // ---------- スキル4：剛勇覚醒 ----------
        if (stype === "warrior_4") {
            this.active_buffs.push({
                type: "攻撃力",
                power: 20,
                rounds: 5,
                source: "剛勇覚醒",
            });

            const total = this.get_total_attack() + this.get_dojo_skill_damage_bonus();
            log(`🔥 剛勇覚醒！ 攻撃力+20（5T）後、${total} ダメージ！`);
            opponent.take_damage(total, false, this);

            this.used_skill_set.add(stype);
            return true;
        }

        // ---------- スキル5：覇断一閃 ----------
        if (stype === "warrior_5") {
            const buffBonus = this.count_attack_up_buff_types() * 10;
            const total = this.get_total_attack() + this.get_dojo_skill_damage_bonus() + buffBonus;
            log(`⚔️ 覇断一閃！ 防御無視 ${total} ダメージ！（攻撃力アップ種類ボーナス +${buffBonus}）`);
            opponent.take_damage(total, true, this);

            this.used_skill_set.add(stype);
            return true;
        }


        log("未対応の戦士スキル:", stype);
        return false;
    }

    // ---------------------------------------------------------
    // 騎士スキル（Python版完全移植）
    // ---------------------------------------------------------
    _use_knight_skill(stype, opponent) {

        if (this.skill_sealed) {
            log(`${this.name} はスキル封印されている！`);
            return false;
        }

        // ---------- スキル1 ----------
        if (stype === "knight_1") {
            opponent.take_damage(20, false);

            // 防御バフ power=2, turns=4
            this.active_buffs.push({
                type: "防御力",
                power: 2,
                rounds: 4,
            });

            this.used_skill_set.add(stype);
            return true;
        }

        // ---------- スキル2 ----------
        if (stype === "knight_2") {
            const total = 15 + this.get_total_defense();
            opponent.take_damage(total, false);

            this.active_buffs.push({
                type: "防御力",
                power: 4,
                rounds: 3,
            });

            this.used_skill_set.add(stype);
            return true;
        }

        // ---------- スキル3 ----------
        if (stype === "knight_3") {
            const total = 25 + this.get_total_defense();
            opponent.take_damage(total, false);

            this.used_skill_set.add(stype);
            return true;
        }

        log("未対応の騎士スキル:", stype);
        return false;
    }
    // ---------------------------------------------------------
    // 僧侶スキル（Python版完全移植）
    // ---------------------------------------------------------
    _use_priest_skill(stype, opponent) {

        if (this.skill_sealed) {
            log(`${this.name} はスキル封印されている！`);
            return false;
        }

        if (stype === "priest_1") {
            this.active_buffs.push({
                type: "継続回復",
                power: 2,
                rounds: 10,
                source: "祝福",
                uid: crypto.randomUUID(),
            });
            this.blessing_count = Number(this.blessing_count ?? 0) + 1;
            log("✨ 継続回復！ 10Tの間、毎ターンHPを2回復する！");
            this.used_skill_set.add(stype);
            return true;
        }

        if (stype === "priest_2") {
            this.remove_negative_buffs();
            this.dot_effects = [];
            this.active_buffs.push({
                type: "継続回復",
                power: 2,
                rounds: 12,
                source: "祝福",
                uid: crypto.randomUUID(),
            });
            this.blessing_count = Number(this.blessing_count ?? 0) + 1;
            log("✨ デバフ解除＋継続回復！ 12Tの間、毎ターンHPを2回復する！");

            this.used_skill_set.add(stype);
            return true;
        }

        if (stype === "priest_3") {
            if (!opponent) return false;
            const blessing = Number(this.blessing_count ?? 0);
            const dmg = Math.max(0, Math.floor(Number(this.hp ?? 0) / 10) + blessing);
            this.blessing_count = 0;
            opponent.take_damage(dmg, true, this);
            log(`✨ ホーリースマイト！ 祝福を全消費して ${dmg}ダメージ！（消費祝福 ${blessing}）`);

            this.used_skill_set.add(stype);
            return true;
        }

        return false;
    }

    // ---------------------------------------------------------
    // デバフ解除（Python版 _remove_negative_buffs）
    // ---------------------------------------------------------
    remove_negative_buffs() {
        const negative_types = ["スキル封印", "攻撃力低下", "防御力低下"];

        const before = this.active_buffs.length;
        this.active_buffs = this.active_buffs.filter(
            b => b?.unremovable || b?.passive || !negative_types.includes(b.type)
        );
        const freezeRemoved = Array.isArray(this.freeze_debuffs) ? this.freeze_debuffs.length : 0;
        const defenseRemoved = Array.isArray(this.defense_debuffs) ? this.defense_debuffs.length : 0;
        this.freeze_debuffs = [];
        this.defense_debuffs = [];
        const after = this.active_buffs.length;

        if (before !== after || freezeRemoved > 0 || defenseRemoved > 0) {
            log("✨ デバフを解除した！");
        }
    }

    // ---------------------------------------------------------
    // 盗賊スキル（Python版完全移植）
    // ---------------------------------------------------------
    _use_thief_skill(stype, opponent) {

        if (this.skill_sealed) {
            log(`${this.name} はスキル封印されている！`);
            return false;
        }

        // ---------- スキル1：25ダメージ + 盗む ----------
        if (stype === "thief_1") {
            opponent.take_damage(25, false);
            this._thief_steal(opponent);
            this.used_skill_set.add(stype);
            return true;
        }

        // ---------- スキル2：25 + 所持アイテム数×2 ダメージ + 盗む ----------
        if (stype === "thief_2") {
            const dmg = 25 + this.items.length * 2;
            opponent.take_damage(dmg, false);
            this._thief_steal(opponent);
            this.used_skill_set.add(stype);
            return true;
        }

        // ---------- スキル3：所持アイテム全部無料発動 ----------
        if (stype === "thief_3") {
            log("🗡 シャドウバースト！ 所持アイテムを全て発動！（消費なし）");

            for (const it of this.items) {
                const fake = { ...it }; // 元を消費しないためコピー
                this.apply_item(fake);
                this.used_items_this_round -= 1; // 使用回数を戻す（無料扱い）
            }

            if (opponent && opponent.hp > 0) {
                const damage = this.getActualAttack ? this.getActualAttack() : this.get_total_attack();
                const dealt = opponent.take_damage(damage, false, this);
                log(`🗡 シャドウバーストの追撃！ 通常攻撃で ${dealt} ダメージ！`);
            }

            this.used_skill_set.add(stype);
            return true;
        }

        log("未対応の盗賊スキル:", stype);
        return false;
    }
    // ---------------------------------------------------------
    // 盗賊：奪う処理（Python版完全移植）
    // ---------------------------------------------------------
    _thief_steal(opponent) {

        this.last_thief_steal_result = null;
        let candidates = [];

        // --- 相手アイテムから盗めるものを探す ---
        opponent.items.forEach((it, idx) => {
            if (!isThiefStealableItem(it)) return;
            candidates.push({ origin: "items", index: idx, obj: it });
        });

        // --- 相手の通常装備インベントリ（複数） ---
        opponent.equipment_inventory.forEach((eq, idx) => {
            if (!isThiefStealableItem(eq)) return;

            candidates.push({ origin: "equip_inv", index: idx, obj: eq });
        });

        // --- 奪えるものがあればランダムに選択 ---
        if (candidates.length > 0) {
            const pick = candidates[Math.floor(Math.random() * candidates.length)];

            if (pick.origin === "items") {
                const stolen = opponent.items.splice(pick.index, 1)[0];
                this.items.push(stolen);
                this.last_thief_steal_result = {
                    success: true,
                    source: "opponent",
                    sourceName: opponent?.name ?? "相手",
                    itemName: stolen?.name ?? "アイテム",
                    itemKind: "アイテム"
                };
                log(`💰 ${this.name} は ${opponent.name} からアイテム『${stolen.name}』を奪った！`);
                return true;
            } else {
                const stolen = opponent.equipment_inventory.splice(pick.index, 1)[0];
                this.equipment_inventory.push(stolen);
                this.last_thief_steal_result = {
                    success: true,
                    source: "opponent",
                    sourceName: opponent?.name ?? "相手",
                    itemName: stolen?.name ?? "装備",
                    itemKind: "装備"
                };
                log(`💰 ${this.name} は ${opponent.name} から装備『${stolen.name}』を奪った！`);
                return true;
            }
        }

        // --- 奪えるものが無い → ショップから盗む ---
        // ★ オンライン版 this.shop_items / オフライン this.shop のどちらかだけ使う

        let shopArr = null;

        // まずオンラインショップを優先
        if (Array.isArray(this.shop_items) && this.shop_items.length > 0) {
            shopArr = this.shop_items;
        }
        // オフライン用（オンラインでは基本未使用）
        else if (Array.isArray(this.shop) && this.shop.length > 0) {
            shopArr = this.shop;
        }

        // どちらにも盗めるものがない
        if (!shopArr) {
            log("奪えるものが何もなかった…");
            this.last_thief_steal_result = { success: false };
            return false;
        }

        const shopCandidates = shopArr.filter(isThiefStealableItem);
        if (shopCandidates.length === 0) {
            log("奪えるものが何もなかった…");
            this.last_thief_steal_result = { success: false };
            return false;
        }

        // ランダム盗み
        const stolen = shopCandidates[Math.floor(Math.random() * shopCandidates.length)];

        // 配列から削除
        if (shopArr === this.shop_items) {
            this.shop_items = this.shop_items.filter(s => s !== stolen);
        } else {
            this.shop = this.shop.filter(s => s !== stolen);
        }

        // UID付与
        if (!stolen.uid) stolen.uid = crypto.randomUUID();

        // 装備かアイテムか振り分け
        if (stolen.is_equip || stolen.equip_type === "normal") {
            this.equipment_inventory.push(stolen);
            this.last_thief_steal_result = {
                success: true,
                source: "shop",
                sourceName: "ショップ",
                itemName: stolen?.name ?? "装備",
                itemKind: "装備"
            };
            log(`🛒 ショップから装備『${stolen.name}』を盗んだ！`);
        } else {
            this.items.push(stolen);
            this.last_thief_steal_result = {
                success: true,
                source: "shop",
                sourceName: "ショップ",
                itemName: stolen?.name ?? "アイテム",
                itemKind: "アイテム"
            };
            log(`🛒 ショップからアイテム『${stolen.name}』を盗んだ！`);
        }

        return true;


    }
    // ---------------------------------------------------------
    // 魔導士スキル（Python版完全移植）
    // ---------------------------------------------------------
    _use_mage_skill(stype, opponent) {

        if (this.skill_sealed) {
            log(`${this.name} はスキル封印されている！`);
            return false;
        }

        // ---------- スキル1：魔力チャージ（1回のみ） ----------
        if (stype === "mage_1") {

            if (this.used_skill_set.has(stype)) {
                log("❌ このスキルはすでに使った。");
                return false;
            }

            const before = this.mana;
            this.mana = Math.min(this.mana + 20, this.mana_max);

            log(`🔮 魔力チャージ！ ${before} → ${this.mana}`);

            this.used_skill_set.add(stype);
            return true;
        }

        // ---------- スキル2：エレメントバースト ----------
        if (stype === "mage_2") {

            if (this.mana < 30) {
                log("❌ 魔力が足りない！（必要30）");
                return false;
            }

            this.mana -= 30;
            const dmg = 30;

            log(`🔥 エレメントバースト！ 魔力-30 → ${this.mana}`);

            // 魔導書装備で防御貫通 (= magic_pierce == true)
            opponent.take_damage(dmg, this.magic_pierce);
            return true;
        }

        // ---------- スキル3：メテオインパクト ----------
        if (stype === "mage_3") {

            if (this.mana < 60) {
                log("❌ 魔力が足りない！（必要60）");
                return false;
            }

            const consumed = this.mana;
            this.mana = 0;

            // ダメージ = 消費魔力 - 30（最低0）
            const dmg = Math.max(consumed - 30, 0);

            log(`🌋 メテオインパクト！！ 消費:${consumed} → ダメージ:${dmg}`);

            opponent.take_damage(dmg, this.magic_pierce);
            return true;
        }

        log("未定義の魔導士スキルタイプ");
        return false;
    }
    _use_onmyoji_skill(stype, opponent) {
    const pool_lv1 = ["鬼火", "猫又", "玄武", "烏天狗"];
    const pool_all = ["鬼火", "猫又", "玄武", "烏天狗", "九尾", "白龍"];
    this.last_summoned_shikigami = [];

    if (stype === "onmyoji_1") {
        const chosen = pool_lv1[Math.floor(Math.random() * pool_lv1.length)];
        log("📜 式神召喚・初級！");
        this._summon_shikigami(chosen, opponent);
        this.last_summoned_shikigami.push(chosen);
    }

    else if (stype === "onmyoji_2") {
        const chosen = pool_all[Math.floor(Math.random() * pool_all.length)];
        log("📜 式神召喚・上級！");
        this._summon_shikigami(chosen, opponent);
        this.last_summoned_shikigami.push(chosen);
    }

    else if (stype === "onmyoji_3") {
        const c1 = pool_all[Math.floor(Math.random() * pool_all.length)];
        const pool2 = pool_all.filter(x => x !== c1);
        const c2 = pool2[Math.floor(Math.random() * pool2.length)];

        log("🌌 二重召喚！！");
        this._summon_shikigami(c1, opponent);
        this._summon_shikigami(c2, opponent);
        this.last_summoned_shikigami.push(c1, c2);
    }

    this.used_skill_set.add(stype);
    return true;
}

    // ---------------------------------------------------------
    // 式神召喚（Python版完全移植）
    // ---------------------------------------------------------
    _summon_shikigami(name, opponent) {

        // 念のため配列がなければ初期化
        if (!this.shikigami_effects) {
            this.shikigami_effects = [];
        }

        const targetName = opponent?.name ?? "相手";
        const selfName = this.name ?? "自分";

        // ===== 鬼火（各ターン終了時 5 ダメ × 3T）=====
        if (name === "鬼火") {
            log(`🕯 式神「鬼火」を召喚！ ${targetName}に鬼火を付与：お互いのターン終了時に5ダメージ（3T）`);

            opponent.dot_effects.push({
                name: "鬼火",
                power: 5,
                turns: 3,
                rounds: 3,
                source: this.name,
            });

            // ★ 鬼火は shikigami_effects に入れない（重要）
            return;
        }


        // ===== 猫又（スキル封印 3T）=====
        if (name === "猫又") {
            log(`🐈‍⬛ 式神「猫又」を召喚！ ${targetName}にスキル封印を付与（3T）`);

            opponent.active_buffs.push({
                type: "スキル封印",
                power: 0,
                duration: 3,
                rounds: 3,
                source: "猫又",
                is_debuff: true,
            });

            opponent.skill_sealed = true;


            // ★ UI 用：式神一覧に登録
            this.shikigami_effects.push({
                name: "猫又",
                rounds: 3+1
            });

            return;
        }






        // ===== 玄武（防御+5 3T＋バリア1回）=====
        if (name === "玄武") {
            log(`🐢 式神「玄武」を召喚！ ${selfName}に防御力+5（3T）と攻撃無効バリア1回を付与`);
            this.active_buffs.push({
                type: "防御力",
                power: 5,
                rounds: 3,
            });
            this.barrier += 1;

            // ★ UI 用：式神一覧に登録
            this.shikigami_effects.push({
                name: "玄武",
                rounds: 3+1
            });

            return;
        }


        // ===== 烏天狗（自ターン攻撃/スキル時に追撃 ×3回）=====
        if (name === "烏天狗") {
            log(`🐦 式神「烏天狗」を召喚！ ${selfName}に追撃効果を付与：攻撃/スキル時に追加攻撃（残り3回）`);

            // ★ UI 表示用（rounds を3 に統一）
            this.shikigami_effects.push({
                name: "烏天狗",
                rounds: 3+1
            });

            // ★ 内部発動回数（追撃用）
            this.karasu_tengu_triggers = 3;  

            return;
        }


        // ===== 九尾（30防御無視 + 現在装備破壊 + バフ全消し）=====
        if (name === "九尾") {
            log(`🦊 式神「九尾」を召喚！ ${targetName}に防御無視30ダメージ、装備破壊、バフ解除を発動`);

            opponent.take_damage(30, true);

            // ---- 現在装備のみ破壊（特殊装備・矢は破壊しない） ----
            if (
                opponent.equipment &&
                opponent.equipment.equip_type !== "mage_equip" &&
                opponent.equipment.equip_type !== "alchemist_unique" &&
                !opponent.equipment.is_arrow
            ) {
                log(`💥 九尾の炎が相手の装備『${opponent.equipment.name}』を焼き尽くした！`);
                opponent.equipment = null;
            }

            // ---- バフ解除：デバフ（攻撃低下・防御低下・スキル封印など）は残す ----
            if (typeof opponent.remove_dispellable_buffs === "function") {
                opponent.remove_dispellable_buffs();
            } else {
                opponent.active_buffs = (opponent.active_buffs ?? []).filter(
                    b =>
                        b?.unremovable ||
                        b?.passive ||
                        b?.is_debuff === true ||
                        b?.debuff === true ||
                        b?.type === "攻撃力低下" ||
                        b?.type === "防御力低下" ||
                        b?.type === "スキル封印"
                );
            }
            opponent.barrier = 0;

            return;
        }


        // ===== 白龍（30 + 自身の防御力 回復）=====
        if (name === "白龍") {
            const heal = 30 + this.get_total_defense();
            const before = this.hp;
            const healed = this.restore_hp(heal);
            log(healed > 0
                ? `🐉 式神「白龍」を召喚！ ${selfName}のHPを${healed}回復（30＋防御力） HP ${before}→${this.hp}`
                : `🐉 式神「白龍」を召喚！ ${selfName}は回復できなかった`);
            return;
        }

        // 念のためのフォールバック
        log(`式神 '${name}' は未定義です。`);
    }
    // ---------------------------------------------------------
    // 錬金術師スキル（Python版完全移植）
    // ---------------------------------------------------------
    async _use_alchemist_skill(stype, target) {


        // Python同様、スキル封印中は不可
        if (this.skill_sealed) {
            log(`${this.name} はスキル封印されている！`);
            return false;
        }

        // --- 依存関数（equip.js 側で用意されている想定） ---
        // import { generateRandomEquip, upgradeEquipStar, createAlchemistUniqueEquip }
        // from "./equip.js";

        // -----------------------------------------------------
        // スキル1：ランダム装備 2つ生成
        // -----------------------------------------------------
        if (stype === "alchemist_1") {
            log("⚗ 錬成開始！ランダム装備を2つ生成する！");

            for (let i = 0; i < 2; i++) {
                const newEquip = generateRandomEquip();
                newEquip.uid = crypto.randomUUID();
                this.equipment_inventory.push(newEquip);
                log(`✨ ${newEquip.name} を錬成した！`);
            }

            this.used_skill_set.add(stype);
            return true;
        }

        // -----------------------------------------------------
        // スキル2：全装備の星を +1
        // -----------------------------------------------------
        if (stype === "alchemist_2") {
            log("✨ 精錬！全装備の星を +1 する！");

            // 現在装備
            if (this.equipment) {
                upgradeEquipStar(this.equipment);
                log(`🔧 ${this.equipment.name} → 星${this.equipment.star} に進化！`);
            }

            // 所持装備
            for (const eq of this.equipment_inventory) {
                upgradeEquipStar(eq);
                log(`🔧 ${eq.name} → 星${eq.star} に進化！`);
            }

            this.used_skill_set.add(stype);
            return true;
        }

        // -----------------------------------------------------
        // スキル3：三重合成
        // -----------------------------------------------------
        if (stype === "alchemist_3") {
            if (this.devMode) return;

            log("⚗ 三重合成：装備を3つ選んで1つの特殊武器を作る！");
        



            const candidates = this.getAlchemistFusionCandidates();

            if (candidates.length < 3) {
                log("❌ 合成に使える装備が3つありません。");
                return false;
            }

            const selectedUids = Array.isArray(this.pending_alchemist_selection)
                ? this.pending_alchemist_selection.map(uid => String(uid))
                : [];
            this.pending_alchemist_selection = [];

            let selected = [];

            if (this.isBot) {
                const pool = [...candidates];
                while (selected.length < 3 && pool.length > 0) {
                    const pick = pool.splice(
                        Math.floor(Math.random() * pool.length), 1
                    )[0];
                    if (pick) selected.push(pick);
                }
            } else {
                if (selectedUids.length !== 3 || new Set(selectedUids).size !== 3) {
                    log("❌ 合成する装備を3つ選んでください。");
                    return false;
                }

                selected = selectedUids
                    .map(uid =>
                        candidates.find(sel => String(sel.obj?.uid ?? "") === uid)
                    )
                    .filter(Boolean);

                if (selected.length !== 3) {
                    log("❌ 合成に使う装備が見つかりません。");
                    return false;
                }
            }

            // --- ステータス合計（錬金術師・三重合成）---
            let totalAtk = 0;
            let totalDef = 0;
            let totalCoin = 0;
            let totalStar = 0;

            for (const { obj } of selected) {

                // ★ 星数
                totalStar += obj.star ?? 1;

                // ★ 攻撃力
                if (
                    obj.effect_type === "攻撃力" ||
                    obj.equip_category === "攻撃力"
                ) {
                    totalAtk += obj.power ?? 0;
                }

                // ★ 防御力
                if (
                    obj.effect_type === "防御力" ||
                    obj.equip_category === "防御力"
                ) {
                    totalDef += obj.power ?? 0;
                }

                // ★ コイン（旧: coin_per_turn / 新: coin_per_round 両対応）
                if (
                    obj.effect_type === "coin_per_turn" ||
                    obj.effect_type === "coin_per_round" ||
                    obj.equip_category === "coin"
                ) {
                    totalCoin += obj.power ?? 0;
                }
            }


            // ----------------------------------
            // 特殊装備生成
            // ----------------------------------
            const newEquip = createAlchemistUniqueEquip({
                atk: totalAtk,
                defense: totalDef,
                coin: totalCoin,
                star: totalStar,
            });

            newEquip.uid = crypto.randomUUID();


            // ----------------------------------
            // 元の装備を削除
            // ----------------------------------
            for (const sel of selected) {
                if (sel.origin === "equip_slot") {
                    this.equipment = null;
                } else {
                    const idx = this.equipment_inventory.indexOf(sel.obj);
                    if (idx !== -1) this.equipment_inventory.splice(idx, 1);
                }
            }

            // ----------------------------------
            // ★ 完成品は「特殊装備インベントリ」へ
            // ----------------------------------
            this.special_inventory.push(newEquip);


            log(`✨ 特殊武器『${newEquip.name}』を錬成した！`);

            this.used_skill_set.add(stype);
            return true;

        }

        return false;
    }
    // ---------------------------------------------------------
    // 弓兵スキル（Python版完全移植）
    // ---------------------------------------------------------
    _use_archer_skill(stype, opponent) {

        if (this.skill_sealed) {
            log(`${this.name} はスキル封印されている！`);
            return false;
        }

        // ---------- スキル1：追撃 +1（3ターン） ----------
        if (stype === "archer_1") {
            this.add_archer_extra_buff(1, 3, "集中射撃");
            log("⚡ 集中射撃！ 3Tの間、追撃が +1 回になる。");
            this.used_skill_set.add(stype);
            return true;
        }


        // ---------- スキル2：狙い撃ち＋矢拡張 ----------
        if (stype === "archer_2") {

            // ▼ 矢スロットを恒久的に +1
            if (this.arrow_slots < 2) {
                this.arrow_slots = 2;
            }

            // ▼ 追撃バフ（3T）
            this.add_archer_extra_buff(1, 3, "狙い撃ち＋矢拡張");

            log("🏹 狙い撃ち＋矢拡張！ 矢スロット+1 ＆ 追撃+1（3T）");

            this.used_skill_set.add(stype);
            return true;
        }




        // ---------- スキル3：矢を消費しない永続効果 ----------
        if (stype === "archer_3") {
            this.archer_no_consume_rounds = 0;
            this.archer_no_consume_permanent = true;
            this.archer_pierce_rounds = 0;
            this.archer_next_pierce = false;
            log("🎯 無尽射撃！ 以後、矢を消費せずに攻撃できる！");
            this.used_skill_set.add(stype);
            return true;
        }

        return false;
    }
    
    // ---------------------------------------------------------
    // 弓兵：矢攻撃処理（freeze・毒・防御低下・反撃対応）
    // ---------------------------------------------------------
    trigger_arrow_attack(opponent, { consume = true } = {}) {

        const arrowEntries = this.get_equipped_arrow_entries();
        if (arrowEntries.length === 0) {
            return { ok: false, reason: "no_arrow", results: [] };
        }

        const repeat = 1 + this.get_archer_extra_attack_count();
        const noConsume = !!this.archer_no_consume_permanent || Number(this.archer_no_consume_rounds ?? 0) > 0;
        const results = [];
        const depletedSlots = new Set();

        for (let r = 0; r < repeat; r++) {
            for (const entry of arrowEntries) {
                const arrow = entry.item;
                const arrowIndex = arrowEntries.indexOf(entry);
                const { power, pierce, name, effect } = arrow;
                const isExtraAttack = r > 0;
                const shouldConsume = consume && !noConsume && !isExtraAttack;
                const targetType =
                    opponent.doll && !opponent.doll.is_broken
                        ? "doll"
                        : "body";

                const counterBase = effect === "counter"
                    ? Math.floor(Number(this.damage_taken_last_turn ?? this.damage_taken_last_round ?? 0) / 2)
                    : 0;
                const basePower = (effect === "normal")
                    ? this.get_total_attack()
                    : Number(power ?? 0) + counterBase;
                const pierceFinal = !!pierce || !!this.archer_next_pierce || Number(this.archer_pierce_rounds ?? 0) > 0;
                const dealt = opponent.take_damage(basePower, pierceFinal, this);

                let remaining = this.normalize_arrow_ammo(arrow);
                if (shouldConsume) {
                    remaining = Math.max(0, remaining - 1);
                    arrow.arrows_remaining = remaining;
                    arrow.arrow_count = remaining;
                    if (remaining <= 0) depletedSlots.add(entry.slot);
                }

                results.push({
                    name,
                    slot: entry.slot,
                    arrowIndex,
                    repeatIndex: r,
                    power: basePower,
                    dealt,
                    isCrit: false,
                    pierce: pierceFinal,
                    effect,
                    consumed: shouldConsume,
                    noConsume,
                    extraAttack: isExtraAttack,
                    remaining,
                    targetType,
                    statusSnapshot: {
                        hp: opponent.hp,
                        max_hp: opponent.max_hp,
                        doll: opponent.doll
                            ? {
                                durability: opponent.doll.durability,
                                max_durability: opponent.doll.max_durability,
                                is_broken: opponent.doll.is_broken,
                                charge: Number(opponent.doll.charge ?? 0),
                                pending_charge_ready: !!opponent.doll.pending_charge_ready,
                            }
                            : null,
                    },
                });

                console.log(
                    `🏹 弓兵の攻撃（${name}）！ ${basePower} ダメージ`
                    + (pierceFinal ? " (防御貫通)" : "")
                    + (shouldConsume ? ` 残り${remaining}本` : "")
                );

                if (effect === "poison") {
                    opponent.dot_effects.push({
                        name: "毒",
                        power: 2,
                        turns: 2,
                        rounds: 2,
                        source: this.name,
                    });
                } else if (effect === "freeze") {
                    if (!opponent.freeze_debuffs) opponent.freeze_debuffs = [];
                    opponent.freeze_debuffs.push({ atkDown: 2, rounds: 2, owner: this });
                } else if (effect === "def_down") {
                    if (!opponent.defense_debuffs) opponent.defense_debuffs = [];
                    opponent.defense_debuffs.push({ defDown: 1, rounds: 3, owner: this });
                }
            }
        }

        for (const slot of depletedSlots) {
            this[slot] = null;
        }

        return { ok: true, results, arrow_count: arrowEntries.length, repeat };
    }

    // ---------------------------------------------------------
    // 人形使いスキル（server.js 完全移植・最終版）
    // ---------------------------------------------------------
    async _use_doll_skill(stype, opponent) {

    // スキル封印中
    if (this.skill_sealed) {
        return { ok: false, reason: "スキルは封印されている…！" };
    }

    // 人形チェック
    if (!this.doll) {
        return { ok: false, reason: "人形が存在しません" };
    }
    if (this.doll.is_broken && stype !== "doll_1") {
        return { ok: false, reason: "人形が壊れているためスキルを使用できません" };
    }

    // =========================
    // スキル1：修理キット調達
    // =========================
    if (stype === "doll_1") {
        this.items.push({
            name: "修理キット",
            price: 30,
            category: "item",
            is_doll_item: true,
            effect_text: "人形の耐久を20回復。ボロボロ衣装があれば1つ修復",
            uid: crypto.randomUUID(),
        });
        this.used_skill_set.add(stype);

        return {
            ok: true,
            logs: [
                "🧰 修理キットを1つ入手した！"
            ]
        };
    }


    // =========================
    // スキル2：全衣装仕立て直し
    // =========================
    if (stype === "doll_2") {
        if (!this.doll?.costumes) {
            return { ok: false, reason: "人形が存在しません" };
        }

        const maxStar = 8;
        const upgraded = [];
        for (const [part, c] of Object.entries(this.doll.costumes)) {
            if (!c) continue;
            const beforeStar = Number(c.star ?? 1);
            if (beforeStar >= maxStar) continue;
            c.star = Math.min(maxStar, beforeStar + 1);
            this.updateCostumeDisplayName(c);
            upgraded.push(`${part} ★${beforeStar}→★${c.star}`);
        }

        if (upgraded.length === 0) {
            return { ok: false, reason: "強化できる衣装がありません" };
        }

        this.used_skill_set.add(stype);

        return {
            ok: true,
            logs: [
                "🪡 装備中の衣装すべての星が上がった！",
                ...upgraded.map(msg => `⭐ ${msg}`)
            ]
        };
    }


    // =========================
    // スキル3：人形暴走
    // =========================
    if (stype === "doll_3") {
        this.doll.is_rampage = true;
        this.doll.rampage_rounds = 3;

        this.used_skill_set.add(stype);

        return {
            ok: true,
            logs: [
                "🔥 人形が暴走状態に入った！",
                "⚠ 衣装効果が2倍になる（3T）"
            ]
        };
    }

    return { ok: false, reason: "不明な人形スキルです" };



    }
// ---------------------------------------------------------
    // 狂人専用スキル処理（統一規格版）
    // ---------------------------------------------------------
    _use_mad_skill(stype, opponent) {

        // 他の職業と同じくスキル封印チェック
        if (this.skill_sealed) {
            log(`${this.name} はスキル封印されている！`);
            return false;
        }

        const THRESHOLD = 120; // 狂化のしきい値
        const isMad = this.total_damage_received >= THRESHOLD;

        // ---------- スキル1：自傷の狂気 ----------
        if (stype === "mad_1") {
            if (isMad) {
                // 狂化状態：相手に30ダメージ（防御無視）
                log(`⚠️ ${this.name} は狂化している！ 狂気が相手を襲う！`);
                opponent.take_damage(30, true);
            } else {
                // 通常：自分に30ダメージ
                const beforeHp = this.hp;
                this.hp -= 30;
                if (this.hp <= 0) { 
                    this.hp = 0; 
                    this.is_dead = true; 
                }
                const selfDamage = beforeHp - this.hp;
                this.total_damage_received += selfDamage;
                log(`🔪 ${this.name} は高笑いしながら自らを傷つけた！ (30ダメージ)`);
            }
            this.used_skill_set.add(stype);
            return true;
        }

        // ---------- スキル2：痛みへの執着 ----------
        if (stype === "mad_2") {
            // 共通：攻撃力+3 (3ターン)
            this.active_buffs.push({ type: "攻撃力", power: 3, rounds: 3 });
            log(`🔥 ${this.name} は痛みへの執着を見せた！ (攻撃力+3 / 3T)`);

            if (isMad) {
                // 狂化状態：2ターンの間、大幅強化
                this.active_buffs.push({ type: "攻撃力", power: 10, rounds: 2 });
                this.active_buffs.push({ type: "防御力", power: 5, rounds: 2 });
                log(`👹 狂化ボーナス！ 2Tの間、攻撃力+10、防御力+5！`);
            }
            this.used_skill_set.add(stype);
            return true;
        }

        // ---------- スキル3：破滅の微笑 ----------
        if (stype === "mad_3") {
            this.madman_guts = true;
            log(`🛡 ${this.name} は我慢の構えを取った！ 致死ダメージを1回だけHP10で耐える！`);

            if (isMad) {
                this.madman_rage_active = true;
                log(`⚙️ 狂化ボーナス！ 累積被ダメージの 1/20 だけ攻撃力が上がる！`);
            }
            this.used_skill_set.add(stype);
            return true;
        }

        log("未対応の狂人スキル:", stype);
        return false;
    }
}
