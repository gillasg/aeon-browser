export const browserFastApi = `
var __states = new Map(), __tabs = new Map(), __seen = new Map(), __dirty = new Map(), __lastTarget;
var __key = target => JSON.stringify(target);
function __beginCell() { __dirty.clear(); __hasDelivered=false; __deliveryValue=undefined; }
async function __step(step, readOnly = false) {
  if (step.target) __lastTarget = step.target;
  var action = ['click','fill','press','scroll','navigate','evaluate','cdp','upload','pointer','keys','reconnect'].includes(step.op);
  if(step.op==='frames' && ['click','fill','cdp'].includes(step.action))action=true;
  if (readOnly) action=false;
  if (action) __dirty.set(__key(step.target), step.target);
  var result = await __call(step);
  if (result.kind === 'tab') { __lastTarget = result.tab.target; __tabs.set(__key(__lastTarget),result.tab); }
  var observation = result.kind === 'semantic' ? result : result.observation;
  if (observation) {
    __states.set(__key(step.target), observation);
    __dirty.delete(__key(step.target));
  }
  if (action) {
    console.log('[ok] ' + step.op + (result.outcome ? ' ' + result.outcome : '') + (result.url ? ' -> ' + result.url : '') +
      (result.data && result.data.settle ? ' (' + result.data.settle.why + ')' : ''));
  }
  return result;
}
function __element(target, element) {
  if (element && typeof element === 'object' && !element.kind) {
    if (typeof element.text === 'string') return {kind:'query',by:'text',value:element.text};
    if (typeof element.ref === 'string' && typeof element.snapshotId === 'string') return {kind:'ref',ref:element.ref,snapshotId:element.snapshotId};
    throw Error('INVALID_ELEMENT: use page.getByText(text).click(), page.locator(css).click(), an observed id, or a target with kind');
  }
  if (typeof element !== 'number' && typeof element !== 'string') return element;
  var state = __states.get(__key(target));
  if (!state) throw Error('Observe this page with bu.state() before using an id');
  var node = state.nodes.find(n => n.backendNodeId === element || n.ref === element);
  if (!node) throw Error('STALE_REF: id absent from the latest state; observe again');
  return node.backendNodeId ? {kind:'backend',backendNodeId:node.backendNodeId,documentEpoch:state.documentEpoch}
    : {kind:'ref',snapshotId:state.snapshotId,ref:node.ref};
}
function __formatState(state, max = 3000) {
  var key = __key(state.target) + ':' + state.documentEpoch;
  var previous = __seen.get(key) || new Map(), next = new Map();
  var lines = [state.url];
  for (var n of state.nodes) {
    if (n.role.toLowerCase() === 'heading') {lines.push('## '+n.name);continue;}
    if (['statictext','paragraph'].includes(n.role.toLowerCase())) {lines.push(n.name);continue;}
    var text = (n.backendNodeId ? '[' + n.backendNodeId + '] ' : '[' + n.ref + '] ') + n.role + ' ' + JSON.stringify(n.name);
    if (n.value !== undefined) text += ' = ' + JSON.stringify(n.value);
    for (var prop of ['disabled','checked','focused','expanded','selected','pressed','mixed'])
      if (n[prop] !== undefined) text += ' ' + prop + '=' + n[prop];
    var id = n.backendNodeId || n.ref;
    next.set(id,text);
    if (previous.size && previous.get(id) !== text) text = '* ' + text;
    lines.push(text);
  }
  __seen.set(key,next);
  while (__seen.size > 32) __seen.delete(__seen.keys().next().value);
  if (state.text) {
    var labels = new Set(state.nodes.map(n=>n.name));
    lines.push(state.text.split('\\n').filter(line=>!labels.has(line)).join('\\n'));
  }
  if (state.truncated) lines.push('[observation truncated; use a focused snapshot or page.evaluate]');
  var text = lines.join('\\n');
  max = Math.min(30000, Math.max(500, max));
  if (text.length > max) text = text.slice(0, Math.floor(max * .8)) + '\\n[... clipped; bu.state({max:30000}) for more]\\n' + text.slice(-Math.floor(max * .2));
  return text;
}
Object.defineProperty(globalThis,'page',{value:undefined,writable:true,configurable:true});
var bu = Object.freeze({
  use: target => { __lastTarget = target; globalThis.page = browser.page(target); return globalThis.page; },
  state: async (options = {}) => {
    var target = options.target || __lastTarget;
    if (!target) throw Error('Use bu.use(attachedTarget) or browser.page(target) first');
    var state = await browser.page(target).snapshot(options);
    var text = __formatState(state, options.max);
    console.log(text);
    return text;
  },
  click: (id) => browser.page(__lastTarget).click(__element(__lastTarget, id)),
  type: async (id, text, options = {}) => {
    var target = __lastTarget;
    var element = __element(target, id);
    var result = await browser.page(target).fill(element, text);
    if (options.enter) result = await browser.page(target).press(element, 'Enter', {focus:false});
    return result;
  },
});
async function __finishCell() {
  for (var target of [...__dirty.values()]) {
    try { await bu.state({target}); }
    catch (error) { console.log('Final observation unavailable: ' + error.message); }
  }
  __dirty.clear();
}
`;
