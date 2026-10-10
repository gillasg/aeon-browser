export async function visiblePageText(debuggee: chrome.debugger.Debuggee): Promise<string> {
  const response = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression: `(${collectVisibleText.toString()})()`,
    returnByValue: true,
  })) as { result?: { value?: string } };
  return response.result?.value ?? "";
}
function collectVisibleText() {
  const roots: (Document | ShadowRoot)[] = [document];
  const lines: string[] = [];
  const visible = new WeakMap<Element, boolean>();
  let length = 0;
  for (let i = 0; i < roots.length && length < 20000; i++) {
    const root = roots[i];
    if (!root) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && length < 20000; node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (element.shadowRoot) roots.push(element.shadowRoot);
        if (element instanceof HTMLIFrameElement && element.contentDocument)
          roots.push(element.contentDocument);
        continue;
      }
      const text = visibleLine(node);
      if (text) {
        lines.push(text);
        length += text.length + 1;
      }
    }
  }
  return lines.join("\n").slice(0, 20000);
  function visibleLine(node: Node) {
    let element = node.parentElement;
    const text = node.textContent?.replace(/\s+/g, " ").trim();
    if (!element || !text || element.closest("script,style,noscript,[data-aeon-overlay]"))
      return "";
    while (element.parentElement && getComputedStyle(element).display === "contents")
      element = element.parentElement;
    if (!visible.has(element))
      visible.set(
        element,
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      );
    return visible.get(element) ? text : "";
  }
}
