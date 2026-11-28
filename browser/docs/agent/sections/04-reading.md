## Reading pages

**Browsing: `page.glance()`.** It returns `{url, title, text, controls, scroll}` for what is on
screen now, in under a second: no settle wait, no "Show more" clicks, no walk of the whole page.
Links come back without ad redirects and tracking parameters. Use it (or `bu.state()`) between
clicks, typing and scrolling; use `page.read()` only to extract a whole page.

**One `page.read()` per page, every tab at once with `Promise.all`.** It returns an object, not
text: `url`, `title`, `text`, `markdown`, `data`, `list`, `partial`, `notes`, plus `scrollers`,
`embedded` and `artifact` when those apply. `text` is `markdown` plus each frame's text under
`[frame: name]`; a check uses `(await page.read()).text`. Never `page.evaluate(() => document.body.innerText)`,
and never slice a page across cells.

Start with `page.read({max})`: data, the main repeated list and Markdown in one answer, with
`partial: true` and notes when it saw less. It expands "Show more"/"Show replies" controls, waits
for the content to settle, scrolls an infinite feed, and every panel that scrolls on its own (a
transcript, chat log): one that draws lines only on scroll comes back whole in `scrollers`. It
fits a 30 s budget (`timeMs`), so a huge page returns what it has. One call reads a whole article
(`max` up to 200000); never slice a page across several cells. `page.scrollers()` reads only the
panels, once you have opened one (a "Show transcript" button, say). Then, when a smaller piece is enough: `page.data()` first
(embedded JSON: every value, no HTML parsing), then `page.table(css)`, `page.list(rowCss?)` for every
row of a list (it scrolls virtual lists; past its 20 s budget it returns `{partial: true, items}`),
`page.links(css)`, `page.markdown()` (it now includes repeated article/feed items), then locators.
The site's own API next; your own DOM or network code last. Never parse `__NEXT_DATA__` or
`innerText` by hand. Large scripts or responses: fetch once and keep the text in a top-level
variable, which persists between cells; never refetch them each cell.
