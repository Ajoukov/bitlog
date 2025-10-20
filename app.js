/* -------- small utils -------- */
function decodeHTML(s){ if(!s) return ""; const el=document.createElement("textarea"); el.innerHTML=s; return el.value; }
const $ = sel => document.querySelector(sel);
const api = path => `/api${path}`;

/* inputs / targets */
const nameEl = $("#name");
const passEl = $("#password");
const textEl = $("#text");
const msgEl  = $("#msg");
const whoEl  = $("#who");
const usersUl = $("#users");
const allUl   = $("#all-timeline"); // latest entries
const ul = $("#timeline");

/* ---------- word counting (client guard only) ---------- */
function countWords(s){ const m = String(s||"").match(/\b[\w’'-]+\b/g); return m ? m.length : 0; }

/* ---------- 5am-local “journal day” helpers ---------- */
const JOURNAL_OFFSET_H  = 5;                             // 5-hour cutoff after local midnight
const JOURNAL_OFFSET_MS = JOURNAL_OFFSET_H * 3600 * 1000;
// const JOURNAL_OFFSET_MS = 0;
const pad2 = n => String(n).padStart(2,"0");

/* Map a Date -> "YYYY-MM-DD" using a 5am local cutoff:
   subtract 5h, then format using local Y/M/D. */
function journalLocalISO(d){
  // const adj = new Date(d.getTime() - JOURNAL_OFFSET_MS);
  const adj = new Date(d.getTime());
  // return `${adj.getFullYear()}-${pad2(adj.getMonth()+1)}-${pad2(adj.getDate())}`;
  return `${adj.getUTCFullYear()}-${pad2(adj.getUTCMonth()+1)}-${pad2(adj.getUTCDate())}`;
}

/* Parse backend timestamps:
   - numeric epoch seconds (preferred)
   - numeric string epoch seconds
   - ISO-8601 string (with Z or offset)
   Returns Date or null. */
function parseTSToDate(ts){
  if (ts === null || ts === undefined) return null;

  // numeric
  if (typeof ts === "number") {
    if (!Number.isFinite(ts)) return null;
    const local = new Date(ts * 1000);
    // console.log((local.getYear() + 1900) + " " + local.getMonth() + " " + local.getDate());
    return new Date(Date.UTC(local.getYear() + 1900, local.getMonth(), local.getDate()));
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
    const d = new Date(s.replace("Z","+00:00"));
    return isNaN(d) ? null : d;
  }
  return null;
}

/* Start-of-week (Sunday) in local time */
function startOfWeekLocal(d){
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
    const res = await fetch(api('/entry'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // send no ts; server will fill current UTC epoch seconds (that’s fine)
      body: JSON.stringify({ name, password, text })
    });
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('application/json') ? await res.json()
              : { ok:false, message:(await res.text()).slice(0,200) };
    if (!res.ok || body.ok === false) throw new Error(body.message || res.statusText);

    // body.ts is epoch seconds; format to journal day and show local word count
    const tsDate = parseTSToDate(body.ts);
    const dayStr = tsDate ? journalLocalISO(tsDate) : "(unknown day)";
    msg(`saved for ${dayStr} (${w} word${w===1?"":"s"})${body.overwritten ? " [overwritten]" : ""}`);

    textEl.value = "";
    await Promise.all([load(name), loadAll()]);
  } catch (e) {
    msg(String(e.message || e));
  }
}

/* ---------- per-user views ---------- */
async function load(name){
  if (!name) return;
  whoEl.textContent = decodeHTML(`@${name}`);
  await Promise.all([loadTimeline(name), loadCalendar(name)]);
}

function entries_to_dayToEntry(entries) {
  // Aggregate by journal day (local +5h) -> max word count that day
  const dayToEntry = Object.create(null);
  for (const e of entries) {
    // console.log(e.ts - JOURNAL_OFFSET_MS/1000);
    const key = parseTSToDate(e.ts - JOURNAL_OFFSET_MS/1000);
    // console.log(journalLocalISO(key));
    if (!key)
      continue;
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
      if (Array.isArray(j.entries))
        entries = j.entries;
    }
  } catch { /* ignore; show empty grid */ }
  // console.log(entries);
  return entries_to_dayToEntry(entries);
}

async function loadTimeline(name){
  console.log("loadTimeline: IN");
  ul.innerHTML = "";
  const dayToEntry = await fetch_calendar(name);
  // console.log(dayToEntry);
  const entries = Object.values(dayToEntry).sort((a, b) => b.ts - a.ts);
  // console.log(entries);

  entries.forEach(e => {
    const dObj = e.day;
    // console.log(dObj);
    // console.log(journalLocalISO(dObj));
    // const dayStr = dObj ? journalLocalISO(dObj) : "(unknown day)";
    const dayStr = dObj ? journalLocalISO(dObj) : "(unknown day)";
    const wc = countWords(e.text);

    const li = document.createElement("li");

    const d  = document.createElement("span");
    d.className = "date";
    d.textContent = decodeHTML(`${dayStr} - ${wc} word${wc===1?"":"s"}`);

    const t  = document.createElement("span");
    t.className = "txt";
    t.textContent = decodeHTML(e.text || "");
    t.style.marginLeft = "10px";

    li.appendChild(d); li.appendChild(t);
    ul.appendChild(li);
  });
}

/* ---------- GitHub-style heatmap ---------- */
/* We render weeks as columns and days (Sun..Sat) as rows. */
async function loadCalendar(name){
  const grid = $("#calendar");
  grid.innerHTML = "";

  // Force a GitHub-like grid layout regardless of page CSS
  const CELL = 12; // px; tweak if your stylesheet sizes .day differently
  grid.style.display = "grid";
  grid.style.gridAutoFlow = "column";      // fill down first, then next column
  grid.style.gridTemplateRows = "repeat(7, " + CELL + "px)";
  grid.style.gridTemplateColumns = "repeat(53, " + CELL + "px)";
  grid.style.gap = "3px";

  // Anchor end as "today’s journal day" (5h cutoff), then build 53 weeks (371 days)
  const now = new Date();
  const anchor = new Date(now.getTime() - JOURNAL_OFFSET_MS);
  // const end = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate()); // local midnight of journal day
  const end = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate()); // local midnight of journal day
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  start.setDate(start.getDate() - (7*53 - 1));

  // Snap start to Sunday in local time (so the grid starts at a full week)
  // const firstSunday = startOfWeekLocal(start);
  const firstSunday = new Date(startOfWeekLocal(end).getTime() - 52*7*24*60*60*1000);

  // Fetch timestamped entries: { entries: [{ts, text}, ...] }
  const dayToEntry = await fetch_calendar(name);

  // Build cells column-by-column (weeks), row-by-row (days)
  let cur = new Date(firstSunday.getFullYear(), firstSunday.getMonth(), firstSunday.getDate());
  for (let col = 0; col < 53; col++) {
    for (let row = 0; row < 7; row++) {
      const _d = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate());
      const date = journalLocalISO(_d);      // local 5h day key
      const key = parseTSToDate(date);      // local 5h day key
      const wc = dayToEntry[key] ? countWords(dayToEntry[key].text) : 0;

      const cell = document.createElement("div");
      cell.className = "day";
      if (wc > 0) cell.setAttribute("data-w", String(Math.min(wc, 10)));
      cell.title = `${key} - ${wc} word${wc === 1 ? "" : "s"}`;

      grid.appendChild(cell);
      cur.setDate(cur.getDate() + 1);
    }
  }
}

