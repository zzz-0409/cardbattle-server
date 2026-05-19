import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

function getArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => String(arg).startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function loadJson(file) {
  return JSON.parse(readFileSync(path.resolve(process.cwd(), file), "utf8"));
}

function writeJson(file, data) {
  const resolved = path.resolve(process.cwd(), file);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, JSON.stringify(data, null, 2), "utf8");
  return resolved;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mutateNumber(value, pct = 0.18, step = 50) {
  const base = Number(value ?? 0);
  const delta = (Math.random() * 2 - 1) * pct;
  const raw = Math.max(0, base * (1 + delta));
  return Math.round(raw / step) * step;
}

function buildCandidate(base, index) {
  const next = clone(base);
  next.onmyoji ??= {};
  const keys = [
    "catVsMageBonus",
    "catVsArcherOrSummonerBonus",
    "kyuubiManyBuffsBonus",
    "kyuubiPerBuffBonus",
    "kyuubiOneBuffBonus",
    "whiteDragonTwoPoisonBonus",
    "whiteDragonOnePoisonBonus",
    "whiteDragonVsArcherPoisonBonus",
    "actionShopFewTalismansScore",
    "actionShopEnoughTalismansScore",
    "actionUseItemScoreOffset"
  ];
  const changes = 3 + Math.floor(Math.random() * 4);
  for (let i = 0; i < changes; i++) {
    const key = keys[Math.floor(Math.random() * keys.length)];
    next.onmyoji[key] = mutateNumber(next.onmyoji[key], 0.22, 50);
  }
  next.meta = {
    ...(next.meta ?? {}),
    generatedAt: new Date().toISOString(),
    candidateIndex: index,
    source: "dev/cpu_ai_tune.js"
  };
  return next;
}

function scoreBalanceDiagnostic(summary) {
  const jobs = Object.values(summary.byJob ?? {});
  if (jobs.length === 0) return -Infinity;
  const rates = jobs.map(j => Number(j.winRate ?? 0));
  const meanPenalty = rates.reduce((sum, r) => sum + Math.abs(r - 0.5), 0) / rates.length;
  const floorPenalty = rates.reduce((sum, r) => sum + Math.max(0, 0.35 - r) * 1.8, 0);
  const ceilingPenalty = rates.reduce((sum, r) => sum + Math.max(0, r - 0.68) * 1.2, 0);
  const first = Number(summary.byTurnOrder?.first?.winRate ?? 0);
  const second = Number(summary.byTurnOrder?.second?.winRate ?? 0);
  const orderPenalty = Math.abs(first - second) * 0.6;
  const turnPenalty = Math.abs(Number(summary.averageTurns ?? 15) - 15) * 0.01;
  return 100 - meanPenalty * 100 - floorPenalty * 100 - ceilingPenalty * 100 - orderPenalty * 100 - turnPenalty * 100;
}

function inc(map, key, amount = 1) {
  map[key] = Number(map[key] ?? 0) + amount;
}

function getWinnerJob(match) {
  if (match.result === "p1") return match.p1?.job ?? null;
  if (match.result === "p2") return match.p2?.job ?? null;
  return null;
}

function createJobStats() {
  return {
    decisions: 0,
    wins: 0,
    games: 0,
    actions: {},
    skills: {},
    items: {},
    reasons: {},
    score: 0,
    notes: [],
  };
}

function addQuality(stats, amount, note) {
  stats.score += amount;
  if (note && stats.notes.length < 12) stats.notes.push(note);
}

function itemKey(item) {
  return String(item?.shikigamiName || item?.name || item?.arrowEffect || item?.summonerDragonType || item?.equipType || "");
}

