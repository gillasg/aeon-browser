// Executed inside QuickJS. The only host capability is the validated browser call bridge.
export const browserCodeApi = `
function __locator(target, element) {
  return Object.freeze({
    element,
    click: () => __call({op:'click',target,element}),
    fill: (value) => __call({op:'fill',target,element,value}),
    press: (key) => __call({op:'press',target,element,key}),
    getByRole: (role, options = {}) => {
      if (element.kind !== 'query' || element.by !== 'css') throw Error('Scope with page.locator(css).getByRole(...)');
      return __locator(target,{kind:'locator',role,name:options.name || '',exact:options.name !== undefined,...options,scope:element.value});
    },
    locator: (selector) => {
      if (element.kind !== 'query' || element.by !== 'css') throw Error('Scope with a CSS locator');
      return __locator(target,{kind:'query',by:'css',value:selector,scope:element.value});
    },
  });
}
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
    read: (selector, options = {}) => __call({op:"read", target, selector, ...options}),
    wait: (selector, options = {}) => __call({op:"wait", target, selector,
      ...(typeof options === "number" ? {timeoutMs:options} : options)}),
    navigate: (url) => __call({op:"navigate", target, url}),
    diagnostics: (clear = false) => __call({op:"diagnostics", target, clear}),
    popups: () => __call({op:"popups", target}),
    removePreview: (scriptId) => __call({op:"siteScript", target, action:"remove", scriptId}),
    snapshot: (options = {}) => __call({op:'observe', target, kind:'semantic', ...options}),
    locator: (selector, options = {}) => __locator(target,{kind:'query',by:'css',value:selector,...options}),
    getByRole: (role, options = {}) => __locator(target,{kind:'locator',role,name:options.name || '',exact:options.name !== undefined,...options}),
    getByText: (value, options = {}) => __locator(target,{kind:'query',by:'text',value,...options}),
    getByLabel: (value, options = {}) => __locator(target,{kind:'query',by:'label',value,...options}),
    getByPlaceholder: (value, options = {}) => __locator(target,{kind:'query',by:'placeholder',value,...options}),
    press: (element, key) => __call({op:'press',target,element,key}),
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
