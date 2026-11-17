## Abilities and long jobs

- **Users' words:** "automations" are routines (`aeon automation`); "teach Aeon a site" is mapping.
- **Long jobs.** One `aeon tool` call runs up to 60 s; for hours, start a durable
  `browser.sweep`/`browser.job` and check it with `aeon job`, or `aeon sweep @urls.txt --pilot 5`
  (`help('sweep')`). Other state: `checkpoint`/`loadCheckpoint`.
- **Varied samples.** A build takes 5–8 public samples (other store, region, empty record) and
  stores one test per differing trait; a write rehearses read-only on them before saving.
- **Login codes.** Email: the newest inbox message. SMS: messages.google.com/web.
- **Phone/desktop apps:** proxy via mitmproxy, then `site_mapper action=import`.
- **An MCP server or SDK for a site.** Map it (`explore`, `actions: true` also maps actions in dry
  run), read `operations` and `docs`, save and test abilities, `heal` what breaks.
  `site_mapper action=export` writes OpenAPI and a typed client; `aeon mcp <site>` serves it.
- **Your own tools:** register CLIs and MCP servers as capabilities. Videos: `yt-dlp`.
