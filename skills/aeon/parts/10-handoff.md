## Hand Aeon a whole task: `aeon run`

**Run `aeon tools` once:** every tool with its full API and guidance; this file is the overview.

```sh
aeon run "Find the cheapest flight from Delhi to Goa next Friday and give me the link"
aeon run --file tasks.txt --parallel 5
aeon run "Collect every open role at these 40 startups" --max-steps 60 --max-minutes 15
aeon result <chatId>      # the answer again; aeon trace <chatId> shows every step
aeon chats --unreviewed   # chats whose traces nobody has reviewed yet (or used since)
aeon chats --from user --since 2026-10-01 --until 2026-10-24   # the chats the user started
aeon search "screen recording" --from user --json   # titles, messages, saved answers; never runs
aeon review <chatId> @findings.md   # mark it reviewed and save what you found
```

Each task is a full Aeon chat (own agent and model) in a background tab. It takes minutes and the
command blocks until every task finishes, so use it for goals ("find", "compare", "book"); single
steps are faster with `aeon tool`. `--max-steps`, `--max-minutes` and `--max-cost` cap each chat; at the limit
the agent stops using tools and answers with what it has (`aeon_run` takes `budget`). `--from` takes `user`, `cli`, `mcp`, `companion`, `agent`,
`routine` or `unknown`. Over MCP (`aeon mcp`, stdio): `aeon_run` returns a run id for
`aeon_run_status` and `aeon_result`; `aeon_search` searches chats.
