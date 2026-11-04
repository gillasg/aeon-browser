## Browser code in one minute

`browserkit repl "<code>"` (or `browser_code`) runs JavaScript in a persistent REPL inside Chrome.
Globals: `browser`, `page`, `bu`, `siteMapper`, `google`, `skills`, `artifact`, `checkpoint`,
`help`. Variables, tabs and files persist per `--session`.

```js
const page = await browser.openTab("https://shop.example");
await bu.state(); // [id] role "name" = value, plus visible text
await bu.click(12); // act by bu id, role or visible text
await page.locator("input[name=q]").fill("lamp");
await page.getByRole("button", { name: "Search" }).click();
const rows = await page.list("tr"); // every row, scrolling lists that draw lazily
```

- One `page` per site: `browser.openTab` on a site you already have a tab for navigates it
  (`{newTab: true}` for another tab). `browser.activeTab()` is the tab the user is on;
  `browser.tabs(query?)` lists tabs (`mine:true` only for tabs this chat or session opened). Any
  open tab works directly, no attaching: `bu.use(tabId)` or `browser.tab(tabId)`; a tab on a site
  the user blocked answers `SITE_BLOCKED`, so tell them. Work through the user's tabs
  in place, all at once with `Promise.all`, navigating them too when the task is about them; for
  anything else open your own tab, so what the user is watching stays put.
- `bu.state()` prints `[id] role "name" = value` and visible text (`*` marks changes; scope with
  `{selector}` or `{query}`). Act on apps that redraw themselves by visible text, role or bu id,
  never `document.querySelector`. Controls inside a cross-origin iframe appear under their iframe
  with a frame prefix (`f2:e14`); acting on one goes through that frame, and
  `bu.state({root: "f2:e14"})` / `page.snapshot({root})` scopes to that subtree (an iframe ref
  means its whole document).
- On crowded or unfamiliar pages, `await page.act("add the large size to the cart")` does one step
  from plain words: a fast model picks the element (one quick call), the next run on that site
  replays it from a local cache with no model call, and a changed page makes it ask again and
  re-cache. `await page.observe("every field of the shipping form")` returns actions that
  `page.act(action)` runs with no further model call. Pass values as `{variables: {email}}`: that
  model, the cache and the result only see `%email%`. With a known id or selector, act on it
  directly. `help('act')`.
- `page.console()` reads console messages and errors (capture is off until asked for).
- `page` is Playwright-style (`goto`, `locator`, `getByRole`, `getByText`, `getByLabel`, `$$eval`,
  `keyboard.press`, `waitForSelector`). There is no `page.playwright`. `help('playwright')`.
- After a cell with actions the new page state prints automatically; never add blind sleeps. A cell
  returns its last expression: end with one object holding what you found, and print only what you
  will use. Close tabs you are done with (`await page.close()`, or `browser.closeTab(id)`; any tab,
  then unsplit first); `page.keep()` hands one to the user when they need it
  (a result, cart or form). For more than a few pages or sites use
  `browser.job(items, async (page, item) => …)`, which returns a job id and keeps running after
  the cell; check `browser.job.status(id)` or `browser.job.result(id)` later. `browser.reset()`
  closes every tab the chat opened except kept ones.
