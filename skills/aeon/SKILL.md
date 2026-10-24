---
name: aeon
description: Use the user's real, logged-in Chrome through Aeon from the shell - drive tabs step by step (browser_code), read pages and whole sites (crawl), call mapped site APIs or check them for new items (site_mapper), turn text into JSON (extract), or hand Aeon's own agent a whole task. Use it for anything that needs the user's own browser, accounts or tabs, instead of a separate or headless browser.
---

# Aeon

Aeon is an AI browser agent that lives in the user's Chrome. From a shell you can drive that
browser yourself, one call at a time, or hand Aeon's own agent a whole task. Everything runs in the
user's real Chrome, with their logins, in tabs they can see. Actions are real: what you submit,
send or buy happens on the user's accounts.

## Before you start

1. **Run `aeon tools` once.** It prints every tool with its full API and guidance (boosts,
   media, network capture, Playwright-style calls, ...). This file is only the overview.
2. **Don't put JSON on the command line.** Shells mangle its quotes (PowerShell strips them
   entirely). For simple inputs use `key=value` pairs: `aeon tool site_mapper action=sites`
   (values that are valid JSON, like numbers or `'["a","b"]'`, are parsed as JSON). For code or
   anything nested, write the input to a file and pass `@file.json`, or pipe it in with `-`.
3. **Pick one session name and reuse it** (`--session work`). Calls in the same session share
   variables, tabs and saved files; a call without `--session` uses the session `cli`.

If `aeon` is not on the PATH, use `node <this skill's folder>/../../apps/cli/dist/cli.js` instead,
and run `aeon install` once to fix it.

## Hand Aeon a whole task: `aeon run`

```sh
aeon run "Find the cheapest flight from Delhi to Goa next Friday and give me the link"
aeon run --file tasks.txt --parallel 5
aeon result <chatId>      # the answer again; aeon trace <chatId> shows every step
aeon chats --unreviewed   # chats whose traces nobody has reviewed yet (or used since)
aeon chats --from user --since 2026-10-01 --until 2026-10-24   # the chats the user started
aeon search "screen recording" --from user --since 2026-10-01   # chats, messages and saved answers
aeon review <chatId> @findings.md   # mark it reviewed and save what you found
```

MCP clients hand off a task the same way with the `aeon_run` tool: it starts the same chats and
returns a run id for `aeon_run_status` and `aeon_result`. `aeon_search` is the MCP way to search
chats, messages and saved answers. `aeon mcp` is the stdio server that exposes both.

`--from` takes `user`, `cli`, `mcp`, `companion`, `agent`, `routine` or `unknown`, so a report can
leave out test runs by agents. The plain listing and `--json` both show each chat's origin.

When reviewing a trace, check that the agent used the abilities that fit, and note each miss in
the findings:
- the user's history, bookmarks or open tabs for anything they visited, saved or have open;
- the site in the browser, not web search, for anything live (prices, stock, listings);
- `page.data()` before scraping a page by hand;
- after the first of many identical changes, the learned operation with `siteMapper.batch`, in one
  call with `bu.progress`, instead of clicking each item;
- an existing skill, boost or learned API for the site (the `here:` line) before exploring;
- the `Prompt cache` line at the end of `aeon trace`: a turn where it fell means something before
  the cached part of the prompt changed.

A miss seen in two reviewed chats changes the ability map or a hint in browser code, never a
paragraph appended to the guidance.

Each task becomes a full Aeon chat with its own agent and model, opened as a background tab. It
takes minutes, and the command waits until every task has finished, then prints the answers. Use it
for goals ("find", "compare", "book"), not for single steps; for those, `aeon tool` is faster.

## Drive the browser yourself: `aeon tool`

