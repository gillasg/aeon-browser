# Aeon Browser

Local browser agent powered by the shared Core runtime.

```sh
node scripts/link-repos.mjs   # fetches and builds core and the Browser Use Extension next to this folder
pnpm install --ignore-scripts
pnpm build
```

Load `apps/chrome-extension/native-dist` in Chrome. Core supplies Pi sessions and local storage; the extension supplies browser control. `native-dist/build-info.json` lists the revision of every repo the build used.

## Outside agents

Setup also installs an `aeon` command and an Aeon skill (in `~/.agents/skills` and `~/.claude/skills`), so agents on this machine know Aeon exists and can use it from their shell in the same session: `aeon tools` lists the tools with their guidance, `aeon tool browser_code '{...}' --session s` runs one, `aeon run "task"` hands Aeon a whole task. `aeon install` sets this up again.

Other agents (Claude Code, Codex, any MCP client) can use Aeon two ways through its MCP server (`node core/apps/cli/dist/cli.js mcp`):

- **Hand Aeon a task**: `aeon_run`, then `aeon_run_status` / `aeon_result` / `aeon_trace`. Aeon's own agent does the work in a chat.
- **Drive the browser themselves**: `browser_code`, `browser_tabs`, `crawl` and `site_api`, the same tools Aeon's chats use and the same ones the Browser Use Extension offers. Calls with the same `session` share variables, tabs and files.

So with Aeon installed, an outside agent can do everything it could with the Browser Use Extension, without installing it.

## How it all fits together

Aeon is two parts: **core**, the brain (Pi, chats, the agent, and every tool it runs), and **aeon-browser**, this extension (the side panel and chat). Everything browser-related comes from one place, the **browser family**, through the Browser Use Extension.

```
Aeon
├── core                     the brain: Pi, chats, runs every tool
│     └── from BUE: site-to-api and browser-crawl (the site_api and crawl tools)
└── aeon-browser             the face: side panel and chat
      └── from BUE: the engine (browser control) with Site Boosts' engine (boosts)

Browser family (each its own repo, each usable alone)
├── browser-use-extension (BUE)   Aeon without the agent: any agent drives Chrome with it
│     ├── Chrome side: engine (browser control), Site Boosts' engine
│     └── PC side:     bridge, CLI, MCP, site-to-api, browser-crawl
├── site-to-api                    turns a site into an API from your own traffic
├── browser-crawl                  reads pages and whole sites as Markdown and data
└── site-boosts                    lasting changes to sites, in plain English
```

### Why each part plugs in where it does

- **Core runs every tool**, whichever repo the tool's code comes from.
- **site-to-api and browser-crawl run on the PC**, like core, so they plug into core as tools. Core gets them through BUE's PC side (`@browser-use-extension/tools`).
- **Site Boosts' engine has to run inside Chrome** (it changes pages as they load), so it plugs into the extension side: it is part of BUE's engine, which this extension builds in.
- **BUE is the only door.** Aeon takes everything browser-related from BUE; the three other products feed BUE. Links point one way:

```
site-to-api ─┐
browser-crawl├─► BUE ─► Aeon (core + aeon-browser)
site-boosts ─┘
```

### Live links, not copies

The repos use each other through links to sibling folders (`link:../../../browser-use-extension/packages/engine`), not copied files. A change is committed only in the repo where it was made; everything that uses it picks it up at its next build. `node scripts/link-repos.mjs` clones and builds the linked repos; `--revisions` prints which revision of each one is in use.

| You change…                                             | Commits                                |
| ------------------------------------------------------- | -------------------------------------- |
| site-to-api, browser-crawl or site-boosts               | that repo only                         |
| the Browser Use Extension                               | that repo only                         |
| core or aeon-browser                                    | that repo only                         |
| a message or API others call, in a way that breaks them | that repo, plus the code that calls it |

Guards: sprint work happens on branches and reaches `main` when it works; BUE's CI also checks core and aeon-browser against each commit; BUE publishes a tagged release whenever anything in the family changes, listing every revision it was built from.
