// Speed tips from what the cells actually did, not from what the code looks like: two or more
// sites worked one after another (the same steps could have run in parallel tabs), and a run of
// tiny cells (every cell costs a model turn of several seconds). Each tip shows once per realm,
// after a cell that worked, through __tip. Evaluated in the code sandbox with the other APIs.
export const browserSpeedApi = String.raw`
var __speedCells = [];
var __speedNow = null;
var __speedShown = new Set();
function __speedBegin() { __speedNow = {at: Date.now(), hosts: new Set(), steps: 0, actions: 0}; }
function __speedHost(url) {
  try {
    var parsed = new URL(String(url || ''));
    return /^https?:$/.test(parsed.protocol) ? parsed.hostname.toLowerCase().replace(/^www[.]/, '') : '';
  } catch { return ''; }
}
// Called by __step for every step with a target: which site it ran on, and whether it acted.
function __speedNote(url, action) {
  if (!__speedNow) return;
  __speedNow.steps++;
  if (action) __speedNow.actions++;
  var host = __speedHost(url);
  if (host) __speedNow.hosts.add(host);
}
function __speedEnd() {
  if (!__speedNow) return;
  var cell = __speedNow;
  __speedNow = null;
  __speedCells.push({ms: Date.now() - cell.at, hosts: [...cell.hosts], steps: cell.steps, actions: cell.actions});
  if (__speedCells.length > 40) __speedCells.shift();
}
// Consecutive cells on one site each, grouped into runs; a cell on several sites at once means
// the work is already parallel, so the runs before it no longer count.
function __speedRuns() {
  var runs = [];
  for (var cell of __speedCells) {
    if (cell.hosts.length > 1) { runs = []; continue; }
    if (!cell.hosts.length) continue;
    var last = runs[runs.length - 1];
    if (last && last.host === cell.hosts[0]) { last.cells++; last.ms += cell.ms; }
    else runs.push({host: cell.hosts[0], cells: 1, ms: cell.ms});
  }
  return runs;
}
function __speedSerialTip() {
  var runs = __speedRuns();
  if (runs.length < 2) return '';
  var a = runs[runs.length - 2], b = runs[runs.length - 1];
  if (a.cells < 2 || b.cells < 2) return '';
  var seconds = Math.round((a.ms + b.ms) / 1000);
  return a.host + ' and ' + b.host + ' were worked one after another (' + (a.cells + b.cells) + ' cells, ' + seconds +
    ' s of browser time, plus a model turn per cell). If more sites or pages need the same steps, run them together: one tab each and Promise.all over the tabs for every shared step, or browser.pool(urls, async (page, url) => …); steps in different tabs run at the same time. help(\'parallel\')';
}
function __speedTinyTip() {
  var recent = __speedCells.slice(-5);
  if (recent.length < 5) return '';
  if (!recent.every((cell) => cell.steps > 0 && cell.actions <= 1 && cell.ms < 3000)) return '';
  return 'the last 5 cells each did one quick step, and every cell costs a model turn of several seconds. When you already know the next steps, do them in one cell (fill, click and read together; locators wait for their element, and the page state prints after the cell).';
}
function __speedTip() {
  for (var [name, make] of [['serial', __speedSerialTip], ['tiny', __speedTinyTip]]) {
    if (__speedShown.has(name)) continue;
    var text = make();
    if (text) { __speedShown.add(name); return text; }
  }
  return '';
}
`;
