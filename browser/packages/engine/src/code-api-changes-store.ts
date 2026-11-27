// browser.changes(name, items, {key}): what is new, changed or gone since the last call with that
// name. The sets are kept by the Graft daemon (its SQLite store) per watcher, or per chat outside
// one, so a check still compares against its last run after the daemon or the browser restarts.
// A failed read must not become the new baseline: {failed: true}, or a page whose main document
// came back with HTTP 400 or more, answers {skipped: true} and leaves the stored set as it was.
// Polling sees only the state at each check: a value that goes A → B → A between two checks is
// never reported.
export const browserChangesApi = `
var __changeSets = new Map();
function __changesKeyOf(options) {
  return (item) => String(typeof options.key === 'function' ? options.key(item)
    : options.key ? item && item[options.key]
    : item && typeof item === 'object' ? item.id ?? item.url ?? item.href ?? item.key ?? JSON.stringify(item) : item);
}
function __changesDiff(before, now) {
  if (!before) return {first: true, new: [], changed: [], gone: [], count: now.size};
  var fresh = [], changed = [], gone = [];
  for (var [key, item] of now) {
    if (!before.has(key)) fresh.push(item);
    else if (JSON.stringify(before.get(key)) !== JSON.stringify(item)) changed.push({before: before.get(key), after: item});
  }
  for (var [key, item] of before) if (!now.has(key)) gone.push(item);
  return {first: false, new: fresh, changed, gone, count: now.size};
}
async function __changesStored(name) {
  var answer = await __call({changeSets: 'load', name}).catch(() => null);
  return answer && Array.isArray(answer.entries) ? new Map(answer.entries) : undefined;
}
// The HTTP status of the page the check read: the one passed in, else the last one used.
async function __changesStatus(options) {
  if (typeof options.status === 'number') return options.status;
  var page = options.page || options.tab;
  var target = page ? page.target || page : __lastTarget;
  if (!target) return null;
  return __mainStatus(target).catch(() => null);
}
async function __changesSkip(options) {
  if (options.failed === true) return 'the read failed';
  var status = await __changesStatus(options);
  return typeof status === 'number' && status >= 400 ? 'the page answered HTTP ' + status : '';
}
async function __changesRun(name, now, options) {
  var skip = await __changesSkip(options);
  if (skip) return {skipped: true, reason: skip + '; the last set is kept', first: false, new: [], changed: [], gone: [], count: now.size};
  var before = __changeSets.get(name) || await __changesStored(name);
  __changeSets.set(name, now);
  await __call({changeSets: 'save', name, entries: [...now]}).catch(() => undefined);
  return __changesDiff(before, now);
}
function __changes(name, items, options = {}) {
  var list = Array.isArray(items) ? items : items && Array.isArray(items.items) ? items.items : [items];
  var keyOf = __changesKeyOf(options || {});
  var now = new Map(list.map((item) => [keyOf(item), item]));
  var result = __changesRun(String(name), now, options || {});
  // Old checks read the answer without await: they keep this runtime's own comparison.
  return Object.assign(result, __changesDiff(__changeSets.get(String(name)), now));
}
`;
