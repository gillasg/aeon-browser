// Turns on "Allow User Scripts" for an extension the way a person does, through the toggle behind
// chrome://extensions. `browser` sends one CDP command on the browser target: (method, params,
// sessionId) => reply. Resolves to "ok" or Chrome's error text.
export async function userScriptsOn(browser, extensionId) {
  const created = await browser("Target.createTarget", { url: "chrome://extensions" });
  const { targetId } = created.result;
  const attached = await browser("Target.attachToTarget", { targetId, flatten: true });
  const { sessionId } = attached.result;
  try {
    const expression = `new Promise((ok) => chrome.developerPrivate.updateExtensionConfiguration(
      { extensionId: ${JSON.stringify(extensionId)}, userScriptsAccess: true },
      () => ok(chrome.runtime.lastError?.message ?? "ok")))`;
    for (let tries = 0; tries < 40; tries += 1) {
      const reply = await browser(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      const value = reply.result?.result?.value;
      if (value === "ok") return value;
      await new Promise((done) => setTimeout(done, 250));
    }
    return "chrome://extensions never accepted the toggle";
  } finally {
    await browser("Target.closeTarget", { targetId });
  }
}
