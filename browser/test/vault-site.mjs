// Local pages for the password-save flow, and a fake `bw` that records what a save sent. Every
// page is a plain server response, like the other browser tests; no real site is touched. The
// passwords are obviously fake and used only here.
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SAVED = { username: "me@example.com", password: "fake-saved-Passw0rd!" };
export const NEW = { username: "new-user@example.com", password: "fake-new-Passw0rd!" };

const html = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><main><h1>${title}</h1>${body}</main>`;

const form = (passwordName, extra = "", autocomplete = "new-password") => `
  <form id="form" method="post" action="/vault/done">
    <label>Email <input name="email" type="email" autocomplete="username"></label>
    ${extra}
    <label>Password <input id="password" name="${passwordName}" type="password" autocomplete="${autocomplete}"></label>
    <button type="submit">Continue</button>
  </form>`;

// A submit that takes the site's own time: the form stays, then the page moves on.
const slowScript = (ms) => `
  <script>
  document.getElementById("form").addEventListener("submit", (event) => {
    event.preventDefault();
    setTimeout(() => { location.href = "/vault/done"; }, ${ms});
  });
  </script>`;

const replaceScript = (next) => `
  <script>
  document.getElementById("form").addEventListener("submit", (event) => {
    event.preventDefault();
    document.querySelector("main").innerHTML = ${JSON.stringify(next)};
  });
  </script>`;

const CODE_STEP = `
  <p>Enter the code we sent to your email.</p>
  <form><label>Code <input name="code" autocomplete="one-time-code"></label>
  <button type="submit">Verify</button></form>
  <p>Didn't get it? <a href="#">Try again</a></p>`;

const BAD_CODE_STEP = `
  <p>Incorrect code. Try again.</p>
  <form><label>Code <input name="code" autocomplete="one-time-code"></label>
  <button type="submit">Verify</button></form>`;

const PAGES = {
  "/vault/instant": html(
    "Create account",
    form("password") + replaceScript("<h2>Account created</h2><p>Welcome.</p>"),
  ),
  "/vault/slow": html("Create account", form("password") + slowScript(3000)),
  "/vault/refused": html(
    "Create account",
    form("password") +
      `<script>
      document.getElementById("form").addEventListener("submit", (event) => {
        event.preventDefault();
        const error = document.createElement("div");
        error.setAttribute("role", "alert");
        error.textContent = "Wrong password";
        document.querySelector("main").prepend(error);
      });
      </script>`,
  ),
  "/vault/code-ok": html("Create account", form("password") + replaceScript(CODE_STEP)),
  "/vault/code-refused": html("Create account", form("password") + replaceScript(BAD_CODE_STEP)),
  // A button whose name says nothing about submitting, still the form's submit button.
  "/vault/button": html(
    "Create account",
    form("password").replace(
      '<button type="submit">Continue</button>',
      `<button id="go" type="submit">Let's go</button>`,
    ) + replaceScript("<h2>Account created</h2>"),
  ),
  // A button that is not a submit control at all: the click itself has to submit.
  "/vault/pointer": html(
    "Create account",
    form("password").replace(
      `<button type="submit">Continue</button>`,
      `<button id="go" type="button">Go</button>`,
    ) +
      `<script>
      document.getElementById("go").addEventListener("click", () => {
        document.querySelector("main").innerHTML = "<h2>Account created</h2>";
      });
      </script>`,
  ),
  "/vault/enter": html(
    "Create account",
    form("password", "", "new-password").replace(
      `<button type="submit">Continue</button>`,
      `<button type="submit">Done</button>`,
    ) + replaceScript("<h2>Account created</h2>"),
  ),
  // An app that swaps the screen without navigating.
  "/vault/spa": html(
    "Create account",
    form("password") +
      `<script>
      document.getElementById("form").addEventListener("submit", (event) => {
        event.preventDefault();
        document.getElementById("form").remove();
        const done = document.createElement("h2");
        done.textContent = "Account created";
        document.querySelector("main").append(done);
      });
      </script>`,
  ),
  "/vault/confirm": html(
    "Create account",
    form(
      "new_password",
      `<label>Confirm password <input name="confirm_password" type="password" autocomplete="new-password"></label>`,
    ) + replaceScript("<h2>Account created</h2>"),
  ),
  // Remembered accounts stand before the form; picking one reveals the password step.
  "/vault/chooser": html(
    "Welcome",
    `<div id="chooser"><h2>Choose an account</h2>
      <button onclick="pick('me@example.com')">me@example.com</button>
      <button onclick="pick('other@example.com')">other@example.com</button></div>
    <div id="signin" hidden>
      <form method="get" action="/vault/chooser/check">
        <label>Email <input name="email" type="email" autocomplete="username" value="me@example.com" readonly></label>
        <label>Password <input name="password" type="password" autocomplete="current-password"></label>
        <button type="submit">Sign in</button>
      </form>
    </div>
    <script>
      function pick(email) {
        document.getElementById("chooser").remove();
        document.getElementById("signin").hidden = false;
        document.querySelector("#signin input[name=email]").value = email;
      }
    </script>`,
  ),
  // The site refuses the password: the password form is shown again with the error.
  "/vault/chooser/rejected": html(
    "Sign in",
    `<p>Wrong password.</p>
    <form method="get" action="/vault/chooser/check">
      <label>Email <input name="email" type="email" autocomplete="username" value="me@example.com" readonly></label>
      <label>Password <input name="password" type="password" autocomplete="current-password"></label>
      <button type="submit">Sign in</button>
    </form>`,
  ),
  "/vault/chooser/check": html(
    "Sign in",
    `<p>Wrong password.</p>
    <form method="get" action="/vault/chooser/check">
      <label>Email <input name="email" type="email" autocomplete="username" value="me@example.com" readonly></label>
      <label>Password <input name="password" type="password" autocomplete="current-password"></label>
      <button type="submit">Sign in</button>
    </form>`,
  ),
  "/vault/chooser/done": html("Signed in", `<p>Signed in as ${SAVED.username}.</p>`),
  "/vault/done": html("Welcome", "<p>Welcome.</p>"),
  "/vault/popups": html(
    "Links",
    `<a id="blank" href="/vault/popup-one" target="_blank">next</a>
     <button id="win" onclick="window.open('/vault/popup-two', '_blank')">open</button>`,
  ),
  "/vault/popup-one": html("Popup One", "<p>one</p>"),
  "/vault/popup-two": html("Popup Two", "<p>two</p>"),
};

