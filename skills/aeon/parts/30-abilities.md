## Abilities and long jobs

- **Long jobs.** One `aeon tool` call runs up to 60 seconds, but a shell loop can run for hours:
  start a durable `browser.sweep`/`browser.job` and check it with `aeon job` (or run `aeon sweep
@urls.txt`), keeping state with `checkpoint`/`loadCheckpoint` for anything else. First check your
  shell can run `aeon` (`aeon tools`).
- **Bulk site scans.** `aeon sweep @urls.txt --pilot 5` (see `help('sweep')`).
- **Login codes.** Email codes: open the inbox in the browser and read the newest message. SMS
  codes: open messages.google.com/web (Google Messages for web, once paired with the phone).
- **Phone and desktop apps.** Proxy the app through mitmproxy, save the flows, then
  `site_mapper action=import site=<app> files=[...]`.
- **An MCP server or SDK for a site.** Map it (`explore`, add `actions: true` to also map actions in
  dry run, or just use the site in `browser_code`), read `operations` and `docs`, save abilities,
  test them, `heal` what breaks. `site_mapper action=export` writes OpenAPI and a typed
  client; `aeon mcp <site>` serves it as an MCP server.
- **Your own tools.** Register CLIs and MCP servers you install with Aeon's capability tools.
- **Whole videos.** `yt-dlp` in the shell.
