// page.pick({prompt, maxPicks, timeoutMs}): the user points at elements on the page and may add a
// note to each; the call returns {status: "done" | "cancelled" | "timeout", picks: [{selector,
// role, name, tag, text, rect, note}]}. The overlay and its state live in the tab's isolated world
// (pick-overlay-source.ts); this side starts it, reads its state every 250 ms, and takes it down on
// timeout. A page that navigates away takes the overlay with it: the call reports "cancelled".
import { PICK_DESCRIBE_SOURCE } from "./pick-describe-source.js";
import { PICK_OVERLAY_SOURCE } from "./pick-overlay-source.js";

export const browserPickApi = `
var __PICK_PAGE_SOURCE = ${JSON.stringify(PICK_DESCRIBE_SOURCE + PICK_OVERLAY_SOURCE)};
var __PICK_READ = '(function () { var s = globalThis.__graftPickState; return s ? {status: s.status, picks: s.picks, navigated: s.navigated === true} : null; })()';
var __PICK_STOP = '(function () { var s = globalThis.__graftPickState; if (s) s.finish("timeout"); return s ? {status: s.status, picks: s.picks} : null; })()';
function __pickOptions(options) {
  if (typeof options === 'string') options = {prompt: options};
  options = options || {};
  var maxPicks = options.maxPicks === undefined ? 0 : Math.floor(Number(options.maxPicks));
  if (!(maxPicks >= 0) || maxPicks > 200) throw Error('INVALID_INPUT: page.pick maxPicks must be a whole number from 1 to 200');
  var timeoutMs = options.timeoutMs === undefined ? 300000 : Number(options.timeoutMs);
  if (!(timeoutMs >= 1000) || timeoutMs > 1800000) throw Error('INVALID_INPUT: page.pick timeoutMs must be 1000 to 1800000 ms');
  return {prompt: options.prompt === undefined ? '' : String(options.prompt).slice(0, 200), maxPicks: maxPicks, timeoutMs: timeoutMs};
}
function __pickResult(status, picks) {
  return {status: status, picks: (picks || []).map((pick) => ({selector: pick.selector, role: pick.role ?? null, name: pick.name ?? null,
    tag: pick.tag, text: pick.text || '', rect: pick.rect, note: pick.note || ''}))};
}
async function __pick(target, options) {
  var settings = __pickOptions(options);
  await __isolatedEval(target, '(function () {' + __PICK_PAGE_SOURCE + '; return __pickStart(' + JSON.stringify(settings) + '); })()');
  var deadline = Date.now() + settings.timeoutMs, last = [];
  while (Date.now() < deadline) {
    await __sleep(250);
    var state = await __isolatedEval(target, __PICK_READ).catch(() => null);
    if (!state || state.navigated) return {...__pickResult('cancelled', []), reason: 'the page navigated away'};
    if (state.status !== 'active') return __pickResult(state.status, state.picks);
    last = state.picks;
  }
  var stopped = await __isolatedEval(target, __PICK_STOP).catch(() => null);
  return __pickResult('timeout', stopped ? stopped.picks : last);
}
`;
