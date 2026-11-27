// browser.liveView: a live viewer page on this machine that rows and frames stream into, run by
// the Graft daemon. start() also tells the extension the viewer's push address and token, so
// boosts can feed it with GM.liveView.push without the token ever appearing in their source.

export const browserLiveViewApi = `
var __liveView = Object.freeze({
  start: async (options = {}) => {
    var view = await __call({liveView:'start', title: options && options.title !== undefined ? String(options.title) : undefined});
    await __call({boosts:'viewAdd', view: {id: view.id, title: view.title, pushUrl: view.pushUrl, token: view.token}}).catch(() => undefined);
    return view;
  },
  stop: async (id) => {
    var answer = await __call({liveView:'stop', id: String(id)});
    await __call({boosts:'viewRemove', id: String(id)}).catch(() => undefined);
    return answer;
  },
  list: () => __call({liveView:'list'}),
});
browser = Object.freeze(Object.assign({}, browser, {liveView: __liveView}));
`;
