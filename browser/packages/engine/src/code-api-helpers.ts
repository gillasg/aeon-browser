// Page-side helpers for the browser_code API, evaluated in the same realm as code-api.ts. Each
// export is spliced into browserCodeApi verbatim, so the realm source is unchanged.

export const browserEmulationShims = `// Chrome accepts every alert/confirm/prompt by default; this lets the agent decline or answer them.
function __dialogShim(policy) {
  var accept = policy.mode !== 'dismiss';
  window.confirm = (message) => { console.info('[dialog confirm] ' + message + (accept ? ' (accepted)' : ' (dismissed)')); return accept; };
  window.prompt = (message, value) => { console.info('[dialog prompt] ' + message); return accept ? (policy.promptText || value || '') : null; };
  window.alert = (message) => { console.info('[dialog alert] ' + message); };
}
var __devices = {
  iphone: {width: 390, height: 844, scale: 3, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'},
  android: {width: 412, height: 915, scale: 2.625, userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'},
  ipad: {width: 820, height: 1180, scale: 2, userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'},
};
function __geolocationShim(coords) {
  var geo = navigator.geolocation;
  if (!geo || !/native code/.test(Function.prototype.toString.call(geo.getCurrentPosition))) return;
  var real = { get: geo.getCurrentPosition.bind(geo), watch: geo.watchPosition.bind(geo) };
  var position = () => ({ coords: { ...coords, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
  // Use the real location when it answers: the user's position is more useful than the preset one.
  // Fall back on a denial, and on macOS when the OS location service never answers at all: without
  // a deadline getCurrentPosition hangs the page's evaluate forever instead of giving the coords.
  var answer = (call, ok, fail, options) => {
    var done = false;
    var timer = setTimeout(() => { if (!done) { done = true; ok(position()); } }, 1500);
    var settle = (value, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!error) ok(value);
      else if (error.code === 1) ok(position());
      else if (fail) fail(error);
    };
    return call((value) => settle(value), (error) => settle(undefined, error), options);
  };
  geo.getCurrentPosition = (ok, fail, options) => answer(real.get, ok, fail, options);
  geo.watchPosition = (ok, fail, options) => answer(real.watch, ok, fail, options);
}`;

export const browserInputFieldHelpers = `function __holdMs(options) {
  if (!options || options.ms === undefined || options.ms === null) return undefined;
  var ms = Math.round(Number(options.ms));
  if (!Number.isFinite(ms)) return undefined;
  return Math.max(0, Math.min(15000, ms));
}
function __holdFields(options) {
  var ms = __holdMs(options);
  return ms === undefined ? {} : {ms: ms};
}
function __stepTimeout(options) {
  if (!options) return undefined;
  var raw = options.timeoutMs ?? options.timeout;
  if (raw === undefined || raw === null) return undefined;
  var ms = Math.round(Number(raw));
  return Number.isFinite(ms) ? Math.max(100, Math.min(120000, ms)) : undefined;
}
// Playwright's button and modifiers, as the protocol fields. Unknown names are left out.
function __pointerFields(options) {
  if (!options) return {};
  var fields = {};
  if (options.human === true) fields.human = true;
  var timeoutMs = __stepTimeout(options);
  if (timeoutMs !== undefined) fields.timeoutMs = timeoutMs;
  var button = String(options.button || '').toLowerCase();
  if ({left:1, middle:1, right:1, back:1, forward:1}[button]) fields.button = button;
  var raw = options.modifiers;
  if (raw === undefined || raw === null || raw === '') return fields;
  var alias = {command:'meta', ctrl:'control'};
  var names = Array.isArray(raw) ? raw : String(raw).split(/[+,]/);
  var modifiers = [];
  for (var i = 0; i < names.length && modifiers.length < 4; i++) {
    var key = alias[String(names[i]).trim().toLowerCase()] || String(names[i]).trim().toLowerCase();
    if ({alt:1, control:1, meta:1, shift:1}[key] && modifiers.indexOf(key) < 0) modifiers.push(key);
  }
  if (modifiers.length) fields.modifiers = modifiers;
  return fields;
}`;