```sh
aeon tool browser_code @step.json --session work
#   step.json: {"code": "const p = await browser.openTab('https://example.com'); await bu.state()"}
aeon tool browser_tabs
aeon tool crawl action=scrape url=https://example.com/pricing
aeon tool site_mapper action=sites
aeon tool extract @extract.json --session work
#   extract.json: {"file": "page.md", "schema": {"type": "array", "items": {"type": "object"}}}
```

| Tool | What it does | Input |
| --- | --- | --- |
| `browser_code` | JavaScript in a persistent REPL inside Chrome: globals `browser`, `page`, `bu`, `siteMapper`, `google`, `skills`, `artifact`, `checkpoint`, `help`; Playwright-style calls, `page.saveMedia`, `page.upload`, `browser.boosts`. Batch many steps in one call; each call may run for up to 60 seconds. | `{"code": "..."}` |
| `browser_tabs` | The user's open tabs, with the target for `browser.attachTab(target)`. | none |
| `crawl` | A page, a whole site or a section as Markdown and data; plain HTTP first, the user's browser when needed. Faster than `browser_code` for reading many pages. | `{"action": "scrape" \| "crawl" \| "map" \| "search" \| "find", "url", "query", "limit", ...}` |
| `site_mapper` | Mapped sites as APIs: `sites`, `operations`, `call`, `watch`, `explore`, `import`, plus `action`/`actions`, `channel`, `docs`, `heal`, `coverage`, `edit`, `name`, `describe`, `signing`, `session`, `export`. | `{"action", "site", "operation", "params", ...}` |
| `extract` | Text or a saved file into JSON that matches a JSON Schema. | `{"schema", "text" or "file", "instructions"?}` |

The result is printed as text (for `browser_code`: the steps taken, then `output:` and `value:`).
Screenshots are saved as image files and their paths printed. A non-zero exit code means the tool
reported an error; read the message, fix the code, and call again.

Files a session saves (`page.network.save`, `page.saveMedia`, `artifact`, crawls) live in Aeon's
data folder under `external/<session>/` (on Windows `%LOCALAPPDATA%\Aeon\data\external\<session>`).
`site_mapper import` and `extract` with `file` read from the same folder, so use the same session.

## browserkit's commands, through Aeon

Aeon's command line has every browserkit command, running in the user's Chrome through Aeon
(no browserkit extension or native host needed): same arguments, `--help`, `--json` and exit
codes (1 failed, 2 needs input, 3 signed out, 4 no browser, 5 the API failed, 6 a bot wall).
The AI commands (`describe`, `edit`, `name`, `find`, `map --explore`) use Aeon's own model.

```sh
# Mapped sites, without writing JSON by hand
aeon sites                                  # what is mapped
aeon ops shop.example                       # operations, inputs and capabilities
aeon call shop.example listProducts '{"q":"lamp"}'   # --transport direct skips the browser
aeon watch shop.example listProducts        # only items new or changed since the last watch
aeon federate shop.example:listProducts other.example:searchProducts --params '{"q":"lamp"}'
aeon rest [shop.example]                    # local REST API + docs; prints the token calls need
aeon mcp [shop.example]                     # one site as an MCP server; no site: Aeon's own MCP

# Reading the web
aeon crawl https://example.com/docs --limit 10   # also scrape | map-urls | search | find | sync

# Mapping a site
aeon map https://shop.example --attach 123  # record a flow (--passive, --explore)
aeon build shop.example                     # rebuild from every flow it has
aeon learn shop.example flow.har            # add captures, then rebuild
aeon describe shop.example "search for lamps"   # an agent performs it while recording
aeon edit shop.example "rename getMe to currentUser" | aeon name shop.example
aeon noise [add <regex>]

# Keeping it working
aeon heal shop.example [--repair] [--include-actions]
aeon coverage shop.example | aeon diff shop.example | aeon session shop.example [--status]
aeon docs shop.example | aeon export shop.example [--out dir]
aeon action shop.example [name] [json] | aeon channel shop.example [id] | aeon signing shop.example <op>

# The user's own settings
aeon block hdfcbank.com | aeon unblock hdfcbank.com | aeon blocked
aeon boosts list|get|save|remove|enable     # lasting changes to sites
aeon status | tabs | repl "<code>" | journal | doctor | setup
```

