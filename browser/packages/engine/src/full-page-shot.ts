// Full-page screenshots when the document does not scroll. Scroll-jacked pages keep the
// content in an inner element (often overflow:hidden). The probe runs in the page; the plan
// runs in the sandbox and in tests. The probe stays self-contained so its source can be sent
// to the page with no helpers from this module.

export type ShotScroller = {
  selector: string;
  scrollHeight: number;
  clientHeight: number;
  top: number;
  left: number;
  width: number;
  height: number;
  overflow: number;
};

export type ShotProbe = {
  documentScrolls: boolean;
  viewportWidth: number;
  viewportHeight: number;
  scrollers: ShotScroller[];
};

/** overflow:hidden still scrolls; overflow:visible does not. */
export function scrollsForShot(overflowY: string): boolean {
  return overflowY !== "visible";
}

/** Page probe. Marks each candidate with data-graft-shot so a later evaluate can scroll it. */
export function pageScrollerProbe(): ShotProbe {
  document.querySelectorAll("[data-graft-shot]").forEach((node) => {
    node.removeAttribute("data-graft-shot");
  });
  const root = document.scrollingElement || document.documentElement;
  const documentScrolls = root.scrollHeight - root.clientHeight > 80;
  const scrollers: ShotScroller[] = [];
  for (const node of document.querySelectorAll("body *")) {
    if (!(node instanceof HTMLElement)) continue;
    const overflow = node.scrollHeight - node.clientHeight;
    if (overflow <= 40) continue;
    const box = node.getBoundingClientRect();
    if (box.width < 120 || box.height < 80) continue;
    if (
      box.bottom <= 0 ||
      box.right <= 0 ||
      box.top >= window.innerHeight ||
      box.left >= window.innerWidth
    )
      continue;
    const style = getComputedStyle(node);
    if (style.overflowY === "visible" || style.visibility === "hidden" || style.display === "none")
      continue;
    const index = scrollers.length;
    node.setAttribute("data-graft-shot", String(index));
    scrollers.push({
      selector: '[data-graft-shot="' + index + '"]',
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      top: box.top,
      left: box.left,
      width: box.width,
      height: box.height,
      overflow,
    });
  }
  return {
    documentScrolls,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollers,
  };
}

/** The scroller with the most hidden content, or none when the document itself scrolls. */
export function pickScroller(probe: ShotProbe): ShotScroller | undefined {
  if (probe.documentScrolls) return undefined;
  let best: ShotScroller | undefined;
  for (const scroller of probe.scrollers) {
    if (
      !best ||
      scroller.overflow > best.overflow ||
      (scroller.overflow === best.overflow && scroller.width > best.width)
    )
      best = scroller;
  }
  return best;
}

/** Viewport slices down the scroller. The last offset is clamped so the tail is not a gap. */
export function stitchOffsets(scrollHeight: number, clientHeight: number, cap = 24): number[] {
  if (!(clientHeight > 0)) return [0];
  const max = Math.max(0, scrollHeight - clientHeight);
  const offsets: number[] = [];
  for (let y = 0; offsets.length < cap; y += clientHeight) {
    const next = Math.min(y, max);
    const prev = offsets[offsets.length - 1];
    if (prev === undefined || prev !== next) offsets.push(next);
    if (y >= max) break;
  }
  return offsets;
}

export type FullPagePlan =
  { mode: "document"; offsets: number[] } | { mode: "inner"; selector: string; offsets: number[] };

export function planFullPage(probe: ShotProbe): FullPagePlan {
  const chosen = pickScroller(probe);
  if (!chosen) return { mode: "document", offsets: [] };
  const offsets = stitchOffsets(chosen.scrollHeight, chosen.clientHeight);
  if (offsets.length < 2) return { mode: "document", offsets: [] };
  return { mode: "inner", selector: chosen.selector, offsets };
}

