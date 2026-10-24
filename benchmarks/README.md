# Aeon test bench

Runs the same task list (`tasks.json`) two ways and writes a table of pass/fail, steps and time:

- **scripted**: a `browser_code` solution through `aeon tool browser_code`.
- **agent**: Aeon's own agent through `aeon run`.

```sh
pnpm bench                 # dry run: fixtures, no browser
pnpm bench:live            # real run against the local fixture pages
node benchmarks/run.mjs --dry-run --out results/run.json
node benchmarks/run.mjs --only deals-price,apply-form --allow-browser
```

The real run starts a local fixture server on `127.0.0.1` and drives the user's Chrome, so it
refuses to start without `--allow-browser`. The three example tasks cover reading a table, reading
a virtualized list and filling a form. `tasks.json` fields: `id`, `task` (the `{{base}}`
placeholder becomes the fixture origin), `startUrl`, `script` (the browser_code solution), `expected`
(facts that must appear), and `fixture` (the dry-run answers for both ways).
