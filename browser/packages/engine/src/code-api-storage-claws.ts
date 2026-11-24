// page.db, page.downloads, page.archive, page.freeze and page.dryRun: thin calls to the tab's
// claws (native-browser-claws.ts). Evaluated in the code sandbox with the other APIs.
export const browserStorageClawsApi = `
function __extendPageStorageClaws(target, base) {
  var claw = (name, fields) => __call(Object.assign({claws: name, target}, fields || {}));
  var archive = async (kind, options = {}) => {
    var receipt = await claw('archive.' + kind, {options});
    if (!options.save) return receipt;
    var name = typeof options.save === 'string' ? options.save : 'receipt-' + receipt.sha256.slice(0, 12) + '.' + kind;
    await __call({workspace: 'artifact', name, value: receipt.base64, base64: true});
    if (options.base64 !== true) delete receipt.base64;
    return Object.assign(receipt, {saved: name});
  };
  return Object.assign(base, {
    db: Object.freeze({
      indexedDb: Object.freeze({
        databases: () => claw('db.databases'),
        read: (db, store, options = {}) => claw('db.read', {db, store, options}),
      }),
      caches: Object.freeze({
        list: () => claw('db.caches'),
        entries: (cache, options = {}) => claw('db.cacheEntries', {cache, options}),
      }),
      watch: (filter = {}) => claw('db.watch', {filter}),
      changes: (options = {}) => claw('db.changes', {options}),
      unwatch: () => claw('db.unwatch'),
      stop: () => claw('db.stop'),
    }),
    downloads: Object.freeze({
      start: (options = {}) => claw('downloads.start', {options}),
      stop: () => claw('downloads.stop'),
      list: (filter = {}) => claw('downloads.list', {filter}),
      waitFor: (filter = {}, timeoutMs = 30000) => claw('downloads.waitFor', {filter: typeof filter === 'string' ? {filename: filter} : filter, timeoutMs}),
    }),
    archive: Object.freeze({
      pdf: (options) => archive('pdf', options),
      mhtml: (options) => archive('mhtml', options),
    }),
    freeze: Object.freeze({
      snapshot: (label) => claw('freeze.snapshot', {label}),
      restore: (id) => claw('freeze.restore', {id}),
      list: () => claw('freeze.list'),
      drop: (id) => claw('freeze.drop', {id}),
      clear: () => claw('freeze.clear'),
    }),
    dryRun: Object.freeze({
      start: (options = {}) => claw('dryRun.start', {options}),
      stop: () => claw('dryRun.stop'),
      list: (options = {}) => claw('dryRun.list', {options}),
    }),
  });
}
`;
