# Core

Local Pi session runtime shared by Aeon interfaces.

`pnpm install --ignore-scripts` then `pnpm build`. Run `pnpm start` for a standalone runtime, or use the Windows login supervisor. Existing data paths remain compatible.

Native clients connect using the private `core-connection.json` file in the runtime data directory. Browser execution is provided by Aeon Browser.

## CLI and MCP

`pnpm aeon <command>` (or `node apps/cli/dist/cli.js`) drives the running Aeon from a terminal or another agent. Each task becomes a full Aeon chat, opened as a background tab in Chrome so you can watch it.

```sh
pnpm aeon run "Find the cheapest iPhone 16 128GB on Amazon.in"
pnpm aeon run --file tasks.txt --parallel 5   # one task per line, or a JSON array
pnpm aeon chats
pnpm aeon result <chatId>
pnpm aeon trace <chatId>
```

`run` options: `--quiet` (no chat tabs), `--model provider/id`, `--thinking level`, `--timeout minutes`, `--json`. Each run saves a report under `cli-runs/` in the data directory.

`pnpm aeon mcp` is a stdio MCP server with `aeon_run` (starts tasks, returns a run id), `aeon_run_status`, `aeon_result`, `aeon_trace` and `aeon_chats`:

```json
{ "command": "node", "args": ["/path/to/core/apps/cli/dist/cli.js", "mcp"] }
```
