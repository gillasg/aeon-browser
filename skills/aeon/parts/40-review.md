## Reviewing traces

When reviewing a trace, check that the agent used the abilities that fit, and note each miss in the
findings:

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

## If something fails

- "Aeon is not running": the user must open Chrome with Aeon loaded; Aeon's background service
  starts with it. Then retry.
- "BROWSER_OFFLINE": Chrome is closed or Aeon is not loaded in it.
- A step times out: split the work into smaller calls, or use `browser.pool` for many pages.
- Ask for tabs and the user's context: `aeon context` (or the `aeon_context` MCP tool) returns titles
  and URLs only when the user enabled "Let outside agents see my open tabs" in Aeon Settings.
- MCP alternative: `aeon mcp` is a stdio MCP server with the same tools plus `aeon_run`,
  `aeon_search`, `aeon_routine` and `aeon_context` (MCP tools usually appear in the agent's next
  session; the shell commands work right away).
