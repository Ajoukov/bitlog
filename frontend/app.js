/* -------- small utils -------- */
function decodeHTML(s) {
  if (!s) return "";
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}
const $ = (sel) => document.querySelector(sel);
// const api = (path) => `https://bitlog.us/api${path}`;
// const api = (path) => `http://18.118.32.133/api${path}`;
// const api = (path) => `https://18.118.32.133/api${path}`;
const api = (path) => `/api${path}`;

/* inputs / targets */
const nameEl = $("#name");
const passEl = $("#password");
const textEl = $("#text");
const msgEl = $("#msg");
const whoEl = $("#who");
const usersUl = $("#users");
const allUl = $("#all-timeline"); // latest entries
const ul = $("#timeline");
const userModal = $("#user-modal");
const modalUsers = $("#modal-users");
const modalSearch = $("#modal-search");

/* ---------- word counting (client guard only) ---------- */

// function countWords(s) {
//   const m = String(s || "").match(/\b[\w’'-]+\b/gu);
//   return m ? m.length : 0;
// }

const WORD_RE =
  /(?:^|[^\p{L}\p{M}\p{N}_])([\p{L}\p{M}\p{N}_]+(?:[’'-][\p{L}\p{M}\p{N}_]+)*)/gu;

function countWords(s) {
  let n = 0;
  for (const _ of htmlToText(String(s ?? "")).matchAll(WORD_RE)) n++;
  return n;
}

/* ---------- interestingness scoring for heatmap ---------- */
function scoreEntry(text) {
  const plain = htmlToText(String(text ?? ""));
  const matches = [...plain.matchAll(WORD_RE)].map(m => m[1]);
  const words = matches.length;
  if (words === 0) return 0;

  // 1. Word count (0–2 pts)
  const wcScore = Math.min(words / 5, 2);

  // 2. Average word length (0–2.5 pts)
  const avgLen = matches.reduce((s, w) => s + w.length, 0) / words;
  const avgScore = Math.min(Math.max((avgLen - 3) / 2, 0), 2.5);

  // 3. Unique word ratio (0–2 pts)
  const unique = new Set(matches.map(w => w.toLowerCase()));
  const uniqScore = (unique.size / words) * 2;

  // 4. Event density (0–2 pts) — sentence-like segments
  const segments = plain.split(/[.;!?]+/).filter(s => s.trim().length > 0).length;
  const densityScore = Math.min(Math.max((segments - 1) / 3, 0), 2);

  // 5. Specificity (0–1.5 pts) — caps not at sentence start + digits in words
  let specCount = 0;
  const sentences = plain.split(/[.;!?]+/).filter(s => s.trim().length > 0);
  const sentenceStartWords = new Set();
  for (const sent of sentences) {
    const first = [...sent.trim().matchAll(WORD_RE)];
    if (first.length > 0) sentenceStartWords.add(first[0][1]);
  }
  for (const w of matches) {
    if (/\d/.test(w)) { specCount++; continue; }
    if (/^\p{Lu}/u.test(w) && !sentenceStartWords.has(w)) specCount++;
  }
  const specScore = Math.min(specCount * 0.3, 1.5);

  const total = wcScore + avgScore + uniqScore + densityScore + specScore;
  return Math.round(Math.min(total, 10));
}

/* ---------- 5am-local "journal day" helpers ---------- */
const JOURNAL_OFFSET_H = 5; // 5-hour cutoff after local midnight
const JOURNAL_OFFSET_MS = JOURNAL_OFFSET_H * 3600 * 1000;
// const JOURNAL_OFFSET_MS = 0;
const pad2 = (n) => String(n).padStart(2, "0");
function ordinalSuffix(n) {
  const j = n % 10;
  const k = n % 100;
  if (j === 1 && k !== 11) return "st";
  if (j === 2 && k !== 12) return "nd";
  if (j === 3 && k !== 13) return "rd";
  return "th";
}

/* Map a Date -> "YYYY-MM-DD" using a 5am local cutoff:
   subtract 5h, then format using local Y/M/D. */
function journalLocalISO(d) {
  // const adj = new Date(d.getTime() - JOURNAL_OFFSET_MS);
  const adj = new Date(d.getTime());
  // return `${adj.getFullYear()}-${pad2(adj.getMonth()+1)}-${pad2(adj.getDate())}`;
  return `${adj.getUTCFullYear()}-${pad2(adj.getUTCMonth() + 1)}-${pad2(
    adj.getUTCDate()
  )}`;
}

/* Parse backend timestamps:
   - numeric epoch seconds (preferred)
   - numeric string epoch seconds
   - ISO-8601 string (with Z or offset)
   Returns Date or null. */
function parseTSToDate(ts) {
  if (ts === null || ts === undefined) return null;

  // numeric
  if (typeof ts === "number") {
    if (!Number.isFinite(ts)) return null;
    const local = new Date(ts * 1000);
    // console.log((local.getYear() + 1900) + " " + local.getMonth() + " " + local.getDate());
    return new Date(
      Date.UTC(local.getYear() + 1900, local.getMonth(), local.getDate())
    );
  }
  // decimal-as-string or plain int string
  if (typeof ts === "string") {
    const s = ts.trim();
    // numeric string?
    if (/^[+-]?\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n)) return null;
      return new Date(Math.trunc(n) * 1000);
    }
    // ISO
    const d = new Date(s.replace("Z", "+00:00"));
    return isNaN(d) ? null : d;
  }
  return null;
}

/* Start-of-week (Sunday) in local time */
function startOfWeekLocal(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay(); // 0=Sun
  x.setDate(x.getDate() - dow);
  return x;
}

/* ---------- submit ---------- */
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
      // send no ts; server will fill current UTC epoch seconds (that’s fine)
      body: JSON.stringify({ name, password, text }),
    });
    const ct = res.headers.get("content-type") || "";
    const body = ct.includes("application/json")
      ? await res.json()
      : { ok: false, message: (await res.text()).slice(0, 200) };
    if (!res.ok || body.ok === false)
      throw new Error(body.message || res.statusText);

    // body.ts is epoch seconds; format to journal day and show local word count
    const tsDate = parseTSToDate(body.ts);
    const dayStr = tsDate ? journalLocalISO(tsDate) : "(unknown day)";
    msg(
      `saved for ${dayStr} (${w} word${w === 1 ? "" : "s"})${
        body.overwritten ? " [overwritten]" : ""
      }`
    );

    textEl.value = "";
    await Promise.all([load(name), loadAll()]);
  } catch (e) {
    msg(String(e.message || e));
  }
}

