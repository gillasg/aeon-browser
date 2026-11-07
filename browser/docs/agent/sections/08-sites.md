## Mapped sites

Users call them abilities too (`abilities`; `actions` is an old alias).

```sh
browserkit sites                          # which sites are mapped
browserkit ops shop.example               # what it can do, with inputs and capabilities
browserkit call shop.example search '{"query":"lamp"}' --param page=2
browserkit watch shop.example listings '{}' --key id     # only new/changed items since the last watch
browserkit federate shop.example:search other.example:search --params '{"query":"lamp"}'
browserkit heal shop.example              # drift, breakage, sign-out, bot walls
browserkit abilities build shop.example "find a product's price and stock"   # a tested ability
browserkit abilities run shop.example order --inputs '{"item":"tea"}' --key order-tea-1
browserkit abilities test shop.example search  # its stored cases; fails on constant output
```

- **A `[site]` line** appears when you open a mapped site: it names the site's abilities and API
  reads. Use them instead of clicking through the pages.
- **A `[site] … not learned yet` line** appears after 90 s of page work on a site with no
  abilities or API reads: end your answer with the one-line offer it gives, and save the task as
  an ability (`abilities build`, which learns the site's API on the way) if the user says yes.
  Learning a site maps what it can do; an ability is one task saved to run in one call.
- **Built-in abilities** come with AI sites, Gemini and X (`ask`, `make_image`, `thread`,
  `research`…; see AI sites below). A saved ability with the same name replaces one.
- **Anything can be an ability:** an API call or chain, a workflow of steps, a script (node or in
  the page), or a page read. Save whatever you will do again on a site. Ways run in order, each the
  fallback for the one before: an `api` way first when a learned operation answers the task (no
  tab, fastest), then a page way (`page` collect for lists, a `page` script when the data only
  exists rendered) so a changed API still works; `steps` for click flows with no clean API (forms,
  wizards, anything that pays or posts); a `node` script to combine several calls.
- **Start with `site.capabilities()`** in browser code (or `browserkit capabilities <site>`): the
  site's abilities, mapped operations, notes and WebMCP tools in one answer. Run one with
  `site.run(name, inputs, {via, key, limit, cursor})` or `site.<name>(inputs)`.
- **Abilities keep their promises:** lists page with `limit`/`next_cursor`; a write with a `key`
  never applies twice; a failed write says `possible_commit` and how to `retry`; an ignored filter
  fails as `INPUT_NOT_APPLIED`. Details: `help('abilities')`.
- **Site APIs** (or `siteMapper` in browser code) only work on sites that are mapped. Check `sites`
  first. To map a site: `map`, `describe`, `learn`, or use it in `browser_code` so its requests are
  learned as you go.
- `call` reads. A write the page made successfully can be repeated with `siteMapper.write`; the
  same change on many items is `siteMapper.batch` in one call (paced, stops at the first error).
  Paying, ordering, sending, posting, deleting and account changes always stay in the page.
- `watch` is one check, not a monitor: it calls the operation and returns only the items new or
  changed since the last watch of the same call; nothing runs in between. For ongoing monitoring,
  schedule the command yourself.
