import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  getGitHubAccountStorageInfo,
  pullGitHubAccounts,
  scheduleGitHubAccountsPush
} from "./github_account_storage.js";

// =========================================================
// アカウント + 職業別戦績/レート 永続ストア
//  - JSONファイルに保存（簡易DB）
//  - ES Module で動作
// =========================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_DATA_DIR = path.join(__dirname, "data");
const RENDER_DEFAULT_DISK_DIR = "/var/data/cardbattle";
const DATA_DIR_ENV_NAME = ["ACCOUNT_DATA_DIR", "CARDBATTLE_DATA_DIR", "DATA_DIR"]
  .find(name => process.env[name]);

function resolveDataDir() {
  if (DATA_DIR_ENV_NAME) return path.resolve(process.env[DATA_DIR_ENV_NAME]);

  if (process.env.RENDER && fs.existsSync("/var/data")) {
    return RENDER_DEFAULT_DISK_DIR;
  }

  return LOCAL_DATA_DIR;
}

const DATA_DIR = resolveDataDir();
const DATA_FILE = path.join(DATA_DIR, "accounts.json");
const DATA_TMP_FILE = DATA_FILE + ".tmp";
const DATA_BACKUP_FILE = DATA_FILE + ".backup";
const DATA_BACKUP_DIR = path.join(DATA_DIR, "backup");
const DATA_DIR_SOURCE = DATA_DIR_ENV_NAME || (DATA_DIR === LOCAL_DATA_DIR ? "local" : "render-disk-default");

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

