import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// =========================================================
// アカウント + 職業別戦績/レート 永続ストア
//  - JSONファイルに保存（簡易DB）
//  - ES Module で動作
// =========================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "accounts.json");
const DATA_TMP_FILE = DATA_FILE + ".tmp";
const DATA_BACKUP_FILE = DATA_FILE + ".backup";
const DATA_BACKUP_DIR = path.join(DATA_DIR, "backup");

const DEFAULT_RATING = 1000;
const MIN_RATING = 500;
const NAME_MIN = 2;
const NAME_MAX = 12;
const NAME_CHANGE_COOLDOWN_MS = 0; // 名前変更のクールダウンなし

function nowMs() {
  return Date.now();
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function normalizeDb(data) {
  if (!data || typeof data !== "object") return { accounts: {} };
  if (!data.accounts || typeof data.accounts !== "object") data.accounts = {};
  return data;
}

function writeInitialDbIfMissing() {
  if (fs.existsSync(DATA_FILE)) return;
  fs.writeFileSync(DATA_FILE, JSON.stringify({ accounts: {} }, null, 2), "utf-8");
}

function loadJsonSafe() {
  ensureDir();

  try {
    writeInitialDbIfMissing();
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    return normalizeDb(JSON.parse(raw));
  } catch (e) {
    console.warn("⚠ accounts.json 読み込み失敗。backupから復旧を試します:", e);
  }

  try {
    if (fs.existsSync(DATA_BACKUP_FILE)) {
      const raw = fs.readFileSync(DATA_BACKUP_FILE, "utf-8");
      const backup = normalizeDb(JSON.parse(raw));
      saveJsonSafe(backup);
      console.log("✅ accounts.json.backup から復旧しました");
      return backup;
    }
  } catch (e) {
    console.error("❌ backup復旧失敗:", e);
  }

  return { accounts: {} };
}

function rotateGenerationBackups() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    if (!fs.existsSync(DATA_BACKUP_DIR)) {
      fs.mkdirSync(DATA_BACKUP_DIR, { recursive: true });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const generationFile = path.join(DATA_BACKUP_DIR, `accounts_${stamp}.json`);
    fs.copyFileSync(DATA_FILE, generationFile);

    const files = fs.readdirSync(DATA_BACKUP_DIR)
      .filter(name => name.startsWith("accounts_") && name.endsWith(".json"))
      .map(name => ({
        name,
        time: fs.statSync(path.join(DATA_BACKUP_DIR, name)).mtimeMs
      }))
      .sort((a, b) => b.time - a.time);

    for (const f of files.slice(20)) {
      fs.unlinkSync(path.join(DATA_BACKUP_DIR, f.name));
    }
  } catch (e) {
    console.warn("⚠ 世代バックアップ作成失敗:", e);
  }
}

function saveJsonSafe(data) {
  try {
    ensureDir();

    const normalized = normalizeDb(data);
    const json = JSON.stringify(normalized, null, 2);

    if (fs.existsSync(DATA_FILE)) {
      fs.copyFileSync(DATA_FILE, DATA_BACKUP_FILE);
      rotateGenerationBackups();
    }

    fs.writeFileSync(DATA_TMP_FILE, json, "utf-8");
    fs.renameSync(DATA_TMP_FILE, DATA_FILE);

    console.log("💾 accounts.json 保存成功");
    return true;
  } catch (e) {
    console.error("❌ accounts.json 保存失敗:", e);
    try {
      if (fs.existsSync(DATA_TMP_FILE)) fs.unlinkSync(DATA_TMP_FILE);
    } catch {}
    return false;
  }
}

// 文字列検証
export function validateAccountName(name) {
  if (typeof name !== "string") return { ok: false, reason: "名前が不正です" };
  // 改行・タブ禁止
  if (/[\n\r\t]/.test(name)) return { ok: false, reason: "改行・タブは禁止です" };
  // 先頭末尾スペース禁止
  if (name !== name.trim()) return { ok: false, reason: "先頭・末尾スペースは禁止です" };
  // 連続スペース禁止（半角スペース2連）
  if (/ {2,}/.test(name)) return { ok: false, reason: "連続スペースは禁止です" };

  const len = [...name].length;
  if (len < NAME_MIN || len > NAME_MAX) {
    return { ok: false, reason: `名前は${NAME_MIN}〜${NAME_MAX}文字です` };
  }

  return { ok: true };
}

