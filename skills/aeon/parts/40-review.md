## Reviewing traces

Check that the agent used the abilities that fit, and note each miss: the user's history,
bookmarks or open tabs for what they visited or have open; the site, not web search, for anything
live; `page.data()` before scraping by hand; `siteMapper.batch` after the first of many identical
changes; `site.capabilities()` (abilities, learned API, boosts) before exploring; a `key` on every
ability write; the `Prompt cache` line at the end of `aeon trace` (a turn where it fell means
something before the cached part changed). A miss seen in two reviewed chats changes the ability
map or a hint in browser code, never a paragraph appended to the guidance.

## If something fails

- "Aeon is not running": the user must open Chrome with Aeon loaded (its background service starts
  with it). "BROWSER_OFFLINE": Chrome is closed or Aeon is not loaded in it.
- A step times out: split the work into smaller calls, or use `browser.pool` for many pages.
- The user's tabs as context: `aeon context` (or `aeon_context`) returns titles and URLs only when
  the user enabled "Let outside agents see my open tabs" in Aeon Settings.
- `aeon mcp` is a stdio MCP server with the same tools plus `aeon_run`, `aeon_search`,
  `aeon_routine` and `aeon_context` (MCP tools appear in the agent's next session; shell commands
  work right away).
