## Hand Aeon a whole task: `aeon run`

**Run `aeon tools` once.** It prints every tool with its full API and guidance (boosts, media,
network capture, ...); this file is the overview.

```sh
aeon run "Find the cheapest flight from Delhi to Goa next Friday and give me the link"
aeon run --file tasks.txt --parallel 5
aeon result <chatId>      # the answer again; aeon trace <chatId> shows every step
aeon chats --unreviewed   # chats whose traces nobody has reviewed yet (or used since)
aeon chats --from user --since 2026-10-01 --until 2026-10-24   # the chats the user started
aeon search "screen recording" --from user --since 2026-10-01   # chats, messages and saved answers
aeon review <chatId> @findings.md   # mark it reviewed and save what you found
```

MCP clients hand off a task the same way with the `aeon_run` tool: it starts the same chats and
returns a run id for `aeon_run_status` and `aeon_result`. `aeon_search` is the MCP way to search
chats, messages and saved answers. `aeon mcp` is the stdio server that exposes both.

Each task becomes a full Aeon chat with its own agent and model, opened as a background tab. It
takes minutes, and the command waits until every task has finished, then prints the answers. Use it
for goals ("find", "compare", "book"), not for single steps; for those, `aeon tool` is faster.

`--from` takes `user`, `cli`, `mcp`, `companion`, `agent`, `routine` or `unknown`, so a report can
leave out test runs by agents. The plain listing and `--json` both show each chat's origin.
