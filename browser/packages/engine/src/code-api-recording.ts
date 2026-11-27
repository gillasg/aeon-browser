// Streaming DevTools events and recording a tab, for browser_code: page.onCdp(event, handler)
// calls the handler for every matching DevTools event until stopped, and page.recordTab(options)
// saves the tab's screencast as JPEG frames plus frames.json (one wall-clock time per frame, the
// same clock as the timings actions return) in the workspace. Evaluated in the sandbox realm.
export const browserRecordingApi = `
function __cdpStream(target, event, handler, options = {}) {
  var stopped = false, id, failure;
  var ready = __call({op:'event',target,action:'subscribe',event}).then((result) => (id = result.data.subscriptionId));
  var loop = (async () => {
    await ready;
    while (!stopped) {
      try {
        var result = await __call({op:'event',target,action:'poll',subscriptionId:id,timeoutMs:1000});
        if (result.data.dropped && options.onDropped) options.onDropped(result.data.dropped);
        for (var item of result.data.events) await handler(item.params, item.at);
      } catch (error) { failure = error; stopped = true; }
    }
    await __call({op:'event',target,action:'dispose',subscriptionId:id}).catch(() => {});
    if (failure && !/disposed/.test(String(failure.message))) throw failure;
  })();
  // A closed tab ends the stream with an error; it is reported through failed(), never as an
  // unhandled rejection that would throw away a recording's frames.
  loop.catch(() => {});
  return Object.freeze({ready, stop: async () => { stopped = true; await loop.catch(() => {}); }, done: loop, failed: () => failure});
}

// Provenance events page.why() leaves while a tab records; saved as events.json beside frames.json.
var __provRecordings = new Map();
async function __recordTab(target, options = {}) {
  var page = browser.page(target), events = [];
  __provRecordings.set(__key(target), events);
  var name = String(options.name || 'recording-' + Date.now()).replace(/[^A-Za-z0-9._-]+/g, '-');
  var frames = [], writes = [], every = Math.max(1, Math.round(60 / Math.min(60, options.fps ?? 30)));
  var stream = __cdpStream(target, 'Page.screencastFrame', (params) => {
    var file = name + '/frame-' + String(frames.length + 1).padStart(6, '0') + '.jpg';
    var meta = params.metadata || {};
    frames.push({file, t: Math.round((meta.timestamp || Date.now() / 1000) * 1000), width: meta.deviceWidth, height: meta.deviceHeight, scrollX: meta.scrollOffsetX, scrollY: meta.scrollOffsetY});
    writes.push(__call({workspace:'artifact', name: file, value: params.data, base64: true}));
  });
  await stream.ready;
  await page.cdp('Page.startScreencast', {format: 'jpeg', quality: options.quality ?? 85, maxWidth: options.maxWidth ?? 1920, maxHeight: options.maxHeight ?? 1080, everyNthFrame: every});
  var startedAt = Date.now(), asked = Math.min(60, options.fps ?? 30);
  var stop = async () => {
    var lost = stream.failed();
    await page.cdp('Page.stopScreencast', {}).catch(() => {});
    await stream.stop();
    await Promise.all(writes);
    if (__provRecordings.get(__key(target)) === events) __provRecordings.delete(__key(target));
    if (events.length) await __call({workspace:'artifact', name: name + '/events.json', value: JSON.stringify({events}, null, 1)});
    var summary = {folder: name, frames: frames.length, startedAt, stoppedAt: Date.now(),
      fps: frames.length > 1 ? Math.round((frames.length - 1) / ((frames[frames.length - 1].t - frames[0].t) / 1000) * 10) / 10 : 0};
    summary.fpsAsked = asked;
    summary.fpsDelivered = summary.fps;
    if (lost) summary.lost = 'TARGET_LOST: the tab closed during the recording; the ' + frames.length + ' frames captured before that are kept.';
    if (frames.length > 1 && summary.fpsDelivered < 0.8 * asked) summary.warning = 'Asked for ' + asked + ' fps, Chrome delivered ' + summary.fpsDelivered + ' fps (it paints only when the page changes, and a busy machine paints less).';
    await __call({workspace:'artifact', name: name + '/frames.json', value: JSON.stringify({...summary, frames}, null, 1)});
    if (!frames.length) summary.warning = 'No frames: Chrome only paints visible windows. Open the tab with browser.openTab(url, {window: {width, height}}) and keep it unminimized.';
    return summary;
  };
  if (options.seconds) {
    var until = startedAt + Math.min(options.seconds, 50) * 1000;
    while (Date.now() < until && !stream.failed()) await __sleep(Math.min(200, until - Date.now()));
    return stop();
  }
  return Object.freeze({folder: name, stop, frames: () => frames.length});
}
`;
