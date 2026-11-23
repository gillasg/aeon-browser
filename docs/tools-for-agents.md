# Tools for agents

`aeon mcp` is a stdio MCP server over the user's own Chrome. Mapped sites and saved abilities are tools with typed inputs. A routine can POST a webhook when its check passes.

## Catalog

Besides `browser_code`, `browser_tabs`, `crawl` and `site_mapper`, the server lists each mapped operation and each saved ability as its own tool.

A name looks like `site__amazon_in__searchProducts`: the site, then the operation or ability. The input schema is that call's parameters. The description says what it returns.

Each tool has an effect, `read`, `write` or `irreversible`:

- GET is read. POST, PUT and DELETE are write.
- Payment, checkout, delete-account, send and submit are irreversible.
- An override on the operation, ability or routine replaces that guess.

Annotations follow the effect. `readOnlyHint` is true for a read. `destructiveHint` is true only for an irreversible call.

`catalog_search` takes `{query}` and returns the matching tools. When the catalog changes, the server sends `notifications/tools/list_changed`.

`aeon mcp <site>` is that one site, with short tool names.

## Watchers

`aeon automation create "<instruction>"` schedules a routine.

- `--browser <name>` pins the connected Chrome profile the check and the run use.
- `--webhook <url>` POSTs `{routineId, title, value, firedAt}` when the check passes. `--webhook-secret` signs the raw body as HMAC-SHA256 in `X-Aeon-Signature` (`sha256=` plus hex). Delivery is tried three times. The run records delivered or failed.
- `--webhook-only` delivers the webhook and does not start the agent.
- `--effect read|write|irreversible` overrides the inferred effect.

The webhook fires when the check passes. A routine with no check runs the agent on its schedule and does not POST. The same fields exist on `create_routine` and `update_routine`.

## MCP Events

`aeon mcp` advertises the `io.modelcontextprotocol/events` extension. Every routine whose check passes is written to a durable event log (`mcp-events.jsonl` in the data directory) and served as events.

| Stream                | Fires when                                            |
| --------------------- | ----------------------------------------------------- |
| `aeon/routine.fired`  | any of the below                                      |
| `aeon/watcher.fired`  | a scheduled watcher's check passed                    |
| `aeon/listener.fired` | a response-listener routine heard a match             |
| `aeon/webhook.fired`  | a routine with a webhook fired (the POST is sent too) |

- `events/list` returns the streams and their payload schema.
- `events/subscribe {name, filter?: {routineId?, site?}, cursor?}` returns `{subscriptionId, cursor}`. Without a cursor it starts at the newest event. While connected, each new match is pushed as `notifications/events/emitted`.
- `events/poll {subscriptionId}` or `{name, filter?, cursor, limit?}` returns `{events, cursor, hasMore}`. Cursors are monotonic integers (as strings). Pass the returned cursor back to resume, across restarts of either side.
- `events/unsubscribe {subscriptionId}`.

Each event's `data` is `{routineId, site, title, value, firedAt, cursor}`. Payloads are scrubbed when written and again when served: secret-named keys (password, token, otp, cookie, cvv, …), bearer tokens, JWTs, API keys, card numbers and one-time codes become `<redacted>`.

## MCP Tasks

`aeon mcp` advertises `io.modelcontextprotocol/tasks`. A task is a tool call or a watch that runs in the background.

- Start one with `tasks/create {name, arguments}`, or add `task: {ttl?}` to a `tools/call` to get `{task}` back instead of the result.
- `name: "aeon_watch"` with `{name?, filter?, cursor?}` completes on the next matching event.
- `tasks/get {taskId}`, `tasks/list`, `tasks/cancel {taskId}`. `tasks/result {taskId}` waits for the end and returns the tool result, or an error if it failed or was cancelled.
- Status is `working`, `input_required`, `completed`, `failed` or `cancelled`. Every change is pushed as `notifications/tasks/status`.
- `input_required` carries `inputRequest {kind, message, requestedSchema?}`. `kind: "confirm"` is the cliff edge before an irreversible call: answer `tasks/input {taskId, response: {confirm: true}}` to run it; anything else fails the task without running it. `kind: "sign_in"` means the call came back unauthorised: sign in, then answer to retry once.
- Tasks are saved in `mcp-tasks.json`. A task that was running when the server stopped reads as `failed` afterwards. Results are scrubbed like events.

## Tool discovery

The catalog is re-read every five seconds (`AEON_CATALOG_POLL_MS`). A new or re-saved site operation, ability or replay, or a changed schema or effect, sends `notifications/tools/list_changed`, so a connected agent sees it without restarting.
