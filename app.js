// Utilities
function decodeHTML(s) {
  if (!s) return "";
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}
const $   = sel  => document.querySelector(sel);
const api = path => `/api${path}`;

// DOM refs
const nameEl  = $("#name");
const passEl  = $("#password");
const textEl  = $("#text");
const msgEl   = $("#msg");
const whoEl   = $("#who");
const usersUl = $("#users");
const allUl   = $("#all-timeline");

// ---- Journal boundary: local time + 5 hours ----
const JOURNAL_OFFSET_H  = 5; // submit at 03:30 local -> still previous day
const JOURNAL_OFFSET_MS = JOURNAL_OFFSET_H * 3600 * 1000;
const pad2 = n => String(n).padStart(2, "0");

// Normalize to local midnight (handles DST safely)
function localMidnight(d) {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

// Week starts Sunday; for Monday start, change to ((dow+6)%7)
function startOfWeekLocal(d) {
  const x = localMidnight(d);
  const dow = x.getDay(); // 0=Sun
  x.setDate(x.getDate() - dow);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Build journal key "YYYY-MM-DD" using 5am-local cutoff.
// We subtract 5h (wall clock), then format using local Y/M/D.
function journalISO(d) {
  const adj = new Date(d.getTime() - JOURNAL_OFFSET_MS);
  return `${adj.getFullYear()}-${pad2(adj.getMonth() + 1)}-${pad2(adj.getDate())}`;
}

// Also handy: pure local date (no offset) and UTC date strings
function localISO(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}
function utcISO(d) {
  return d.toISOString().slice(0, 10);
}

// Robust timestamp extractor → milliseconds (Number).
// Accepts: ms, seconds, ISO, "YYYY-MM-DD", numeric strings, various field names.
// Returns NaN if nothing usable found.
function extractTsMs(entry) {
  if (entry == null || typeof entry !== "object") return NaN;

  let ts = entry.ts ?? entry.timestamp ?? entry.time ?? entry.date ?? entry.created_at ?? entry.createdAt ?? entry.created ?? entry._ts ?? entry.t;
  if (ts == null) return NaN;

  if (typeof ts === "string" && /^\d+$/.test(ts.trim())) {
    const n = Number(ts.trim());
    return n < 1e12 ? n * 1000 : n;
  }
  if (typeof ts === "string") {
    const p = Date.parse(ts);
    if (!Number.isNaN(p)) return p;
  }
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return ts < 1e12 ? ts * 1000 : ts;
  }
  if (typeof ts === "object") {
    if (ts instanceof Date) return ts.getTime();
    const sec = ts.seconds ?? ts._seconds ?? ts.epoch ?? ts.s;
    const ms  = ts.milliseconds ?? ts._milliseconds ?? ts.ms ?? ts.m;
    if (Number.isFinite(ms)) return ms;
    if (Number.isFinite(sec)) return sec * 1000;
  }
  return NaN;
}

// Count words in a short text (supports curly apostrophes)
function countWords(s) {
  const m = String(s || "").match(/\b[\w’'-]+\b/g);
  return m ? m.length : 0;
}

// Messaging
function msg(s) { msgEl.textContent = decodeHTML(String(s || "")); }

// ----- Actions -----
async function submit() {
  const name = nameEl.value.trim();
  const password = passEl.value;
  const text = textEl.value.trim();

  if (!name) return msg("name required");
  const w = countWords(text);
  if (w === 0) return msg("entry text required");
  if (w > 10) return msg("max 10 words");

  try {
    const res = await fetch(api("/entry"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, password, text })
    });

    const ct = res.headers.get("content-type") || "";
    const body = ct.includes("application/json")
      ? await res.json()
      : { ok: false, message: (await res.text()).slice(0, 200) };

    if (!res.ok || body.ok === false) throw new Error(body.message || res.statusText);

    // For the toast only: infer date from returned timestamp if present, else now.
    let tsMs = extractTsMs(body);
    if (!Number.isFinite(tsMs)) tsMs = Date.now();
    const computedDay = journalISO(new Date(tsMs));

    msg(`saved for ${computedDay} (${w})${body.overwritten ? " [overwritten]" : ""}`);
    textEl.value = "";

    await Promise.all([load(name), loadAll()]);
  } catch (e) {
    msg(String(e?.message || e));
  }
}

async function load(name) {
  if (!name) return;
  whoEl.textContent = decodeHTML(`@${name}`);
  await Promise.all([loadTimeline(name), loadCalendar(name)]);
}

async function loadTimeline(name) {
  const ul = $("#timeline");
  ul.innerHTML = "";
  try {
    const res = await fetch(api(`/user/${encodeURIComponent(name)}`));
    if (!res.ok) throw new Error("user not found");
    const j = await res.json();

    (j.entries || []).forEach(e => {
      const text = String(e.text || "");
      const wc   = countWords(text);
      const tsMs = extractTsMs(e);

      const dKey = Number.isFinite(tsMs)
        ? journalISO(new Date(tsMs))
        : (String(e.day || "").slice(0,10) || journalISO(new Date())); // keeps old entries visible if they only had a day string

      const li = document.createElement("li");

      const d = document.createElement("span");
      d.className = "date";
      d.textContent = decodeHTML(`${dKey} - ${wc} word${wc === 1 ? "" : "s"}`);

      const t = document.createElement("span");
      t.className = "txt";
      t.textContent = decodeHTML(text);
      t.style.marginLeft = "10px";

      li.appendChild(d);
      li.appendChild(t);
      ul.appendChild(li);
    });
  } catch (e) {
    msg(String(e?.message || e));
  }
}

/* ===========================
   Heatmap (printing only)
   - Uses /api/calendar/:name data
   - Robust key matching
   - GitHub-style layout (weeks as columns, Sun..Sat rows)
   =========================== */
function normalizeCalendarData(raw) {
  // raw is expected to be an object: { "YYYY-MM-DD": number, ... }
  // Build three lookup maps keyed by ms(local midnight) for robustness:
  //  A) interpret keys as 5am-offset local days
  //  B) interpret keys as local calendar days (no offset)
  //  C) interpret keys as UTC calendar days
  const A = new Map(); // 5h-offset
  const B = new Map(); // local
  const C = new Map(); // UTC
  if (!raw || typeof raw !== "object") return { A, B, C };

  for (const [k, v] of Object.entries(raw)) {
    const wc = Number(v) || 0;
    if (!wc) continue;

    // Try to parse "YYYY-MM-DD"
    let y=NaN,m=NaN,d=NaN;
    const m0 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k);
    if (m0) { y = +m0[1]; m = +m0[2]; d = +m0[3]; }

    // If parseable, compute ms keys three ways:
    if (!Number.isNaN(y)) {
      // (B) local midnight (no offset)
      const local = new Date(y, m-1, d, 0, 0, 0, 0);
      const keyB = local.getTime();
      B.set(keyB, (B.get(keyB) || 0) + wc);

      // (A) 5h offset: the *journal* day that would show that label.
      // We want: date label K corresponds to dK, whose journal day midnight
      // is (local midnight at y-m-d) + 5h. The actual cell key is that time.
      // To match our journalISO(d) on any Date d, we derive a representative
      // Date at local midnight and then *add* the offset to locate the cell’s
      // representative moment. When we build the grid we subtract 5h before formatting,
      // so here we ensure correspondence by inverting.
      const localPlus5h = new Date(local.getTime() + JOURNAL_OFFSET_MS);
      const keyA = localPlus5h.getTime(); // representative ms for A
      A.set(keyA, (A.get(keyA) || 0) + wc);

      // (C) UTC midnight of that label
      const utc = Date.UTC(y, m-1, d);
      C.set(utc, (C.get(utc) || 0) + wc);
    } else {
      // Fallback: try Date.parse and derive variants
      const p = Date.parse(k);
      if (!Number.isNaN(p)) {
        const dt = new Date(p);

        const local = localMidnight(dt).getTime();
        B.set(local, (B.get(local) || 0) + wc);

        const a = new Date(local + JOURNAL_OFFSET_MS).getTime();
        A.set(a, (A.get(a) || 0) + wc);

        const utc = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
        C.set(utc, (C.get(utc) || 0) + wc);
      }
    }
  }
  return { A, B, C };
}

