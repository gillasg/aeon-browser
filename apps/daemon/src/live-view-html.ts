// The live viewer page: no external scripts, styles or fonts. Rows render as a table, tap frames as
// a newest-first log; both arrive over /events.

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `
:root{color-scheme:dark;--bg:#000;--fg:#e6e6e6;--dim:#7a7a7a;--line:#1c1c1c;--ok:#4ade80;--bad:#f87171}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,sans-serif}
header{position:sticky;top:0;background:var(--bg);display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;padding:14px 16px;border-bottom:1px solid var(--line)}
h1{font-size:16px;font-weight:600;margin:0;flex:1 1 auto}.meta{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}
#status::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:var(--bad)}
#status.live::before{background:var(--ok)}main{padding:0 16px 32px}
section{margin-top:18px;overflow-x:auto}h2{font-size:12px;font-weight:500;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis}
th{color:var(--dim);font-weight:500;font-size:12px}ol{list-style:none;margin:0;padding:0;font:12px/1.5 ui-monospace,monospace}
li{padding:4px 0;border-bottom:1px solid var(--line);white-space:pre-wrap;word-break:break-all}.empty{color:var(--dim)}[hidden]{display:none}
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
let rows = [], frames = [];
const cell = (v) => v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
function el(tag, text) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; }
function renderRows() {
  const cols = [...new Set(rows.flatMap((r) => r && typeof r === "object" ? Object.keys(r) : ["value"]))];
  const head = el("tr"); for (const c of cols) head.append(el("th", c));
  const body = rows.map((r) => { const tr = el("tr"); for (const c of cols) tr.append(el("td", cell(r && typeof r === "object" ? r[c] : r))); return tr; });
  $("thead").replaceChildren(head); $("tbody").replaceChildren(...body);
  $("rows").hidden = !rows.length;
}
function renderFrames() {
  $("frames").replaceChildren(...frames.slice().reverse().map((f) => el("li", cell(f))));
  $("log").hidden = !frames.length;
}
function apply(state) {
  if (state.title) { $("title").textContent = state.title; document.title = state.title; }
  if (state.rows) { rows = state.rows; renderRows(); }
  if (state.frames) { frames = state.frames; renderFrames(); }
  if (state.frame !== undefined) { frames.push(state.frame); if (frames.length > MAX_EVENTS) frames.shift(); renderFrames(); }
  $("count").textContent = rows.length + " rows · " + frames.length + " frames";
  if (state.updatedAt) $("updated").textContent = "updated " + new Date(state.updatedAt).toLocaleTimeString();
  $("empty").hidden = rows.length > 0 || frames.length > 0;
}
const source = new EventSource("events");
source.addEventListener("open", () => { $("status").textContent = "live"; $("status").className = "live"; });
source.addEventListener("error", () => { $("status").textContent = "reconnecting"; $("status").className = ""; });
for (const name of ["snapshot", "rows", "frame"]) source.addEventListener(name, (e) => apply(JSON.parse(e.data)));
`;

export function liveViewHtml(title: string, maxEvents: number): string {
  const safe = escapeHtml(title);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safe}</title><style>${STYLE}</style></head>
<body><header><h1 id="title">${safe}</h1><span class="meta" id="status">connecting</span>
<span class="meta" id="count">0 rows · 0 frames</span><span class="meta" id="updated"></span></header>
<main><p class="empty" id="empty">Waiting for data…</p>
<section id="rows" hidden><h2>Rows</h2><table><thead id="thead"></thead><tbody id="tbody"></tbody></table></section>
<section id="log" hidden><h2>Live frames</h2><ol id="frames"></ol></section></main>
<script>const MAX_EVENTS = ${maxEvents};${SCRIPT}</script></body></html>`;
}
