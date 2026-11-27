## Reviewing traces

Check the agent used the abilities that fit, and note each miss: history, bookmarks or open tabs
for what the user visited or has open; the site, not web search, for anything live; `page.data()`
before scraping by hand; `siteMapper.batch` after the first of many identical changes;
a saved ability (`[saved]` or `site.run`) before clicking through; a `key` on every ability write; the `Prompt cache` line at
the end of `graft trace` (where it falls, something before the cached part changed). A miss seen in
two reviewed chats changes the ability map or a browser-code hint, never appended guidance.

## If something fails

- "Graft is not running": the user must open Chrome with Graft loaded. "BROWSER_OFFLINE": Chrome is
  closed or Graft is not loaded in it.
- A step times out: split it into smaller calls, or `browser.pool` for many pages.
- The user's tabs as context: `graft context` (MCP `graft_context`) returns titles and URLs only when
  "Let other agents see my open tabs" is on in Graft's Settings.
- `graft mcp` has the same tools plus `graft_run`, `graft_search`, `graft_routine` and `graft_context`
  (new MCP tools appear next session; shell commands work now).