function ensureJobSlot(account, jobName) {
  if (!account.jobs) account.jobs = {};
  if (!account.jobs[jobName]) {
    account.jobs[jobName] = {
      rating: DEFAULT_RATING,
      wins: 0,
      losses: 0,
      updatedAt: 0
    };
  }
  // 旧データ互換
  if (typeof account.jobs[jobName].rating !== "number") account.jobs[jobName].rating = DEFAULT_RATING;
  if (typeof account.jobs[jobName].wins !== "number") account.jobs[jobName].wins = 0;
  if (typeof account.jobs[jobName].losses !== "number") account.jobs[jobName].losses = 0;
  if (typeof account.jobs[jobName].updatedAt !== "number") account.jobs[jobName].updatedAt = 0;
}

function ensureDojoProgressSlot(account, jobName) {
  if (!account.dojoProgress || typeof account.dojoProgress !== "object") {
    account.dojoProgress = {};
  }
  if (!account.dojoProgress[jobName]) {
    account.dojoProgress[jobName] = {
      highestStage: 0,
      clearCount: 0,
      cleared: false,
      updatedAt: 0
    };
  }
  const slot = account.dojoProgress[jobName];
  if (typeof slot.highestStage !== "number") slot.highestStage = 0;
  if (typeof slot.clearCount !== "number") slot.clearCount = 0;
  if (typeof slot.cleared !== "boolean") slot.cleared = false;
  if (typeof slot.updatedAt !== "number") slot.updatedAt = 0;
  if (typeof slot.prestigePoints !== "number") slot.prestigePoints = 0;
  if (typeof slot.trailAttackGrowth !== "number") slot.trailAttackGrowth = 0;
  if (!Array.isArray(slot.trailNodes)) slot.trailNodes = [];
  slot.trailNodes = [...new Set(slot.trailNodes.map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 1 && n <= 80))].sort((a, b) => a - b);
  if (slot.savedRun != null && typeof slot.savedRun !== "object") slot.savedRun = null;
  return slot;
}

export function getOrCreateAccount(accountId) {
  const db = loadJsonSafe();
  if (!db.accounts[accountId]) {
    db.accounts[accountId] = {
      id: accountId,
      name: "",
      createdAt: nowMs(),
      lastNameChangeAt: 0,
      jobs: {},
      dojoProgress: {}
    };
    saveJsonSafe(db);
  }
  return db.accounts[accountId];
}

export function registerAccount({ accountId, name }) {
  const v = validateAccountName(name);
  if (!v.ok) return { ok: false, reason: v.reason };

  const db = loadJsonSafe();
  const exists = Boolean(db.accounts[accountId]);

  if (!db.accounts[accountId]) {
    db.accounts[accountId] = {
      id: accountId,
      name,
      createdAt: nowMs(),
      lastNameChangeAt: nowMs(),
      jobs: {},
      dojoProgress: {}
    };
  } else {
    // 既存：名前が空なら登録、空でなければ保持
    if (!db.accounts[accountId].name) {
      db.accounts[accountId].name = name;
      db.accounts[accountId].lastNameChangeAt = nowMs();
    }
  }

  saveJsonSafe(db);
  return {
    ok: true,
    existed: exists,
    account: {
      id: db.accounts[accountId].id,
      name: db.accounts[accountId].name,
      nextNameChangeAt: 0
    }
  };
}