/* ---------- global users + recent ---------- */
async function loadUsers(){
  usersUl.innerHTML = "";
  try {
    const r = await fetch(api('/users'));
    if (!r.ok) throw new Error("failed to load users");
    const j = await r.json();
    (j.users || []).forEach(u => {
      const li=document.createElement('li');
      const a=document.createElement('a'); a.textContent=decodeHTML('@' + u); a.href="#";
      a.addEventListener('click', (ev)=>{ ev.preventDefault(); nameEl.value=u; load(u); });
      li.appendChild(a); usersUl.appendChild(li);
    });
  } catch { /* ignore */ }
}

async function loadAll(){
  allUl.innerHTML = "";
  const r=await fetch(api('/all_recent?limit=200'));
  if (!r.ok) throw new Error("failed to load recent");
  const j=await r.json();

  let data = Array.isArray(j.entries) ? j.entries : [];
  const byUser = new Map();
  for (const e of data) {
    let user_entries = byUser.get(e.user);
    if (!user_entries) { user_entries = []; byUser.set(e.user, user_entries); }
    user_entries.push(e);
  }
  const merged = [];
  for (const userEntries of byUser.values()) {
    const dayToEntry = entries_to_dayToEntry(userEntries);
    merged.push(...Object.values(dayToEntry));
  }
  const entries = merged.sort((a, b) => b.ts - a.ts);
  console.log(entries);
  entries.forEach(e=>{
    const tsDate = parseTSToDate(e.ts);
    const dayStr = tsDate ? journalLocalISO(tsDate) : "(unknown day)";

    const li=document.createElement('li');
    const meta=document.createElement('span'); meta.className='meta';

    const name=document.createElement('a'); name.textContent=decodeHTML('@' + e.user); name.href='#';
    name.addEventListener('click', (ev)=>{ ev.preventDefault(); nameEl.value=e.user; load(e.user); });

    meta.appendChild(document.createTextNode(`${dayStr} - `));
    meta.appendChild(name);

    const txt=document.createElement('span'); txt.className='txt';
    txt.textContent=decodeHTML(e.text || "");

    li.appendChild(meta); li.appendChild(txt); allUl.appendChild(li);
  });
}

/* ---------- messages & wiring ---------- */
function msg(s){ msgEl.textContent = decodeHTML(s); }

/* wire up */
$("#submit").addEventListener("click", submit);
$("#text").addEventListener("keydown", e=>{ if(e.key==="Enter") submit(); });
$("#name").addEventListener("change", e=> load(e.target.value.trim()));
document.addEventListener("DOMContentLoaded", async ()=>{
  const who=new URLSearchParams(location.search).get("u")||"";
  if (who){ nameEl.value=who; await load(who); }
  await loadUsers(); await loadAll();
});