function lookupCalendarCountForDate(d, maps) {
  // d is a Date for the grid cell (actual calendar day at *local midnight* of that cell).
  // We try to match using the three maps; we compute representative ms the same ways.
  const localMs = localMidnight(d).getTime(); // B basis
  const aMs     = new Date(localMs + JOURNAL_OFFSET_MS).getTime(); // A basis
  const utcMs   = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); // C basis

  // Prefer A (journal 5h), then B (local), then C (UTC)
  if (maps.A.has(aMs)) return maps.A.get(aMs);
  if (maps.B.has(localMs)) return maps.B.get(localMs);
  if (maps.C.has(utcMs)) return maps.C.get(utcMs);
  return 0;
}

async function loadCalendar(name) {
  const container = $("#calendar");
  container.innerHTML = "";

  // Layout to GitHub-style columns (weeks) with 7 rows (Sun..Sat)
  container.style.display = "flex";
  container.style.flexDirection = "row";
  container.style.alignItems = "flex-start";
  container.style.gap = "2px";

  // Anchor "today" to the current journal day (local with 5am cutoff)
  const now    = new Date();
  const anchor = new Date(now.getTime() - JOURNAL_OFFSET_MS);
  const end    = localMidnight(anchor);
  const start  = localMidnight(new Date(end)); start.setDate(start.getDate() - 364);
  const weeks  = 53;

  // Fetch aggregated calendar data; DO NOT change your collection mechanism
  let raw = {};
  try {
    const res = await fetch(api(`/calendar/${encodeURIComponent(name)}`));
    if (res.ok) raw = await res.json();
  } catch { /* ignore */ }

  const maps = normalizeCalendarData(raw);

  // Build columns
  let colStart = startOfWeekLocal(start);
  for (let w = 0; w < weeks; w++) {
    const weekCol = document.createElement("div");
    weekCol.className = "week";
    weekCol.style.display = "flex";
    weekCol.style.flexDirection = "column";
    weekCol.style.gap = "2px";

    for (let r = 0; r < 7; r++) {
      const d = new Date(colStart.getTime());
      d.setDate(d.getDate() + r);

      const key = journalISO(d); // tooltip label with 5h cutoff
      const wc  = lookupCalendarCountForDate(d, maps);

      const cell = document.createElement("div");
      cell.className = "day";
      // If you already style via CSS, remove these sizes:
      cell.style.width  = "10px";
      cell.style.height = "10px";
      cell.style.borderRadius = "2px";

      if (wc > 0) cell.setAttribute("data-w", String(Math.min(wc, 10)));
      cell.title = `${key} - ${wc} word${wc === 1 ? "" : "s"}`;

      weekCol.appendChild(cell);
    }

    container.appendChild(weekCol);
    colStart.setDate(colStart.getDate() + 7);
    colStart = localMidnight(colStart);
  }
}

