// ============================================
// item.js
// Python版 core/items.py をJSに完全移植
// ============================================

// ★レアリティ倍率（★1=1.0, ★2=1.5, ★3=2.0）
function rarityMultiplier(star) {
    return 1.0 + (star - 1) * 0.5;
}

// 基礎値（Pythonの constants.py と同じ）
const BASE_ATKDEF_BASE = 6;      // 攻撃/防御バフ用ベース
const HP_RECOVERY_BASE = 10;     // HP回復のベース

// 価格（Pythonの PRICE_BUFF / PRICE_RECOVER と同じ）
const PRICE_BUFF = { 1: 8, 2: 12, 3: 16 };
const PRICE_RECOVER = { 1: 15, 2: 20, 3: 25 };

// 効果タイプ（Pythonの EFFECT_TYPES）
const EFFECT_TYPES = ["攻撃力", "防御力", "HP"];

// --------------------------------------------
// バフの強さ計算（攻撃/防御）
// Python: calc_buff_power(star, duration)
// --------------------------------------------
function calcBuffPower(star, duration) {
    if (duration <= 0) {
        duration = 1;
    }
    const val = (BASE_ATKDEF_BASE * rarityMultiplier(star)) / duration;
    return Math.max(1, Math.round(val));
}

// --------------------------------------------
// HP回復量計算
// Python: calc_hp_recovery(star)
// --------------------------------------------
function calcHpRecovery(star) {
    const val = HP_RECOVERY_BASE * rarityMultiplier(star);
    return Math.max(1, Math.round(val));
}

// ============================================
// ショップ用アイテムを1つ生成
// Python: generate_one_shop_item(level)
// ============================================
export function generateOneShopItem(level) {
    // ★の決定（Pythonと同じ確率）
    const roll = Math.floor(Math.random() * 100) + 1;
    let star;

    if (level === 1) {
        if (roll <= 70) {
            star = 1;
        } else if (roll <= 95) {
            star = 2;
        } else {
            star = 3;
        }
    } else if (level === 2) {
        if (roll <= 40) {
            star = 1;
        } else if (roll <= 90) {
            star = 2;
        } else {
            star = 3;
        }
    } else {
        if (roll <= 20) {
            star = 1;
        } else if (roll <= 70) {
            star = 2;
        } else {
            star = 3;
        }
    }

    // 効果種別（攻撃力 / 防御力 / HP）
    const effect = EFFECT_TYPES[Math.floor(Math.random() * EFFECT_TYPES.length)];

    // バフ継続ラウンド（1〜3）※HPのときは0（即時）
    const duration = Math.floor(Math.random() * 3) + 1;
    const duration_use = (effect === "HP") ? 0 : duration;

    let power;
    let price;
    let name;
    let effect_text;

    if (effect === "攻撃力") {
        power = calcBuffPower(star, duration_use);
        price = PRICE_BUFF[star];
        name = `★${star} 攻撃力UP (${duration_use}R)`;
        effect_text = `攻撃力 +${power} / ${duration_use}R`;
    } else if (effect === "防御力") {
        power = calcBuffPower(star, duration_use);
        price = PRICE_BUFF[star];
        name = `★${star} 防御力UP (${duration_use}R)`;
        effect_text = `防御力 +${power} / ${duration_use}R`;
    } else {  // HP
        power = calcHpRecovery(star);
        price = PRICE_RECOVER[star];
        name = `★${star} HP回復`;
        effect_text = `HP +${power} (即時)`;
    }

    return {
        name,               // アイテム名（★付き）
        star,               // レアリティ★
        effect_type: effect, // "攻撃力" / "防御力" / "HP"
        power,              // 効果量
        duration: duration_use, // バフラウンド（HPは0）
        price,              // ショップ価格
        effect_text,        // 説明テキスト
        is_equip: false
    };
}

// おまけ：レベル指定なしの簡易ランダム生成（必要なら使用）
export function generateRandomItem(level = 1) {
    return generateOneShopItem(level);
}