`aeon rest` and `aeon mcp <site>` need no browser for public endpoints; calls behind a login run
through the user's Chrome. `aeon block` edits the same list as settings → Blocked sites: only the
user changes it, never agent code.

## Recipes

- **Long jobs.** One `aeon tool` call runs up to 60 seconds, but a shell loop can run for hours:
  call `aeon tool browser_code @step.json --session job` per item and keep state with
  `checkpoint`/`loadCheckpoint`. First check your shell can run `aeon` (`aeon tools`).
- **Several accounts on one site.** Save each account's cookies and storage with
  `page.session()`, then switch by clearing and setting cookies through
  `page.cdp('Network.clearBrowserCookies')` and `page.cdp('Network.setCookies', {cookies})`.
- **Login codes.** Email codes: open the inbox in the browser and read the newest message. SMS
  codes: open messages.google.com/web (Google Messages for web, once paired with the phone).
- **Phone and desktop apps.** Route the app through mitmproxy (on Android, `adb` sets the proxy
  and installs mitmproxy's certificate), use the app, save the flows into the session's folder, then
  `site_mapper action=import site=<app> files=[...]`.
- **An MCP server or SDK for a site.** Map it (`explore`, add `actions: true` to also map
  actions in dry run, or just use the site in `browser_code`), read `operations` and `docs`, save multi-step
  actions, test calls, `heal` what breaks. `site_mapper action=export` writes OpenAPI and a typed
  client; `aeon mcp <site>` serves it as an MCP server.
- **Live data.** `site_mapper action=channel` lists and listens on a site's WebSockets and event
  streams; `page.waitForChange`, `page.waitForResponse` and `page.waitForMessage` wait in code.
- **Your own tools.** Register CLIs and MCP servers you install with Aeon's capability tools, and
  save repeatable site flows as site skills (`skills.save`).
- **Audio and video.** `yt-dlp` in the shell downloads whole videos; `page.recordMedia` records
  what is playing in a tab.

## Don't confuse

- **`site_mapper watch` is one check, not a monitor.** It calls the operation and returns only the
  items that are new or changed since the last `watch` of the same call; nothing runs in between.
  **For ongoing monitoring, ask Aeon to create a routine**, e.g.
  `aeon run "Every 15 minutes, check shop.example for new listings matching 'desk lamp' and tell me about new ones"`.
  Routines run inside Aeon, and their alerts appear in Aeon, not in your session.
- **`site_mapper` only works on sites that are mapped.** Check `aeon tool site_mapper action=sites`
  first. To map a new site: `aeon tool site_mapper action=explore 'sites=["shop.example"]'` (an agent browses it in a background
  tab for a few minutes, looking only), or use the site in `browser_code`: every page action's
  requests are learned after each call, and the output says what can now be called. A write the
  page made successfully can then be repeated with `siteMapper.write`, or over many items with
  `siteMapper.batch`.
- **`aeon run` is not a quick command.** It starts a whole agent and blocks until it is done.
- **`aeon rest` and `aeon mcp <site>` serve the site's API, not a browser session.** Calls behind a
  login use the user's Chrome; public endpoints run over plain HTTP.

## If something fails

- "Aeon is not running": the user must open Chrome with Aeon loaded; Aeon's background service
  starts with it. Then retry.
- "BROWSER_OFFLINE": Chrome is closed or Aeon is not loaded in it.
- A step times out: split the work into smaller calls, or use `browser.pool` for many pages.
- MCP alternative: `aeon mcp` is a stdio MCP server with the same tools plus `aeon_run` and
  `aeon_search` (MCP tools usually appear in the agent's next session; the shell commands work
  right away).
