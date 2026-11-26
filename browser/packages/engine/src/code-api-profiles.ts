// browser.profiles(), the {browser: alias} openTab option, browser.pool.map(..., {across}) and
// browser.diff(): one flow run as several Chrome profiles in one cell, and what each one saw.
// Evaluated in the code sandbox with the other APIs.
export const browserProfilesApi = `
async function __profiles() {
  var info = await __call({browserInfo: true}) || {};
  var list = Array.isArray(info.browsers) && info.browsers.length ? info.browsers
    : (info.clientInstanceIds || []).map((id) => ({clientInstanceId: id}));
  return list.map((entry) => ({id: entry.clientInstanceId || entry.id,
    name: entry.name || String(entry.clientInstanceId || entry.id).slice(0, 8),
    ...(entry.label ? {label: entry.label} : {}),
    ...(entry.focused !== undefined ? {focused: entry.focused === true} : {}),
    ...(entry.tabs !== undefined ? {tabs: entry.tabs} : {})}));
}
// A profile by name, label or id prefix, case-insensitive; an exact id or name wins over a prefix.
function __resolveProfile(alias, profiles) {
  var wanted = String(alias).toLowerCase();
  var names = (p) => [p.name, p.label].filter(Boolean).map((n) => String(n).toLowerCase());
  var exact = profiles.filter((p) => p.id.toLowerCase() === wanted || names(p).includes(wanted));
  var hits = exact.length ? exact : profiles.filter((p) => p.id.toLowerCase().startsWith(wanted));
  var known = profiles.map((p) => p.name).join(', ') || 'none connected';
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw Error('UNKNOWN_BROWSER: no profile matches "' + alias + '"; connected: ' + known);
  throw Error('AMBIGUOUS_BROWSER: "' + alias + '" matches ' + hits.map((p) => p.name).join(', ') + '; use a longer name or the id');
}
async function __pickClient(options, last) {
  if (options.clientInstanceId) return options.clientInstanceId;
  if (options.browser) return __resolveProfile(options.browser, await __profiles()).id;
  if (last && last.clientInstanceId) return last.clientInstanceId;
  var profiles = await __profiles();
  if (!profiles.length) throw Error('BROWSER_OFFLINE: no browser executor is connected');
  if (profiles.length === 1) return profiles[0].id;
  var focused = profiles.filter((p) => p.focused);
  if (focused.length === 1) return focused[0].id;
  // The profile owning the active tab of the window the user last focused (P7).
  if (typeof __focusedProfile === 'function') return __focusedProfile(profiles.map((p) => p.id)).catch(() => { throw Error('Multiple browser profiles are connected (' + profiles.map((p) => p.name).join(', ') + '); pass {browser: name}'); });
  throw Error('Multiple browser profiles are connected (' + profiles.map((p) => p.name).join(', ') + '); pass {browser: name}');
}
// background: a new tab placed by the tabPlacement setting; placement picks the space outright.
function __placementStep(options) {
  if (options.placement === 'background-window') return {background: true, space: 'window'};
  if (options.placement === 'current-window-group') return {background: true, space: 'tabs'};
  return options.background === true ? {background: true} : {};
}
// One lane per named profile, all at once: fn(page, item, profile) on each item in that profile's
// own background tab, closed when the lane ends. Returns {[profile]: [{ok, item, value|error}]}.
async function __poolAcross(items, worker, options = {}) {
  var profiles = await __profiles();
  var lanes = options.across.map((alias) => ({alias: String(alias), profile: __resolveProfile(alias, profiles)}));
  var list = Array.from(items), out = {};
  await Promise.all(lanes.map(async (lane) => {
    var page, results = [];
    try {
      for (var item of list) {
        try {
          var url = typeof item === 'string' ? item : item && item.url;
          if (!page) page = await browser.openTab(url || 'about:blank', {clientInstanceId: lane.profile.id, new: true, present: false, background: true});
          else if (url) await page.goto(url, {present: false});
          results.push({ok: true, item, value: await worker(page, item, lane.alias)});
        } catch (error) { results.push({ok: false, item, error: String(error && error.message || error)}); }
      }
    } finally { if (page && page.close) await page.close().catch(() => {}); }
    out[lane.alias] = results;
  }));
  return out;
}
// browser.diff(a, b, {key}): {same, added, removed, changed: [{path, a, b}], summary}. Arrays of
// records are matched by key (as browser.changes does: id, url, href or key), else by index;
// multi-line strings are compared line by line. Pool results ({ok, value}) compare by value.
function __diff(a, b, options = {}) {
  var added = [], removed = [], changed = [];
  var unwrap = (v) => Array.isArray(v) && v.length && v.every((r) => r && typeof r === 'object' && 'ok' in r && 'item' in r)
    ? v.map((r) => r.ok ? r.value : {error: r.error}) : v;
  var keyOf = (item) => typeof options.key === 'function' ? options.key(item)
    : options.key ? item && item[options.key] : item && typeof item === 'object' ? item.id ?? item.url ?? item.href ?? item.key : undefined;
  var join = (path, part) => typeof part === 'number' ? path + '[' + part + ']' : path ? path + '.' + part : part;
  var keyed = (list) => list.length > 0 && list.every((x) => keyOf(x) !== undefined) && new Set(list.map(keyOf)).size === list.length;
  function walk(x, y, path) {
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (typeof x === 'string' && typeof y === 'string' && (x.includes('\\n') || y.includes('\\n'))) {
      var left = x.split('\\n'), right = y.split('\\n');
      right.filter((line) => !left.includes(line)).forEach((line) => added.push({path, value: line}));
      left.filter((line) => !right.includes(line)).forEach((line) => removed.push({path, value: line}));
      return;
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      if (keyed(x) && keyed(y)) {
        var before = new Map(x.map((v) => [String(keyOf(v)), v])), after = new Map(y.map((v) => [String(keyOf(v)), v]));
        for (var [k, v] of after) before.has(k) ? walk(before.get(k), v, join(path, '[' + k + ']')) : added.push({path: join(path, '[' + k + ']'), value: v});
        for (var [k2, v2] of before) if (!after.has(k2)) removed.push({path: join(path, '[' + k2 + ']'), value: v2});
        return;
      }
      for (var i = 0; i < Math.max(x.length, y.length); i++) {
        if (i >= x.length) added.push({path: join(path, i), value: y[i]});
        else if (i >= y.length) removed.push({path: join(path, i), value: x[i]});
        else walk(x[i], y[i], join(path, i));
      }
      return;
    }
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      for (var key of Object.keys(y)) key in x ? walk(x[key], y[key], join(path, key)) : added.push({path: join(path, key), value: y[key]});
      for (var gone of Object.keys(x)) if (!(gone in y)) removed.push({path: join(path, gone), value: x[gone]});
      return;
    }
    changed.push({path: path || '(root)', a: x, b: y});
  }
  walk(unwrap(a), unwrap(b), '');
  var same = !added.length && !removed.length && !changed.length;
  var summary = same ? 'same' : [added.length && added.length + ' added', removed.length && removed.length + ' removed', changed.length && changed.length + ' changed'].filter(Boolean).join(', ')
    + ': ' + [...changed, ...added, ...removed].slice(0, 5).map((d) => d.path).join(', ');
  return {same, added, removed, changed, summary};
}
`;