// =========================================================
// クライアント localStorage からのバックアップ復元
//  - Render等でサーバ側データが失われた場合の救済用
//  - 既存の戦績が存在する場合は原則上書きしない
// =========================================================
export function importJobRecordBackup(accountId, backupJobs = {}) {
  if (!accountId) return { ok: false, reason: "account_id required" };
  if (!backupJobs || typeof backupJobs !== "object") return { ok: false, reason: "backup invalid" };

  const db = loadJsonSafe();
  if (!db.accounts[accountId]) {
    db.accounts[accountId] = {
      id: accountId,
      name: "",
      createdAt: nowMs(),
      lastNameChangeAt: 0,
      jobs: {}
    };
  }
  const acc = db.accounts[accountId];
  if (!acc.jobs) acc.jobs = {};

  let applied = 0;
  for (const [job, rec] of Object.entries(backupJobs)) {
    if (!job) continue;

    const wins = Math.max(0, Number(rec?.wins ?? 0) || 0);
    const losses = Math.max(0, Number(rec?.losses ?? 0) || 0);
    let rating = Number(rec?.rating ?? DEFAULT_RATING);
    if (!Number.isFinite(rating)) rating = DEFAULT_RATING;
    rating = Math.max(MIN_RATING, Math.floor(rating));

    // 既存スロット確保
    ensureJobSlot(acc, job);

    const cur = acc.jobs[job];
    const curWins = Number(cur?.wins ?? 0) || 0;
    const curLosses = Number(cur?.losses ?? 0) || 0;
    const curRating = Number(cur?.rating ?? DEFAULT_RATING) || DEFAULT_RATING;

    const curHasProgress = (curWins + curLosses) > 0 || curRating !== DEFAULT_RATING;
    const backupHasProgress = (wins + losses) > 0 || rating !== DEFAULT_RATING;

    const backupUpdatedAt = Math.max(0, Number(rec?.updatedAt ?? 0) || 0);
    const curUpdatedAt = Math.max(0, Number(cur?.updatedAt ?? 0) || 0);

    // サーバ側が初期化状態なら復元。
    // さらに、localStorage側の方が明確に新しい場合も復元する。
    // これによりサーバ再起動後、復元済みアカウントが accounts.json に残り、
    // 本人がログインしていない間もランキングに表示されやすくなる。
    if ((!curHasProgress && backupHasProgress) || (backupHasProgress && backupUpdatedAt > curUpdatedAt)) {
      acc.jobs[job] = {
        rating,
        wins,
        losses,
        updatedAt: backupUpdatedAt || nowMs()
      };
      applied += 1;
    }
  }

  saveJsonSafe(db);
  return { ok: true, applied };
}
export function changeAccountName({ accountId, name }) {
  const v = validateAccountName(name);
  if (!v.ok) return { ok: false, reason: v.reason };

  const db = loadJsonSafe();
  if (!db.accounts[accountId]) {
    return { ok: false, reason: "アカウントが存在しません" };
  }

  const acc = db.accounts[accountId];
  const now = nowMs();

  acc.name = name;
  acc.lastNameChangeAt = now;

  saveJsonSafe(db);
  return { ok: true, account: { id: acc.id, name: acc.name, nextNameChangeAt: 0 } };
}

// 職業別の戦績+レートを返す（クライアントの職業カード用）
export function getAccountSummary(accountId, jobNames = []) {
  const db = loadJsonSafe();
  const acc = db.accounts[accountId];
  if (!acc) return { ok: false, reason: "アカウントが存在しません" };

  const out = {};
  const dojoOut = {};
  for (const job of jobNames) {
    ensureJobSlot(acc, job);
    const dojo = ensureDojoProgressSlot(acc, job);
    out[job] = {
      rating: acc.jobs[job].rating,
      wins: acc.jobs[job].wins,
      losses: acc.jobs[job].losses,
      updatedAt: acc.jobs[job].updatedAt
    };
    dojoOut[job] = {
      highestStage: dojo.highestStage,
      clearCount: dojo.clearCount,
      cleared: dojo.cleared,
      prestigePoints: dojo.prestigePoints,
      trailNodes: dojo.trailNodes,
      hasSavedRun: !!dojo.savedRun,
      savedStage: dojo.savedRun?.run?.stage ?? null,
      savedAt: dojo.savedRun?.savedAt ?? null,
      updatedAt: dojo.updatedAt
    };
  }

  return {
    ok: true,
    account: {
      id: acc.id,
      name: acc.name,
      nextNameChangeAt: 0
    },
    jobs: out,
    dojoProgress: dojoOut
  };
}

