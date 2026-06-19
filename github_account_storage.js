import https from "https";

const DEFAULT_REMOTE_PATH = "data/accounts.json";
const DEFAULT_BRANCH = "main";
const PUSH_DEBOUNCE_MS = Math.max(500, Number(process.env.GITHUB_ACCOUNT_PUSH_DEBOUNCE_MS ?? 2500) || 2500);

let lastPull = null;
let lastPush = null;
let lastError = "";
let pushTimer = null;
let pushRunning = false;
let pushQueued = false;
let pendingReadDb = null;

function getConfig() {
  const token = process.env.GILSYS_GITHUB_TOKEN || process.env.GITHUB_ACCOUNT_TOKEN || process.env.GITHUB_TOKEN || "";
  const repoSpec = process.env.GILSYS_GITHUB_REPOSITORY || process.env.GITHUB_ACCOUNT_REPOSITORY || process.env.GITHUB_REPOSITORY || "";
  const owner = process.env.GILSYS_GITHUB_OWNER || process.env.GITHUB_ACCOUNT_OWNER || "";
  const repo = process.env.GILSYS_GITHUB_REPO || process.env.GITHUB_ACCOUNT_REPO || "";
  const [repoOwner, repoName] = repoSpec.includes("/") ? repoSpec.split("/", 2) : [owner, repo];
  const branch = process.env.GILSYS_GITHUB_BRANCH || process.env.GITHUB_ACCOUNT_BRANCH || DEFAULT_BRANCH;
  const dataPath = (process.env.GILSYS_GITHUB_DATA_PATH || process.env.GITHUB_ACCOUNT_DATA_PATH || DEFAULT_REMOTE_PATH)
    .replace(/^\/+/, "");

  return {
    enabled: Boolean(token && repoOwner && repoName),
    token,
    owner: repoOwner,
    repo: repoName,
    branch,
    dataPath
  };
}

function encodeContentPath(filePath) {
  return String(filePath || "")
    .split("/")
    .filter(Boolean)
    .map(part => encodeURIComponent(part))
    .join("/");
}

function requestJson(method, apiPath, body = null) {
  const cfg = getConfig();
  const payload = body == null ? null : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.github.com",
      method,
      path: apiPath,
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        "User-Agent": "gilsys-cardbattle-account-storage",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
      }
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { raw += chunk; });
      res.on("end", () => {
        let data = null;
        if (raw) {
          try {
            data = JSON.parse(raw);
          } catch {
            data = { raw };
          }
        }
        resolve({ statusCode: res.statusCode || 0, data });
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function makeContentsPath(cfg) {
  return `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${encodeContentPath(cfg.dataPath)}`;
}

function normalizeRemoteDb(data) {
  if (!data || typeof data !== "object") return { accounts: {} };
  if (!data.accounts || typeof data.accounts !== "object") data.accounts = {};
  return data;
}

export function getGitHubAccountStorageInfo() {
  const cfg = getConfig();
  return {
    enabled: cfg.enabled,
    configured: cfg.enabled,
    repo: cfg.owner && cfg.repo ? `${cfg.owner}/${cfg.repo}` : "",
    branch: cfg.branch,
    dataPath: cfg.dataPath,
    pending: Boolean(pushTimer || pushRunning || pushQueued),
    lastPull,
    lastPush,
    lastError,
    missingEnv: cfg.enabled ? [] : [
      ...(cfg.token ? [] : ["GILSYS_GITHUB_TOKEN"]),
      ...(cfg.owner && cfg.repo ? [] : ["GILSYS_GITHUB_REPOSITORY"])
    ]
  };
}

export async function pullGitHubAccounts() {
  const cfg = getConfig();
  if (!cfg.enabled) {
    return { ok: true, enabled: false, exists: false, reason: "github storage disabled" };
  }

  try {
    const apiPath = `${makeContentsPath(cfg)}?ref=${encodeURIComponent(cfg.branch)}`;
    const res = await requestJson("GET", apiPath);
    if (res.statusCode === 404) {
      lastPull = { ok: true, exists: false, at: Date.now() };
      lastError = "";
      return { ok: true, enabled: true, exists: false };
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const reason = res.data?.message || `GitHub GET failed (${res.statusCode})`;
      lastPull = { ok: false, exists: false, at: Date.now() };
      lastError = reason;
      return { ok: false, enabled: true, exists: false, reason };
    }

    const decoded = Buffer.from(String(res.data?.content || "").replace(/\s/g, ""), "base64").toString("utf8");
    const parsed = normalizeRemoteDb(JSON.parse(decoded || "{}"));
    lastPull = { ok: true, exists: true, at: Date.now(), sha: res.data?.sha || "" };
    lastError = "";
    return { ok: true, enabled: true, exists: true, data: parsed, sha: res.data?.sha || "" };
  } catch (e) {
    const reason = e?.message || String(e);
    lastPull = { ok: false, exists: false, at: Date.now() };
    lastError = reason;
    return { ok: false, enabled: true, exists: false, reason };
  }
}

export async function pushGitHubAccounts(db, { message = "" } = {}) {
  const cfg = getConfig();
  if (!cfg.enabled) {
    return { ok: true, enabled: false, reason: "github storage disabled" };
  }

  try {
    const current = await pullGitHubAccounts();
    if (!current.ok) return current;

    const apiPath = makeContentsPath(cfg);
    const json = JSON.stringify(normalizeRemoteDb(db), null, 2);
    const body = {
      message: message || `chore: sync gilsys account data ${new Date().toISOString()}`,
      content: Buffer.from(json, "utf8").toString("base64"),
      branch: cfg.branch,
      ...(current.sha ? { sha: current.sha } : {})
    };
    const res = await requestJson("PUT", apiPath, body);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const reason = res.data?.message || `GitHub PUT failed (${res.statusCode})`;
      lastPush = { ok: false, at: Date.now() };
      lastError = reason;
      return { ok: false, enabled: true, reason };
    }

    lastPush = { ok: true, at: Date.now(), sha: res.data?.content?.sha || "" };
    lastError = "";
    return { ok: true, enabled: true, sha: res.data?.content?.sha || "" };
  } catch (e) {
    const reason = e?.message || String(e);
    lastPush = { ok: false, at: Date.now() };
    lastError = reason;
    return { ok: false, enabled: true, reason };
  }
}

async function flushQueuedPush() {
  if (pushRunning) {
    pushQueued = true;
    return;
  }
  pushRunning = true;
  pushQueued = false;

  try {
    const readDb = pendingReadDb;
    if (typeof readDb === "function") {
      const db = await readDb();
      await pushGitHubAccounts(db);
    }
  } finally {
    pushRunning = false;
    if (pushQueued) {
      pushQueued = false;
      scheduleGitHubAccountsPush(pendingReadDb, 0);
    }
  }
}

export function scheduleGitHubAccountsPush(readDb, delayMs = PUSH_DEBOUNCE_MS) {
  const cfg = getConfig();
  if (!cfg.enabled || typeof readDb !== "function") return false;
  pendingReadDb = readDb;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    flushQueuedPush().catch(e => {
      lastError = e?.message || String(e);
      lastPush = { ok: false, at: Date.now() };
    });
  }, Math.max(0, Number(delayMs) || 0));
  return true;
}
