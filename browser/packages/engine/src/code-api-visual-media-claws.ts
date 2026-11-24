// Visual, media-tap and workspace claws in browser code: page.canvas, page.visual, page.pip,
// page.media.audioState/captions, browser.workspaces and browser.suspension. Each is one host
// request; nothing is watched or patched in the page until a call starts it. Kept apart from
// code-api-claws.ts (the Wave 1A claws), which it does not touch.
export const browserVisualMediaClawsApi = `
var __extendPageVisualMediaClaws = (target) => ({
  canvas: Object.freeze({
    list: (options = {}) => __call({visual:'canvas', target, selector: options.selector, digest: options.digest === true}).then((r) => r.canvases),
    tap: Object.freeze({
      start: (options = {}) => __call({visual:'canvasTap', target, action:'start', limit: options.limit}),
      stop: () => __call({visual:'canvasTap', target, action:'stop'}),
      list: () => __call({visual:'canvasTap', target, action:'list'}),
    }),
  }),
  visual: Object.freeze({
    regionDiff: (clip, baseline, options = {}) => __call({visual:'regionDiff', target, clip, baseline, reset: options.reset === true}),
    occlusion: (what) => __call({visual:'occlusion', target, visualTarget: typeof what === 'string' ? {selector: what} : what}),
    forget: () => __call({visual:'forget', target}),
  }),
  pip: (action = 'status', options = {}) => __call({pip: String(action), target, ...options}),
});
var __visualMediaTap = (target) => ({
  audioState: () => __call({mediaTap:'audioState', target}),
  captions: Object.freeze({
    start: () => __call({mediaTap:'captionsStart', target}),
    stop: () => __call({mediaTap:'captionsStop', target}),
    list: (filter, options = {}) => __call({mediaTap:'captionsList', target, filter, after: options.after}),
    waitFor: (filter, timeoutMs) => __call({mediaTap:'captionsWait', target, filter, timeoutMs}),
  }),
});
var __visualMediaWorkspaces = Object.freeze({
  list: () => __call({workspaces:'list'}),
  group: (tabIds, options = {}) => __call({workspaces:'group', tabIds, ...options}),
  ungroup: (tabIds) => __call({workspaces:'ungroup', tabIds}),
  update: (groupId, patch = {}) => __call({workspaces:'update', groupId, patch}),
  save: (name) => __call({workspaces:'save', name}),
  restore: (name) => __call({workspaces:'restore', name}),
  listSaved: () => __call({workspaces:'listSaved'}),
  removeSaved: (name) => __call({workspaces:'removeSaved', name}),
});
var __visualMediaSuspension = Object.freeze({
  protect: (tabId, keep = true) => __call({suspension:'protect', tabId, protected: keep !== false}),
  suspendIdle: (options = {}) => __call({suspension:'suspendIdle', options}),
  status: () => __call({suspension:'status'}),
});
`;
