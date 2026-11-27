## Sessions, spaces and bulk work

`--session <name>` keeps variables, tabs and files together (default `cli`, and `mcp` for the MCP
server). Files land in the session's workspace ({{workspace}}); `browserkit journal <session>`
shows what it ran. Every agent can read, act in, navigate and close every tab, its own, the user's
or another session's; actions in one tab queue, reads run in parallel.

- **Spaces:** `browser.openTab(url, {space: "window"})` keeps a session's tabs in one background
  window; `browser.session.finish({keep: ["p2"]})` hands the kept tabs to the user. Tabs carry
  stable labels (`p1`, `p2…`). `help('spaces')`.
- **Ask the user to point:** `await page.pick({prompt: "Click the price"})` lets them click
  elements (with optional notes) and returns `{status, picks: [{selector, role, name, text, note}]}`;
  use it before a boost, watcher, ability or site action that needs "this element".
- **Placement and locks:** a new tab opens where your tabs are now (the user may drag them);
  `{windowOf: tab}` opens beside a tab. `{readOnly: true}` blocks clicks and typing in that tab
  (`TAB_READ_ONLY`); `{allowedOrigins: [origin]}` keeps it on those origins (`TAB_ORIGIN_BLOCKED`).
- **The user acts in your tab:** a click or typing only pauses you; your next step waits until
  they stop, then runs. Read the page again before relying on old refs. Esc is a real take-over:
  steps fail with `USER_TOOK_CONTROL`; `page.waitForControl()` waits until it is given back.
- **Many sites:** `browser.sweep(urls, {gate: true, pilot: 5})` returns one outcome per URL (`ok`,
  `gated`, `dead`…) as a durable job; start with a pilot. `help('sweep')`, `help('jobs')`.
- **Network:** `page.network.list()` works without `start()`, `page.network.body(id)` reads what a
  call returned (`{decode: "auto"}` for protobuf, RSC or framed JSON), `page.media()` parses video
  manifests. `help('network')`.
- **Clearing state:** cookies, storage, service workers, permissions. `help('state')`.
- **Other tools:** `browserkit cdp` starts a local DevTools endpoint for Playwright or Puppeteer
  (`connectOverCDP(url)`); its tabs close when the client disconnects.
