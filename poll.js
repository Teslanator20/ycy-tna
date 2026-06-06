import { readFile, writeFile } from "node:fs/promises";

// ──────────────────────────────────────────────────────────────
// Config / constants
// ──────────────────────────────────────────────────────────────
const GUILD_FILE = "guild.json";
const STATE_FILE = "state.json";
const PAIRS_FILE = "pairs.json";
const RUNS_FILE  = "runs.json";

const RANK_ORDER   = ["owner", "chief", "strategist", "captain", "recruiter", "recruit"];
const RUNS_RETAIN_DAYS = 30;
const BYDAY_RETAIN_DAYS = 60;
const MAX_GROUP = 8;          // ignore "same server" clusters bigger than this (hub noise)
const TIMEOUT_MS = 25_000;
const CONCURRENCY = 3;        // PLAYER bucket is 50/min — stay gentle
const MAX_PLAYER_FETCH = 48;  // hard cap per poll to never blow the bucket
const UA = "ycy-tna-tracker/1.0";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ──────────────────────────────────────────────────────────────
// Fetch helpers
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

// rate-limit-aware fetch: on HTTP 429, wait the reset window and retry
async function fetchJsonRL(url, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
      if (r.status === 429 && attempt < retries) {
        const reset = Number(r.headers.get("ratelimit-reset")) || 30;
        clearTimeout(t);
        await sleep((reset + 1) * 1000);
        continue;
      }
      if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }
}

