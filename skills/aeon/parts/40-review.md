## Reviewing traces

Check the agent used the abilities that fit, and note each miss: history, bookmarks or open tabs
for what the user visited or has open; the site, not web search, for anything live; `page.data()`
before scraping by hand; `siteMapper.batch` after the first of many identical changes;
`site.capabilities()` before exploring; a `key` on every ability write; the `Prompt cache` line at
the end of `aeon trace` (where it falls, something before the cached part changed). A miss seen in
two reviewed chats changes the ability map or a browser-code hint, never appended guidance.

## If something fails

- "Aeon is not running": the user must open Chrome with Aeon loaded. "BROWSER_OFFLINE": Chrome is
  closed or Aeon is not loaded in it.
- A step times out: split it into smaller calls, or `browser.pool` for many pages.
- The user's tabs as context: `aeon context` (MCP `aeon_context`) returns titles and URLs only when
  "Let other agents see my open tabs" is on in Aeon's Settings.
- `aeon mcp` has the same tools plus `aeon_run`, `aeon_search`, `aeon_routine` and `aeon_context`
  (new MCP tools appear next session; shell commands work now).
