// browser.clock, browser.scheduleAt, browser.pool.map and browser.accounts in the code sandbox.
// The timing functions are native-browser-sniper.ts's own source, so the tested code is what runs.
import { createTimingKit } from "./native-browser-sniper.js";

export const browserTimingApi = `
var __timing = (${createTimingKit.toString()})();
// The site's clock against ours: median of (Date header + half its step) minus each trip's midpoint.
async function __clockSync(url, options = {}) {
  var probe = async () => {
    var response = await browser.fetch(url, {method: 'HEAD', as: 'text', cache: 'no-store'});
    var header = response.headers && (response.headers.date || response.headers.Date);
    return Date.parse(header);
  };
  return __timing.syncClock(probe, options);
}
// browser.pool.map(items, worker, {concurrency, jitterMs, pauseOnRateLimit, signal}): worker gets
// (item, index, lane); lane.tab(url) opens this lane's own tab once, closed when the pool ends.
async function __poolMap(items, worker, options = {}) {
  return __timing.poolMap(Array.from(items), (item, index, lane) => {
    lane.tab = lane.tab || (async (url) => {
      if (lane.page) { if (url) await lane.page.goto(url, {present: false}); return lane.page; }
      lane.page = await browser.openTab(url || 'about:blank', {new: true, present: false});
      var page = lane.page;
      lane.onCleanup(() => page.close().catch(() => undefined));
      return page;
    });
    return worker(item, index, lane);
  }, options);
}
function __accountStep(action, site, account) {
  return __step({op: 'cookies', target: __hostTarget(), action, url: String(site), ...(account ? {account: String(account)} : {})}).then((r) => r.data);
}
var __accounts = Object.freeze({
  save: (site, account) => __accountStep('accountSave', site, account),
  switch: (site, account) => __accountStep('accountSwitch', site, account),
  list: (site) => __accountStep('accountList', site),
  current: (site) => __accountStep('accountCurrent', site),
  remove: (site, account) => __accountStep('accountRemove', site, account),
});
`;