/* ---------- per-user views ---------- */
async function load(name) {
  if (!name) return;
  whoEl.textContent = decodeHTML(`@${name}`);
  await Promise.all([loadTimeline(name), loadCalendar(name)]);
}

function entries_to_dayToEntry(entries) {
  // Aggregate by journal day (local +5h) -> max word count that day
  const dayToEntry = Object.create(null);
  for (const e of entries) {
    // console.log(e.ts - JOURNAL_OFFSET_MS/1000);
    const key = parseTSToDate(e.ts - JOURNAL_OFFSET_MS / 1000);
    // console.log(journalLocalISO(key));
    if (!key) continue;
    if (!dayToEntry[key] || e.ts > dayToEntry[key].ts)
      dayToEntry[key] = { text: e.text, day: key, ts: e.ts, user: e.user };
  }
  return dayToEntry;
}

async function fetch_calendar(name) {
  let entries = [];
  try {
    const res = await fetch(api(`/calendar/${encodeURIComponent(name)}`));
    if (res.ok) {
      const j = await res.json();
      if (Array.isArray(j.entries)) entries = j.entries;
    }
  } catch {
    /* ignore; show empty grid */
  }
  // console.log(entries);
  return entries_to_dayToEntry(entries);
}

async function loadTimeline(name) {
  console.log("loadTimeline: IN");
  ul.innerHTML = "";
  const dayToEntry = await fetch_calendar(name);
  // console.log(dayToEntry);
  const entries = Object.values(dayToEntry).sort((a, b) => b.ts - a.ts);
  // console.log(entries);

  entries.forEach((e) => {
    const dObj = e.day;
    // console.log(dObj);
    // console.log(journalLocalISO(dObj));
    // const dayStr = dObj ? journalLocalISO(dObj) : "(unknown day)";
    const dayStr = dObj ? journalLocalISO(dObj) : "(unknown day)";
    const wc = countWords(e.text);

    const li = document.createElement("li");

    const d = document.createElement("span");
    d.className = "date";
    d.textContent = decodeHTML(`${dayStr} - ${wc} word${wc === 1 ? "" : "s"}`);

    const t = document.createElement("span");
    t.className = "txt";
    t.textContent = decodeHTML(e.text || "");
    t.style.marginLeft = "10px";

    li.appendChild(d);
    li.appendChild(t);
    ul.appendChild(li);
  });
}

