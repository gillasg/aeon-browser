export async function selectScrollContainer(
  debuggee: chrome.debugger.Debuggee,
  point: { x: number; y: number },
  horizontal: boolean,
): Promise<string> {
  const expression = `(() => {
    const horizontal = ${horizontal};
    let node = document.elementFromPoint(${point.x}, ${point.y});
    if (node?.tagName === 'IFRAME') return null;
    while (node && node !== document.documentElement && node !== document.body) {
      const style = getComputedStyle(node);
      const overflow = horizontal ? style.overflowX : style.overflowY;
      const extent = horizontal ? node.scrollWidth : node.scrollHeight;
      const viewport = horizontal ? node.clientWidth : node.clientHeight;
      if (/(auto|scroll|overlay)/.test(overflow) && extent > viewport + 2) return node;
      node = node.parentElement;
    }
    return document.scrollingElement;
  })()`;
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression,
    returnByValue: false,
  })) as { result?: { objectId?: string } };
  if (!result.result?.objectId) throw new Error("UNSUPPORTED");
  return result.result.objectId;
}

export async function measureScroll(
  debuggee: chrome.debugger.Debuggee,
  objectId: string,
  horizontal: boolean,
): Promise<{ position: number; extent: number; viewport: number }> {
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.callFunctionOn", {
    objectId,
    returnByValue: true,
    arguments: [{ value: horizontal }],
    functionDeclaration: `function(horizontal) {
      if (!this.isConnected) return null;
      return {position: horizontal ? this.scrollLeft : this.scrollTop,
        extent: horizontal ? this.scrollWidth : this.scrollHeight,
        viewport: horizontal ? this.clientWidth : this.clientHeight};
    }`,
  })) as { result?: { value?: { position: number; extent: number; viewport: number } } };
  const value = result.result?.value;
  if (!value || ![value.position, value.extent, value.viewport].every(Number.isFinite))
    throw new Error("UNSUPPORTED");
  return value;
}
