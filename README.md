# Aeon

A browser agent that lives in your Chrome.

## Install

One command installs Aeon; `aeon setup` (which the installer already runs) then guides you through the only step Chrome requires. Aeon builds itself, installs the background service and the `aeon` command, opens `chrome://extensions` and puts the extension folder on your clipboard. In that Chrome tab:

1. Turn on **Developer mode** (top right).
2. Click **Load unpacked**.
3. Paste the folder (Ctrl+V / Cmd+V) and choose it.

Aeon notices the connection, opens its Chat and shows one line about itself with three example tasks. **No Chrome flags are needed**: a normal Chrome launch works. `aeon doctor` checks each piece and names the one fix if something is missing; `aeon setup` repeats the guided steps any time. Re-run the install command to update — the three clicks are needed only once.

| OS                   | One-line install                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Windows (PowerShell) | `irm https://raw.githubusercontent.com/gillasg/aeon-browser/main/install.ps1 \| iex`      |
| macOS / Linux        | `curl -fsSL https://raw.githubusercontent.com/gillasg/aeon-browser/main/install.sh \| sh` |

Chrome shows a _Disable developer mode extensions_ banner whenever an extension is loaded from a folder instead of the Chrome Web Store. Aeon is not in the store; dismiss the banner and leave Developer mode on. On Linux, `sudo loginctl enable-linger "$USER"` is optional: it keeps the service running while you are logged out.

Aeon keeps its files in the data folder (`~/.local/share/aeon` on Linux, `~/Library/Application Support/Aeon` on macOS, `%LOCALAPPDATA%\Aeon` on Windows). Updates keep that data. If you start Chrome with a custom `--user-data-dir`, copy `com.aeon.native_host.json` from the default profile into `<user-data-dir>/NativeMessagingHosts/` too.

From a clone instead: `node scripts/setup.mjs` does the same from this folder. By hand: `pnpm install --ignore-scripts`, `pnpm build`, then `node apps/native-host/scripts/install.mjs`, and load `apps/chrome-extension/native-dist` in Chrome. The daemon (`apps/daemon`) supplies Pi sessions, the agent and local storage; the extension supplies the side panel, chat and browser control. Run `pnpm start` for a standalone daemon, or use the installed login service.

## What is in this repo

```
apps/
  daemon          the brain: Pi sessions, chats, the agent, every tool it runs
  cli             the aeon command and MCP server for outside agents
  native-host     connects Chrome to the daemon
  chrome-extension  the face: side panel, chat, new tab, orb
packages/
  protocol        Aeon's messages (re-exporting the engine's)
  pi-adapter      Pi sessions, browser tools, guidance
  domain, store   chat state and local storage
  ui              the shared React UI
```

Everything browser-related lives in `browser/`: the engine (browser control), the protocol, the tools, boosts, the site API, the crawl tool and the command line Aeon's CLI builds on. It is part of this workspace and builds first.

## Local connections

The daemon listens on `127.0.0.1` only. The extension socket is `/aeon/v1`: a connection is accepted when its `Origin` is this install's `chrome-extension://` id, and any other origin, including a web page, is rejected (`ORIGIN_NOT_ALLOWED`). The first message must carry a connection grant minted for that extension, which expires and is checked with a constant-time compare. Chrome delivers the grant through the native messaging host (`com.aeon.native_host`), which Chrome starts for the extension and which itself refuses a caller whose origin is not that extension. A page cannot open the native host, cannot mint a grant, and cannot complete the handshake. The CLI socket (`/core/v1`) accepts only a client that sends no `Origin`. The grant is not a user prompt: Aeon does not ask permission to run.

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

## Outside agents

Setup also installs an `aeon` command and an Aeon skill (in `~/.agents/skills` and `~/.claude/skills`), so agents on this machine know Aeon exists and can use it from their shell: `aeon tools` lists the tools with their guidance, `aeon tool browser_code '{...}' --session s` runs one, `aeon run "task"` hands Aeon a whole task. `aeon install` sets this up again.

Other agents (Claude Code, Codex, any MCP client) can use Aeon two ways through its MCP server (`node apps/cli/dist/cli.js mcp`):

- **Hand Aeon a task**: `aeon_run`, then `aeon_run_status` / `aeon_result` / `aeon_trace`.
- **Drive the browser themselves**: `browser_code`, `browser_tabs`, `crawl` and `site_mapper`, the same tools Aeon's chats use. Calls with the same `session` share variables, tabs and files.

When your agent supports MCP sampling, Aeon uses its model for Aeon's own calls if you have no Aeon model signed in; set `aeon settings set mcpUseClientModel=true` to always prefer it (no Aeon model key needed).