// Users list
async function loadUsers() {
  usersUl.innerHTML = "";
  try {
    const r = await fetch(api("/users"));
    const j = await r.json();
    (j.users || []).forEach(u => {
      const li = document.createElement("li");
      const a  = document.createElement("a");
      a.textContent = decodeHTML("@" + u);
      a.href = "#";
      a.addEventListener("click", ev => { ev.preventDefault(); nameEl.value = u; load(u); });
      li.appendChild(a);
      usersUl.appendChild(li);
    });
  } catch { /* ignore */ }
}

// Recent feed (derive day & word count locally for display only)
async function loadAll() {
  allUl.innerHTML = "";
  try {
    const r = await fetch(api("/all_recent?limit=200"));
    const j = await r.json();
    (j.entries || []).forEach(e => {
      const user = e.user || e.name || "";
      const text = String(e.text || "");
      const wc   = countWords(text);
      const tsMs = extractTsMs(e);
      const dKey = Number.isFinite(tsMs)
        ? journalISO(new Date(tsMs))
        : (String(e.day || "").slice(0,10) || journalISO(new Date()));

      const li   = document.createElement("li");
      const meta = document.createElement("span");
      meta.className = "meta";
      const name = document.createElement("a");
      name.textContent = decodeHTML("@" + user);
      name.href = "#";
      name.addEventListener("click", ev => { ev.preventDefault(); nameEl.value = user; load(user); });

      meta.appendChild(document.createTextNode(`${dKey} - `));
      meta.appendChild(name);

      const txt = document.createElement("span");
      txt.className = "txt";
      txt.textContent = decodeHTML(text);

      li.appendChild(meta);
      li.appendChild(txt);
      allUl.appendChild(li);
    });
  } catch { /* ignore */ }
}

// Wire up UI
$("#submit").addEventListener("click", submit);
$("#text").addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
$("#name").addEventListener("change", e => load(e.target.value.trim()));

document.addEventListener("DOMContentLoaded", async () => {
  const who = new URLSearchParams(location.search).get("u") || "";
  if (who) { nameEl.value = who; await load(who); }
  await loadUsers();
  await loadAll();
});

