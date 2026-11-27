// Playwright-compatible names on top of the browser_code API. Models reach for Playwright by
// habit (page.title(), page.goto(), locator.innerText(), page.$$eval...), so those calls work as
// a Playwright user expects instead of failing and costing a model turn. Reads run in the page;
// actions reuse the engine's own click/fill/press so they keep its waiting and verification.
export const browserPlaywrightApi = `
// A string that can also be called, so page.url and page.url() both work.
function __callableString(read, call) {
  var fn = call || (() => read());
  return new Proxy(fn, {
    get(_, key) {
      var value = read() || '';
      if (key === Symbol.toPrimitive || key === 'toString' || key === 'valueOf' || key === 'toJSON') return () => value;
      if (key === Symbol.for('nodejs.util.inspect.custom')) return () => value;
      var member = value[key];
      return typeof member === 'function' ? member.bind(value) : member;
    },
  });
}
// A page read must not hang a model turn when the execution context is gone.
function __withTimeout(promise, ms, code) {
  var timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code || 'PAGE_READ_TIMEOUT')), ms); }),
  ]).finally(() => clearTimeout(timer));
}
// Compare two screenshots in the page (canvas, no native dependencies) and optionally return a
// red-marked PNG. Images arrive in chunks because a single evaluate expression is capped at
// 20k characters and a screenshot is much larger. Used by page.diffScreenshot.
function __diffImageParts(options) {
  var store = window.__uxbDiffParts || {};
  var beforeSource = (store[options.id + ':before'] || []).join('');
  var afterSource = (store[options.id + ':after'] || []).join('');
  delete store[options.id + ':before'];
  delete store[options.id + ':after'];
  if (!Object.keys(store).length) delete window.__uxbDiffParts;
  // createImageBitmap on raw bytes, not an <img> onload: Chrome can hold back image loading in a
  // background tab (seen on macOS), which stalled the evaluate past its deadline.
  function load(source) {
    var comma = source.indexOf(',');
    var mime = (/^data:([^;,]+)/.exec(source) || [])[1] || 'image/png';
    var binary = atob(source.slice(comma + 1));
    var bytes = new Uint8Array(binary.length);
    for (var b = 0; b < binary.length; b++) bytes[b] = binary.charCodeAt(b);
    return createImageBitmap(new Blob([bytes], { type: mime })).catch(function () {
      throw new Error('SCREENSHOT_DECODE_FAILED');
    });
  }
  return (async function () {
    var before = await load(beforeSource), after = await load(afterSource);
    if (before.width !== after.width || before.height !== after.height)
      throw new Error('SCREENSHOT_SIZE_MISMATCH: ' + before.width + 'x' + before.height + ' vs ' + after.width + 'x' + after.height);
    var width = before.width, height = before.height;
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(before, 0, 0);
    var first = context.getImageData(0, 0, width, height).data;
    context.clearRect(0, 0, width, height);
    context.drawImage(after, 0, 0);
    var second = context.getImageData(0, 0, width, height).data;
    var diff = context.createImageData(width, height), changed = 0, limit = options.threshold * 255;
    for (var i = 0; i < first.length; i += 4) {
      var delta = Math.max(Math.abs(first[i] - second[i]), Math.abs(first[i + 1] - second[i + 1]), Math.abs(first[i + 2] - second[i + 2]));
      if (delta > limit) {
        changed++;
        diff.data[i] = 255; diff.data[i + 1] = 0; diff.data[i + 2] = 0; diff.data[i + 3] = 255;
      } else {
        diff.data[i] = first[i]; diff.data[i + 1] = first[i + 1]; diff.data[i + 2] = first[i + 2]; diff.data[i + 3] = 80;
      }
    }
    var image = '';
    if (options.wantImage) {
      context.putImageData(diff, 0, 0);
      image = canvas.toDataURL('image/png');
    }
    return { matches: changed === 0, width: width, height: height, changedPixels: changed, totalPixels: width * height, changedRatio: changed / (width * height), threshold: options.threshold, image: image };
  })();
}
async function __diffPush(target, id, side, data) {
  var size = 12000;
  for (var i = 0; i < data.length; i += size) {
    var part = { key: id + ':' + side, chunk: data.slice(i, i + size) };
    await __isolatedEval(target, '(' + function (part) {
      var store = window.__uxbDiffParts || (window.__uxbDiffParts = {});
      (store[part.key] || (store[part.key] = [])).push(part.chunk);
    }.toString() + ')(' + JSON.stringify(part) + ')');
  }
}
async function __diffScreenshot(target, baseline, options) {
  options = options || {};
  var threshold = options.threshold === undefined ? 0.1 : Number(options.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('SCREENSHOT_DIFF_THRESHOLD: use a number from 0 to 1');
  var before;
  var baselineMime = baseline && baseline.mimeType ? baseline.mimeType : 'image/jpeg';
  if (
    typeof baseline === 'string' &&
    baseline.indexOf('data:') !== 0 &&
    /\\.(png|jpe?g|webp)$/i.test(baseline)
  ) {
    var stored = await __call({ workspace: 'image', name: baseline });
    before = 'data:' + (stored.mimeType || 'image/png') + ';base64,' + stored.dataBase64;
  } else {
    before = typeof baseline === 'string' ? baseline : baseline && (baseline.dataBase64 || (baseline.data && baseline.data.dataBase64));
  }
  if (!before) throw new Error('SCREENSHOT_BASELINE_REQUIRED: pass page.screenshot(), a workspace image path, or a base64 image');
  if (before.indexOf('data:') !== 0) before = 'data:' + baselineMime + ';base64,' + before;
  var current = await __step({ op: 'observe', target: target, kind: 'screenshot' });
  var shot = current && (current.data || current);
  if (!shot || !shot.dataBase64) throw new Error('SCREENSHOT_CAPTURE_FAILED');
  var after = 'data:' + (shot.mimeType || 'image/jpeg') + ';base64,' + shot.dataBase64;
  var id = 'diff-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  await __diffPush(target, id, 'before', before);
  await __diffPush(target, id, 'after', after);
  var result;
  try {
    result = await __isolatedEval(target, '(' + __diffImageParts.toString() + ')(' + JSON.stringify({ id: id, threshold: threshold, wantImage: Boolean(options.path) }) + ')');
  } finally {
    await __isolatedEval(target, '(' + function (key) {
      var store = window.__uxbDiffParts;
      if (!store) return;
      delete store[key + ':before'];
      delete store[key + ':after'];
      if (!Object.keys(store).length) delete window.__uxbDiffParts;
    }.toString() + ')(' + JSON.stringify(id) + ')').catch(function () {});
  }
  if (options.path) {
    var name = String(options.path);
    if (!/\\.png$/i.test(name)) throw new Error('SCREENSHOT_DIFF_PATH: the diff output must end in .png');
    var base64 = String(result.image || '').replace(/^data:image\\/png;base64,/, '');
    if (!base64) throw new Error('SCREENSHOT_DIFF_IMAGE: the diff image was empty');
    await __call({ workspace: 'artifact', name: name, value: base64, base64: true });
    delete result.image;
    result.path = name;
  }
  return result;
}
// Resolves a locator spec to elements inside the page (runs page-side, so it must be self-contained).
function __resolveInPage(spec, within) {
  var roots = within ? [within] : spec.scopeSpec ? __resolveInPage(spec.scopeSpec) : spec.scope ? [...document.querySelectorAll(spec.scope)] : [document];
  // Open shadow roots are walked in tree order (a host's shadow content right after the host), as
  // fillForm and page.batch do, so web-component pages resolve the same through every path.
  var deep = (root, selector, out) => {
    if (root.shadowRoot) deep(root.shadowRoot, selector, out);
    for (var el of root.querySelectorAll('*')) {
      if (el.matches(selector)) out.push(el);
      if (el.shadowRoot) deep(el.shadowRoot, selector, out);
    }
    return out;
  };
  var all = (selector) => roots.flatMap((root) => deep(root, selector, []));
  var byId = (el, id) => { var home = el.getRootNode(); return (home.getElementById ? home.getElementById(id) : null) || document.getElementById(id); };
  var labelTexts = (el) => [...(el.labels || [])].map(text)
    .concat((el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => byId(el, id)).filter(Boolean).map(text))
    .concat([el.getAttribute('aria-label') || '', el.localName.includes('-') ? el.getAttribute('label') || '' : '']);
  var xpath = (value) => roots.flatMap((root) => {
    var result = document.evaluate(value, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    return Array.from({length: result.snapshotLength}, (_, i) => result.snapshotItem(i));
  });
  var text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  var pattern = spec.regex ? new RegExp(spec.regex[0], spec.regex[1]) : null;
  var match = (value) => pattern ? pattern.test(value) : spec.exact ? value === spec.value : value.toLowerCase().includes(String(spec.value).toLowerCase());
  var found;
  if (spec.by === 'css') found = all(spec.value);
  else if (spec.by === 'xpath') found = xpath(spec.value);
  else if (spec.by === 'text') found = all('body *').filter((el) => match(text(el)) && ![...el.children].some((child) => match(text(child))));
  else if (spec.by === 'label') found = all('input,textarea,select,[contenteditable],[role=combobox],[role=textbox],[role=searchbox],[role=listbox],[role=spinbutton],[role=slider],[role=checkbox],[role=radio],[role=switch],[label]')
    .filter((el) => (el.localName.includes('-') || !el.hasAttribute('label') || el.matches('input,textarea,select,[contenteditable],[role]')) && labelTexts(el).some((value) => value && match(value)))
    // A labeled host whose own shadow control carries the same label is one field: keep the control.
    .filter((el, _, list) => !(el.shadowRoot && list.some((other) => other !== el && el.shadowRoot.contains(other))));
  else if (spec.by === 'placeholder') found = all('[placeholder]').filter((el) => match(el.getAttribute('placeholder') || ''));
  else {
    var roles = {button:'button,[role=button],input[type=button],input[type=submit]', link:'a[href],[role=link]',
      textbox:'input:not([type]),input[type=text],input[type=search],input[type=email],input[type=tel],input[type=url],input[type=number],input[type=password],textarea,[role=textbox],[role=searchbox]',
      searchbox:'input[type=search],[role=searchbox]', heading:'h1,h2,h3,h4,h5,h6,[role=heading]', checkbox:'input[type=checkbox],[role=checkbox]',
      radio:'input[type=radio],[role=radio]', combobox:'select,[role=combobox]', option:'option,[role=option]', img:'img,[role=img]',
      listitem:'li,[role=listitem]', list:'ul,ol,[role=list]', row:'tr,[role=row]', cell:'td,[role=cell]', table:'table,[role=table]', tab:'[role=tab]', menuitem:'[role=menuitem]', dialog:'dialog,[role=dialog]'};
    // Like Playwright's getByRole: what the accessibility tree hides (display:none, visibility
    // hidden, aria-hidden) is not a match, so first() lands on the copy the user can see.
    found = all(roles[spec.role] || '[role="' + spec.role + '"]').filter((el) => !el.closest('[aria-hidden="true"]') && (!el.checkVisibility || el.checkVisibility({visibilityProperty: true})));
    var name = (el) => (el.getAttribute('aria-label') || text(el) || el.value || el.alt || el.title || '').replace(/\\s+/g, ' ').trim();
    if (pattern) found = found.filter((el) => pattern.test(name(el)));
    else if (spec.name) found = found.filter((el) => spec.exact ? name(el) === spec.name : name(el).toLowerCase().includes(spec.name.toLowerCase()));
  }
  var textMatch = (el, wanted) => Array.isArray(wanted) ? new RegExp(wanted[0], wanted[1]).test(text(el)) : text(el).toLowerCase().includes(String(wanted).toLowerCase());
  for (var filter of spec.filters || []) {
    if (filter.hasText !== undefined) found = found.filter((el) => textMatch(el, filter.hasText));
    if (filter.hasNotText !== undefined) found = found.filter((el) => !textMatch(el, filter.hasNotText));
    if (filter.has) found = found.filter((el) => __resolveInPage(filter.has, el).length > 0);
    if (filter.hasNot) found = found.filter((el) => __resolveInPage(filter.hasNot, el).length === 0);
    if (filter.and) { var both = __resolveInPage(filter.and, within); found = found.filter((el) => both.includes(el)); }
    if (filter.or) {
      var either = __resolveInPage(filter.or, within);
      found = [...new Set([...found, ...either])].sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1);
    }
  }
  if (Number.isInteger(spec.index)) found = spec.index < 0 ? found.slice(spec.index).slice(0, 1) : found.slice(spec.index, spec.index + 1);
  return found;
}
function __spec(element) {
  if (element.kind === 'locator') return {role: element.role, name: element.name, exact: element.exact, scope: element.scope, scopeSpec: element.scopeSpec, filters: element.filters, regex: element.regex, index: element.index};
  return {by: element.by, value: element.value, exact: element.exact, scope: element.scope, scopeSpec: element.scopeSpec, filters: element.filters, regex: element.regex, index: element.index};
}
// Runs a read on the matched elements in the page: op receives (elements, arg). The expression is
// assembled as source, not eval'd in the page, so strict Content-Security-Policy pages allow it.
function __locatorRead(target, element, index, op, arg) {
  if (op && typeof op === 'object') throw Error('INVALID_INPUT: this read takes a function. An object is not page code.');
  var expression = '(() => { var found = (' + __resolveInPage.toString() + ')(' + JSON.stringify(__spec(element)) + ');' +
    (index === undefined ? '' : ' var index = ' + Number(index) + '; found = index < 0 ? found.slice(index).slice(0, 1) : found.slice(index, index + 1);') +
    ' return (' + op.toString() + ')(found, ' + (arg === undefined ? 'undefined' : JSON.stringify(arg)) + '); })()';
  return browser.page(target).inspect(expression);
}
// An indexed locator (nth/first/last) cannot use the engine's unique-match targeting, so it is
// picked in the page: first() (and a filtered locator's default) takes the first match on screen,
// nth(i) takes that match. Like Playwright, it waits a moment for the element to be visible, and
// refuses a hidden one rather than acting on empty space (a field collapsed behind a search
// button is 0×0). One still off-screen after scrolling (a transformed or sticky header) is
// TARGET_HIDDEN, never a pointer at negative coordinates. A nonce stamps it for the engine's fill.
function __pickInPage(found, a) {
  var list = a.visibleFirst ? found : a.index < 0 ? found.slice(a.index).slice(0, 1) : found.slice(a.index, a.index + 1);
  if (!list.length) throw new Error('TARGET_NOT_FOUND: no element matches');
  var offscreen = 0;
  // A custom-element host (display: contents or inline, its box drawn by its shadow root or
  // slotted children) has no box of its own: the first descendant with one stands for it.
  var boxed = (el) => {
    var rect = el.getBoundingClientRect();
    if (rect.width && rect.height) return el;
    var kids = el.localName === 'slot' ? el.assignedElements({flatten: true}) : [...(el.shadowRoot ? el.shadowRoot.children : []), ...(el.children || [])];
    for (var kid of kids) { var inner = boxed(kid); if (inner) return inner; }
    return null;
  };
  for (var el of list) {
    var style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    var shown = boxed(el);
    if (!shown || getComputedStyle(shown).visibility === 'hidden') continue;
    shown.scrollIntoView({block: 'center', inline: 'center'});
    var rect = shown.getBoundingClientRect();
    var x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) { offscreen++; continue; }
    if (a.nonce) el.setAttribute('data-ux-pick', a.nonce);
    return {x, y};
  }
  return {hidden: true, offscreen: offscreen > 0};
}
async function __pickIndexed(target, element, index, nonce) {
  for (var waited = 0; ; waited += 250) {
    var box = await __locatorRead(target, element, undefined, __pickInPage, {index, visibleFirst: index === 0, nonce});
    if (!box.hidden) return box;
    if (waited >= 2000 && box.offscreen) throw new Error('TARGET_HIDDEN: the element stays off-screen after scrolling (inside a transformed, sticky or clipped ancestor); target the copy the page shows, e.g. a locator scoped to the visible container');
    if (waited >= 2000) throw new Error('TARGET_HIDDEN: the element is not visible (0×0 or hidden); it may be collapsed behind a button or menu that opens it: open that first, then retry');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
async function __clickIndexed(target, element, index, options, hold) {
  var box = await __pickIndexed(target, element, index);
  var page = browser.page(target);
  if (hold) return page.holdAt(box.x, box.y, options);
  var gesture = __pointerFields(options);
  return options && options.clickCount === 2 ? page.doubleClickAt(box.x, box.y, gesture) : page.clickAt(box.x, box.y, gesture);
}
// One verified write path: the indexed element is stamped and filled by the engine's own fill
// (focus emulation, remount retry, keys or insert, the rich-text ladder). The stamp always goes.
async function __fillIndexed(target, element, index, value, options) {
  var nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  try {
    await __pickIndexed(target, element, index, nonce);
    return await __locator(target, {kind: 'query', by: 'css', value: '[data-ux-pick="' + nonce + '"]'}).fill(value, options);
  } finally {
    await browser.page(target).inspect('document.querySelectorAll(' + JSON.stringify('[data-ux-pick="' + nonce + '"]') + ').forEach((el) => el.removeAttribute("data-ux-pick"))').catch(() => {});
  }
}
// fill's receipt: the step result plus {value, via, committed}. commit: 'enter' presses Enter (a
// search box or combobox), 'blur' leaves the field (v-model.lazy, blur validation), 'change'
// blurs and fires change when the blur did not.
async function __fillDone(target, element, index, options, result) {
  var fill = (result && result.fill) || {};
  var committed = Boolean(result && result.effect === 'confirmed');
  var commit = options && options.commit;
  if (commit !== undefined && !['enter', 'blur', 'change'].includes(commit)) throw new Error("INVALID_INPUT: commit is 'enter', 'blur' or 'change'");
  if (commit === 'enter') await browser.page(target).keyboard('Enter');
  else if (commit) committed = await __locatorRead(target, element, index, function (found, kind) {
    var el = found[0];
    if (!el) return false;
    var fired = false, mark = () => { fired = true; };
    el.addEventListener('change', mark);
    if (el.getRootNode().activeElement === el) el.blur();
    else { el.dispatchEvent(new FocusEvent('blur')); el.dispatchEvent(new FocusEvent('focusout', {bubbles: true})); }
    if (kind === 'change' && !fired) el.dispatchEvent(new Event('change', {bubbles: true}));
    el.removeEventListener('change', mark);
    return true;
  }, commit) && committed;
  // One vocabulary: a write the engine confirmed did change the page, so the outcome says so.
  var outcome = result && result.outcome === 'unknown' && result.effect === 'confirmed' ? 'changed' : result && result.outcome;
  return {...result, ...(outcome ? {outcome} : {}), value: fill.value, via: fill.via, committed};
}
var __mouseAt = new Map();
function __extendLocator(target, element, base, index) {
  var self = () => __locator(target, element, index);
  var read = (op, arg) => __locatorRead(target, element, index, op, arg);
  // Filtered and regex locators resolve in the page, so actions on them click the element at its index (first by default).
  var indexed = index !== undefined || Boolean(element.filters || element.regex);
  var at0 = index === undefined ? 0 : index;
  var at = (i) => __locator(target, element, i);
  return Object.assign(base, {
    first: () => at(0), last: () => at(-1), nth: (i) => at(i),
    all: async () => Array.from({length: await read((found) => found.length)}, (_, i) => at(i)),
    count: () => read((found) => found.length),
    filter: (options = {}) => __locator(target, __withOptions(element, options), index),
    and: (other) => __locator(target, __withFilter(element, {and: __spec(other.element)}), index),
    or: (other) => __locator(target, __withFilter(element, {or: __spec(other.element)}), index),
    innerText: () => read((found) => found.length ? found[0].innerText : (() => { throw new Error('TARGET_NOT_FOUND: no element matches'); })()),
    textContent: () => read((found) => found.length ? found[0].textContent : null),
    innerHTML: () => read((found) => found.length ? found[0].innerHTML : ''),
    inputValue: () => read((found) => found.length ? found[0].value : ''),
    getAttribute: (name) => read((found, name) => found.length ? found[0].getAttribute(name) : null, name),
    isVisible: () => read((found) => found.some((el) => { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; })),
    isChecked: () => read((found) => Boolean(found[0] && found[0].checked)),
    allInnerTexts: () => read((found) => found.map((el) => el.innerText)),
    allTextContents: () => read((found) => found.map((el) => el.textContent || '')),
    evaluate: (fn, arg) => read('(found, arg) => (' + fn.toString() + ')(found[0], arg)', arg),
    evaluateAll: (fn, arg) => read('(found, arg) => (' + fn.toString() + ')(found, arg)', arg),
    // Playwright states. visible is the default. hidden and detached succeed when nothing
    // matches, so a spinner wait does not return while the node is still on the page.
    waitFor: (options = {}) => {
      var state = __waitStateName(options.state);
      return __waitUntil(() => read(function (found, state) {
        function shown(el) {
          var rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
        }
        if (state === 'attached') return found.length > 0;
        if (state === 'detached') return found.length === 0;
        if (state === 'hidden') return found.every(function (el) { return !shown(el); });
        return found.some(shown);
      }, state), options.timeout ?? options.timeoutMs ?? 10000, state);
    },
    ...(indexed ? {
      click: (options) => __clickIndexed(target, element, at0, options),
      hold: (options) => __clickIndexed(target, element, at0, options, true),
      dblclick: (options) => __clickIndexed(target, element, at0, Object.assign({}, options, {clickCount: 2})),
      fill: (value, options) => __fillIndexed(target, element, at0, value, options),
    } : {
      dblclick: (options) => __clickIndexed(target, element, 0, Object.assign({}, options, {clickCount: 2})),
    }),
    // Key by key, like Playwright: for fields that react to keystrokes (autocomplete, search
    // as you type, code boxes). fill() stays the fast way to set a value.
    type: async (value) => { await self().click(); return browser.page(target).keyboard(String(value)); },
    pressSequentially: async (value) => { await self().click(); return browser.page(target).keyboard(String(value)); },
    selectOption: (value) => __locatorSelect(target, element, index, value),
    check: async () => { if (!(await self().isChecked())) await self().click(); },
    uncheck: async () => { if (await self().isChecked()) await self().click(); },
    // Page-side reads only see what is inside the op, so the not-found check is inline.
    hover: async () => { var b = await read((found) => { if (!found.length) throw new Error('TARGET_NOT_FOUND: no element matches'); found[0].scrollIntoView({block: 'center', inline: 'center'}); var r = found[0].getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; }); await browser.page(target).hover(b.x, b.y); return b; },
    boundingBox: () => read((found) => { if (!found.length) return null; var r = found[0].getBoundingClientRect(); return {x: r.left, y: r.top, width: r.width, height: r.height}; }),
    scrollIntoViewIfNeeded: () => read((found) => { if (found[0]) found[0].scrollIntoView({block: 'center'}); return true; }),
    dragTo: (other) => __dragTo(target, self(), other),
    setInputFiles: (files) => {
      if (element.kind !== 'query' || element.by !== 'css') throw Error('INVALID_TARGET: setInputFiles needs a CSS locator, e.g. page.locator("input[type=file]").setInputFiles(paths)');
      return browser.page(target).upload(element.value, [].concat(files));
    },
  });
}
// Page-side: rows of the first matching table (or role=table grid) keyed by header text.
function __readTable(selector, options) {
  var table = document.querySelector(selector);
  if (!table) throw new Error('TARGET_NOT_FOUND: no table matches ' + selector);
  var clean = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  var rows = [...table.querySelectorAll('tr,[role=row]')].map((row) => [...row.querySelectorAll('th,td,[role=cell],[role=columnheader],[role=gridcell]')].map(clean));
  rows = rows.filter((cells) => cells.some(Boolean));
  if (!rows.length) return [];
  var headers = rows[0].map((cell, i) => cell || 'column' + (i + 1));
  var body = rows.slice(1, 1 + (options.limit || 500));
  return options.raw ? rows.slice(0, 1 + (options.limit || 500)) : body.map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])));
}
function __readLinks(selector) {
  var root = document.querySelector(selector) || document.body;
  return [...root.querySelectorAll('a[href]')].slice(0, 500).map((a) => ({text: (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 200), href: a.href}));
}
// google.search: real Google results through the user's browser (their region and language),
// parsed into {title, url, source, snippet}. Run queries one after another, never in parallel.
var google = Object.freeze({
  search: async (query, options = {}) => {
    var page = await __call({google: 'search', query, ...options});
    return __parseGoogle(page.html, options.limit ?? 10);
  },
});
// The realm has no DOM: the extension parses the results page with the browser's own parser.
function __parseGoogle(html, limit) {
  return __call({domParse: 'google', html: String(html || ''), limit: Number(limit) || 10});
}
function __waitStateName(state) {
  if (state === undefined || state === null || state === '') return 'visible';
  if (state === 'attached' || state === 'detached' || state === 'visible' || state === 'hidden') return state;
  throw new Error('INVALID_INPUT: state must be attached, detached, visible or hidden');
}
async function __waitUntil(check, timeout, pending) {
  var deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((done) => setTimeout(done, 250)); }
  throw new Error(pending ? 'TIMEOUT: element did not become ' + pending : 'TIMEOUT: element did not appear');
}
// waitForLoad is the common guess for "the DOM is usable". Pages that never reach
// readyState complete (analytics, ads) must not fail the cell once the DOM is interactive.
// waitForLoadState stays strict: Playwright's 'load' still rejects on timeout.
async function __waitForLoad(base, options) {
  options = options || {};
  var timeoutMs = options.timeout ?? options.timeoutMs ?? 8000;
  try {
    return await base.waitFor(function () { return document.readyState === 'complete'; }, {timeoutMs: timeoutMs});
  } catch (error) {
    var state = '';
    try { state = await base.evaluate(function () { return document.readyState; }); }
    catch (ignored) { throw error; }
    if (state === 'interactive' && /TIMEOUT/.test(String(error && error.message || error))) {
      console.warn('[warn] load still pending after ' + Math.max(1, Math.round(Number(timeoutMs) / 1000)) + ' s; DOM ready');
      return {readyState: 'interactive'};
    }
    throw error;
  }
}
function __extendPage(target, base) {
  var css = (selector) => base.locator(selector);
  var keys = base.keyboard;
  var keyboard = Object.assign((combo) => keys(combo), {
    press: (combo) => keys(combo),
    type: (text) => keys(String(text)),
    insertText: (text) => keys(String(text)),
  });
  var byRole = base.getByRole, byText = base.getByText;
  // Agents sometimes reach for page.playwright.X: it is the page itself.
  base.playwright = base;
  var actions = __targetActions(target, base);
  return __extendPageCause(target, __extendPagePosthocNet(target, __extendPageDemoClaws(target, __extendPageL2(target, __extendPageWhy(target, __extendPageStorageClaws(target, __extendPageRound3(target, __extendPageClaws(target, __extendPageAct(target, __extendPageSurface(target, __extendPageControls(target, __extendPageEvents(target, __extendPageData(target, Object.assign(base, {
    // Playwright accepts a RegExp for names and text. The engine's own targeting matches strings,
    // so a regex locator resolves in the page and acts on its first match.
    getByRole: (role, options = {}) => options.name instanceof RegExp
      ? __locator(target, {kind: 'locator', role, regex: [options.name.source, options.name.flags]})
      : byRole(role, options),
    getByText: (value, options = {}) => value instanceof RegExp
      ? __locator(target, {kind: 'query', by: 'text', regex: [value.source, value.flags]})
      : byText(value, options),
    // click, type, hover, check and the rest name a target the one way (code-api-target.ts).
    type: actions.type, dblclick: actions.dblclick, hover: actions.hover, check: actions.check, uncheck: actions.uncheck,
    // Playwright-style text snapshot of the page: the same view as bu.state().
    ariaSnapshot: (options = {}) => bu.state({...options, target}),
    // A common guess for the same view.
    domSnapshot: (options = {}) => bu.state({...options, target}),
    goto: (url, options) => base.navigate(url, options),
    reload: async (options = {}) => {
      // The address already known for this tab. Reading it from the page is code, and a page
      // holding a password the agent did not type refuses that; reload is how that page reopens.
      var href = String(base.url || "");
      if (!/^https?:/i.test(href)) href = await base.evaluate(() => location.href);
      var timeoutMs = options.timeoutMs || options.timeout;
      var result = await __step({op:'navigate', target, url: href, reload: true,
        ...(timeoutMs ? {timeoutMs: Math.max(500, Math.min(Number(timeoutMs) || 0, 120000))} : {})});
      if (result && result.data && result.data.note) console.log(result.data.note);
      return result;
    },
    goBack: () => base.evaluate(() => history.back()),
    goForward: () => base.evaluate(() => history.forward()),
    content: () => base.evaluate(() => document.documentElement.outerHTML),
    $: (selector) => css(selector).first(),
    $$: (selector) => css(selector).all(),
    $eval: (selector, fn, arg) => css(selector).first().evaluate(fn, arg),
    $$eval: (selector, fn, arg) => css(selector).evaluateAll(fn, arg),
    textContent: (selector) => css(selector).first().textContent(),
    innerText: (selector) => css(selector).first().innerText(),
    getAttribute: (selector, name) => css(selector).first().getAttribute(name),
    inputValue: (selector) => css(selector).first().inputValue(),
    isVisible: (selector) => css(selector).isVisible(),
    hoverSelector: (selector) => css(selector).first().hover(),
    waitForSelector: (selector, options = {}) => base.locator(selector).first().waitFor({state: options.state, timeout: options.timeout ?? options.timeoutMs ?? 5000}),
    bringToFront: async () => undefined,
    selectOption: (selector, value) => css(selector).first().selectOption(value),
    // Playwright's frame locator: the engine reaches into frames itself, so this scopes nothing.
    frameLocator: (selector) => __frameLocator(target, selector),
    setInputFiles: (selector, files) => base.upload(selector, [].concat(files)),
    waitForLoadState: (state, options = {}) => base.waitFor(state === 'domcontentloaded' ? () => document.readyState !== 'loading' : () => document.readyState === 'complete', {timeoutMs: options.timeout ?? 8000}),
    // A common guess from other tools. Unlike waitForLoadState('load'), a timeout is not a
    // failure when the DOM is already interactive.
    waitForLoad: (options) => __waitForLoad(base, options),
    waitForURL: (pattern, options = {}) => __waitUntil(async () => {
      var url = await base.evaluate(() => location.href);
      return pattern instanceof RegExp ? pattern.test(url) : String(url).includes(String(pattern).replace(/\\*\\*/g, ''));
    }, options.timeout ?? 15000),
    waitForTimeout: (ms) => new Promise((done) => setTimeout(done, Math.min(ms, 30000))),
    // Extraction: a table as rows keyed by its header cells, and links with their text.
    table: (selector = 'table', options = {}) => (__noteRead(target), base.inspect('(' + __readTable.toString() + ')(' + JSON.stringify(selector) + ', ' + JSON.stringify(options) + ')')),
    // Every row of a list, scrolling lists that only draw what is on screen (code-api-list.ts).
    list: (selector, options) => (__noteRead(target), __collectList(base, selector, options)),
    scrollers: (options) => (__noteRead(target), __readScrollers(base, options)),
    links: (selector = 'body') => base.inspect('(' + __readLinks.toString() + ')(' + JSON.stringify(selector) + ')'),
    keyboard,
    mouse: Object.freeze({
      click: (x, y, options = {}) => options.clickCount === 2 ? base.doubleClickAt(x, y, options) : base.clickAt(x, y, options),
      dblclick: (x, y, options = {}) => base.doubleClickAt(x, y, options),
      // {steps} moves in that many small mouse events from the last position, as a person would.
      move: async (x, y, options = {}) => {
        var steps = Math.max(1, Math.min(200, Math.round(options.steps ?? 1))), from = __mouseAt.get(__key(target)) || {x, y};
        for (var i = 1; i <= steps; i++)
          await base.cdp('Input.dispatchMouseEvent', {type: 'mouseMoved', x: from.x + (x - from.x) * i / steps, y: from.y + (y - from.y) * i / steps});
        __mouseAt.set(__key(target), {x, y});
        return {x, y, t: Date.now()};
      },
      down: (options = {}) => { var at = __mouseAt.get(__key(target)) || {x: 0, y: 0}; return base.cdp('Input.dispatchMouseEvent', {type: 'mousePressed', x: at.x, y: at.y, button: options.button || 'left', clickCount: 1}); },
      up: (options = {}) => { var at = __mouseAt.get(__key(target)) || {x: 0, y: 0}; return base.cdp('Input.dispatchMouseEvent', {type: 'mouseReleased', x: at.x, y: at.y, button: options.button || 'left', clickCount: 1}); },
      wheel: (_dx, dy) => base.scroll(dy >= 0 ? 'down' : 'up', Math.abs(dy) || 600),
    }),
  }))))))))))))))
}
`;