/* ---------- GitHub-style heatmap ---------- */
/* Auto-scroll calendar to rightmost side on mobile */
function scrollCalendarToRight() {
  const grid = $("#calendar");
  if (!grid) return;
  // Check if mobile viewport (matches CSS media query)
  if (window.innerWidth <= 640) {
    // Use requestAnimationFrame to ensure DOM is fully rendered
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        grid.scrollLeft = grid.scrollWidth - grid.clientWidth;
      });
    });
  }
}

/* We render weeks as columns and days (Sun..Sat) as rows. */
async function loadCalendar(name) {
  const grid = $("#calendar");
  grid.innerHTML = "";

  // Force a GitHub-like grid layout regardless of page CSS
  const CELL = 12; // px; tweak if your stylesheet sizes .day differently
  grid.style.display = "grid";
  grid.style.gridAutoFlow = "column"; // fill down first, then next column
  grid.style.gridTemplateRows = "repeat(7, " + CELL + "px)";
  grid.style.gridTemplateColumns = "repeat(53, " + CELL + "px)";
  grid.style.gap = "3px";

  // Anchor end as "today’s journal day" (5h cutoff), then build 53 weeks (371 days)
  const now = new Date();
  const anchor = new Date(now.getTime() - JOURNAL_OFFSET_MS);
  // const end = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate()); // local midnight of journal day
  const end = new Date(
    anchor.getFullYear(),
    anchor.getMonth(),
    anchor.getDate()
  ); // local midnight of journal day
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  start.setDate(start.getDate() - (7 * 53 - 1));

  // Snap start to Sunday in local time (so the grid starts at a full week)
  // const firstSunday = startOfWeekLocal(start);
  const firstSunday = new Date(
    startOfWeekLocal(end).getTime() - 52 * 7 * 24 * 60 * 60 * 1000
  );

  // Fetch timestamped entries: { entries: [{ts, text}, ...] }
  const dayToEntry = await fetch_calendar(name);

  // Build cells column-by-column (weeks), row-by-row (days)
  let cur = new Date(
    firstSunday.getFullYear(),
    firstSunday.getMonth(),
    firstSunday.getDate()
  );
  for (let col = 0; col < 53; col++) {
    for (let row = 0; row < 7; row++) {
      const _d = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate());
      const date = journalLocalISO(_d); // local 5h day key
      const key = parseTSToDate(date); // local 5h day key
      const score = dayToEntry[key] ? scoreEntry(dayToEntry[key].text) : 0;

      const cell = document.createElement("div");
      cell.className = "day";
      if (score > 0) cell.setAttribute("data-w", String(score));
      const monthName = _d.toLocaleString("en-US", { month: "long" });
      const dayNum = _d.getDate();
      const yearNum = _d.getFullYear();
      const ord = ordinalSuffix(dayNum);
      cell.title = `score ${score}/10 on ${monthName} ${dayNum}${ord} ${yearNum}`;

      grid.appendChild(cell);
      cur.setDate(cur.getDate() + 1);
    }
  }
  scrollCalendarToRight();
}

/* ---------- global users + recent ---------- */
async function loadUsers() {
  usersUl.innerHTML = "";
  modalUsers.innerHTML = "";
  try {
    const r = await fetch(api("/users"));
    if (!r.ok) throw new Error("failed to load users");
    const j = await r.json();
    const users = j.users || [];

    // Modal: @everyone first
    const evLi = document.createElement("li");
    evLi.textContent = "@everyone";
    evLi.addEventListener("click", () => {
      nameEl.value = "";
      showEveryone();
      closeModal();
    });
    modalUsers.appendChild(evLi);

    users.forEach((u) => {
      // Sidebar list
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.textContent = decodeHTML("@" + u);
      a.href = "#";
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        nameEl.value = u;
        load(u);
      });
      li.appendChild(a);
      usersUl.appendChild(li);

      // Modal list
      const mLi = document.createElement("li");
      mLi.textContent = "@" + u;
      mLi.addEventListener("click", () => {
        nameEl.value = u;
        load(u);
        closeModal();
      });
      modalUsers.appendChild(mLi);
    });
  } catch {
    /* ignore */
  }
}

