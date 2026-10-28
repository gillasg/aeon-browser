# Aeon

A browser agent that lives in your Chrome.

```sh
git clone https://github.com/gillasg/aeon-browser && cd aeon-browser && node scripts/setup.mjs
```

`setup.mjs` (Windows; needs Node.js 22+, pnpm and Chrome):

- fetches and builds browserkit next to this folder, then builds Aeon;
- installs the native host and the background service that starts at login;
- puts the `aeon` command and skill in place, and adds Aeon's MCP server to the coding agents it finds (Claude Code, Codex, opencode, Cursor, Gemini CLI, Claude Desktop);
- opens `chrome://extensions` with the extension folder on your clipboard, and waits.

One step is yours: turn on **Developer mode**, click **Load unpacked** and choose that folder (`apps/chrome-extension/native-dist`). Setup sees Aeon connect and finishes. Run it again after pulling changes. On macOS and Linux, use browserkit (`npx browserkit setup`) for now.

The manual steps, if you prefer: `node scripts/link-repos.mjs`, `pnpm install --ignore-scripts`, `pnpm build`, `scripts/setup-core.ps1`, then load `apps/chrome-extension/native-dist` in Chrome. The daemon (`apps/daemon`) supplies Pi sessions, the agent and local storage; the extension supplies the side panel, chat and browser control. `native-dist/build-info.json` lists the revision of every repo the build used. Run `pnpm start` for a standalone daemon, or use the Windows login supervisor.

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

Everything browser-related comes from **browserkit**, which Aeon builds in: the engine (browser control), boosts, the site API and the crawl tool. browserkit stands alone, so any agent can use it without Aeon.

```
browserkit ─► Aeon
```

The repos use each other through links to sibling folders, not copies: a change is committed only in the repo where it was made, and everything that uses it picks it up at its next build. `node scripts/link-repos.mjs --revisions` prints which revision of each one is in use.

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
