import { Player } from "./player.js";

const a = new Player("錬金A");
a.assignJob(7);

// スキル1（ランダム装備生成）
console.log("=== スキル1 ===");
a.use_alchemist_skill("alchemist_1");
console.log(a.equipment_inventory);

// スキル2（星+1）
console.log("=== スキル2 ===");
a.use_alchemist_skill("alchemist_2");

// スキル3（三重合成）
console.log("=== スキル3 ===");
a.use_alchemist_skill("alchemist_3");
console.log(a.equipment_inventory);
