import assert from "node:assert/strict";
import test from "node:test";
import {
  AccountJars,
  cookieBelongsTo,
  jarOrigin,
  restoreDetails,
} from "../dist/native-browser-accounts.js";

const SECRET = "tok-very-secret-value";

function cookie(name, value, domain, extra = {}) {
  return {
    name,
    value,
    domain,
    path: "/",
    secure: true,
    httpOnly: true,
    hostOnly: !domain.startsWith("."),
    sameSite: "lax",
    session: false,
    expirationDate: 4e9,
    ...extra,
  };
}

/** A tiny cookie store keyed like Chrome's (domain, path, name). */
function fakeBrowser(initial) {
  let jar = [...initial];
  let stored;
  const calls = { set: [], remove: [] };
  const key = (c) => `${c.domain}|${c.path}|${c.name}`;
  return {
    calls,
    cookies: () => jar,
    deps: {
      getAll: async () => jar.map((c) => ({ ...c })),
      set: async (d) => {
        calls.set.push(d);
        const host = new URL(d.url).hostname;
        const c = {
          name: d.name,
          value: d.value,
          domain: d.domain ?? host,
          path: d.path,
          secure: d.secure,
          httpOnly: d.httpOnly,
          hostOnly: d.domain === undefined,
          sameSite: d.sameSite,
          session: d.expirationDate === undefined,
          ...(d.expirationDate ? { expirationDate: d.expirationDate } : {}),
          ...(d.partitionKey ? { partitionKey: d.partitionKey } : {}),
        };
        jar = jar.filter((x) => key(x) !== key(c)).concat(c);
        return c;
      },
      remove: async (d) => {
        calls.remove.push(d);
        const host = new URL(d.url).hostname;
        const before = jar.length;
        jar = jar.filter((x) => !(x.name === d.name && x.domain.replace(/^\./, "") === host));
        return before !== jar.length ? {} : null;
      },
      load: async () => stored && structuredClone(stored),
      save: async (data) => void (stored = structuredClone(data)),
      now: () => 1_700_000_000_000,
    },
  };
}

test("origin matching follows host-only vs domain cookies", () => {
  assert.equal(jarOrigin("app.example.com/path"), "https://app.example.com");
  assert.equal(
    cookieBelongsTo({ domain: "app.example.com", hostOnly: true }, "app.example.com"),
    true,
  );
  assert.equal(
    cookieBelongsTo({ domain: "example.com", hostOnly: true }, "app.example.com"),
    false,
  );
  assert.equal(
    cookieBelongsTo({ domain: ".example.com", hostOnly: false }, "app.example.com"),
    true,
  );
  assert.equal(
    cookieBelongsTo({ domain: ".other.com", hostOnly: false }, "app.example.com"),
    false,
  );
  assert.equal(
    cookieBelongsTo({ domain: ".notexample.com", hostOnly: false }, "example.com"),
    false,
  );
});

test("restoring keeps host-only cookies host-only and keeps every attribute", () => {
  const hostOnly = restoreDetails(
    cookie("sid", "v", "app.example.com", {
      partitionKey: { topLevelSite: "https://example.com" },
    }),
  );
  assert.equal("domain" in hostOnly, false);
  assert.deepEqual(hostOnly.partitionKey, { topLevelSite: "https://example.com" });
  assert.equal(hostOnly.httpOnly, true);
  assert.equal(hostOnly.expirationDate, 4e9);
  const shared = restoreDetails(
    cookie("pref", "v", ".example.com", { session: true, expirationDate: undefined }),
  );
  assert.equal(shared.domain, ".example.com");
  assert.equal("expirationDate" in shared, false);
});

test("save, switch, list, current and remove; other sites untouched; no values out", async () => {
  const other = cookie("other", "keep-me", ".unrelated.org");
  const sibling = cookie("sib", "keep-sibling", "www.example.com");
  const browser = fakeBrowser([
    cookie("sid", SECRET, "app.example.com"),
    cookie("pref", "a", ".example.com"),
    other,
    sibling,
  ]);
  const jars = new AccountJars(browser.deps);
  const site = "https://app.example.com/inbox";

  const saved = await jars.run("save", site, "personal");
  assert.deepEqual(saved.saved, {
    account: "personal",
    origin: "https://app.example.com",
    cookies: 2,
    updatedAt: "2023-11-14T22:13:20.000Z",
    active: true,
  });

  // Sign in as someone else, save that as work.
  await browser.deps.set(restoreDetails(cookie("sid", "work-token", "app.example.com")));
  await jars.run("save", site, "work");
  const switched = await jars.run("switch", site, "personal");
  assert.equal(switched.switched.account, "personal");
  assert.equal(browser.cookies().find((c) => c.name === "sid").value, SECRET);
  assert.equal(browser.cookies().find((c) => c.name === "sid").hostOnly, true);
  assert.ok(browser.cookies().includes(other), "an unrelated site's cookie is never touched");
  assert.ok(
    browser.cookies().includes(sibling),
    "a sibling subdomain's host-only cookie is never touched",
  );
  assert.ok(browser.calls.remove.every((d) => /example\.com/.test(d.url) && !/www\./.test(d.url)));

  const listed = await jars.run("list", site);
  assert.deepEqual(
    listed.accounts.map((a) => [a.account, a.active]),
    [
      ["personal", true],
      ["work", false],
    ],
  );
  assert.deepEqual(await jars.run("current", site), {
    origin: "https://app.example.com",
    current: "personal",
  });

  await jars.run("switch", site, "work");
  assert.equal(browser.cookies().find((c) => c.name === "sid").value, "work-token");
  assert.deepEqual(await jars.run("remove", site, "work"), {
    removed: true,
    origin: "https://app.example.com",
    account: "work",
  });
  assert.equal((await jars.run("current", site)).current, null);

  const everything = JSON.stringify([saved, switched, listed]);
  assert.equal(everything.includes(SECRET), false);
  assert.equal(everything.includes("work-token"), false);
  assert.equal(everything.includes("value"), false);
});

test("a refused cookie rolls the switch back", async () => {
  const browser = fakeBrowser([cookie("sid", "live", "app.example.com")]);
  const jars = new AccountJars(browser.deps);
  await jars.run("save", "app.example.com", "a");
  const realSet = browser.deps.set;
  let fail = true;
  browser.deps.set = async (d) =>
    fail && d.value === "live" ? ((fail = false), null) : realSet(d);
  await assert.rejects(jars.run("switch", "app.example.com", "a"), /ACCOUNTS_SWITCH.*restored/);
  assert.equal(browser.cookies().find((c) => c.name === "sid").value, "live");
  await assert.rejects(jars.run("switch", "app.example.com", "nope"), /ACCOUNTS_UNKNOWN/);
  await assert.rejects(jars.run("save", "app.example.com", "bad name!"), /ACCOUNTS_NAME/);
});
