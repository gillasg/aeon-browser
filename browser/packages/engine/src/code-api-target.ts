// One way to name a target for page.click / type / fill / hover / check / locator. In order: a bu
// id ("12", "e12"), a frame ref ("f3:e2"), a tab ref ("t5:e12"), an exact, unique, visible text or
// accessible name ("Load details"), then CSS. A ref never reaches CSS. A name that several
// controls share fails TARGET_AMBIGUOUS with each one's ref; a name nothing has gets the closest
// controls on the page, frames included. Role and label locators also find controls the engine
// sees but the page cannot query: closed shadow roots and frames (the nodes bu.state() lists).
// Evaluated in the sandbox realm.

export const browserTargetApi = `
var __TARGET_REF = /^(\\d+|e\\d+|f\\d+:e\\d+|t\\d+:e\\d+)$/i;
var __QUIET_ROLES = ['statictext', 'paragraph', 'heading', 'generic', 'none', 'image', 'img'];
// A string that reads as CSS (or a locator shorthand) rather than text a person sees.
var __TAGS = new Set('a abbr address article aside audio b body button canvas caption code dd details dialog div dl dt em fieldset figure footer form h1 h2 h3 h4 h5 h6 header hr i iframe img input label legend li main menu nav ol optgroup option output p pre progress section select small span strong summary sup svg table tbody td textarea tfoot th thead tr ul video'.split(' '));
function __looksCss(value) {
  if (/^(css|xpath|text|role|label|placeholder|id|testid|data-testid)=|^\\/\\/|^\\(/.test(value)) return true;
  if (/[#\\[\\]>~*=:]|^\\./.test(value)) return true;
  // A bare tag (with classes) is CSS; another lowercase word is a name a person sees ("login").
  var tag = /^([a-z][a-z0-9-]*)((\\.[\\w-]+)*)$/.exec(value);
  return Boolean(tag && (__TAGS.has(tag[1]) || tag[2] || tag[1].includes('-')));
}
function __normName(value) { return String(value ?? '').replace(/\\s+/g, ' ').trim(); }
function __nodeRef(node) { return node.frame || !node.backendNodeId ? node.ref : node.backendNodeId; }
function __nodeLine(node) { return '[' + __nodeRef(node) + '] ' + node.role + ' ' + JSON.stringify(__normName(node.name)); }
// The page's controls as the engine sees them now (frames and closed shadow roots included).
async function __targetNodes(target) {
  await bu.state({target}).catch(() => '');
  var state = __states.get(__key(target));
  return state && Array.isArray(state.nodes) ? state.nodes : [];
}
// Exact name matches, controls first: a button named like the heading above it wins.
function __nameMatches(nodes, name, role) {
  var wanted = __normName(name);
  var hits = nodes.filter((node) => __normName(node.name) === wanted && (!role || String(node.role).toLowerCase() === role));
  var controls = hits.filter((node) => !__QUIET_ROLES.includes(String(node.role).toLowerCase()));
  return controls.length ? controls : hits;
}
// The closest names for a miss: the same words first, then a shared word.
function __closestNodes(nodes, name) {
  var wanted = __normName(name).toLowerCase(), words = wanted.split(' ').filter((word) => word.length > 2);
  var score = (node) => {
    var have = __normName(node.name).toLowerCase();
    if (!have || __QUIET_ROLES.includes(String(node.role).toLowerCase())) return 0;
    if (have.includes(wanted) || wanted.includes(have)) return 3;
    return words.filter((word) => have.includes(word)).length ? 1 : 0;
  };
  return nodes.map((node) => [score(node), node]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 5).map(([, node]) => node);
}
function __ambiguous(name, hits) {
  return Error('TARGET_AMBIGUOUS: ' + JSON.stringify(__normName(name)) + ' matches ' + hits.length + ' elements: ' +
    hits.slice(0, 8).map(__nodeLine).join(', ') + '; pass one of these ids, e.g. page.click(' + JSON.stringify(String(__nodeRef(hits[0]))) + ')');
}
function __missHint(nodes, name) {
  var near = __closestNodes(nodes, name);
  return near.length ? '; closest: ' + near.map(__nodeLine).join(', ') + ' (pass the id)' : '';
}
// {element} for an engine step, or {locator} for a CSS or shorthand target.
async function __resolveTarget(target, element) {
  if (typeof element !== 'string') return {element: __element(target, element)};
  var value = element.trim();
  if (__TARGET_REF.test(value)) return {element: __element(target, value)};
  if (__looksCss(value)) {
    var loc = __locatorFor(target, value);
    return loc ? {locator: loc} : {element: __element(target, value)};
  }
  var nodes = await __targetNodes(target);
  var hits = __nameMatches(nodes, value);
  if (hits.length > 1) throw __ambiguous(value, hits);
  if (hits.length === 1) return {element: __element(target, __nodeRef(hits[0])), node: hits[0]};
  // No control has that name: it may still be a CSS selector (a bare word, a class chain).
  return {element: __element(target, value), miss: __missHint(nodes, value)};
}
async function __withMiss(resolved, run) {
  try { return await run(); }
  catch (error) {
    var message = String(error && error.message || error);
    if (resolved.miss && /TARGET_NOT_FOUND|not a valid selector/.test(message)) throw Error(message.replace(/\\s*$/, '') + resolved.miss);
    throw error;
  }
}
function __clickResolved(target, resolved, options) {
  if (resolved.locator) return resolved.locator.click(options);
  return __withMiss(resolved, () => __step(Object.assign({op:'click',target,element:__wire(resolved.element),observe:false}, __pointerFields(options))));
}
function __fillResolved(target, resolved, value, options) {
  if (resolved.locator) return resolved.locator.fill(value, options);
  var ms = __stepTimeout(options);
  return __withMiss(resolved, () => __step({op:'fill',target,element:__wire(resolved.element),value:String(value),observe:false,
    ...(options && options.human === true ? {human:true} : {}),...(options && options.force === true ? {force:true} : {}),...(ms !== undefined ? {timeoutMs: ms} : {})}));
}
// page.click / page.fill / page.type / page.hover / page.check through the one resolver.
function __targetActions(target, base) {
  var hoverAt = base.hover;
  var resolveFor = (element) => __resolveTarget(target, element);
  var locatorOf = (resolved) => resolved.locator || __locator(target, resolved.element);
  return {
    click: async (element, options) => __clickResolved(target, await resolveFor(element), options),
    fill: async (element, value, options) => __fillResolved(target, await resolveFor(element), value, options),
    type: async (element, value, options) => __fillResolved(target, await resolveFor(element), value, options),
    dblclick: async (element, options) => {
      var resolved = await resolveFor(element);
      return resolved.locator ? resolved.locator.dblclick(options) : __clickResolved(target, resolved, {...options, clickCount: 2});
    },
    check: async (element) => {
      var resolved = await resolveFor(element);
      if (resolved.locator) return resolved.locator.check();
      var node = resolved.node || (await __targetNodes(target)).find((n) => String(__nodeRef(n)) === String(element));
      if (!node || node.checked !== true) return __clickResolved(target, resolved);
    },
    uncheck: async (element) => {
      var resolved = await resolveFor(element);
      if (resolved.locator) return resolved.locator.uncheck();
      var node = resolved.node || (await __targetNodes(target)).find((n) => String(__nodeRef(n)) === String(element));
      if (node && node.checked === true) return __clickResolved(target, resolved);
    },
    hover: async (a, b) => {
      if (typeof a !== 'string') return hoverAt(a, b);
      var resolved = await resolveFor(a);
      if (resolved.locator) return resolved.locator.hover();
      var backendNodeId = resolved.element && resolved.element.backendNodeId;
      if (!backendNodeId) return locatorOf(resolved).hover();
      var model = await base.cdp('DOM.getBoxModel', {backendNodeId});
      var quad = model && model.model && model.model.content;
      if (!quad) throw Error('TARGET_NOT_FOUND: ' + a + ' has no box to hover');
      return hoverAt((quad[0] + quad[4]) / 2, (quad[1] + quad[5]) / 2);
    },
  };
}
// getByRole / getByLabel that the page cannot find (a closed shadow root, a frame) act on the
// engine's own node for that role and name, when exactly one has it.
async function __stateFallback(target, element, error) {
  var message = String(error && error.message || error);
  if (!/TARGET_NOT_FOUND/.test(message) || !element || element.filters || element.regex) return null;
  var role = element.kind === 'locator' ? String(element.role || '').toLowerCase() : '';
  var name = element.kind === 'locator' ? element.name : element.kind === 'query' && element.by === 'label' ? element.value : null;
  if (name == null || name === '') return null;
  var nodes = await __targetNodes(target);
  var hits = __nameMatches(nodes, name, role || undefined);
  if (hits.length > 1) throw __ambiguous(name, hits);
  return hits.length === 1 ? __element(target, __nodeRef(hits[0])) : null;
}
async function __viaState(target, element, run) {
  try { return await run(element); }
  catch (error) {
    var found = await __stateFallback(target, element, error).catch((inner) => { if (/TARGET_AMBIGUOUS/.test(String(inner && inner.message))) throw inner; return null; });
    if (!found) throw error;
    return run(found);
  }
}
// Playwright's frameLocator(sel).getByRole/getByText/getByLabel/locator: the engine already reaches
// into frames, so these search every frame for the role or name.
function __frameLocator(target, frameSelector) {
  var page = browser.page(target);
  var self = {
    getByRole: (role, options) => page.getByRole(role, options),
    getByText: (text, options) => page.getByText(text, options),
    getByLabel: (text, options) => page.getByLabel(text, options),
    getByPlaceholder: (text, options) => page.getByPlaceholder(text, options),
    locator: (selector) => page.locator(selector),
    frameLocator: (selector) => __frameLocator(target, selector),
    first: () => self,
  };
  void frameSelector;
  return Object.freeze(self);
}
// locator.dragTo(other): press on this element, move to the other in steps, release.
async function __dragTo(target, from, to) {
  var page = browser.page(target);
  var a = await from.boundingBox(), b = await to.boundingBox();
  if (!a || !b) throw Error('TARGET_NOT_FOUND: dragTo needs both elements on screen');
  return page.drag(a.x + a.width / 2, a.y + a.height / 2, b.x + b.width / 2, b.y + b.height / 2);
}
`;
