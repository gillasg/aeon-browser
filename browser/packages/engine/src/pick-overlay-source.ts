// The overlay page.pick() shows the user: an outline and badge on the hovered element, and a small
// bar with the prompt, the count, a note field, Done and Cancel. It lives in a closed shadow root
// (page CSS cannot reach it, page scripts cannot open it) on a host that ignores the pointer, and
// it runs in the tab's isolated world, so page scripts never see its state. While it is up, a
// trusted click on the page picks the element and does nothing else (no link, no form submit).
// Page-side JavaScript in a string, with __pickDescribe from pick-describe-source.ts.
// __pickStart(options) starts it; globalThis.__graftPickState holds {status, picks, finish}.

export const PICK_OVERLAY_SOURCE = String.raw`
var __PICK_CSS = ':host{all:initial}' +
  '.box{position:fixed;pointer-events:none;border:2px solid #2563eb;border-radius:3px;background:rgba(37,99,235,.08);display:none;box-sizing:border-box}' +
  '.badge{position:fixed;pointer-events:none;font:600 11px/16px system-ui,sans-serif;color:#fff;background:#2563eb;padding:1px 6px;border-radius:3px;display:none;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis}' +
  '.bar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);pointer-events:auto;display:flex;gap:8px;align-items:center;' +
  'font:13px/1.3 system-ui,sans-serif;color:#111;background:#fff;border:1px solid #d4d4d8;border-radius:10px;padding:8px 10px;box-shadow:0 6px 24px rgba(0,0,0,.18);max-width:min(640px,calc(100vw - 32px))}' +
  '.prompt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}.count{color:#52525b;white-space:nowrap}' +
  'input{font:inherit;border:1px solid #d4d4d8;border-radius:6px;padding:4px 6px;width:180px}input[hidden]{display:none}' +
  'button{font:inherit;border:1px solid #d4d4d8;border-radius:6px;padding:4px 10px;background:#f4f4f5;color:#111;cursor:pointer}' +
  'button.done{background:#111;color:#fff;border-color:#111}';
function __pickBuild(options) {
  var host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  var root = host.attachShadow({mode: 'closed'});
  var make = function (tag, className, text) { var node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
  var style = make('style'); style.textContent = __PICK_CSS;
  var box = make('div', 'box'), badge = make('div', 'badge'), bar = make('div', 'bar');
  var prompt = make('span', 'prompt', options.prompt || 'Click elements to pick them');
  var count = make('span', 'count', '0 picked');
  var note = make('input', 'note'); note.placeholder = 'Add a note (optional)'; note.hidden = true; note.setAttribute('aria-label', 'Note');
  var add = make('button', 'add', 'Add'); add.hidden = true;
  var done = make('button', 'done', 'Done'), cancel = make('button', 'cancel', 'Cancel');
  bar.append(prompt, count, note, add, done, cancel);
  root.append(style, box, badge, bar);
  (document.body || document.documentElement).appendChild(host);
  return {host: host, box: box, badge: badge, count: count, note: note, add: add, done: done, cancel: cancel};
}
function __pickLabel(described) {
  return described.tag + (described.role && described.role !== described.tag ? ' · ' + described.role : '') + (described.name ? ' · ' + described.name.slice(0, 40) : '');
}
function __pickShow(ui, element) {
  if (!element || element === ui.host) { ui.box.style.display = 'none'; ui.badge.style.display = 'none'; return; }
  var rect = element.getBoundingClientRect();
  Object.assign(ui.box.style, {display: 'block', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px'});
  ui.badge.textContent = __pickLabel({tag: element.localName, role: __pickRole(element), name: __pickName(element, __pickRole(element))});
  Object.assign(ui.badge.style, {display: 'block', left: Math.max(0, rect.left) + 'px', top: Math.max(0, rect.top - 20) + 'px'});
}
function __pickOwn(ui, event) {
  return event.target === ui.host || (event.composedPath && event.composedPath().indexOf(ui.host) >= 0);
}
function __pickStart(options) {
  var old = globalThis.__graftPickState;
  if (old && old.status === 'active') old.finish('cancelled');
  var ui = __pickBuild(options), picks = [], max = options.maxPicks || 0;
  var state = {status: 'active', picks: picks, finish: null};
  var commit = function () {
    var text = ui.note.value.trim().slice(0, 500);
    if (picks.length && text) picks[picks.length - 1].note = text;
    ui.note.value = '';
  };
  var finish = function (status) {
    if (state.status !== 'active') return;
    if (status === 'done') commit();
    state.status = status;
    if (status === 'cancelled') picks.length = 0;
    for (var i = 0; i < listeners.length; i++) window.removeEventListener(listeners[i][0], listeners[i][1], true);
    ui.host.remove();
  };
  state.finish = finish;
  var pick = function (element) {
    commit();
    if (max && picks.length >= max) return;
    var described = __pickDescribe(element);
    described.note = '';
    picks.push(described);
    ui.count.textContent = picks.length + ' picked';
    ui.note.hidden = false; ui.add.hidden = false;
    ui.note.focus();
  };
  var swallow = function (event) {
    if (!event.isTrusted || __pickOwn(ui, event)) return false;
    event.preventDefault(); event.stopImmediatePropagation();
    return true;
  };
  var listeners = __pickListeners(ui, state, pick, swallow, commit, max);
  for (var i = 0; i < listeners.length; i++) window.addEventListener(listeners[i][0], listeners[i][1], true);
  ui.done.addEventListener('click', function () { finish('done'); });
  ui.cancel.addEventListener('click', function () { finish('cancelled'); });
  ui.add.addEventListener('click', function () { commit(); ui.note.hidden = true; ui.add.hidden = true; });
  globalThis.__graftPickState = state;
  return true;
}
function __pickListeners(ui, state, pick, swallow, commit, max) {
  var hover = function (event) { if (!__pickOwn(ui, event)) __pickShow(ui, event.target); };
  var press = function (event) { swallow(event); };
  var click = function (event) { if (swallow(event) && event.target && event.target.nodeType === 1) pick(event.target); };
  var key = function (event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); state.finish('cancelled'); return; }
    if (!__pickOwn(ui, event)) return;
    event.stopImmediatePropagation();
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commit();
    if (max && state.picks.length >= max) state.finish('done');
  };
  var stop = function (event) { if (__pickOwn(ui, event)) event.stopImmediatePropagation(); };
  var gone = function () { state.finish('cancelled'); state.navigated = true; };
  return [['pointermove', hover], ['mouseover', hover], ['pointerdown', press], ['mousedown', press], ['pointerup', press],
    ['mouseup', press], ['click', click], ['auxclick', press], ['dblclick', press], ['submit', press], ['keydown', key],
    ['keyup', stop], ['keypress', stop], ['pagehide', gone]];
}
`;