/** Sandbox helpers appended to the page surface. A document that scrolls keeps captureBeyondViewport. */
export function fullPageShotApi(): string {
  return `
var __pageScrollerProbe = ${pageScrollerProbe.toString()};
var __pickScroller = ${pickScroller.toString()};
var __stitchOffsets = ${stitchOffsets.toString()};
async function __stitchFullPage(page, options) {
  var probe = await page.evaluate(__pageScrollerProbe);
  var chosen = __pickScroller(probe);
  var offsets = chosen ? __stitchOffsets(chosen.scrollHeight, chosen.clientHeight) : [];
  var clear = function () {
    return page.evaluate(function () {
      document.querySelectorAll('[data-graft-shot]').forEach(function (node) { node.removeAttribute('data-graft-shot'); });
    }).catch(function () {});
  };
  if (!chosen || offsets.length < 2) { await clear(); return null; }
  var format = options.format || 'png';
  var saved = await page.evaluate(function (selector) {
    var el = document.querySelector(selector);
    return el ? el.scrollTop : 0;
  }, chosen.selector);
  try {
    var images = [];
    var previous = '';
    var take = async function () {
      var shot = await page.cdp('Page.captureScreenshot', { format: format });
      var data = shot && shot.data;
      if (previous && data && data === previous) return '';
      previous = data || '';
      if (data) images.push(data);
      return data || '';
    };
    for (var i = 0; i < offsets.length; i++) {
      await __sequenceStep({ selector: chosen.selector, offset: offsets[i] }, chosen.clientHeight);
      if (!(await take())) break;
    }
    // scrollTop did not move the picture (a transform scroller). Wheel at the centre, same as
    // captureSequence, and stop when two frames match.
    if (images.length < 2) {
      images = [];
      previous = '';
      for (var step = 0; step < offsets.length; step++) {
        if (!(await take())) break;
        await __sequenceStep({}, chosen.clientHeight);
      }
    }
    if (images.length < 2) return null;
    var data = await __composeSlices(images, chosen, offsets, probe.viewportWidth, format);
    return __savedShot({ data: data, mimeType: 'image/' + (format === 'jpeg' ? 'jpeg' : 'png') }, options);
  } finally {
    await page.evaluate(function (arg) {
      var el = document.querySelector(arg.selector);
      if (el) el.scrollTop = arg.top;
    }, { selector: chosen.selector, top: saved }).catch(function () {});
    await clear();
  }
}
function __composeSlices(images, chosen, offsets, viewportWidth, format) {
  return new Promise(function (resolve, reject) {
    var pending = images.length;
    var imgs = new Array(images.length);
    var mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    images.forEach(function (data, index) {
      var img = new Image();
      img.onload = function () { imgs[index] = img; if (--pending === 0) finish(); };
      img.onerror = function () { reject(new Error('SCREENSHOT_DECODE_FAILED')); };
      img.src = 'data:' + mime + ';base64,' + data;
    });
    function finish() {
      var first = imgs[0];
      var scale = viewportWidth > 0 ? first.width / viewportWidth : 1;
      var cssHeight = offsets[offsets.length - 1] + chosen.clientHeight;
      var MAX = 16384;
      if (chosen.width * scale > MAX) scale = MAX / chosen.width;
      if (cssHeight * scale > MAX) scale = MAX / cssHeight;
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(chosen.width * scale));
      canvas.height = Math.max(1, Math.round(Math.min(chosen.scrollHeight, cssHeight) * scale));
      var ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('SCREENSHOT_DECODE_FAILED');
      for (var i = 0; i < imgs.length; i++) {
        var sx = Math.max(0, Math.round(chosen.left * scale));
        var sy = Math.max(0, Math.round(chosen.top * scale));
        var sw = Math.round(chosen.width * scale);
        var sh = Math.round(chosen.clientHeight * scale);
        if (sx + sw > first.width) sw = first.width - sx;
        if (sy + sh > first.height) sh = first.height - sy;
        if (sw < 1 || sh < 1) continue;
        ctx.drawImage(imgs[i], sx, sy, sw, sh, 0, Math.round(offsets[i] * scale), sw, sh);
      }
      resolve(canvas.toDataURL(mime).split(',')[1]);
    }
  });
}
`;
}
