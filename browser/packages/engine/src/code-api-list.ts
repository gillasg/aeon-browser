// page.list(selector?, options?): every row of a list, including lists that only draw the rows
// on screen (virtualized job boards, feeds, inboxes, grids) and lists that load more on scroll.
// The page scrolls the list's own scroller a screen at a time, several screens per call,
// collecting rows as they are drawn, until the end stops moving; then the scroll position goes
// back. A list longer than the time budget comes back {partial: true, items} with every row seen.

export const browserListApi = `
// Page-side: up to options.screens screens in one call, within options.budgetMs. Each screen
// scrolls (a jump by row height when the keys are numbered), tells the list, then waits until new
// rows appear or waitMs passes. Background tabs deliver scroll events late, so the event is sent
// here to keep a list that redraws on scroll in step.
function __listStep(selector, options) {
  var clean = (text) => (text || '').replace(/\\s+/g, ' ').trim();
  var visible = (el) => el.getClientRects().length > 0;
  var guesses = ['[data-index]', '[data-key]', '[role=row]', '[role=listitem]', '[role=article]', 'article', 'li'];
  var rowsOf = (css) => { var found = [...document.querySelectorAll(css)]; return found.filter((row) => !found.some((other) => other !== row && other.contains(row))); };
  var chosen = selector || guesses.find((css) => [...document.querySelectorAll(css)].filter(visible).length >= 3);
  if (!chosen) return {missing: true};
  var first = rowsOf(chosen)[0];
  var scroller = (() => {
    for (var el = first && first.parentElement; el && el !== document.body; el = el.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 4) return el;
    }
    return document.scrollingElement;
  })();
  var start = scroller.scrollTop;
  var max = options.max || Infinity;
  var target = scroller === document.scrollingElement ? window : scroller;
  if (options.restore) { scroller.scrollTop = options.scrollTo; target.dispatchEvent(new Event('scroll')); return {selector: chosen}; }
  var read = () => rowsOf(chosen).map((row) => {
    var link = row.querySelector('a[rel="bookmark"], a[href*="/status/"], a[href*="/p/"], a[href*="/post/"], a[href*="/item/"]') || row.querySelector('a[href]');
    var href = link ? link.href : null;
    var key = href || row.getAttribute('data-id') || row.getAttribute('data-key') || row.getAttribute('data-index') || row.id || null;
    return {key, text: clean(row.innerText).slice(0, options.maxText || 500), ...(href ? {href} : {})};
  });
  var idOf = (item) => item.key ?? item.text + '|' + (item.href || '');
  var seen = new Set(options.known || []), items = [], ended = false, screens = 0;
  var take = () => { var added = 0; for (var item of read()) { var id = idOf(item); if (!seen.has(id)) { seen.add(id); items.push(item); added += 1; } } return added; };
  var view = () => scroller === document.scrollingElement ? window.innerHeight : scroller.clientHeight;
  var rowHeight = () => {
    var boxes = rowsOf(chosen).map((row) => row.getBoundingClientRect().height).filter((h) => h > 0);
    return boxes.length ? boxes.reduce((a, b) => a + b, 0) / boxes.length : 0;
  };
  var numbered = (list) => list.length >= 3 && list.every((item) => /^\\d+$/.test(item.key ?? ''));
  var began = Date.now();
  var budget = options.budgetMs || 2500;
  var reset = options.scrollTo != null && Math.abs(scroller.scrollTop - options.scrollTo) >= 2;
  var stale = reset ? read().map(idOf).join('\\n') : null;
  if (options.scrollTo != null) {
    scroller.scrollTop = options.scrollTo;
    if (reset) target.dispatchEvent(new Event('scroll'));
  }
  return new Promise((done) => {
    var finish = () => done({selector: chosen, items, top: start, end: scroller.scrollTop, ended, screens, inner: scroller !== document.scrollingElement});
    var screen = () => {
      if (seen.size > max || screens >= (options.screens || 40) || Date.now() - began >= budget) return finish();
      screens += 1;
      var before = scroller.scrollTop;
      var step = Math.max(300, view() * 0.95);
      var drawn = read();
      if (numbered(drawn)) {
        // Numbered rows: jump to the row after the last one drawn, by the rows' own height.
        var nums = drawn.map((item) => Number(item.key));
        var last = Math.max(...nums), low = Math.min(...nums);
        var height = rowHeight();
        if (height > 0 && Math.abs(low * height - before) <= view() * 1.5) {
          step = Math.max(step, Math.min(view() * 2, (last + 1) * height - before - height));
        }
      }
      scroller.scrollTop = before + step;
      target.dispatchEvent(new Event('scroll'));
      var moved = Math.abs(scroller.scrollTop - before) >= 2;
      var pollStart = Date.now(), limit = moved ? (options.waitMs || 250) : (options.endWaitMs || 1500);
      if (!moved && Date.now() - began + limit > 5500) return finish();
      var poll = () => {
        var added = take();
        if (seen.size > max) return finish();
        if (added) return setTimeout(screen, 0);
        if (Date.now() - pollStart >= limit) { if (!moved) { ended = true; return finish(); } return setTimeout(screen, 0); }
        if (moved && Date.now() - began >= budget) return finish();
        setTimeout(poll, 50);
      };
      setTimeout(poll, moved ? 30 : 50);
    };
    var begin = () => {
      take();
      if (seen.size > max) return finish();
      screen();
    };
    if (!reset) return begin();
    var resetStart = Date.now(), resetLimit = options.waitMs || 250;
    var waitReset = () => {
      if (read().map(idOf).join('\\n') !== stale || Date.now() - resetStart >= resetLimit) return begin();
      setTimeout(waitReset, 30);
    };
    setTimeout(waitReset, 30);
  });
}
// Sandbox-side: page calls of a few seconds each, so long lists never hit the evaluate timeout.
// Rows go into __partialValue as they arrive: a cell that hits its deadline still returns them.
async function __collectList(base, selector, options) {
  if (selector && typeof selector === 'object') { options = selector; selector = null; }
  options = options || {};
  var cellEnds = Number(globalThis.__cellEndsAt) || 0;
  var deadline = options.deadline ?? Date.now() + Math.min(Number(options.timeMs) || 20000, cellEnds ? Math.max(1000, cellEnds - 5000 - Date.now()) : 20000);
  var max = options.max ?? 1000, seen = new Map(), chosen = selector || null, start = null;
  var complete = false, scrolls = 0, inner = false;
  var step = (args) => base.inspect('(' + __listStep.toString() + ')(' + JSON.stringify(chosen) + ', ' + JSON.stringify(args) + ')');
  var snapshot = () => ({partial: true, count: seen.size, selector: chosen, items: [...seen.values()].slice(0, max)});
  for (var i = 0; i < (options.maxScrolls ?? 300) && Date.now() < deadline && seen.size <= max; i++) {
    var read = await step({maxText: options.maxText, ...(i === 0 ? {scrollTo: 0} : {}), known: [...seen.keys()],
      max, waitMs: options.waitMs, budgetMs: Math.max(300, Math.min(2500, deadline - Date.now())), screens: options.screens});
    if (read.missing) {
      if (i === 0) throw Error('TARGET_NOT_FOUND: no repeated rows found; pass the row selector, e.g. page.list(".result-card")');
      break;
    }
    chosen = read.selector;
    inner = read.inner;
    if (start === null) start = read.top;
    scrolls += read.screens;
    for (var item of read.items) {
      var id = item.key ?? item.text + '|' + (item.href || '');
      if (!seen.has(id)) seen.set(id, item);
    }
    globalThis.__partialValue = snapshot();
    if (seen.size > max) break;
    if (read.ended) { complete = true; break; }
  }
  if (start !== null) await step({scrollTo: start, restore: true}).catch(() => {});
  globalThis.__partialValue = undefined;
  var items = [...seen.values()].slice(0, max);
  if (items.length && items.every((item) => /^\\d+$/.test(item.key ?? ''))) items.sort((a, b) => a.key - b.key);
  var why = seen.size > max ? ' (max reached)' : Date.now() >= deadline ? ' (time budget)' : '';
  return {
    count: items.length,
    complete,
    partial: !complete,
    selector: chosen,
    scrolls,
    scroller: inner ? 'inner' : 'window',
    ...(!complete ? {note: 'list is not complete: stopped after ' + items.length + ' rows' + why + '; call page.list() again, pass {timeMs} or a larger max'} : {}),
    items,
  };
}
`;
