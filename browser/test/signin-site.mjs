// Sign-in pages built the ways real sites build them: the form in an open shadow root, in a
// same-origin iframe, in a frame of another origin on the same site, in a frame of another site,
// and a form whose button does nothing. A fake `bw` holds the login. Every submitted login is
// recorded, so a test can prove nothing reached a site it must not reach.
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SIGNIN = { username: "me@example.com", password: "shadow-Secret-42!" };

const html = (title, body) => `<!doctype html><title>${title}</title><body>${body}</body>`;
const fields = `<label>Email <input name="email" type="email" autocomplete="username"></label>
<label>Password <input name="password" type="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button>`;
const form = `<form action="/signin/check" method="get">${fields}</form>`;

export function signinRoutes(seen) {
  return (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (!url.pathname.startsWith("/signin")) return false;
    response.setHeader("content-type", "text/html");
    const port = url.port;
    const pages = {
      "/signin/shadow": html(
        "Sign in",
        `<login-box></login-box><script>customElements.define("login-box", class extends HTMLElement {
          constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(form)}; }
        });</script>`,
      ),
      "/signin/frame-form": html("Frame", form),
      "/signin/iframe": html(
        "Sign in",
        `<iframe src="/signin/frame-form" width="500" height="300"></iframe>`,
      ),
      "/signin/auth-frame": html(
        "Sign in",
        `<iframe src="http://auth.app.localhost:${port}/signin/frame-form" width="500" height="300"></iframe>`,
      ),
      "/signin/other-site-frame": html(
        "Sign in",
        `<iframe src="http://localhost:${port}/signin/frame-form" width="500" height="300"></iframe>`,
      ),
      "/signin/dead": html("Sign in", `<form onsubmit="event.preventDefault()">${fields}</form>`),
      "/signin/plain": html("Nothing here", "<p>No form on this page.</p>"),
      "/signin/account": html("Account", `<p>Signed in</p>`),
    };
    if (url.pathname === "/signin/check") {
      seen.push({
        host: url.hostname,
        email: url.searchParams.get("email") ?? "",
        password: url.searchParams.get("password") ?? "",
      });
      const ok =
        url.searchParams.get("email") === SIGNIN.username &&
        url.searchParams.get("password") === SIGNIN.password;
      response.statusCode = 302;
      response.setHeader("location", ok ? "/signin/account" : "/signin/frame-form?error=1");
      response.end();
      return true;
    }
    const body = pages[url.pathname];
    if (!body) return false;
    response.end(body);
    return true;
  };
}

/** A `bw` that answers like an unlocked vault holding the login for each of these hosts. */
export async function fakeVaultFor(hosts) {
  const dir = await mkdtemp(join(tmpdir(), "fake-bw-"));
  const items = hosts.map((host, index) => ({
    id: `item-${index}`,
    name: `Site ${host}`,
    login: { ...SIGNIN, uris: [{ uri: `http://${host}/signin` }] },
  }));
  const script = join(dir, "bw.mjs");
  await writeFile(
    script,
    `const args = process.argv.slice(2);
if (args[0] === "status") process.stdout.write(JSON.stringify({ status: "unlocked" }));
else if (args[0] === "list") {
  const items = ${JSON.stringify(items)};
  const url = args[args.indexOf("--url") + 1] || "";
  let host = ""; try { host = new URL(url).hostname; } catch {}
  process.stdout.write(JSON.stringify(args.includes("--url") ? items.filter((item) => { const saved = new URL(item.login.uris[0].uri).hostname; return saved === host || saved.endsWith("." + host) || host.endsWith("." + saved); }) : items));
}
else process.exit(1);
`,
  );
  if (process.platform === "win32")
    await writeFile(join(dir, "bw.cmd"), `@node "${script}" %*\r\n`);
  else {
    await writeFile(join(dir, "bw"), `#!/bin/sh\nexec node "${script}" "$@"\n`);
    await chmod(join(dir, "bw"), 0o755);
  }
  return dir;
}
