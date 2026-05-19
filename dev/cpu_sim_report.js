import { readFileSync, writeFileSync, mkdirSync } from "fs";
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

function pct(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`;
}

function signed(value, digits = 1) {
  const n = Number(value ?? 0);
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}`;
}

function ppDeltaRate(next, prev) {
  return signed((Number(next ?? 0) - Number(prev ?? 0)) * 100, 1);
}

function collectItemUsage(log, job = null) {
  const usage = {};
  for (const match of log.results ?? []) {
    const winner = match.result === "p1" ? match.p1?.job : match.result === "p2" ? match.p2?.job : null;
    for (const d of match.decisions ?? []) {
      if (job && d.actor !== job) continue;
      const item = d.item;
      if (!item) continue;
      const key = item.shikigamiName || item.name || item.summonerDragonType || item.arrowEffect || item.equipType || "unknown";
      usage[key] ??= { total: 0, wins: 0, losses: 0, buy: 0, use: 0, equip: 0 };
      usage[key].total += 1;
      if (d.action === "buy_item") usage[key].buy += 1;
      if (d.action === "use_item") usage[key].use += 1;
      if (["equip", "special", "arrow"].includes(d.action)) usage[key].equip += 1;
      if (winner && winner === d.actor) usage[key].wins += 1;
      else if (winner) usage[key].losses += 1;
    }
  }
  return usage;
}

function topUsageLines(usage, limit = 12) {
  return Object.entries(usage)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, limit)
    .map(([name, v]) => `- ${name}: total ${v.total}, buy ${v.buy}, use ${v.use}, equip ${v.equip}, win logs ${v.wins}, loss logs ${v.losses}`);
}

function bestWorstMatchups(summary, job, count = 3) {
  const rows = Object.entries(summary?.byJobOpponent?.[job] ?? {})
    .map(([opponent, v]) => ({ opponent, ...v }))
    .sort((a, b) => Number(b.winRate ?? 0) - Number(a.winRate ?? 0));
  return {
    best: rows.slice(0, count),
    worst: rows.slice(-count).reverse(),
  };
}

function buildReport(current, baseline = null) {
  const s = current.summary ?? {};
  const b = baseline?.summary ?? null;
  const lines = [];
  lines.push("# CPU Sim Report");
  lines.push("");
  lines.push(`current: ${current.createdAt ?? "unknown"}`);
  if (baseline) lines.push(`baseline: ${baseline.createdAt ?? "unknown"}`);
  lines.push("");

  lines.push("## Overall");
  lines.push(`- matches: ${s.matches ?? 0}`);
  if (b) {
    lines.push(`- averageTurns: ${b.averageTurns} -> ${s.averageTurns} (${signed(Number(s.averageTurns ?? 0) - Number(b.averageTurns ?? 0), 2)})`);
    lines.push(`- first winRate: ${pct(b.byTurnOrder?.first?.winRate)} -> ${pct(s.byTurnOrder?.first?.winRate)} (${ppDeltaRate(s.byTurnOrder?.first?.winRate, b.byTurnOrder?.first?.winRate)}pt)`);
    lines.push(`- second winRate: ${pct(b.byTurnOrder?.second?.winRate)} -> ${pct(s.byTurnOrder?.second?.winRate)} (${ppDeltaRate(s.byTurnOrder?.second?.winRate, b.byTurnOrder?.second?.winRate)}pt)`);
  } else {
    lines.push(`- averageTurns: ${s.averageTurns}`);
    lines.push(`- first winRate: ${pct(s.byTurnOrder?.first?.winRate)}`);
    lines.push(`- second winRate: ${pct(s.byTurnOrder?.second?.winRate)}`);
  }
  lines.push("");

  lines.push("## Job Winrates");
  for (const [job, v] of Object.entries(s.byJob ?? {})) {
    if (b?.byJob?.[job]) {
      lines.push(`- ${job}: ${pct(b.byJob[job].winRate)} -> ${pct(v.winRate)} (${ppDeltaRate(v.winRate, b.byJob[job].winRate)}pt), ${v.wins}-${v.losses}-${v.draws}`);
    } else {
      lines.push(`- ${job}: ${pct(v.winRate)}, ${v.wins}-${v.losses}-${v.draws}`);
    }
  }
  lines.push("");

  if (b) {
    const deltas = [];
    for (const [job, opponents] of Object.entries(s.byJobOpponent ?? {})) {
      for (const [opponent, v] of Object.entries(opponents ?? {})) {
        const prev = b.byJobOpponent?.[job]?.[opponent];
        if (!prev) continue;
        deltas.push({ job, opponent, delta: Number(v.winRate ?? 0) - Number(prev.winRate ?? 0), from: prev.winRate, to: v.winRate });
      }
    }
    deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    lines.push("## Biggest Matchup Changes");
    for (const d of deltas.slice(0, 12)) {
      lines.push(`- ${d.job} vs ${d.opponent}: ${pct(d.from)} -> ${pct(d.to)} (${ppDeltaRate(d.to, d.from)}pt)`);
    }
    lines.push("");
  }

  for (const job of ["陰陽師", "弓兵", "召喚士", "僧侶"]) {
    if (!s.byJobOpponent?.[job]) continue;
    const { best, worst } = bestWorstMatchups(s, job);
    lines.push(`## ${job} Matchups`);
    lines.push(`best: ${best.map(v => `${v.opponent} ${pct(v.winRate)}`).join(", ")}`);
    lines.push(`worst: ${worst.map(v => `${v.opponent} ${pct(v.winRate)}`).join(", ")}`);
    lines.push("");
  }

  const onmyojiUsage = collectItemUsage(current, "陰陽師");
  if (Object.keys(onmyojiUsage).length > 0) {
    lines.push("## Onmyoji Item Usage");
    lines.push(...topUsageLines(onmyojiUsage));
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

const currentPath = getArg("current");
if (!currentPath) {
  console.error("usage: node dev/cpu_sim_report.js --current=tmp/current.json [--baseline=tmp/base.json] [--out=tmp/report.md]");
  process.exit(1);
}

const current = loadJson(currentPath);
const baselinePath = getArg("baseline", null);
const baseline = baselinePath ? loadJson(baselinePath) : null;
const report = buildReport(current, baseline);
const out = getArg("out", null);
if (out) {
  const resolved = path.resolve(process.cwd(), out);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, report, "utf8");
  console.log(`[CPU_REPORT] wrote ${resolved}`);
} else {
  console.log(report);
}
