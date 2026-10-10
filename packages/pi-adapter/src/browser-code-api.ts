// Installed once in the chat's JavaScript realm. Chrome operations use the browser call bridge.
export const browserCodeApi = `
function __locator(target, element) {
  return Object.freeze({
    element,
    click: () => __step({op:'click',target,element,observe:false}),
    fill: (value) => __step({op:'fill',target,element,value,observe:false}),
    press: (key) => __step({op:'press',target,element,key}),
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
  waitFor: (event, options = {}) => __event(options.target || __lastTarget,event,options),
  tabs: Object.assign(async (query) => (await __step({op:'listTabs', ...(query ? {query} : {})})).tabs,
    {list: async (query) => browser.tabs(query)}),
  openTab: async (url, options = {}) => {
    let clientInstanceId = options.clientInstanceId || __lastTarget?.clientInstanceId;
    if (!clientInstanceId) {
      const clients = (await __call({browserInfo:true})).clientInstanceIds;
      if (clients.length === 0) throw Error('BROWSER_OFFLINE: no browser executor is connected');
      if (clients.length !== 1) throw Error('Multiple browser profiles are connected; choose clientInstanceId from browser.tabs()');
      clientInstanceId = clients[0];
    }
    const result = await __step({op:'openTab', clientInstanceId, url,
      foreground: options.foreground === true});
    return browser.page(result.tab.target);
  },
  attachTab: async (target) => {
    await __step({op:'attachTab', target});
    return browser.page(target);
  },
  page: (target) => (__lastTarget = target, Object.freeze({
    target,
    get url() { return __states.get(__key(target))?.url || __tabs.get(__key(target))?.url; },
    get title() { return __tabs.get(__key(target))?.title; },
    [Symbol.for('nodejs.util.inspect.custom')]() { return {target,url:this.url,title:this.title}; },
    waitForEvent: (event, options = {}) => __event(target,event,options),
    expect: async (event, action, options = {}) => {var wait=__event(target,event,options);await wait.ready;try {await action();return await wait;}catch(error){await wait.dispose().catch(()=>{});throw error;}},
    frames: async () => (await __step({op:'frames',target,action:'list'})).data.map(info=>__framePage(target,info)),
    upload: (selector, files) => __step({op:'upload',target,selector,files}),
    setFileInputFiles: (backendNodeId, files) => __step({op:'upload',target,backendNodeId,files}),
    clickAt: (x,y) => __step({op:'pointer',target,action:'click',x,y}),
    doubleClickAt: (x,y) => __step({op:'pointer',target,action:'doubleClick',x,y}),
    hover: (x,y) => __step({op:'pointer',target,action:'hover',x,y}),
    drag: (x,y,toX,toY) => __step({op:'pointer',target,action:'drag',x,y,toX,toY}),
    keyboard: (keys) => __step({op:'keys',target,keys}),
    reconnect: () => __step({op:'reconnect',target}),
    download: async (url, filename) => (await __step({op:'downloads',target,action:'start',url,...(filename?{filename}:{})})).data,
    resolveDownload: async (token) => (await __step({op:'downloads',target,action:'resolve',token})).data,
    waitForDownload: async (downloadId, options = {}) => {var deadline=Date.now()+(options.timeoutMs??20000);while(Date.now()<deadline){var result=(await __step({op:'downloads',target,action:'wait',downloadId,timeoutMs:Math.min(1000,deadline-Date.now())})).data;if(result.state==='complete')return result;if(result.state==='interrupted')throw Error('DOWNLOAD_INTERRUPTED: '+result.error);}throw Error('TIMEOUT: download still in progress; do not start it again');},
    cancelDownload: (downloadId) => __step({op:'downloads',target,action:'cancel',downloadId}),
    read: (selector, options = {}) => __step({op:"read", target, selector, ...options}),
    wait: (selector, options = {}) => __step({op:"wait", target, selector,
      ...(typeof options === "number" ? {timeoutMs:options} : options)}),
    navigate: (url) => __step({op:"navigate", target, url}),
    diagnostics: (clear = false) => __step({op:"diagnostics", target, clear}),
    popups: () => __step({op:"popups", target}),
    removePreview: (scriptId) => __step({op:"siteScript", target, action:"remove", scriptId}),
    snapshot: (options = {}) => { const {max,target:ignored,...filters}=options; return __step({op:'observe',target,kind:'semantic',...filters}); },
    locator: (selector, options = {}) => __locator(target,{kind:'query',by:'css',value:selector,...options}),
    getByRole: (role, options = {}) => __locator(target,{kind:'locator',role,name:options.name || '',exact:options.name !== undefined,...options}),
    getByText: (value, options = {}) => __locator(target,{kind:'query',by:'text',value,...options}),
    getByLabel: (value, options = {}) => __locator(target,{kind:'query',by:'label',value,...options}),
    getByPlaceholder: (value, options = {}) => __locator(target,{kind:'query',by:'placeholder',value,...options}),
    press: (element, key, options = {}) => __step({op:'press',target,element:__element(target,element),key,...options}),
    screenshot: () => __step({op:'observe', target, kind:'screenshot'}),
    click: (element) => __step({op:'click',target,element:__element(target,element),observe:false}),
    fill: (element, value) => __step({op:'fill',target,element:__element(target,element),value,observe:false}),
    evaluate: async (fn, arg) => (await __step({op:'evaluate',target,expression:__expression(fn,arg)})).data.value,
    inspect: async (fn, arg) => (await __step({op:'evaluate',target,expression:__expression(fn,arg)},true)).data.value,
    pdfText: (options = {}) => browser.page(target).inspect(__readPdfText,options),
    cdp: async (method, params = {}) => (await __step({op:'cdp',target,method,params})).data.value,
    waitFor: (fn, options = {}) => __step({op:'waitFor',target,expression:'('+fn.toString()+')()',...options}),
    scroll: (direction = 'down', amount = 1200, element) =>
      __step({op:'scroll', target, direction, amount, ...(element ? {element} : {})}),
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
  })),
});
`;