async function loadAll() {
  allUl.innerHTML = "";
  const r = await fetch(api("/all_recent?limit=200"));
  if (!r.ok) throw new Error("failed to load recent");
  const j = await r.json();

  let data = Array.isArray(j.entries) ? j.entries : [];
  const byUser = new Map();
  for (const e of data) {
    let user_entries = byUser.get(e.user);
    if (!user_entries) {
      user_entries = [];
      byUser.set(e.user, user_entries);
    }
    user_entries.push(e);
  }
  const merged = [];
  for (const userEntries of byUser.values()) {
    const dayToEntry = entries_to_dayToEntry(userEntries);
    merged.push(...Object.values(dayToEntry));
  }
  const entries = merged.sort((a, b) => b.ts - a.ts);
  console.log(entries);
  entries.forEach((e) => {
    const dayStr = e.day ? journalLocalISO(e.day) : "(unknown day)";

    const li = document.createElement("li");
    const meta = document.createElement("span");
    meta.className = "meta";

    const name = document.createElement("a");
    name.textContent = decodeHTML("@" + e.user);
    name.href = "#";
    name.addEventListener("click", (ev) => {
      ev.preventDefault();
      nameEl.value = e.user;
      load(e.user);
    });

    meta.appendChild(document.createTextNode(`${dayStr} - `));
    meta.appendChild(name);

    const txt = document.createElement("span");
    txt.className = "txt";
    txt.textContent = decodeHTML(e.text || "");

    li.appendChild(meta);
    li.appendChild(txt);
    allUl.appendChild(li);
  });
}

/* ---------- global heatmap (all users) ---------- */
async function loadGlobalCalendar() {
  const grid = $("#calendar");
  if (!grid) return;
  grid.innerHTML = "";

  const CELL = 12;
  grid.style.display = "grid";
  grid.style.gridAutoFlow = "column";
  grid.style.gridTemplateRows = "repeat(7, " + CELL + "px)";
  grid.style.gridTemplateColumns = "repeat(53, " + CELL + "px)";
  grid.style.gap = "3px";

  // Pull a large recent window to approximate the last year across all users
  const r = await fetch(api("/all_recent?limit=5000"));
  if (!r.ok) return;
  const j = await r.json();
  const entries = Array.isArray(j.entries) ? j.entries : [];

  // Build day -> set(users) so each user counts at most once per day
  const dayToUsers = new Map(); // key: YYYY-MM-DD, value: Set of user names
  for (const e of entries) {
    const d = parseTSToDate(e.ts);
    if (!d) continue;
    const dayStr = journalLocalISO(d);
    let set = dayToUsers.get(dayStr);
    if (!set) {
      set = new Set();
      dayToUsers.set(dayStr, set);
    }
    if (e.user) set.add(e.user);
  }

  // Build a fixed 53x7 grid covering the last 371 days ending today
  const now = new Date();
  const anchor = new Date(now.getTime() - JOURNAL_OFFSET_MS);
  const end = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  start.setDate(start.getDate() - (7 * 53 - 1));
  const firstSunday = new Date(startOfWeekLocal(end).getTime() - 52 * 7 * 24 * 60 * 60 * 1000);

  let cur = new Date(firstSunday.getFullYear(), firstSunday.getMonth(), firstSunday.getDate());
  for (let col = 0; col < 53; col++) {
    for (let row = 0; row < 7; row++) {
      const _d = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate());
      const dayStr = journalLocalISO(_d);
      const contributors = dayToUsers.get(dayStr)?.size || 0;

      const cell = document.createElement("div");
      cell.className = "day";
      if (contributors > 0) {
        // Steeper contrast curve for global view
        let shade;
        if (contributors === 1) shade = 2;
        else if (contributors === 2) shade = 5;
        else if (contributors === 3) shade = 7;
        else if (contributors === 4) shade = 9;
        else shade = 10;
        cell.setAttribute("data-w", String(shade));
      }

      const monthName = _d.toLocaleString("en-US", { month: "long" });
      const dayNum = _d.getDate();
      const yearNum = _d.getFullYear();
      const ord = ordinalSuffix(dayNum);
      cell.title = `${contributors} ${contributors === 1 ? "contributor" : "contributors"} on ${monthName} ${dayNum}${ord} ${yearNum}`;

      grid.appendChild(cell);
      cur.setDate(cur.getDate() + 1);
    }
  }
  scrollCalendarToRight();
}

