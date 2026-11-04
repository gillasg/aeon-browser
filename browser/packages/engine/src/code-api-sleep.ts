// Blind sleeps in a cell end when the page settles. Agents write
// `await new Promise(r => setTimeout(r, 4000))` after a click "to let the page update", though
// every action already waits for its page to settle; one real chat spent 140 s of 510 s in such
// sleeps. A timer the cell's own code sets (not the runtime's), for 0.8 to 20 s, within 15 s of an
// action on a tab, now fires once that tab is quiet (no DOM changes and no requests in flight for
// 500 ms, the engine's settle step) or at its full time, whichever is first, and never before
// 300 ms. The cell is told how much waiting was saved. `page.waitForTimeout(ms)` keeps the exact
// wait, for pacing on purpose.

export const browserSleepApi = `
var __realSetTimeout = setTimeout, __realClearTimeout = clearTimeout;
var __acted = {at: 0, target: null}, __sleepSaved = 0, __sleepCut = 0, __cancelledTimers = new Set();
function __noteActed(target) { if (target) { __acted.at = Date.now(); __acted.target = target; } }
// Only timers set directly by the cell's code: the cell is evaluated as aeon-cell.js.
function __fromCell() {
  var frames = String(new Error().stack || '').split(String.fromCharCode(10));
  return /aeon-cell\\.js/.test(frames[3] || '');
}
function __settledSleep(fn, delay, args) {
  var started = Date.now(), fired = false, target = __acted.target, id;
  var fire = () => {
    if (fired || __cancelledTimers.has(id)) return;
    fired = true;
    __realClearTimeout(id);
    var waited = Date.now() - started;
    if (delay - waited > 250) { __sleepSaved += delay - waited; __sleepCut++; }
    fn(...args);
  };
  id = __realSetTimeout(fire, delay);
  __step({op: 'settle', target, quietMs: 500, timeoutMs: Math.max(delay - 50, 100)})
    .then((result) => {
      if (!result || !result.data || !result.data.settled) return;
      __realSetTimeout(fire, Math.max(0, 300 - (Date.now() - started)));
    })
    .catch(() => {});
  return id;
}
globalThis.setTimeout = function (fn, ms, ...args) {
  var delay = Number(ms) || 0;
  if (typeof fn !== 'function' || delay < 800 || delay > 20000 || !__acted.target || Date.now() - __acted.at > 15000 || !__fromCell())
    return __realSetTimeout(fn, ms, ...args);
  return __settledSleep(fn, delay, args);
};
globalThis.clearTimeout = function (id) { __cancelledTimers.add(id); return __realClearTimeout(id); };
function __sleepReport() {
  if (!__sleepCut) return '';
  var line = '[sleep] ' + __sleepCut + ' wait' + (__sleepCut > 1 ? 's' : '') + ' ended ' + (__sleepSaved / 1000).toFixed(1) + ' s early, when the page settled: actions already wait for the page, so drop blind sleeps (page.waitForTimeout(ms) waits the full time)';
  __sleepSaved = 0; __sleepCut = 0; __cancelledTimers.clear();
  return line;
}
`;