export function getDojoTrailState({ accountId, job }) {
  if (!accountId || !job) return { ok: false, reason: "account_id and job required" };
  const db = loadJsonSafe();
  const acc = db.accounts[accountId];
  if (!acc) return { ok: false, reason: "account not found" };
  const slot = ensureDojoProgressSlot(acc, job);
  saveJsonSafe(db);
  return {
    ok: true,
    prestigePoints: Number(slot.prestigePoints ?? 0),
    trailNodes: [...slot.trailNodes],
    trailAttackGrowth: Number(slot.trailAttackGrowth ?? 0)
  };
}

export function addDojoPrestige({ accountId, job, amount = 0 }) {
  if (!accountId || !job) return { ok: false, reason: "account_id and job required" };
  const add = Math.max(0, Math.floor(Number(amount ?? 0) || 0));
  if (add <= 0) return getDojoTrailState({ accountId, job });
  const db = loadJsonSafe();
  const acc = db.accounts[accountId];
  if (!acc) return { ok: false, reason: "account not found" };
  const slot = ensureDojoProgressSlot(acc, job);
  slot.prestigePoints = Number(slot.prestigePoints ?? 0) + add;
  slot.updatedAt = nowMs();
  saveJsonSafe(db);
  return {
    ok: true,
    prestigePoints: Number(slot.prestigePoints ?? 0),
    trailNodes: [...slot.trailNodes],
    trailAttackGrowth: Number(slot.trailAttackGrowth ?? 0)
  };
}

export function addDojoTrailAttackGrowth({ accountId, job, amount = 1 }) {
  if (!accountId || !job) return { ok: false, reason: "account_id and job required" };
  const add = Math.max(0, Math.floor(Number(amount ?? 0) || 0));
  if (add <= 0) return getDojoTrailState({ accountId, job });
  const db = loadJsonSafe();
  const acc = db.accounts[accountId];
  if (!acc) return { ok: false, reason: "account not found" };
  const slot = ensureDojoProgressSlot(acc, job);
  slot.trailAttackGrowth = Number(slot.trailAttackGrowth ?? 0) + add;
  slot.updatedAt = nowMs();
  saveJsonSafe(db);
  return {
    ok: true,
    prestigePoints: Number(slot.prestigePoints ?? 0),
    trailNodes: [...slot.trailNodes],
    trailAttackGrowth: Number(slot.trailAttackGrowth ?? 0)
  };
}

export function unlockDojoTrailNode({ accountId, job, nodeId, cost }) {
  if (!accountId || !job) return { ok: false, reason: "account_id and job required" };
  const id = Math.floor(Number(nodeId ?? 0) || 0);
  const need = Math.max(1, Math.floor(Number(cost ?? 1) || 1));
  if (id < 1 || id > 80) return { ok: false, reason: "invalid node" };
  const db = loadJsonSafe();
  const acc = db.accounts[accountId];
  if (!acc) return { ok: false, reason: "account not found" };
  const slot = ensureDojoProgressSlot(acc, job);
  if (slot.trailNodes.includes(id)) {
    return { ok: false, reason: "already unlocked", prestigePoints: slot.prestigePoints, trailNodes: [...slot.trailNodes] };
  }
  if (Number(slot.prestigePoints ?? 0) < need) {
    return { ok: false, reason: "not enough points", prestigePoints: slot.prestigePoints, trailNodes: [...slot.trailNodes] };
  }
  slot.prestigePoints = Number(slot.prestigePoints ?? 0) - need;
  slot.trailNodes.push(id);
  slot.trailNodes = [...new Set(slot.trailNodes)].sort((a, b) => a - b);
  slot.updatedAt = nowMs();
  saveJsonSafe(db);
  return {
    ok: true,
    prestigePoints: Number(slot.prestigePoints ?? 0),
    trailNodes: [...slot.trailNodes],
    trailAttackGrowth: Number(slot.trailAttackGrowth ?? 0)
  };
}

