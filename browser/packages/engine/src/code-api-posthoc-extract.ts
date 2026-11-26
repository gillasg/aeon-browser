// Post-hoc data extraction in the sandbox: page.state.fiber() (React props, hook state, class
// instances), page.data() v2 ({attrs}, {globals}, {find, deep}) and page.code.modules() (the live
// webpack/Rspack registry). Each embeds page code by source from its native-browser-* file, runs it
// once with page.inspect, and scrubs the result (scrubDeep) before it leaves the sandbox.
import { fiberScript } from "./native-browser-fiber.js";
import { dataV2Script } from "./native-browser-data-v2.js";
import { modulesScript } from "./native-browser-modules.js";

const prelude = (script: string, call: RegExp) => JSON.stringify(script.replace(call, ""));

const help = {
  fiber:
    "page.state.fiber({minLen: 3, keys?, component?, instance?, limit: 20, sampleSize: 3}) reads React fiber trees, read-only: arrays in component props (source 'prop'), in hook state (source 'hook', path hooks[i]) and, with instance: 'App' or /Editor/, a class component's stateNode fields (source 'stateNode', e.g. Excalidraw's scene). keys keeps arrays whose rows have every key; component (a name or RegExp) keeps those components. Returns {componentsScanned, matches: [{component, source, path, len, keys, sample}]}, ranked and deduplicated, values scrubbed. Use it when page.state.stores() is empty but the page renders a list.",
  modules:
    "page.code.modules({grep?, limit: 50}) scans the live webpack/Rspack module registry (window.webpackChunk*) with zero network requests and without calling any module: each loaded factory's source is grepped (default: API paths, /vN/, graphql, operationName, persistedQuery, sha256Hash, sign, nonce, csrf; grep takes a string or RegExp). Returns {chunks, modulesScanned, matches: [{id, bytes, hits: [{kind: 'url'|'operation'|'hash'|'signer'|'grep', value}]}]}, scrubbed. It sees lazy chunks page.code.bundle() misses; a legacy webpackJsonp page returns no chunks and a note.",
  data: "page.data() returns embedded JSON (JSON-LD, __NEXT_DATA__, app state, application/json scripts) and metadata with the largest arrays of objects; {summary: true} lists sources; {find: ['title', 'id']} returns arrays of objects with those keys. v2: {attrs: true} adds attrs: [{selector, attr, bytes, keys, value}] from data-* attributes holding JSON (data-props, data-blob, data-a-state, data-mw, data-page-cfg); {globals: true} adds globals: [{name, bytes, keys, value}] from inline window data (ytInitialData, ytInitialPlayerResponse, _preloads, __DISCOGS_DATA__, __BXD_DATA, StoreDefaults, CLIENT_ENV and other large plain objects); {find: 'averageRating' | ['id', 'price'], deep: true} walks every source (scripts, attrs, globals) to depth 30 and returns matches: [{source, path, kind: 'array'|'object'|'scalar', len?, value}], scalars included. All scrubbed and bounded.",
};

export const browserPosthocExtractApi = `
var __fiberPrelude = ${prelude(fiberScript({}), /\nreturn fbCollect\(window, document, \{\}\);\}\)\(\)$/)};
var __dataV2Prelude = ${prelude(dataV2Script({}), /\nreturn dvCollect\(window, document, \{\}\);\}\)\(\)$/)};
var __modulesPrelude = ${prelude(modulesScript({}), /\nreturn mdCollect\(window, \{\}\);\}\)\(\)$/)};
if (typeof __helpTopics === 'object' && __helpTopics) Object.assign(__helpTopics, ${JSON.stringify(help)});
function __posthocPattern(value) {
  if (value instanceof RegExp) return {source: value.source, flags: value.flags};
  if (typeof value === 'string') return value;
  return undefined;
}
function __posthocGrep(value) {
  if (value instanceof RegExp) return {source: value.source, flags: value.flags};
  if (typeof value === 'string' && value) return {source: value.split('').map((c) => /[A-Za-z0-9 _]/.test(c) ? c : '\\\\' + c).join(''), flags: 'i'};
  return undefined;
}
async function __posthocFiber(base, options = {}) {
  var opts = {...options, component: __posthocPattern(options.component), instance: __posthocPattern(options.instance)};
  var raw = await base.inspect(__fiberPrelude + '\\nreturn fbCollect(window, document, ' + JSON.stringify(opts) + ');})()');
  return scrubDeep(raw || {componentsScanned: 0, matches: []});
}
async function __posthocModules(base, options = {}) {
  var opts = {...options, grep: __posthocGrep(options.grep)};
  var raw = await base.inspect(__modulesPrelude + '\\nreturn mdCollect(window, ' + JSON.stringify(opts) + ');})()');
  return scrubDeep(raw || {chunks: [], modulesScanned: 0, matches: []});
}
async function __posthocData(base, data, options) {
  var deep = options.deep === true && options.find != null;
  var {attrs, globals, deep: _deep, ...rest} = options;
  void _deep;
  var v2 = {attrs: !!attrs, globals: !!globals, ...(deep ? {deep: true, find: options.find, max: options.max} : {})};
  var extra = scrubDeep(await base.inspect(__dataV2Prelude + '\\nreturn dvCollect(window, document, ' + JSON.stringify(v2) + ');})()') || {});
  if (deep)
    return {...(attrs ? {attrs: extra.attrs || []} : {}), ...(globals ? {globals: extra.globals || []} : {}),
      find: extra.find, deep: true, matches: extra.matches || [], sources: extra.sources || []};
  var result = await data(rest);
  return {...(result || {}), ...(attrs ? {attrs: extra.attrs || []} : {}), ...(globals ? {globals: extra.globals || []} : {})};
}
function __extendPagePosthoc(target, base) {
  var state = base.state;
  if (typeof state === 'function') state.fiber = (options = {}) => __posthocFiber(base, options);
  var data = base.data;
  if (typeof data === 'function')
    base.data = (options = {}) => options && typeof options === 'object' && (options.attrs || options.globals || options.deep)
      ? __posthocData(base, data, options)
      : data(options);
  if (base.code) base.code = Object.freeze({...base.code, modules: (options = {}) => __posthocModules(base, options)});
  return base;
}
`;
