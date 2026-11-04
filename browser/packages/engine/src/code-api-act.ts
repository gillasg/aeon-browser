// page.observe(instruction) and page.act(instruction | action) in browser code. A small fast
// model picks elements from a compact page listing (one call, through the host's `locate`
// request), so the agent's own model does not spend turns reading bu.state() and probing with
// evaluate. An act that worked is cached on this machine by site and instruction and replays
// with no model call; when the page changed and the replay misses, the act asks the model again
// and re-caches (self-healing). A two-step act (open a menu, then pick in it) shows the model
// only what changed after the first step. `%name%` variables are filled in at action time: the
// model, the cache and the result only ever see the placeholder.

export const browserActApi = `
var __ACT_SKIP = ['statictext','paragraph','generic','none','heading','image','img','separator','listitem','list'];
function __actId(n) { return n.frame || !n.backendNodeId ? n.ref : n.backendNodeId; }
// The page for the model: actionable elements with their ids, headings and a little text for
// context. only: a Set of ids to keep (the changed part, for a second look).
function __actListing(state, only) {
  var lines = [], size = 0;
  for (var n of state.nodes || []) {
    var role = String(n.role || '').toLowerCase(), line;
    if (role === 'heading') line = '## ' + n.name;
    else if (role === 'statictext' || role === 'paragraph') { if (only) continue; line = String(n.name || '').slice(0, 120); }
    else if (__ACT_SKIP.includes(role)) continue;
    else {
      if (only && !only.has(String(__actId(n)))) continue;
      line = '[' + __actId(n) + '] ' + n.role + ' ' + JSON.stringify(String(n.name || '').slice(0, 160));
      if (n.value !== undefined) line += ' = ' + JSON.stringify(String(n.value).slice(0, 80));
      for (var prop of ['disabled','checked','expanded','selected']) if (n[prop] !== undefined) line += ' ' + prop + '=' + n[prop];
    }
    if (!line.trim()) continue;
    size += line.length + 1;
    if (size > 24000) { lines.push('[... page clipped]'); break; }
    lines.push(line);
  }
  return lines.join(String.fromCharCode(10));
}
function __actVariables(variables) {
  if (variables == null) return {};
  if (typeof variables !== 'object' || Array.isArray(variables)) throw Error('INVALID_VARIABLES: variables is an object of names to values, e.g. {email: "a@b.c"}');
  return variables;
}
function __actFill(arg, variables) {
  return String(arg).replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) => {
    if (!Object.prototype.hasOwnProperty.call(variables, name)) throw Error('INVALID_VARIABLE: %' + name + '% was not passed in {variables}');
    return String(variables[name]);
  });
}
// The node an action means in the current state: its id when still there, else the one element
// with the same role and name (an id from an older load, or a cached step).
function __actNode(state, action) {
  var nodes = state.nodes || [];
  if (action.id != null) {
    var byId = nodes.find((n) => String(__actId(n)) === String(action.id));
    if (byId && (!action.role || byId.role === action.role)) return byId;
  }
  if (!action.role) return null;
  var same = nodes.filter((n) => n.role === action.role && String(n.name || '') === String(action.name || ''));
  return same.length === 1 ? same[0] : null;
}
// Every method goes through the engine's id-based steps (ids are CDP nodes, not page selectors).
var __actMethods = {
  click: (page, id) => page.click(id),
  fill: (page, id, node, args) => page.fill(id, args[0] ?? ''),
  // A native select takes its option label through fill.
  select: (page, id, node, args) => page.fill(id, args[0] ?? ''),
  press: (page, id, node, args) => page.press(id, args[0] || 'Enter'),
  check: (page, id, node) => node.checked === true ? null : page.click(id),
  uncheck: (page, id, node) => node.checked === true ? page.click(id) : null,
  hover: async (page, id, node) => {
    if (!node.backendNodeId || node.frame) throw Error('INVALID_ACTION: hover works on elements of the top page; use page.locator(css).hover() in a frame');
    var quad = (await page.cdp('DOM.getBoxModel', {backendNodeId: node.backendNodeId})).model.border;
    return page.hover((quad[0] + quad[4]) / 2, (quad[1] + quad[5]) / 2);
  },
};
async function __actRun(page, method, id, node, args) {
  var run = __actMethods[method];
  if (!run) throw Error('INVALID_ACTION: method ' + method + ' is not one of ' + Object.keys(__actMethods).join(', '));
  return run(page, id, node, args);
}
async function __actPerform(target, action, variables) {
  var state = __states.get(__key(target)) || await browser.page(target).snapshot({});
  var node = __actNode(state, action);
  if (!node) throw Error('ACT_TARGET_LOST: ' + (action.description || action.role + ' ' + JSON.stringify(action.name)) + ' is not on the page now');
  var id = __actId(node), page = browser.page(target);
  var args = (action.args || []).map((arg) => __actFill(arg, variables));
  var method = action.method === 'type' ? 'fill' : action.method;
  await __actRun(page, method, id, node, args);
  __states.delete(__key(target));
  return {role: node.role, name: String(node.name || ''), method, args: action.args || [], description: action.description || ''};
}
async function __actLocate(target, request, state, only) {
  var answer = await __call({locate: {...request, url: state.url, page: __actListing(state, only)}});
  var actions = [];
  for (var item of answer.actions || []) {
    var node = __actNode(state, {id: item.id});
    if (node) actions.push({id: String(__actId(node)), role: node.role, name: String(node.name || ''), method: item.method, args: item.args || [], description: item.description || ''});
  }
  return {actions, twoStep: Boolean(answer.twoStep)};
}
async function __observe(target, instruction, options) {
  var startedAt = Date.now();
  var state = await browser.page(target).snapshot({});
  var variables = Object.keys(__actVariables(options.variables));
  var found = await __actLocate(target, {instruction: String(instruction), mode: 'observe', limit: Math.min(Math.max(Number(options.limit) || 8, 1), 30), variables}, state);
  console.log('[observe] ' + found.actions.length + ' for ' + JSON.stringify(String(instruction).slice(0, 80)) + ' ' + (Date.now() - startedAt) + ' ms');
  return found.actions;
}
function __actSite(state) { try { return new URL(state.url).hostname; } catch { return ''; } }
async function __actReplay(target, key, variables) {
  var hit = await __call({actionCache: 'get', ...key}).catch(() => ({steps: null}));
  if (!hit || !Array.isArray(hit.steps) || !hit.steps.length) return null;
  var done = [];
  try {
    for (var step of hit.steps) {
      if (done.length) await browser.page(target).snapshot({});
      done.push(await __actPerform(target, step, variables));
    }
    return done;
  } catch (error) {
    // The page changed under the cached step: a later step must not run on a guess. When nothing
    // ran yet, the act falls back to the model, which re-caches what works now.
    if (done.length) throw Error('ACT_REPLAY_PARTIAL: ' + done.map((step) => step.description || step.method).join(' -> ') + ' ran from the cache, then: ' + error.message);
    await __call({actionCache: 'drop', ...key}).catch(() => {});
    return null;
  }
}
async function __actInfer(target, instruction, variables, names) {
  var state = await browser.page(target).snapshot({});
  var first = await __actLocate(target, {instruction, mode: 'act', variables: names}, state);
  if (!first.actions.length) throw Error('ACT_NOT_FOUND: nothing on ' + state.url + ' matches ' + JSON.stringify(instruction) + '; bu.state() shows what is there');
  var done = [await __actPerform(target, first.actions[0], variables)];
  if (!first.twoStep) return done;
  // The second look: only the elements that are new since the first, on the same document.
  var next = await browser.page(target).snapshot({});
  var before = new Set((state.nodes || []).map((n) => String(__actId(n))));
  var added = new Set((next.nodes || []).map((n) => String(__actId(n))).filter((id) => !before.has(id)));
  var only = next.documentEpoch === state.documentEpoch && added.size ? added : null;
  var second = await __actLocate(target, {instruction, mode: 'second', done: done[0].description || done[0].method, variables: names}, next, only);
  if (second.actions.length) done.push(await __actPerform(target, second.actions[0], variables));
  return done;
}
async function __act(target, input, options) {
  var startedAt = Date.now();
  var variables = __actVariables(options.variables);
  if (input && typeof input === 'object') {
    var step = await __actPerform(target, input, variables);
    console.log('[act] ' + (step.description || step.method) + ' ' + (Date.now() - startedAt) + ' ms');
    return {ok: true, cached: false, steps: [step.description || step.method]};
  }
  var instruction = String(input || '').trim();
  if (!instruction) throw Error('INVALID_ACTION: page.act takes an instruction or an action from page.observe()');
  var names = Object.keys(variables);
  var state = __states.get(__key(target)) || await browser.page(target).snapshot({});
  var key = {site: __actSite(state), instruction, variables: names};
  var useCache = options.cache !== false && key.site;
  var done = useCache ? await __actReplay(target, key, variables) : null;
  var cached = Boolean(done);
  if (!done) {
    done = await __actInfer(target, instruction, variables, names);
    if (useCache) await __call({actionCache: 'put', ...key, steps: done}).catch(() => {});
  }
  var said = done.map((step) => step.description || step.method);
  console.log('[act] ' + said.join(' -> ') + (cached ? ' (cached)' : '') + ' ' + (Date.now() - startedAt) + ' ms');
  return {ok: true, cached, steps: said};
}
// page.extract('the price and delivery date', {schema}): the page's Markdown to a fast model,
// shaped by an optional JSON schema. page.extract({script}) is the scripted read, unchanged.
async function __extractAsk(target, base, instruction, options) {
  var startedAt = Date.now();
  var page = await base.markdown({max: 60000});
  var url = await base.url();
  var value = await __call({pageExtract: {instruction: String(instruction), schema: options.schema, url: String(url), page: String(page)}});
  console.log('[extract] ' + JSON.stringify(String(instruction).slice(0, 80)) + ' ' + (Date.now() - startedAt) + ' ms');
  return value;
}
function __extendPageAct(target, base) {
  var scripted = base.extract;
  return Object.assign(base, {
    extract: (spec, options = {}) => typeof spec === 'string' ? __extractAsk(target, base, spec, options || {}) : scripted(spec),
    observe: (instruction, options = {}) => __observe(target, instruction, options || {}),
    act: (input, options = {}) => __act(target, input, options || {}),
  });
}
`;
