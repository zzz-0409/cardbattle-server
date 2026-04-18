// ===============================
// ★ simulate 実行フラグ（最重要）
// ===============================
globalThis.SIMULATE = true;
globalThis.DEV_MODE = true;

import { Player } from "../player.js";
import { cpuStep } from "../server.js";
import { Match, JOB_DATA } from "../server.js";
import { maybeCpuTurn } from "../server.js";




function createBot(jobId) {
  if (!JOB_DATA[jobId]) {
    throw new Error(`Invalid jobId: ${jobId}`);
  }

  return {
    isBot: true,
    readyState: 1,
    devMode: true,
    send() {},
    player: new Player(
      "BOT",
      jobId
    )

  };
}




async function simulateMatch(jobA, jobB, maxRounds = 50) {
  const p1 = createBot(jobA);
  const p2 = createBot(jobB);

  const match = new Match(p1, p2, { devMode: true });


  let rounds = 0;

  while (!match.ended) {
    await maybeCpuTurn(match);
  }


  if (match.P1.hp <= 0 && match.P2.hp <= 0) return "draw";
  if (match.P1.hp <= 0) return jobB;
  if (match.P2.hp <= 0) return jobA;

  return "draw";
}

const JOB_KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

// ★ 職業ID → 表示名 変換
const jobName = (id) => JOB_DATA[id]?.name ?? `JOB_${id}`;

const RESULT = {};
const GAMES = 10;

(async () => {
  for (let i = 0; i < JOB_KEYS.length; i++) {
    const a = JOB_KEYS[i];
    RESULT[a] = {};

    for (let j = i + 1; j < JOB_KEYS.length; j++) {
      const b = JOB_KEYS[j];
      let win = 0;

      console.log(
        `\n[SIM] START ${jobName(a)} vs ${jobName(b)}`
      );

      for (let k = 0; k < GAMES; k++) {
        const r = await simulateMatch(a, b);

        if ((k + 1) % 5 === 0) {
          console.log(
            `[SIM] ${jobName(a)} vs ${jobName(b)} : ${k + 1}/${GAMES}`
          );
        }

        if (r === a) win++;
      }


      console.log(
        `[SIM] END ${jobName(a)} vs ${jobName(b)}`
      );

      RESULT[a][b] = (win / GAMES).toFixed(2);
      console.log(`${jobName(a)} vs ${jobName(b)} : ${RESULT[a][b]}`);

    }
  }

  // ===============================
  // ★ 表示用：職業名に変換した勝率表
  // ===============================
  const RESULT_BY_NAME = {};

  for (const a of JOB_KEYS) {
    const nameA = jobName(a);
    RESULT_BY_NAME[nameA] = {};

    for (const b of JOB_KEYS) {
      if (RESULT[a]?.[b] !== undefined) {
        const nameB = jobName(b);
        RESULT_BY_NAME[nameA][nameB] = RESULT[a][b];
      }
    }
  }

  console.log("\n=== 勝率表 ===");
  console.log(JSON.stringify(RESULT_BY_NAME, null, 2));
})();

