## Abilities and long jobs

- **Users' words:** "actions" are abilities (`aeon actions`), "automations" are routines
  (`aeon automation`), "teach Aeon a site" is mapping it.
- **Long jobs.** One `aeon tool` call runs up to 60 s; for hours, start a durable
  `browser.sweep`/`browser.job` and check it with `aeon job`, or `aeon sweep @urls.txt --pilot 5`
  (`help('sweep')`). Keep other state with `checkpoint`/`loadCheckpoint`.
- **Login codes.** Email: read the newest message in the inbox. SMS: messages.google.com/web.
- **Phone and desktop apps:** proxy through mitmproxy, then `site_mapper action=import`.
- **An MCP server or SDK for a site.** Map it (`explore`, `actions: true` also maps actions in dry
  run), read `operations` and `docs`, save and test abilities, `heal` what breaks.
  `site_mapper action=export` writes OpenAPI and a typed client; `aeon mcp <site>` serves it.
- **Your own tools:** register CLIs and MCP servers with Aeon's capability tools. Videos: `yt-dlp`.
