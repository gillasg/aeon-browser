// A realistic browser_code cell, type-checked against aeon-l2-contract.d.ts under --strict.
export async function sample(): Promise<string> {
  const page = await browser.activeTab();
  await page.goto("https://example.com/cart", { waitUntil: "domcontentloaded" });
  const view = await page.state({ query: "checkout" });
  const ref: `t${number}:e${number}` = `${page.ref}:e12`;
  await page.click(ref);
  await page.fill(page.getByLabel("Email"), "a@b.c");
  await page.getByRole("button", { name: /continue/i }).click();
  await page.waitForURL(/\/pay/);
  const wired = await page.wire([{ match: "||ads.example.com", abort: true }, { turbo: true }]);
  const net = await page.tap("network", { match: "/api/" });
  const hit = await net.waitFor((m) => m.url.includes("/api/total"), { timeout: 5000 });
  await net.stop();
  await wired.undo();
  const answer = await human.handoff("Pay $42.10 to Acme?", {
    page,
    kind: "cliff-edge",
    actionLabel: "Pay $42.10",
    target: ref,
  });
  const signed = await human.signIn({ page });
  if (!signed.signedIn) await human.handoff("Please sign in", { kind: "auth" });
  const ops = await site.ops("github.com");
  const issues = await site.call<{ title: string }[]>("github.com", ops[0]?.id ?? "listIssues", {
    repo: "a/b",
  });
  const titles = await browser.pool(
    ["https://a.test", "https://b.test"],
    async (p, url) => (await p.goto(url), p.title()),
    { concurrency: 2 },
  );
  const res = await browser.fetch("https://api.example.com/me", {
    session: await page.session(),
    as: "json",
  });
  try {
    await page.press("t999:e1", "Enter");
  } catch (error) {
    if ((error as AeonError).code !== "WRONG_TAB") throw error;
  }
  return [view, hit.url, answer, issues.length, titles.join(","), res.status, help("human")].join(
    "\n",
  );
}
