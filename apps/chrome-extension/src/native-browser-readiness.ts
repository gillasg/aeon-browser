export async function waitPageInteractive(tabId: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let prior = "";
  while (Date.now() < deadline) {
    const result = (await chrome.debugger
      .sendCommand({ tabId }, "Runtime.evaluate", {
        expression: `(${interactiveProbe.toString()})()`,
        returnByValue: true,
      })
      .catch(() => undefined)) as { result?: { value?: string } } | undefined;
    const value = result?.result?.value ?? "";
    if (value && value === prior) return true;
    prior = value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
function interactiveProbe(): string {
  if (document.readyState === "loading" || !document.body) return "";
  const elements = [
    ...document.querySelectorAll("input,textarea,button,a[href],[role=button],[role=combobox]"),
  ];
  const visible = elements.filter((el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden";
  });
  if (!visible.length && document.readyState !== "complete") return "";
  return JSON.stringify([location.href, visible.length, document.body.innerText.slice(0, 1000)]);
}

export async function viewportFingerprint(debuggee: chrome.debugger.Debuggee): Promise<string> {
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression: `(${layoutProbe.toString()})()`,
    returnByValue: true,
  })) as { result?: { value?: string }; exceptionDetails?: unknown };
  if (result.exceptionDetails || typeof result.result?.value !== "string" || !result.result.value)
    throw new Error("STALE_REF");
  return result.result.value;
}
function layoutProbe(): string {
  const elements = [...document.querySelectorAll("*")];
  const boxes: unknown[] = [];
  for (const el of elements) {
    const box = el.getBoundingClientRect();
    if (
      box.width <= 0 ||
      box.height <= 0 ||
      box.bottom < 0 ||
      box.top > innerHeight ||
      box.right < 0 ||
      box.left > innerWidth ||
      getComputedStyle(el).visibility === "hidden"
    )
      continue;
    boxes.push([
      el.tagName,
      el.id,
      el.getAttribute("aria-label"),
      el.getAttribute("href"),
      (el.textContent ?? "").trim().slice(0, 80),
      ...[box.x, box.y, box.width, box.height].map(Math.round),
    ]);
    if (boxes.length >= 2000) return "";
  }
  return JSON.stringify([scrollX, scrollY, innerWidth, innerHeight, visualViewport?.scale, boxes]);
}
