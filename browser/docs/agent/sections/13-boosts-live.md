## Boosts across sites, and live viewers

A boost's `js` gets a userscript API that works past the page's own limits:

- `GM.xmlHttpRequest({url, method, headers, data, onload})` reaches other sites with the user's cookies, even under a strict `connect-src`.
- `GM.webSocket({url, onopen, onmessage, onclose})` holds a live socket (8 per script, 32 in all). Sockets can drop; reconnect in `onclose` after a short delay.
- `GM_setValue` / `GM_getValue` are shared by every site the boost runs on and are read fresh at each start. `GM_addValueChangeListener(key, (key, old, value, remote) => …)` hears writes from other tabs (`remote` is true).
- Single-page apps fire `urlchange` on `window`. The boost's site rules are re-checked on every route change, so a boost for `https://site/app/settings*` starts and stops as the app moves.
- `GM.onStop(fn)` runs when the boost is switched off, removed or routed away from. Elements it added, listeners, timers and sockets are taken back by themselves.
- `GM.liveView.push(rows | frame, {view?})` feeds a live viewer. The token stays in the extension.

`jsWorld: 'isolated'` (the default) ignores the page's Content-Security-Policy and Trusted Types. `jsWorld: 'page'` shares the page's `window`. On strict pages, inline `<style>`, `style=""` and `innerHTML` fail silently there, so use `GM_addStyle` / `GM_addElement`.

Saving answers `{id, warnings: [{code, message}]}`:

- `JS_SYNTAX`: the code does not parse.
- `BAD_SITE_RULE`: a rule can never match.
- `BAD_SELECTOR`: a selector is not valid CSS.
- `PAGE_WORLD_STRICT_CSP`: a page-world script is on a site whose last load enforced a strict CSP.
- `USER_SCRIPTS_OFF`: the user must turn on Allow User Scripts.

Fix the cause and save again with the same `id`. `browser.boosts.list(url)` and `get(id)` show `{lastRun, lastError: {message, stack}, tabs}`. Read `lastError` after a reload instead of the page console.

A live viewer is a page on this machine that rows and frames stream into:

- `const v = await browser.liveView.start({title})` returns `{id, url, pushUrl, token}`. Give the user `url`.
- Push with `GM.liveView.push` from a boost, or from a cell with `fetch(v.pushUrl, {method: 'POST', headers: {authorization: 'Bearer ' + v.token}, body: JSON.stringify({rows})})`.
- `browser.liveView.list()` and `stop(id)`; from a shell, `graft live start|list|stop`.

Viewers close when Graft stops, and after 2 hours with no push and no one watching.