// run async tasks with a concurrency cap, returning results in order
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ──────────────────────────────────────────────────────────────
// Parsing
// ──────────────────────────────────────────────────────────────
function extractGuildMembers(guild) {
  const out = [];
  for (const rank of RANK_ORDER) {
    const group = guild?.members?.[rank] || {};
    for (const [username, m] of Object.entries(group)) {
      out.push({
        uuid: m.uuid,
        username,
        rank,
        online: !!m.online,
        server: m.online ? (m.server ?? null) : null,
      });
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
// File IO
// ──────────────────────────────────────────────────────────────
async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return fallback; }
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// group an array of {uuid,...} by a key function, dropping null/empty keys
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

  // 1) guild roster (online + server for everyone) — one cheap GUILD-bucket call
  const guild = await fetchJson(`https://api.wynncraft.com/v3/guild/prefix/${encodeURIComponent(cfg.prefix)}`);
  const roster = extractGuildMembers(guild);

  // 2) per-player raid counts — ONLY for members currently online (PLAYER bucket = 50/min).
  //    TNA totals only rise while online, so this misses no increments while staying rate-safe.
  const onlineRoster = roster.filter(m => m.online).slice(0, MAX_PLAYER_FETCH);
  const fetched = await mapLimit(onlineRoster, CONCURRENCY, async (m) => {
    try {
      const p = await fetchJsonRL(`https://api.wynncraft.com/v3/player/${m.uuid}`);
      return {
        ...m,
        username: p.username ?? m.username,
        online: p.online ?? m.online,
        server: (p.online ? (p.server ?? m.server) : null),
        tna: Number(p.globalData?.raids?.list?.[raidName] ?? NaN),
        ok: Number.isFinite(Number(p.globalData?.raids?.list?.[raidName])),
      };
    } catch {
      return { ...m, tna: NaN, ok: false };
    }
  });
  const fetchedByUuid = new Map(fetched.map(p => [p.uuid, p]));

  // combine: online members carry fresh data; offline members are carried forward from state
  const players = roster.map(m => fetchedByUuid.get(m.uuid) || { ...m, tna: NaN, ok: false });

  const ts = new Date().toISOString();
  const today = ts.slice(0, 10);
  const byDayCutoff = new Date(Date.now() - BYDAY_RETAIN_DAYS * 86400_000).toISOString().slice(0, 10);

  // 3) previous state
  const prev = await loadJson(STATE_FILE, { members: {} });
  const prevMembers = prev.members || {};

  // 4) build new member state + detect TNA increments
  const newMembers = {};
  const incrementers = []; // {uuid, username, delta, server}
  for (const p of players) {
    const pm = prevMembers[p.uuid] || {};
    const hadTna = Number.isFinite(pm.tna);
    const tna = p.ok ? p.tna : (hadTna ? pm.tna : NaN);

    // delta only trusted for co-run pairing when the member was online last poll too
    // (a continuous session ⇒ the increment really happened in this 5-min window)
    let delta = 0;
    const continuous = p.ok && hadTna && pm.online === true && p.online === true;
    if (continuous) delta = Math.max(0, p.tna - pm.tna);

    // baseline = first time we ever saw a valid count for this member
    let baselineTna = pm.baselineTna;
    let baselineTs = pm.baselineTs;
    if (!Number.isFinite(baselineTna) && Number.isFinite(tna)) {
      baselineTna = tna;
      baselineTs = ts;
    }

    // daily history
    const byDay = {};
    for (const [d, v] of Object.entries(pm.byDay || {})) if (d >= byDayCutoff) byDay[d] = v;
    if (Number.isFinite(tna)) byDay[today] = tna;

    // last-known server (use current if online, else keep previous known)
    const server = p.server ?? pm.server ?? null;

    newMembers[p.uuid] = {
      username: p.username,
      rank: p.rank,
      online: !!p.online,
      server: p.online ? p.server : null,
      lastServer: server,
      tna: Number.isFinite(tna) ? tna : null,
      baselineTna: Number.isFinite(baselineTna) ? baselineTna : null,
      baselineTs: baselineTs ?? null,
      gained: (Number.isFinite(tna) && Number.isFinite(baselineTna)) ? tna - baselineTna : 0,
      lastSeen: p.online ? ts : (pm.lastSeen ?? null),
      byDay,
    };

    if (delta > 0) {
      incrementers.push({
        uuid: p.uuid,
        username: p.username,
        delta,
        // prefer current server; fall back to last-known so caching lag still groups
        server: p.server ?? pm.server ?? null,
      });
    }
  }

  // 5) pair accumulators
  const pairs = await loadJson(PAIRS_FILE, { tna: {}, copresence: {} });
  if (!pairs.tna) pairs.tna = {};
  if (!pairs.copresence) pairs.copresence = {};

  const nameOf = (uuid) => newMembers[uuid]?.username ?? uuid;

  function bumpPair(bucket, a, b, field) {
    const key = pairKey(a, b);
    const e = bucket[key] || { a: a < b ? a : b, b: a < b ? b : a, [field]: 0 };
    e[field] = (e[field] || 0) + 1;
    e.usernameA = nameOf(e.a);
    e.usernameB = nameOf(e.b);
    e.lastTs = ts;
    bucket[key] = e;
  }

  // 5a) co-presence: online members on the same server right now
  const onlineNow = players.filter(p => p.online && p.server);
  const byServerNow = groupBy(onlineNow, p => p.server);
  for (const [, group] of byServerNow) {
    if (group.length < 2 || group.length > MAX_GROUP) continue;
    for (let x = 0; x < group.length; x++)
      for (let y = x + 1; y < group.length; y++)
        bumpPair(pairs.copresence, group[x].uuid, group[y].uuid, "samples");
  }

  // 5b) TNA co-runs: members whose TNA count rose this window, grouped by server
  const detectedRuns = [];
  const byServerInc = groupBy(incrementers, p => p.server);
  for (const [server, group] of byServerInc) {
    if (group.length < 2) continue;
    detectedRuns.push({
      ts,
      server,
      players: group.map(g => ({ uuid: g.uuid, username: g.username, delta: g.delta })),
    });
    for (let x = 0; x < group.length; x++)
      for (let y = x + 1; y < group.length; y++)
        bumpPair(pairs.tna, group[x].uuid, group[y].uuid, "count");
  }
  // solo increments (no detected partner this window) — useful context, not paired
  const soloInc = [...byServerInc.values()].filter(g => g.length < 2).flat()
    .concat(incrementers.filter(p => p.server == null));

  pairs.updated = ts;

  // 6) runs log (retain window)
  const runsLog = await loadJson(RUNS_FILE, { runs: [] });
  if (!Array.isArray(runsLog.runs)) runsLog.runs = [];
  runsLog.runs.push(...detectedRuns);
  const runsCutoff = Date.now() - RUNS_RETAIN_DAYS * 86400_000;
  runsLog.runs = runsLog.runs.filter(r => new Date(r.ts).getTime() >= runsCutoff);
  runsLog.updated = ts;

  // 7) state meta
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
    `incr=${incrementers.length} runs=${detectedRuns.length} solo=${soloInc.length} | ` +
    `tnaPairs=${Object.keys(pairs.tna).length} copresPairs=${Object.keys(pairs.copresence).length}`
  );
  if (detectedRuns.length) {
    for (const r of detectedRuns)
      console.log(`  run @${r.server}: ${r.players.map(p => `${p.username}(+${p.delta})`).join(", ")}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
