import fs from "fs";
import path from "path";

// =========================================================
// アカウント + 職業別戦績/レート 永続ストア
//  - JSONファイルに保存（簡易DB）
//  - ES Module で動作
// =========================================================

const DATA_DIR = path.resolve("./data");
const DATA_FILE = path.join(DATA_DIR, "accounts.json");

const DEFAULT_RATING = 1000;
const MIN_RATING = 500;
const NAME_MIN = 2;
const NAME_MAX = 12;
const NAME_CHANGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7日

function nowMs() {
  return Date.now();
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJsonSafe() {
  try {
    ensureDir();
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify({ accounts: {} }, null, 2), "utf-8");
    }
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return { accounts: {} };
    if (!data.accounts || typeof data.accounts !== "object") data.accounts = {};
    return data;
  } catch {
    return { accounts: {} };
  }
}

function saveJsonSafe(data) {
  try {
    ensureDir();
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch {
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

export function getOrCreateAccount(accountId) {
  const db = loadJsonSafe();
  if (!db.accounts[accountId]) {
    db.accounts[accountId] = {
      id: accountId,
      name: "",
      createdAt: nowMs(),
      lastNameChangeAt: 0,
      jobs: {}
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
      jobs: {}
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
      nextNameChangeAt: (db.accounts[accountId].lastNameChangeAt || 0) + NAME_CHANGE_COOLDOWN_MS
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

    // 原則：サーバ側に進捗があるなら上書きしない
    // 例外：サーバ側が初期化状態で、バックアップに進捗がある場合のみ反映
    if (!curHasProgress && backupHasProgress) {
      acc.jobs[job] = {
        rating,
        wins,
        losses,
        updatedAt: nowMs()
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
  const last = Number(acc.lastNameChangeAt ?? 0);
  const nextAllowed = last + NAME_CHANGE_COOLDOWN_MS;
  const now = nowMs();

  if (last > 0 && now < nextAllowed) {
    return { ok: false, reason: "名前変更は7日に1回までです", nextNameChangeAt: nextAllowed };
  }

  acc.name = name;
  acc.lastNameChangeAt = now;

  saveJsonSafe(db);
  return { ok: true, account: { id: acc.id, name: acc.name, nextNameChangeAt: now + NAME_CHANGE_COOLDOWN_MS } };
}

// 職業別の戦績+レートを返す（クライアントの職業カード用）
export function getAccountSummary(accountId, jobNames = []) {
  const db = loadJsonSafe();
  const acc = db.accounts[accountId];
  if (!acc) return { ok: false, reason: "アカウントが存在しません" };

  const out = {};
  for (const job of jobNames) {
    ensureJobSlot(acc, job);
    out[job] = {
      rating: acc.jobs[job].rating,
      wins: acc.jobs[job].wins,
      losses: acc.jobs[job].losses,
      updatedAt: acc.jobs[job].updatedAt
    };
  }

  return {
    ok: true,
    account: {
      id: acc.id,
      name: acc.name,
      nextNameChangeAt: (Number(acc.lastNameChangeAt ?? 0) || 0) + NAME_CHANGE_COOLDOWN_MS
    },
    jobs: out
  };
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