export function recordDojoProgress({ accountId, job, stage = 0, cleared = false }) {
  if (!accountId || !job) return { ok: false, reason: "account_id and job required" };
  const db = loadJsonSafe();
  const acc = db.accounts[accountId];
  if (!acc) return { ok: false, reason: "アカウントが存在しません" };

  const slot = ensureDojoProgressSlot(acc, job);
  const nextStage = Math.max(0, Math.min(30, Math.floor(Number(stage ?? 0) || 0)));
  slot.highestStage = Math.max(Number(slot.highestStage ?? 0), nextStage);
  if (cleared) {
    slot.cleared = true;
    slot.clearCount = Number(slot.clearCount ?? 0) + 1;
    slot.highestStage = Math.max(Number(slot.highestStage ?? 0), 30);
  }
  slot.updatedAt = nowMs();
  saveJsonSafe(db);

  return {
    ok: true,
    progress: {
      job,
      highestStage: slot.highestStage,
      clearCount: slot.clearCount,
      cleared: slot.cleared,
      updatedAt: slot.updatedAt
    }
  };
}

export function getSavedDojoRun({ accountId, job }) {
  if (!accountId || !job) return null;
  const db = loadJsonSafe();
  const acc = db.accounts[accountId];
  if (!acc) return null;
  const slot = ensureDojoProgressSlot(acc, job);
  return slot.savedRun || null;
}

export function saveDojoRun({ accountId, job, savedRun }) {
  if (!accountId || !job || !savedRun) return { ok: false, reason: "account_id, job and savedRun required" };
  const db = loadJsonSafe();
  const acc = db.accounts[accountId];
  if (!acc) return { ok: false, reason: "アカウントが存在しません" };
  const slot = ensureDojoProgressSlot(acc, job);
  slot.savedRun = {
    ...savedRun,
    savedAt: nowMs()
  };
  slot.updatedAt = nowMs();
  saveJsonSafe(db);
  return { ok: true, savedRun: slot.savedRun };
}

export function clearSavedDojoRun({ accountId, job }) {
  if (!accountId || !job) return { ok: false, reason: "account_id and job required" };
  const db = loadJsonSafe();
  const acc = db.accounts[accountId];
  if (!acc) return { ok: false, reason: "アカウントが存在しません" };
  const slot = ensureDojoProgressSlot(acc, job);
  slot.savedRun = null;
  slot.updatedAt = nowMs();
  saveJsonSafe(db);
  return { ok: true };
}

