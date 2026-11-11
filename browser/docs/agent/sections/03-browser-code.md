## Browser code in one minute

`browserkit repl "<code>"` (or `browser_code`) runs JavaScript in a persistent REPL inside Chrome.
Globals: `browser`, `page`, `bu`, `siteMapper`, `google`, `skills`, `artifact`, `checkpoint`,
`help`. Variables, tabs and files persist per `--session`.

```js
const page = await browser.openTab("https://shop.example");
await bu.state(); // host/path · title, then [id] role "name" under its row or dialog
await bu.click(12); // act by bu id, role or visible text
await page.locator("input[name=q]").fill("lamp");
await page.getByRole("button", { name: "Search" }).click();
const rows = await page.list("tr"); // every row, scrolling lists that draw lazily
await page.hold("#confirm", { ms: 1500 }); // hold-to-confirm, long-press menu, hold-to-record
```

- Hold a control with `page.hold(target, {ms})`, `bu.hold(id, {ms})` or `page.holdAt(x, y, {ms})`
  (1500 ms unless `{ms}` says otherwise, at most 15000): a hold-to-confirm button, a long-press
  menu or hold-to-record. The receipt matches a click. `help('visual')`.
- One `page` per site: `browser.openTab` on a site you already have a tab for navigates it
  (`{newTab: true}` for another tab). `browser.activeTab()` is the tab the user is on;
  `browser.tabs(query?)` lists tabs (`mine:true` only for tabs this chat or session opened). Any
  open tab works directly, no attaching: `bu.use(tabId)` or `browser.tab(tabId)`; a tab on a site
  the user blocked answers `SITE_BLOCKED`, so tell them. Work through the user's tabs
  in place, all at once with `Promise.all`, navigating them too when the task is about them; for
  anything else open your own tab, so what the user is watching stays put.
- `bu.state()` (the same call as `page.state()`) prints `host/path · title`, then the page in
  sections. Open dialogs come first. A nav or footer is one line (`nav "Main" (14 links)`) until
  `{expand: ["nav"]}` or `{expand: ["all"]}`. Rows are named from their first cells, so identical
  buttons stay on their own line under the row (`[id] button "Edit"`). Controls are
  `[id] role "name" = value`, plus a same-site link path (`→ /orders/1`), the first select options,
  `required`, `invalid: "…"`, and `↓` when the control is off-screen. A clickable element with no
  role is `clickable "text"`. `*` marks what changed since the last look. `{max}`, `{selector}` and
  `{query}` still scope it, and a cut page ends with a count pointing at `page.state({query})` or
  `page.table()`. The printout is led by any text the user selected on the page. Act by visible
  text, role or bu id, never `document.querySelector`. Controls inside a cross-origin iframe appear
  under their iframe with a frame prefix (`f2:e14`); acting on one goes through that frame, and
  `bu.state({root: "f2:e14"})` / `page.snapshot({root})` scopes to that subtree (an iframe ref
  means its whole document).
- On crowded or unfamiliar pages, `await page.act("add the large size to the cart")` does one step
  from plain words: a fast model picks the element (one quick call), the next run on that site
  replays it from a local cache with no model call, and a changed page makes it ask again and
  re-cache. `await page.observe("every field of the shipping form")` returns actions that
  `page.act(action)` runs with no further model call, and
  `await page.extract("price, stock and delivery date", {schema})` reads values off the page the
  same way instead of slicing `innerText`. Pass values as `{variables: {email}}`: that
  model, the cache and the result only see `%email%`. With a known id or selector, act on it
  directly. `help('act')`.
- `page.console()` reads console messages and errors (capture is off until asked for).
- When you know a dialog is coming, set it first with `await page.dialog.expect("dismiss")`, `page.dialog.expect("accept")` or `page.dialog.expect("the text")`.
- `page` is Playwright-style (`goto`, `locator`, `getByRole`, `getByText`, `getByLabel`, `$$eval`,
  `keyboard.press`, `waitForSelector`). There is no `page.playwright`. `help('playwright')`.
- After a cell with actions the new page state prints automatically; never add blind sleeps (one right
  after an action ends when the page settles; `page.waitForTimeout(ms)` paces on purpose). A site
  that says "too many attempts" or "try again later", or answers 429, is rate-limiting: stop that
  path, use another way it offers, or end the task and report when to retry; never wait it out. A cell
  returns its last expression: end with one object holding what you found, and print only what you
  will use. Close tabs you are done with (`await page.close()`, or `browser.closeTab(id)`; any tab,
  then unsplit first); `page.keep()` hands one to the user when they need it
  (a result, cart or form). The same steps on a few sites or pages run together: one tab each and
  `Promise.all` over the tabs, or `browser.pool(urls, async (page, url) => …)` (`help('parallel')`);
  a `Tip:` after a cell names a faster way. Dozens of pages or over a minute of work:
  `browser.job(items, async (page, item) => …)`, which returns a job id and keeps running after
  the cell; check `browser.job.status(id)` or `browser.job.result(id)` later. `browser.reset()`
  closes every tab the chat opened except kept ones.
