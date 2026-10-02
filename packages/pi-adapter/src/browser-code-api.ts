// Executed inside QuickJS. The only host capability is the validated browser call bridge.
export const browserCodeApi = `
const browser = Object.freeze({
  tabs: async (query) => (await __call({op:'listTabs', ...(query ? {query} : {})})).tabs,
  openTab: async (url, options = {}) => {
    let clientInstanceId = options.clientInstanceId;
    if (!clientInstanceId) {
      const tabs = await browser.tabs();
      const clients = [...new Set(tabs.map(tab => tab.target.clientInstanceId))];
      if (clients.length !== 1) throw Error('Choose an explicit clientInstanceId from browser.tabs()');
      clientInstanceId = clients[0];
    }
    const result = await __call({op:'openTab', clientInstanceId, url,
      foreground: options.foreground !== false});
    return browser.page(result.tab.target);
  },
  attachTab: async (target) => {
    await __call({op:'attachTab', target});
    return browser.page(target);
  },
  page: (target) => Object.freeze({
    target,
    snapshot: () => __call({op:'observe', target, kind:'semantic'}),
    screenshot: () => __call({op:'observe', target, kind:'screenshot'}),
    click: (element) => __call({op:'click', target, element}),
    fill: (element, value) => __call({op:'fill', target, element, value}),
    scroll: (direction = 'down', amount = 1200, element) =>
      __call({op:'scroll', target, direction, amount, ...(element ? {element} : {})}),
    scrollToEnd: async (options = {}) => {
      const page = browser.page(target);
      const maxSteps = Math.min(40, Math.max(1, options.maxSteps || 30));
      let boundaryCount = 0, stalled = 0, last;
      for (let i = 0; i < maxSteps; i++) {
        last = await page.scroll(options.direction || 'down', options.amount || 1200, options.element);
        boundaryCount = last.scroll.atBoundary ? boundaryCount + 1 : 0;
        stalled = last.scroll.moved ? 0 : stalled + 1;
        if (boundaryCount >= 2) return {reachedEnd:true, reason:'boundary', steps:i+1, scroll:last.scroll};
        if (stalled >= 3) return {reachedEnd:false, reason:'no_progress', steps:i+1, scroll:last.scroll};
      }
      return {reachedEnd:false, reason:'step_limit', steps:maxSteps, scroll:last.scroll};
    },
  }),
});
`;