function expectedScore(ra, rb) {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

// レート更新（簡易Elo）
export function recordMatchResult({
  accountIdA,
  jobA,
  accountIdB,
  jobB,
  result, // "A" | "B" | "draw"
  kFactor = 32
}) {
  const db = loadJsonSafe();
  const a = db.accounts[accountIdA];
  const b = db.accounts[accountIdB];
  if (!a || !b) return { ok: false, reason: "アカウントが存在しません" };

  ensureJobSlot(a, jobA);
  ensureJobSlot(b, jobB);

  const ra = a.jobs[jobA].rating;
  const rb = b.jobs[jobB].rating;

  const ea = expectedScore(ra, rb);
  const eb = expectedScore(rb, ra);

  let sa = 0.5;
  let sb = 0.5;
  if (result === "A") { sa = 1; sb = 0; }
  if (result === "B") { sa = 0; sb = 1; }

  // K係数：固定（後で調整可能）
  const K = kFactor;

  const newRa = Math.max(MIN_RATING, Math.round(ra + K * (sa - ea)));
  const newRb = Math.max(MIN_RATING, Math.round(rb + K * (sb - eb)));

  a.jobs[jobA].rating = newRa;
  b.jobs[jobB].rating = newRb;

  if (result === "A") {
    a.jobs[jobA].wins += 1;
    b.jobs[jobB].losses += 1;
  } else if (result === "B") {
    b.jobs[jobB].wins += 1;
    a.jobs[jobA].losses += 1;
  }

  const t = nowMs();
  // 「最終更新」は試合が行われた時点
  a.jobs[jobA].updatedAt = t;
  b.jobs[jobB].updatedAt = t;

  saveJsonSafe(db);

  return {
    ok: true,
    updated: {
      A: { job: jobA, rating: newRa, wins: a.jobs[jobA].wins, losses: a.jobs[jobA].losses },
      B: { job: jobB, rating: newRb, wins: b.jobs[jobB].wins, losses: b.jobs[jobB].losses }
    }
  };
}


// =========================================================
// ルーム対戦：勝敗のみ記録（レート変動なし）
// =========================================================
export function recordMatchResultNoRating({
  accountIdA,
  jobA,
  accountIdB,
  jobB,
  result // "A" | "B" | "draw"
}) {
  const db = loadJsonSafe();
  const a = db.accounts[accountIdA];
  const b = db.accounts[accountIdB];
  if (!a || !b) return { ok: false, reason: "アカウントが存在しません" };

  ensureJobSlot(a, jobA);
  ensureJobSlot(b, jobB);

  if (result === "A") {
    a.jobs[jobA].wins += 1;
    b.jobs[jobB].losses += 1;
  } else if (result === "B") {
    b.jobs[jobB].wins += 1;
    a.jobs[jobA].losses += 1;
  }

  const t = nowMs();
  a.jobs[jobA].updatedAt = t;
  b.jobs[jobB].updatedAt = t;

  saveJsonSafe(db);

  return {
    ok: true,
    updated: {
      A: { job: jobA, rating: a.jobs[jobA].rating, wins: a.jobs[jobA].wins, losses: a.jobs[jobA].losses },
      B: { job: jobB, rating: b.jobs[jobB].rating, wins: b.jobs[jobB].wins, losses: b.jobs[jobB].losses }
    }
  };
}

// =========================================================
// CPU戦：片側のみ記録（レート変動は少なめ）
// =========================================================
export function recordCpuMatchResult({
  accountId,
  job,
  result, // "win" | "lose" | "draw"
  kFactor = 16,
  cpuRating = DEFAULT_RATING
}) {
  const db = loadJsonSafe();
  const acc = db.accounts[accountId];
  if (!acc) return { ok: false, reason: "アカウントが存在しません" };

  ensureJobSlot(acc, job);

  const ra = acc.jobs[job].rating;
  const rb = cpuRating;

  const ea = expectedScore(ra, rb);

  let sa = 0.5;
  if (result === "win") sa = 1;
  if (result === "lose") sa = 0;

  const newRa = Math.max(MIN_RATING, Math.round(ra + kFactor * (sa - ea)));
  acc.jobs[job].rating = newRa;

  if (result === "win") acc.jobs[job].wins += 1;
  else if (result === "lose") acc.jobs[job].losses += 1;

  const t = nowMs();
  acc.jobs[job].updatedAt = t;

  saveJsonSafe(db);

  return {
    ok: true,
    updated: { job, rating: newRa, wins: acc.jobs[job].wins, losses: acc.jobs[job].losses }
  };
}

export function getJobTopRankings(jobName, topN = 5) {
  const db = loadJsonSafe();

  const rows = Object.values(db.accounts).map(acc => {
    if (!acc || !acc.id) return null;
    ensureJobSlot(acc, jobName);
    return {
      accountId: acc.id,
      name: acc.name || "(no name)",
      rating: acc.jobs[jobName].rating,
      wins: acc.jobs[jobName].wins,
      updatedAt: acc.jobs[jobName].updatedAt
    };
  }).filter(Boolean);

  rows.sort((x, y) => {
    // 1) レート降順
    if (y.rating !== x.rating) return y.rating - x.rating;
    // 2) 勝利数降順
    if (y.wins !== x.wins) return y.wins - x.wins;
    // 3) 更新が古い方を上（updatedAt昇順）
    return (x.updatedAt || 0) - (y.updatedAt || 0);
  });

  return {
    ok: true,
    job: jobName,
    top: rows.slice(0, topN).map((r, i) => ({
      rank: i + 1,
      name: r.name,
      rating: r.rating
    }))
  };
}

export const ACCOUNT_STORE_CONST = {
  DEFAULT_RATING,
  MIN_RATING,
  NAME_MIN,
  NAME_MAX,
  NAME_CHANGE_COOLDOWN_MS
};
