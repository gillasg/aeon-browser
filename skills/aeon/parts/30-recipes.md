## Recipes

- **Long jobs.** One `aeon tool` call runs up to 60 seconds, but a shell loop can run for hours:
  start a durable `browser.sweep`/`browser.job` and check it with `aeon job` (or run `aeon sweep
@urls.txt`), keeping state with `checkpoint`/`loadCheckpoint` for anything else. First check your
  shell can run `aeon` (`aeon tools`).
- **Bulk site scans.** `aeon sweep @urls.txt --capture media --play` gives one record per URL with
  `outcome` (`ok`, `gated`, `shell`, `dead`, `parked`, `redirected`, `blocked`, `error`), a
  `warning` when nothing worked, and `--pilot 5`/`--checkpoint` to look first and resume. `aeon
check @hosts.txt --media` is the liveness version. `aeon tools --find media` searches guidance.
- **Several accounts on one site.** Save each account's cookies and storage with `page.session()`,
  then switch by clearing and setting cookies through `page.cdp('Network.clearBrowserCookies')` and
  `page.cdp('Network.setCookies', {cookies})`.
- **Login codes.** Email codes: open the inbox in the browser and read the newest message. SMS
  codes: open messages.google.com/web (Google Messages for web, once paired with the phone).
- **Phone and desktop apps.** Route the app through mitmproxy (on Android, `adb` sets the proxy and
  installs mitmproxy's certificate), use the app, save the flows into the session's folder, then
  `site_mapper action=import site=<app> files=[...]`.
- **An MCP server or SDK for a site.** Map it (`explore`, add `actions: true` to also map actions in
  dry run, or just use the site in `browser_code`), read `operations` and `docs`, save multi-step
  actions, test calls, `heal` what breaks. `site_mapper action=export` writes OpenAPI and a typed
  client; `aeon mcp <site>` serves it as an MCP server.
- **Live data.** `site_mapper action=channel` lists and listens on a site's WebSockets and event
  streams; `page.waitForChange`, `page.waitForResponse` and `page.waitForMessage` wait in code.
- **Your own tools.** Register CLIs and MCP servers you install with Aeon's capability tools, and
  save repeatable site flows as site skills (`skills.save`).
- **Audio and video.** `yt-dlp` in the shell downloads whole videos; `page.recordMedia` records what
  is playing in a tab.