export function vaultRoutes(request, response) {
  const url = new URL(request.url ?? "/", "http://x");
  if (!url.pathname.startsWith("/vault")) return false;
  response.setHeader("content-type", "text/html");
  if (url.pathname === "/vault/chooser/check") {
    const ok = url.searchParams.get("password") === SAVED.password;
    response.statusCode = 302;
    response.setHeader("location", ok ? "/vault/chooser/done" : "/vault/chooser/rejected");
    response.end();
    return true;
  }
  const page = PAGES[url.pathname];
  if (!page) return false;
  response.end(page);
  return true;
}

/**
 * A fake `bw` (Bitwarden's CLI) that keeps its items and every write in one JSON file, so a test
 * observes exactly what a save sent: site, username, password. Locked answers fail like the real
 * locked vault, and `unlock` makes the next save succeed.
 */
export async function fakeVault() {
  const dir = await mkdtemp(join(tmpdir(), "fake-vault-"));
  const statePath = join(dir, "state.json");
  const script = join(dir, "bw.mjs");
  const write = (state) => writeFile(statePath, JSON.stringify(state));
  await write({ locked: false, items: [], writes: [] });
  await writeFile(
    script,
    `import { readFileSync, writeFileSync } from "node:fs";
const statePath = ${JSON.stringify(statePath)};
const read = () => JSON.parse(readFileSync(statePath, "utf8"));
const write = (state) => writeFileSync(statePath, JSON.stringify(state));
const args = process.argv.slice(2);
const locked = () => {
  const state = read();
  if (!state.locked) return false;
  process.stderr.write("Vault is locked. Unlock it with bw unlock.\\n");
  process.exit(1);
};
if (args[0] === "status") {
  process.stdout.write(JSON.stringify({ status: read().locked ? "locked" : "unlocked" }));
} else if (args[0] === "list") {
  locked();
  process.stdout.write(JSON.stringify(read().items));
} else if (args[0] === "get" && args[1] === "totp") {
  locked();
  process.stdout.write(${JSON.stringify("135790")});
} else if (args[0] === "create" && args[1] === "item") {
  locked();
  const state = read();
  const item = JSON.parse(Buffer.from(args[2], "base64").toString("utf8"));
  item.id = "item-" + (state.items.length + 1);
  item.revisionDate = new Date().toISOString();
  state.items.push(item);
  state.writes.push({ kind: "create", item });
  write(state);
} else if (args[0] === "edit" && args[1] === "item") {
  locked();
  const state = read();
  const item = JSON.parse(Buffer.from(args[3], "base64").toString("utf8"));
  state.items = state.items.map((known) => (known.id === args[2] ? { ...known, ...item } : known));
  state.writes.push({ kind: "edit", item });
  write(state);
} else {
  process.stderr.write("unsupported: " + args.join(" ") + "\\n");
  process.exit(1);
}
`,
  );
  if (process.platform === "win32")
    await writeFile(join(dir, "bw.cmd"), `@node "${script}" %*\r\n`);
  else {
    await writeFile(join(dir, "bw"), `#!/bin/sh\nexec node "${script}" "$@"\n`);
    await chmod(join(dir, "bw"), 0o755);
  }
  const read = async () => JSON.parse(await readFile(statePath, "utf8"));
  return {
    dir,
    read,
    reset: (items = []) => write({ locked: false, items, writes: [] }),
    lock: () => read().then((state) => write({ ...state, locked: true })),
    unlock: () => read().then((state) => write({ ...state, locked: false })),
    /** The login item in the fake manager, as a stored Bitwarden item. */
    login: (username, password, site) => ({
      id: "saved-login",
      name: "Saved",
      revisionDate: "2026-01-01T00:00:00.000Z",
      login: { username, password, uris: [{ uri: site }] },
    }),
  };
}