function analyzePlayQuality(log) {
  const jobs = {};
  for (const [job, v] of Object.entries(log.summary?.byJob ?? {})) {
    jobs[job] = createJobStats();
    jobs[job].games = Number(v.games ?? 0);
    jobs[job].wins = Number(v.wins ?? 0);
    const rate = Number(v.winRate ?? 0);
    addQuality(jobs[job], rate * jobs[job].games * 8, `win pressure ${Math.round(rate * 100)}%`);
  }

  for (const [job, opponents] of Object.entries(log.summary?.byJobOpponent ?? {})) {
    jobs[job] ??= createJobStats();
    for (const [opponent, v] of Object.entries(opponents ?? {})) {
      const games = Number(v.games ?? 0);
      const rate = Number(v.winRate ?? 0);
      addQuality(jobs[job], rate * games * 0.9, `matchup ${opponent} ${Math.round(rate * 100)}%`);
    }
  }

  for (const match of log.results ?? []) {
    const winnerJob = getWinnerJob(match);
    for (const d of match.decisions ?? []) {
      const job = d.actor;
      if (!job) continue;
      jobs[job] ??= createJobStats();
      const s = jobs[job];
      s.decisions += 1;
      inc(s.actions, d.action ?? "unknown");
      if (d.skill != null) inc(s.skills, `skill${d.skill}`);
      if (d.reason) {
        for (const part of String(d.reason).split("+").filter(Boolean)) inc(s.reasons, part);
      }
      const key = itemKey(d.item);
      if (key) inc(s.items, key);

      const enemyJob = String(d.enemyJob ?? "");
      const reason = String(d.reason ?? "");
      const action = String(d.action ?? "");
      const skill = Number(d.skill ?? 0);
      const item = d.item ?? null;
      const name = itemKey(item);

      if (winnerJob && winnerJob === job) addQuality(s, 0.02, "");

      if (job === "陰陽師") {
        if (item?.isOnmyojiTalisman && action === "buy_item") addQuality(s, 0.35, "buys talismans");
        if (item?.isOnmyojiTalisman && action === "use_item") addQuality(s, 0.65, "uses talismans");
        if (enemyJob === "魔導士" && name.includes("猫又")) addQuality(s, 2.8, "cat loop vs mage");
        if ((enemyJob === "召喚士" || enemyJob === "狂人") && name.includes("九尾")) addQuality(s, 2.2, "kyuubi into setup job");
        if (enemyJob === "弓兵" && name.includes("白龍")) addQuality(s, 2.0, "white dragon vs archer pressure");
        if (reason.includes("onmyoji_use_talisman")) addQuality(s, 0.7, "prioritizes talisman usage");
      } else if (job === "弓兵") {
        if (action === "arrow") addQuality(s, 0.55, "keeps arrows equipped");
        if (item?.isArrow && item?.arrowEffect === "poison") addQuality(s, 1.2, "poison arrow priority");
        if (skill === 2) addQuality(s, 1.8, "opens skill2");
        if (skill === 1 && reason.includes("archer_skill1_poison_pair")) addQuality(s, 2.2, "skill1 after poison pair");
        if (skill === 3) addQuality(s, 1.6, "activates infinite arrows");
      } else if (job === "召喚士") {
        if (item?.isSummonerEgg && action === "buy_item") addQuality(s, 1.5, "buys dragon egg");
        if (item?.isSummonerFeed && action === "use_item") addQuality(s, 0.9, "uses feed");
        if (skill === 1) addQuality(s, 1.8, "gets egg by skill1");
        if (skill === 2) addQuality(s, 1.0, "accelerates growth");
        if (skill === 3) addQuality(s, 1.3, "uses resonance attack");
        if (d.summonerFront === "tiamat" || d.summonerFront === "nidhogg") addQuality(s, 0.2, "front dragon active");
      } else if (job === "僧侶") {
        if (skill === 1 || skill === 2) addQuality(s, 1.3, "builds blessing");
        if (skill === 3 && reason.includes("priest_skill3_ready")) addQuality(s, 2.0, "skill3 only when ready");
        if (name.includes("10") || reason.includes("priest_use_holy_incense")) addQuality(s, 1.1, "regen plan");
      } else if (job === "盗賊") {
        if (name.includes("コイン")) addQuality(s, 1.0, "coin economy");
        if (skill === 3) addQuality(s, 2.2, "free item burst");
        if (action === "use_item") addQuality(s, 0.35, "converts stored items");
      } else if (job === "狂人") {
        if (skill === 3) addQuality(s, 1.9, "early madness engine");
        if (skill === 1 || skill === 2) addQuality(s, reason.includes("mad_hold") ? -0.8 : 0.8, "mad skill timing");
        if (item?.isMadSpecial) addQuality(s, 1.1, "mad special item");
      } else if (job === "錬金術師") {
        if (skill === 1) addQuality(s, 1.2, "starts alchemy");
        if (action === "combine_equip") addQuality(s, 1.5, "combines equipment");
        if (skill === 3) addQuality(s, 1.7, "uses special synthesis");
        if (action === "equip" || action === "special") addQuality(s, 0.35, "uses equipment tempo");
      } else if (job === "魔導士") {
        if (item?.equipType === "mage_equip") addQuality(s, 1.1, "equips mage gear");
        if (skill === 2 || skill === 3) addQuality(s, 1.3, "spends mana for damage");
        if (reason.includes("mage_burst")) addQuality(s, 1.2, "burst timing");
      } else if (job === "戦士") {
        if (skill === 1) addQuality(s, 1.0, "pressure skill1");
        if (action === "attack" || skill > 0) addQuality(s, 0.25, "keeps pressure");
      } else if (job === "騎士") {
        if (skill === 1 || skill === 3) addQuality(s, 0.9, "knight pressure");
        if (name.includes("防御")) addQuality(s, 0.7, "defensive scaling");
      }
    }
  }

  const perJob = {};
  let total = 0;
  let count = 0;
  for (const [job, s] of Object.entries(jobs)) {
    const normalized = s.games > 0 ? s.score / Math.max(1, s.games) : 0;
    perJob[job] = {
      score: Number(normalized.toFixed(3)),
      rawScore: Number(s.score.toFixed(3)),
      games: s.games,
      wins: s.wins,
      winRate: s.games > 0 ? Number((s.wins / s.games).toFixed(3)) : 0,
      topActions: Object.fromEntries(Object.entries(s.actions).sort((a, b) => b[1] - a[1]).slice(0, 6)),
      topSkills: Object.fromEntries(Object.entries(s.skills).sort((a, b) => b[1] - a[1]).slice(0, 6)),
      topItems: Object.fromEntries(Object.entries(s.items).sort((a, b) => b[1] - a[1]).slice(0, 8)),
      notes: [...new Set(s.notes)].slice(0, 8),
    };
    total += Math.min(normalized, 30);
    count += 1;
  }

  return {
    score: count > 0 ? total / count : -Infinity,
    perJob,
  };
}

