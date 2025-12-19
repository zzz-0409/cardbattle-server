// ============================================
// main.js
// 起動時に名前＆職業（番号）選択する版（Python main.py 準拠）
// ============================================

import readline from "node:readline/promises";
import { battleLoop } from "./engine.js";
import { Player } from "./player.js";
import { JOB_TEMPLATE } from "./constants.js";  // ★ ここ大事

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const io = {
  log: console.log,
  input: (msg) => rl.question(msg)
};

// ===============================
// 職業選択（Pythonの pick_job 相当）
// ===============================
async function pickJob(playerName) {
  io.log("\n職業一覧:");

  const keys = Object.keys(JOB_TEMPLATE).sort((a, b) => Number(a) - Number(b));

  for (const k of keys) {
    const v = JOB_TEMPLATE[k];
    io.log(
      `${k}: ${v.name} (初期コイン:${v.coin}, atk+${v.atk_bonus}, def+${v.def_bonus})`
    );
  }

  while (true) {
    const c = (await io.input(`${playerName} の職業番号を選んでください: `)).trim();
    if (JOB_TEMPLATE[c]) {
      return c;   // ★ 職業名ではなく「番号」を返す！
    }
    io.log("無効です。");
  }
}


// ===============================
// バトル開始（Pythonの start_battle 相当）
// ===============================
async function startBattle() {
  io.log("=== カードバトル（JS版） ===");

  const name1Input = (await io.input("プレイヤー1の名前: ")).trim();
  const name2Input = (await io.input("プレイヤー2の名前: ")).trim();

  const name1 = name1Input || "Player1";
  const name2 = name2Input || "Player2";

  const job1 = await pickJob(name1);
  const job2 = await pickJob(name2);

  const p1 = new Player(name1, job1);
  const p2 = new Player(name2, job2);

  io.log("\n準備完了。バトル開始！");
  await io.input("\nEnterで開始");

  await battleLoop(p1, p2, io);

  await io.input("\nゲーム終了。Enterで閉じる。");
}

// ===============================
// メイン処理（シンプルメニュー）
// ===============================
async function mainMenu() {
  while (true) {
    console.clear();
    console.log("=== メインメニュー ===");
    console.log("1: 通常バトル開始");
    console.log("0: 終了");

    const cmd = (await io.input("番号を入力: ")).trim();

    if (cmd === "1") {
      await startBattle();
    } else if (cmd === "0") {
      break;
    } else {
      console.log("無効な入力です。");
      await io.input("Enterで続行");
    }
  }

  rl.close();
}

mainMenu();
