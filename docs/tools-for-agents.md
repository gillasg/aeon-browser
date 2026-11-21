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