function saveJsonSafe(data, { skipRemote = false } = {}) {
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

    if (!skipRemote) {
      scheduleGitHubAccountsPush(() => loadJsonSafe());
    }

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
function isLikelyPersistentDataDir() {
  if (DATA_DIR_ENV_NAME) return true;
  if (!process.env.RENDER) return false;
  return path.resolve(DATA_DIR).startsWith(path.resolve("/var/data"));
}

function checkWritableDataDir() {
  try {
    ensureDir();
    const probe = path.join(DATA_DIR, `.write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, "ok", "utf-8");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function getAccountStoreInfo() {
  let accountCount = 0;
  let dataFileExists = false;
  let dataFileMtimeMs = 0;

  try {
    const db = loadJsonSafe();
    accountCount = Object.keys(db.accounts || {}).length;
    dataFileExists = fs.existsSync(DATA_FILE);
    if (dataFileExists) {
      dataFileMtimeMs = fs.statSync(DATA_FILE).mtimeMs;
    }
  } catch (e) {
    return {
      ok: false,
      reason: e?.message || String(e),
      dataDir: DATA_DIR,
      dataFile: DATA_FILE,
      dataDirSource: DATA_DIR_SOURCE,
      render: Boolean(process.env.RENDER),
      likelyPersistent: isLikelyPersistentDataDir(),
      persistenceWarning: process.env.RENDER && !isLikelyPersistentDataDir()
        ? "Render local filesystem is ephemeral unless this path is a persistent disk."
        : "",
      writable: checkWritableDataDir(),
      github: getGitHubAccountStorageInfo()
    };
  }

  return {
    ok: true,
    dataDir: DATA_DIR,
    dataFile: DATA_FILE,
    dataDirSource: DATA_DIR_SOURCE,
    render: Boolean(process.env.RENDER),
    likelyPersistent: isLikelyPersistentDataDir(),
    persistenceWarning: process.env.RENDER && !isLikelyPersistentDataDir()
      ? "Render local filesystem is ephemeral unless this path is a persistent disk."
      : "",
    writable: checkWritableDataDir(),
    dataFileExists,
    dataFileMtimeMs,
    accountCount,
    github: getGitHubAccountStorageInfo()
  };
}

function dbText(data) {
  return JSON.stringify(normalizeDb(cloneJsonSafe(data) || { accounts: {} }));
}

function recordProgressTime(record) {
  return Math.max(0, Number(record?.updatedAt ?? record?.savedAt ?? record?.savedRun?.savedAt ?? 0) || 0);
}

function chooseNewerRecord(localRecord, remoteRecord) {
  if (!localRecord) return cloneJsonSafe(remoteRecord);
  if (!remoteRecord) return cloneJsonSafe(localRecord);
  const lt = recordProgressTime(localRecord);
  const rt = recordProgressTime(remoteRecord);
  if (rt > lt) return cloneJsonSafe(remoteRecord);
  if (lt > rt) return cloneJsonSafe(localRecord);

  const localProgress = (Number(localRecord.wins ?? 0) || 0) + (Number(localRecord.losses ?? 0) || 0);
  const remoteProgress = (Number(remoteRecord.wins ?? 0) || 0) + (Number(remoteRecord.losses ?? 0) || 0);
  return cloneJsonSafe(remoteProgress > localProgress ? remoteRecord : localRecord);
}

function mergeDojoSlot(localSlot = {}, remoteSlot = {}) {
  const lt = recordProgressTime(localSlot);
  const rt = recordProgressTime(remoteSlot);
  const primary = rt > lt ? remoteSlot : localSlot;
  const secondary = rt > lt ? localSlot : remoteSlot;
  const merged = {
    ...cloneJsonSafe(secondary || {}),
    ...cloneJsonSafe(primary || {}),
    highestStage: Math.max(Number(localSlot?.highestStage ?? 0) || 0, Number(remoteSlot?.highestStage ?? 0) || 0),
    clearCount: Math.max(Number(localSlot?.clearCount ?? 0) || 0, Number(remoteSlot?.clearCount ?? 0) || 0),
    cleared: Boolean(localSlot?.cleared || remoteSlot?.cleared),
    trailNodes: normalizeDojoTrailNodes([...(localSlot?.trailNodes || []), ...(remoteSlot?.trailNodes || [])]),
    updatedAt: Math.max(lt, rt)
  };

  const localSavedAt = Math.max(0, Number(localSlot?.savedRun?.savedAt ?? localSlot?.savedAt ?? 0) || 0);
  const remoteSavedAt = Math.max(0, Number(remoteSlot?.savedRun?.savedAt ?? remoteSlot?.savedAt ?? 0) || 0);
  if (remoteSavedAt > localSavedAt) {
    merged.savedRun = cloneJsonSafe(remoteSlot.savedRun || null);
  } else if (localSavedAt > 0) {
    merged.savedRun = cloneJsonSafe(localSlot.savedRun || null);
  } else if (!merged.savedRun) {
    merged.savedRun = null;
  }

  return merged;
}

function mergeAccount(localAccount = {}, remoteAccount = {}) {
  const local = cloneJsonSafe(localAccount) || {};
  const remote = cloneJsonSafe(remoteAccount) || {};
  const merged = { ...remote, ...local };

  const localNameAt = Math.max(0, Number(local.lastNameChangeAt ?? local.createdAt ?? 0) || 0);
  const remoteNameAt = Math.max(0, Number(remote.lastNameChangeAt ?? remote.createdAt ?? 0) || 0);
  if (remoteNameAt > localNameAt || (!merged.name && remote.name)) {
    merged.name = remote.name || "";
    merged.lastNameChangeAt = remote.lastNameChangeAt || remoteNameAt;
  }

  merged.jobs = {};
  const jobNames = new Set([...Object.keys(local.jobs || {}), ...Object.keys(remote.jobs || {})]);
  for (const job of jobNames) {
    merged.jobs[job] = chooseNewerRecord(local.jobs?.[job], remote.jobs?.[job]);
  }

  merged.dojoProgress = {};
  const dojoJobs = new Set([...Object.keys(local.dojoProgress || {}), ...Object.keys(remote.dojoProgress || {})]);
  for (const job of dojoJobs) {
    merged.dojoProgress[job] = mergeDojoSlot(local.dojoProgress?.[job] || {}, remote.dojoProgress?.[job] || {});
  }

  return merged;
}

function mergeAccountDbs(localDb, remoteDb) {
  const local = normalizeDb(cloneJsonSafe(localDb) || { accounts: {} });
  const remote = normalizeDb(cloneJsonSafe(remoteDb) || { accounts: {} });
  const merged = { ...remote, ...local, accounts: {} };
  const accountIds = new Set([...Object.keys(local.accounts || {}), ...Object.keys(remote.accounts || {})]);
  for (const accountId of accountIds) {
    merged.accounts[accountId] = mergeAccount(local.accounts?.[accountId], remote.accounts?.[accountId]);
    merged.accounts[accountId].id = merged.accounts[accountId].id || accountId;
  }
  return merged;
}

export async function hydrateAccountStoreFromRemote() {
  const pulled = await pullGitHubAccounts();
  if (!pulled.enabled) return { ok: true, enabled: false };
  if (!pulled.ok) {
    console.warn("GitHub account storage pull failed:", pulled.reason);
    return pulled;
  }

  const localDb = loadJsonSafe();
  if (!pulled.exists) {
    const hasLocalAccounts = Object.keys(localDb.accounts || {}).length > 0;
    if (hasLocalAccounts) scheduleGitHubAccountsPush(() => loadJsonSafe(), 0);
    return { ok: true, enabled: true, pulled: false, pushedLocal: hasLocalAccounts };
  }

  const merged = mergeAccountDbs(localDb, pulled.data);
  const localChanged = dbText(merged) !== dbText(localDb);
  const remoteChanged = dbText(merged) !== dbText(pulled.data);

  if (localChanged) {
    saveJsonSafe(merged, { skipRemote: true });
  }
  if (remoteChanged) {
    scheduleGitHubAccountsPush(() => loadJsonSafe(), 0);
  }

  return { ok: true, enabled: true, pulled: true, localChanged, remoteChanged };
}

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

function cloneJsonSafe(value) {
  if (value == null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function normalizeDojoTrailNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return [...new Set(nodes
    .map(n => Number(n))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 80))]
    .sort((a, b) => a - b);
}

function normalizeDojoBackupSlot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const savedRun = raw.savedRun && typeof raw.savedRun === "object"
    ? cloneJsonSafe(raw.savedRun)
    : null;
  const savedAt = Math.max(0, Number(raw.savedAt ?? savedRun?.savedAt ?? 0) || 0);
  const updatedAt = Math.max(0, Number(raw.updatedAt ?? savedAt ?? 0) || 0);
  const slot = {
    highestStage: Math.max(0, Math.min(30, Math.floor(Number(raw.highestStage ?? raw.savedStage ?? savedRun?.run?.stage ?? 0) || 0))),
    clearCount: Math.max(0, Math.floor(Number(raw.clearCount ?? 0) || 0)),
    cleared: Boolean(raw.cleared),
    updatedAt,
    prestigePoints: Math.max(0, Math.floor(Number(raw.prestigePoints ?? savedRun?.run?.dojoTrail?.prestigePoints ?? 0) || 0)),
    trailAttackGrowth: Math.max(0, Math.floor(Number(raw.trailAttackGrowth ?? savedRun?.run?.dojoTrail?.trailAttackGrowth ?? 0) || 0)),
    trailNodes: normalizeDojoTrailNodes(raw.trailNodes ?? savedRun?.run?.dojoTrail?.trailNodes)
  };
  if (savedRun) {
    slot.savedRun = {
      ...savedRun,
      savedAt: savedAt || Number(savedRun.savedAt ?? 0) || nowMs()
    };
    slot.updatedAt = Math.max(slot.updatedAt, Number(slot.savedRun.savedAt ?? 0) || 0);
  }
  return slot;
}

function hasDojoSlotProgress(slot) {
  if (!slot || typeof slot !== "object") return false;
  return (
    Number(slot.highestStage ?? 0) > 0 ||
    Number(slot.clearCount ?? 0) > 0 ||
    Boolean(slot.cleared) ||
    Number(slot.prestigePoints ?? 0) > 0 ||
    Number(slot.trailAttackGrowth ?? 0) > 0 ||
    (Array.isArray(slot.trailNodes) && slot.trailNodes.length > 0) ||
    Boolean(slot.savedRun)
  );
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
      jobs: {},
      dojoProgress: {}
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

export function importDojoProgressBackup(accountId, backupProgress = {}) {
  if (!accountId) return { ok: false, reason: "account_id required" };
  if (!backupProgress || typeof backupProgress !== "object") return { ok: false, reason: "backup invalid" };

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
  }
  const acc = db.accounts[accountId];
  if (!acc.jobs || typeof acc.jobs !== "object") acc.jobs = {};
  if (!acc.dojoProgress || typeof acc.dojoProgress !== "object") acc.dojoProgress = {};

  let applied = 0;
  for (const [job, raw] of Object.entries(backupProgress)) {
    if (!job) continue;
    const backup = normalizeDojoBackupSlot(raw);
    if (!backup || !hasDojoSlotProgress(backup)) continue;

    const slot = ensureDojoProgressSlot(acc, job);
    const curHasProgress = hasDojoSlotProgress(slot);
    const curUpdatedAt = Math.max(0, Number(slot.updatedAt ?? slot.savedRun?.savedAt ?? 0) || 0);
    const backupUpdatedAt = Math.max(0, Number(backup.updatedAt ?? backup.savedRun?.savedAt ?? 0) || 0);
    const backupIsNewer = backupUpdatedAt > curUpdatedAt || !curHasProgress;

    if (backupIsNewer) {
      slot.highestStage = backup.highestStage;
      slot.clearCount = backup.clearCount;
      slot.cleared = backup.cleared;
      slot.prestigePoints = backup.prestigePoints;
      slot.trailAttackGrowth = backup.trailAttackGrowth;
      slot.trailNodes = [...backup.trailNodes];
      slot.savedRun = backup.savedRun ? cloneJsonSafe(backup.savedRun) : null;
      slot.updatedAt = backupUpdatedAt || nowMs();
      applied += 1;
      continue;
    }

    let changed = false;
    const nextHighest = Math.max(Number(slot.highestStage ?? 0), Number(backup.highestStage ?? 0));
    if (nextHighest !== Number(slot.highestStage ?? 0)) {
      slot.highestStage = nextHighest;
      changed = true;
    }
    const nextClearCount = Math.max(Number(slot.clearCount ?? 0), Number(backup.clearCount ?? 0));
    if (nextClearCount !== Number(slot.clearCount ?? 0)) {
      slot.clearCount = nextClearCount;
      changed = true;
    }
    if (backup.cleared && !slot.cleared) {
      slot.cleared = true;
      changed = true;
    }
    const mergedTrailNodes = normalizeDojoTrailNodes([...(slot.trailNodes || []), ...(backup.trailNodes || [])]);
    if (mergedTrailNodes.join(",") !== (slot.trailNodes || []).join(",")) {
      slot.trailNodes = mergedTrailNodes;
      changed = true;
    }

    const curSavedAt = Math.max(0, Number(slot.savedRun?.savedAt ?? 0) || 0);
    const backupSavedAt = Math.max(0, Number(backup.savedRun?.savedAt ?? 0) || 0);
    if (backup.savedRun && backupSavedAt > curSavedAt) {
      slot.savedRun = cloneJsonSafe(backup.savedRun);
      changed = true;
    }

    if (changed) {
      slot.updatedAt = Math.max(nowMs(), Number(slot.updatedAt ?? 0), backupUpdatedAt);
      applied += 1;
    }
  }

  if (applied > 0) saveJsonSafe(db);
  return { ok: true, applied };
}

export function exportDojoProgressBackup(accountId, jobNames = []) {
  if (!accountId) return { ok: false, reason: "account_id required" };
  const db = loadJsonSafe();
  const acc = db.accounts[accountId];
  if (!acc) return { ok: false, reason: "account not found" };

  const jobs = Array.isArray(jobNames) && jobNames.length
    ? jobNames
    : Object.keys(acc.dojoProgress || {});
  const dojoProgress = {};
  for (const job of jobs) {
    if (!job) continue;
    const slot = ensureDojoProgressSlot(acc, job);
    dojoProgress[job] = {
      highestStage: Number(slot.highestStage ?? 0),
      clearCount: Number(slot.clearCount ?? 0),
      cleared: Boolean(slot.cleared),
      updatedAt: Number(slot.updatedAt ?? 0),
      prestigePoints: Number(slot.prestigePoints ?? 0),
      trailAttackGrowth: Number(slot.trailAttackGrowth ?? 0),
      trailNodes: [...slot.trailNodes],
      savedRun: slot.savedRun ? cloneJsonSafe(slot.savedRun) : null,
      savedStage: slot.savedRun?.run?.stage ?? null,
      savedAt: slot.savedRun?.savedAt ?? null
    };
  }

  return { ok: true, dojoProgress, exportedAt: nowMs() };
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
    const rec = acc.jobs?.[jobName];
    if (!rec || typeof rec !== "object") return null;

    let rating = Number(rec.rating ?? DEFAULT_RATING);
    if (!Number.isFinite(rating)) rating = DEFAULT_RATING;
    rating = Math.max(MIN_RATING, Math.floor(rating));

    const wins = Math.max(0, Number(rec.wins ?? 0) || 0);
    const losses = Math.max(0, Number(rec.losses ?? 0) || 0);
    const updatedAt = Math.max(0, Number(rec.updatedAt ?? 0) || 0);
    const hasProgress = wins + losses > 0 || rating !== DEFAULT_RATING || updatedAt > 0;
    if (!hasProgress) return null;

    return {
      accountId: acc.id,
      name: acc.name || "(no name)",
      rating,
      wins,
      updatedAt
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