function htmlToText(s) {
  const doc = new DOMParser().parseFromString(String(s ?? ""), "text/html");
  return doc.body.textContent ?? "";
}

/* ---------- global timeline (all users) ---------- */
async function loadGlobalTimeline() {
  ul.innerHTML = "";
  const r = await fetch(api("/all_recent?limit=5000"));
  if (!r.ok) return;
  const j = await r.json();

  let data = Array.isArray(j.entries) ? j.entries : [];
  const byUser = new Map();
  for (const e of data) {
    let user_entries = byUser.get(e.user);
    if (!user_entries) {
      user_entries = [];
      byUser.set(e.user, user_entries);
    }
    user_entries.push(e);
  }
  const merged = [];
  for (const userEntries of byUser.values()) {
    const dayToEntry = entries_to_dayToEntry(userEntries);
    merged.push(...Object.values(dayToEntry));
  }
  const entries = merged.sort((a, b) => b.ts - a.ts);

  entries.forEach((e) => {
    const dayStr = e.day ? journalLocalISO(e.day) : "(unknown day)";
    const wc = countWords(e.text);
    // console.log(e.text);
    // console.log(wc);

    const li = document.createElement("li");

    const d = document.createElement("span");
    d.className = "date";
    d.appendChild(
      document.createTextNode(
        `${dayStr} - ${wc} word${wc === 1 ? "" : "s"} - `
      )
    );
    const name = document.createElement("a");
    name.textContent = decodeHTML("@" + e.user);
    name.href = "#";
    name.addEventListener("click", (ev) => {
      ev.preventDefault();
      nameEl.value = e.user;
      load(e.user);
    });
    d.appendChild(name);

    const t = document.createElement("span");
    t.className = "txt";
    t.textContent = decodeHTML(e.text || "");
    t.style.marginLeft = "10px";

    li.appendChild(d);
    li.appendChild(t);
    ul.appendChild(li);
  });
}

/* ---------- view toggling ---------- */
async function showEveryone() {
  whoEl.textContent = decodeHTML("@everyone");
  await loadGlobalCalendar();
  await loadGlobalTimeline();
}

/* ---------- user-picker modal ---------- */
function isMobile() {
  return window.innerWidth <= 640;
}

function openModal() {
  modalSearch.value = "";
  filterModalUsers("");
  userModal.classList.add("open");
  modalSearch.focus();
}

function closeModal() {
  userModal.classList.remove("open");
  modalSearch.value = "";
  filterModalUsers("");
}

function filterModalUsers(q) {
  const term = q.toLowerCase();
  modalUsers.querySelectorAll("li").forEach((li) => {
    li.style.display = li.textContent.toLowerCase().includes(term) ? "" : "none";
  });
}

/* close on backdrop click */
userModal.addEventListener("click", (e) => {
  if (e.target === userModal) closeModal();
});

/* search filtering */
modalSearch.addEventListener("input", (e) => {
  filterModalUsers(e.target.value);
});

/* #who tap opens modal on mobile */
whoEl.addEventListener("click", () => {
  if (isMobile()) openModal();
});

/* ---------- messages & wiring ---------- */
function msg(s) {
  msgEl.textContent = decodeHTML(s);
}

/* wire up */
$("#submit").addEventListener("click", submit);
$("#text").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submit();
});
$("#name").addEventListener("change", (e) => load(e.target.value.trim()));
const everyoneBtn = $("#everyone-btn");
if (everyoneBtn) everyoneBtn.addEventListener("click", (e) => {
  e.preventDefault();
  nameEl.value = "";
  showEveryone();
});
document.addEventListener("DOMContentLoaded", async () => {
  const who = new URLSearchParams(location.search).get("u") || "";
  if (who) {
    nameEl.value = who;
    await load(who);
  }
  if (!who) {
    await showEveryone();
  }
  await loadUsers();
  await loadAll();
});
