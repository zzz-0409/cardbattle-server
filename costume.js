// costume.js
import crypto from "crypto";

// 衣装部位
export const COSTUME_PARTS = ["hat", "body", "legs", "shoes"];

// 効果タイプ
export const COSTUME_TYPES = {
  ATK: "ATK",
  DEF: "DEF",
  DUR: "DUR"
};

// 衣装生成（★1〜★3）
export function createCostume({
  part,          // "hat" | "body" | "legs" | "shoes"
  type,          // "ATK" | "DEF" | "DUR"
  star = 1       // 1〜3
}) {
  return {
    uid: crypto.randomUUID(),

    // 識別
    is_costume: true,
    item_type: "costume",

    // 性質
    part,        // 部位
    type,        // 効果タイプ
    star,        // ★

    // 状態
    condition: "normal", // "normal" | "boroboro"

    // 表示用（仮）
    name: `★${star} 衣装`,
    price: 10 + star * 5
  };
}
