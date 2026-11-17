# Aeon

A browser agent that lives in your Chrome.

## Install (Windows)

In PowerShell:

```powershell
irm https://raw.githubusercontent.com/gillasg/aeon-browser/main/install.ps1 | iex
```

Aeon installs everything itself: Git and Node.js if they are missing, the background service that starts at login, and the `aeon` command. It then opens `chrome://extensions` and puts the Aeon folder on your clipboard. Three steps are left in Chrome: turn on **Developer mode** (top right), click **Load unpacked**, then paste the folder (Ctrl+V) and choose it. Aeon notices the moment it connects and finishes on its own. Run the same line again to update; you will not need to do these three steps again.

Chrome shows a *Disable developer mode extensions* warning at the top. That is normal: Chrome shows it whenever an extension is loaded from a folder on your computer instead of the Chrome Web Store. Aeon is not in the store, so dismiss the warning and leave Developer mode on.

## Install (macOS)

```sh
curl -fsSL https://raw.githubusercontent.com/gillasg/aeon-browser/main/install.sh | sh
```

Aeon installs Git, Node.js and pnpm when they are missing, fetches Aeon into `~/Library/Application Support/Aeon/aeon-browser` (set `AEON_DIR` to choose another folder), builds it, installs the background service that starts at login, and puts the `aeon` command in place. It then opens `chrome://extensions` and puts the Aeon folder on your clipboard. Three steps are left in Chrome: turn on **Developer mode** (top right), click **Load unpacked**, then paste the folder (Cmd+V) and choose it. Aeon notices the moment it connects and finishes on its own. Run the same line again to update; you will not need to do these three steps again.

Chrome shows a *Disable developer mode extensions* warning at the top. That is normal: Chrome shows it whenever an extension is loaded from a folder on your computer instead of the Chrome Web Store. Aeon is not in the store, so dismiss the warning and leave Developer mode on.

## Install (Linux)

```sh
curl -fsSL https://raw.githubusercontent.com/gillasg/aeon-browser/main/install.sh | sh
```

Aeon installs Git, Node.js and pnpm when they are missing, fetches Aeon into `${XDG_DATA_HOME:-~/.local/share}/aeon/aeon-browser` (set `AEON_DIR` to choose another folder), builds it, installs the background service, and puts the `aeon` command in place. It then opens `chrome://extensions` and puts the Aeon folder on your clipboard. Three steps are left in Chrome: turn on **Developer mode** (top right), click **Load unpacked**, then paste the folder (Ctrl+V) and choose it. Aeon notices the moment it connects and finishes on its own. Run the same line again to update; you will not need to do these three steps again.

Chrome shows a *Disable developer mode extensions* warning at the top. That is normal: Chrome shows it whenever an extension is loaded from a folder on your computer instead of the Chrome Web Store. Aeon is not in the store, so dismiss the warning and leave Developer mode on.

Enable lingering once so the service also runs while you are logged out:

```sh
sudo loginctl enable-linger "$USER"
```

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
