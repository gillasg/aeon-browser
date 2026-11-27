## Hand Graft a whole task: `graft run`

**Run `graft tools` once:** every tool with its full API and guidance; this file is the overview.

```sh
graft run "Find the cheapest flight from Delhi to Goa next Friday and give me the link"
graft run --file tasks.txt --parallel 5
graft run "Collect every open role at these 40 startups" --max-steps 60 --max-minutes 15
graft result <chatId>      # the answer again; graft trace <chatId> shows every step
graft chats --unreviewed   # chats whose traces nobody has reviewed yet (or used since)
graft chats --from user --since 2026-10-01 --until 2026-10-24   # the chats the user started
graft search "screen recording" --from user --json   # titles, messages, answers; never runs
graft review <chatId> @findings.md   # mark it reviewed, save what you found
```

Each task is a full Graft chat (own agent and model) in a background tab. It takes minutes and the
command blocks until every task finishes, so use it for goals ("find", "compare", "book"); single
steps are faster with `graft tool`. `--max-steps`, `--max-minutes` and `--max-cost` cap each chat; at the limit
the agent stops using tools and answers with what it has (`graft_run` takes `budget`). `--from` takes `user`, `cli`, `mcp`, `companion`, `agent`,
`routine` or `unknown`. Over MCP (`graft mcp`, stdio): `graft_run` returns a run id for
`graft_run_status` and `graft_result`; `graft_search` searches chats.

**Keep talking to a chat.** `graft send <chatId> "<message>"` adds a message (a follow-up while it
works, `--steer` to change the current turn, a new turn when idle; `--wait` follows it). When the
chat's agent asks something, `graft watch <chatId>` prints it (`{question}` with its id, kind and
choices) alongside each new step and the final answer, as JSON lines; reply with
`graft answer <chatId> "<answer>"` (yes/no for confirm, a choice or its number for select). Over
MCP: `graft_send`, `graft_answer`, and `graft_wait` (blocks until new steps, a question or the end;
pass back `steps` as `since`); `graft_run_status` lists chats waiting on a question.