function getSelectionScore(playQuality, focusJob = "") {
  const focus = String(focusJob || "");
  if (focus && playQuality.perJob?.[focus]) {
    return Number(playQuality.perJob[focus].score ?? 0);
  }
  return playQuality.score;
}

function runSim({ weightsPath, outPath, matches, repeats, level }) {
  const args = [
    "server.js",
    `--cpu-sim=${matches}`,
    "--cpu-sim-round-robin",
    "--cpu-sim-distinct-jobs",
    `--cpu-sim-level=${level}`,
    `--cpu-sim-repeats=${repeats}`,
    `--cpu-sim-out=${outPath}`,
    `--cpu-ai-weights=${weightsPath}`
  ];
  const result = spawnSync("node", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: Number(getArg("timeout-ms", "900000"))
  });
  if (result.status !== 0) {
    throw new Error(`sim failed for ${weightsPath}\n${result.stderr || result.stdout}`);
  }
  return loadJson(outPath);
}

const basePath = getArg("weights", "cpu_ai_weights.json");
if (!existsSync(path.resolve(process.cwd(), basePath))) {
  console.error(`weights file not found: ${basePath}`);
  process.exit(1);
}

const candidates = Math.max(1, Number(getArg("candidates", "4")) || 4);
const matches = Math.max(1, Number(getArg("matches", "540")) || 540);
const repeats = Math.max(1, Number(getArg("repeats", "3")) || 3);
const level = Math.max(1, Math.min(10, Number(getArg("level", "10")) || 10));
const tag = getArg("tag", new Date().toISOString().replace(/[:.]/g, "-"));
const outDir = getArg("out-dir", `tmp/cpu-ai-tuning/${tag}`);
const focusJob = getArg("focus-job", "");

const base = loadJson(basePath);
const results = [];

for (let i = 0; i < candidates; i++) {
  const weights = i === 0 ? clone(base) : buildCandidate(base, i);
  weights.meta = {
    ...(weights.meta ?? {}),
    candidateIndex: i,
    note: i === 0 ? "baseline" : "mutated"
  };
  const weightsPath = `${outDir}/candidate-${i}-weights.json`;
  const logPath = `${outDir}/candidate-${i}-sim.json`;
  writeJson(weightsPath, weights);
  console.log(`[CPU_TUNE] running candidate ${i}/${candidates - 1}`);
  const log = runSim({ weightsPath, outPath: logPath, matches, repeats, level });
  const playQuality = analyzePlayQuality(log);
  const balanceDiagnostic = scoreBalanceDiagnostic(log.summary);
  const score = getSelectionScore(playQuality, focusJob);
  results.push({
    index: i,
    score,
    playQuality,
    balanceDiagnostic,
    weightsPath,
    logPath,
    summary: log.summary
  });
  console.log(`[CPU_TUNE] candidate ${i} selectionScore=${score.toFixed(3)} playQuality=${playQuality.score.toFixed(3)} balanceDiagnostic=${balanceDiagnostic.toFixed(3)}`);
}

results.sort((a, b) => b.score - a.score);
const best = results[0];
const bestWeights = loadJson(best.weightsPath);
bestWeights.meta = {
  ...(bestWeights.meta ?? {}),
  bestSavedAt: new Date().toISOString(),
  bestSelectionScore: best.score,
  bestPlayQualityScore: best.playQuality?.score ?? best.score,
  bestBalanceDiagnostic: best.balanceDiagnostic,
  focusJob,
  bestLogPath: best.logPath,
  humanReviewRequired: true
};
const bestPath = writeJson(`${outDir}/best-weights-review.json`, bestWeights);
const reportPath = writeJson(`${outDir}/tuning-report.json`, {
  createdAt: new Date().toISOString(),
  basePath,
  matches,
  repeats,
  level,
  focusJob,
  bestPath,
  best,
  ranking: results
});

console.log(`[CPU_TUNE] best candidate: ${best.index} selectionScore=${best.score.toFixed(3)} playQuality=${best.playQuality.score.toFixed(3)} balanceDiagnostic=${best.balanceDiagnostic.toFixed(3)}`);
console.log(`[CPU_TUNE] review weights: ${path.resolve(process.cwd(), bestPath)}`);
console.log(`[CPU_TUNE] report: ${path.resolve(process.cwd(), reportPath)}`);
console.log("[CPU_TUNE] 採用する場合は best-weights-review.json の中身を確認してから cpu_ai_weights.json に反映してください。");
