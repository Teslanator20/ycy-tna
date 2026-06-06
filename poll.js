import { readFile, writeFile } from "node:fs/promises";

// ──────────────────────────────────────────────────────────────
// Config / constants
// ──────────────────────────────────────────────────────────────
const GUILD_FILE = "guild.json";
const STATE_FILE = "state.json";
const PAIRS_FILE = "pairs.json";
const RUNS_FILE  = "runs.json";

const RANK_ORDER   = ["owner", "chief", "strategist", "captain", "recruiter", "recruit"];
const RUNS_RETAIN_DAYS  = 30;
const BYDAY_RETAIN_DAYS = 60;
const COPRES_MAX_GROUP  = 8;  // ignore "same server" co-presence clusters bigger than this (hub noise)
const RUN_PAIR_MAX      = 6;  // a TNA party is 4; pair within groups up to this, bigger = too ambiguous
const TIMEOUT_MS = 25_000;
const UA = "ycy-tna-tracker/1.0";

// ──────────────────────────────────────────────────────────────
// Fetch
// ──────────────────────────────────────────────────────────────
async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ──────────────────────────────────────────────────────────────
// Parsing — guild endpoint already carries each member's raid totals
// ──────────────────────────────────────────────────────────────
function extractMembers(guild, raidName) {
  const out = [];
  for (const rank of RANK_ORDER) {
    const group = guild?.members?.[rank] || {};
    for (const [username, m] of Object.entries(group)) {
      const tnaRaw = m.globalData?.raids?.list?.[raidName];
      out.push({
        uuid: m.uuid,
        username,
        rank,
        online: !!m.online,
        server: m.online ? (m.server ?? null) : null,
        tna: Number.isFinite(Number(tnaRaw)) ? Number(tnaRaw) : NaN,
        ok: Number.isFinite(Number(tnaRaw)),
      });
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return fallback; }
}
function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
function groupBy(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────
async function main() {
  const cfg = JSON.parse(await readFile(GUILD_FILE, "utf8"));
  const raidName = cfg.raid;

  // ── one cheap call gives TNA totals for EVERY member (online + offline) ──
  const guild = await fetchJson(`https://api.wynncraft.com/v3/guild/prefix/${encodeURIComponent(cfg.prefix)}`);
  const players = extractMembers(guild, raidName);

  const ts = new Date().toISOString();
  const today = ts.slice(0, 10);
  const byDayCutoff = new Date(Date.now() - BYDAY_RETAIN_DAYS * 86400_000).toISOString().slice(0, 10);

  const prev = await loadJson(STATE_FILE, { members: {} });
  const prevMembers = prev.members || {};

  // ── build new member state + detect TNA increments (for ALL members) ──
  const newMembers = {};
  const incrementers = []; // {uuid, username, delta, server}
  for (const p of players) {
    const pm = prevMembers[p.uuid] || {};
    const hadTna = Number.isFinite(pm.tna);
    const tna = p.ok ? p.tna : (hadTna ? pm.tna : NaN);

    // increment over the last poll — works regardless of online status, because the
    // guild endpoint reflects a member's TNA total even when they appear offline/hidden
    const delta = (p.ok && hadTna) ? Math.max(0, p.tna - pm.tna) : 0;

    let baselineTna = pm.baselineTna;
    let baselineTs = pm.baselineTs;
    if (!Number.isFinite(baselineTna) && Number.isFinite(tna)) { baselineTna = tna; baselineTs = ts; }

    const byDay = {};
    for (const [d, v] of Object.entries(pm.byDay || {})) if (d >= byDayCutoff) byDay[d] = v;
    if (Number.isFinite(tna)) byDay[today] = tna;

    newMembers[p.uuid] = {
      username: p.username,
      rank: p.rank,
      online: p.online,
      server: p.online ? p.server : null,
      tna: Number.isFinite(tna) ? tna : null,
      baselineTna: Number.isFinite(baselineTna) ? baselineTna : null,
      baselineTs: baselineTs ?? null,
      gained: (Number.isFinite(tna) && Number.isFinite(baselineTna)) ? tna - baselineTna : 0,
      lastSeen: p.online ? ts : (pm.lastSeen ?? null),
      lastRaid: delta > 0 ? ts : (pm.lastRaid ?? null),
      byDay,
    };

    if (delta > 0) {
      // prefer current server; fall back to last-known so caching lag still groups
      incrementers.push({ uuid: p.uuid, username: p.username, delta, server: p.server ?? pm.server ?? null });
    }
  }

  // ── pair accumulators ──
  const pairs = await loadJson(PAIRS_FILE, { tna: {}, copresence: {} });
  if (!pairs.tna) pairs.tna = {};
  if (!pairs.copresence) pairs.copresence = {};
  const nameOf = (uuid) => newMembers[uuid]?.username ?? uuid;

  function bumpPair(bucket, a, b, fields) {
    const key = pairKey(a, b);
    const e = bucket[key] || { a: a < b ? a : b, b: a < b ? b : a };
    for (const f of fields) e[f] = (e[f] || 0) + 1;
    e.usernameA = nameOf(e.a);
    e.usernameB = nameOf(e.b);
    e.lastTs = ts;
    bucket[key] = e;
  }

  // ── 1) co-presence: online members on the same server right now ──
  const onlineNow = players.filter(p => p.online && p.server);
  for (const [, group] of groupBy(onlineNow, p => p.server)) {
    if (group.length < 2 || group.length > COPRES_MAX_GROUP) continue;
    for (let x = 0; x < group.length; x++)
      for (let y = x + 1; y < group.length; y++)
        bumpPair(pairs.copresence, group[x].uuid, group[y].uuid, ["samples"]);
  }

  // ── 2) TNA co-runs: members whose TNA total rose this window ──
  // Group by server; treat null (offline/hidden) as "offline". If exactly ONE real
  // server-party finished this window, fold the offline raiders into it (they almost
  // certainly belong to that single party). Otherwise offline raiders group together
  // as a lower-confidence "window-only" run.
  const groups = groupBy(incrementers, p => p.server ?? "offline");
  const serverKeys = [...groups.keys()].filter(k => k !== "offline");
  if (groups.has("offline") && serverKeys.length === 1) {
    groups.get(serverKeys[0]).push(...groups.get("offline"));
    groups.delete("offline");
  }

  const detectedRuns = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const serverConfirmed = key !== "offline";
    detectedRuns.push({
      ts,
      server: serverConfirmed ? key : null,
      confirmed: serverConfirmed,
      crowded: group.length > RUN_PAIR_MAX,
      players: group.map(g => ({ uuid: g.uuid, username: g.username, delta: g.delta })),
    });
    if (group.length > RUN_PAIR_MAX) continue; // too many at once → ambiguous, log but don't pair
    for (let x = 0; x < group.length; x++)
      for (let y = x + 1; y < group.length; y++) {
        const fields = serverConfirmed ? ["count", "confirmed"] : ["count"];
        bumpPair(pairs.tna, group[x].uuid, group[y].uuid, fields);
      }
  }
  const soloCount = [...groups.values()].filter(g => g.length < 2).flat().length;
  pairs.updated = ts;

  // ── 3) runs log ──
  const runsLog = await loadJson(RUNS_FILE, { runs: [] });
  if (!Array.isArray(runsLog.runs)) runsLog.runs = [];
  runsLog.runs.push(...detectedRuns);
  const runsCutoff = Date.now() - RUNS_RETAIN_DAYS * 86400_000;
  runsLog.runs = runsLog.runs.filter(r => new Date(r.ts).getTime() >= runsCutoff);
  runsLog.updated = ts;

  // ── 4) state ──
  const onlineCount = players.filter(p => p.online).length;
  const okCount = players.filter(p => p.ok).length;
  const state = {
    updated: ts,
    guild: { name: guild.name ?? cfg.name, prefix: guild.prefix ?? cfg.prefix, raid: raidName, raidShort: cfg.raidShort, color: cfg.color },
    online: onlineCount,
    memberCount: players.length,
    members: newMembers,
  };

  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  await writeFile(PAIRS_FILE, JSON.stringify(pairs, null, 2) + "\n");
  await writeFile(RUNS_FILE, JSON.stringify(runsLog, null, 2) + "\n");

  console.log(
    `OK members=${players.length} ok=${okCount} online=${onlineCount} | ` +
    `incr=${incrementers.length} runs=${detectedRuns.length} solo=${soloCount} | ` +
    `tnaPairs=${Object.keys(pairs.tna).length} copresPairs=${Object.keys(pairs.copresence).length}`
  );
  for (const r of detectedRuns)
    console.log(`  run @${r.server ?? "offline/hidden"}${r.crowded ? " [crowded]" : ""}: ${r.players.map(p => `${p.username}(+${p.delta})`).join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
