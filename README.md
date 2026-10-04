# Core

Local Pi session runtime shared by Aeon interfaces.

`pnpm install --ignore-scripts` then `pnpm build`. Run `pnpm start` for a standalone runtime, or use the Windows login supervisor. Existing data paths remain compatible.

Native clients connect using the private `core-connection.json` file in the runtime data directory. Browser execution is provided by Aeon Browser.
