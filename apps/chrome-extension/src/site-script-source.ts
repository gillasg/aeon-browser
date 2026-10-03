import type { SiteScriptDefinition } from "@pippin/protocol";
const bootstrap = `
const previous = globalThis.__aeonSiteScript;
if (previous && previous.revision === revision && !previous.failed) return {alreadyApplied:true};
previous?.dispose();
const cleanups = [], controller = new AbortController();
const state = {revision, failed:false, dispose: () => {
  controller.abort();
  for (const cleanup of cleanups.splice(0).reverse()) {try {cleanup();} catch {}}
  delete globalThis.__aeonSiteScript;
}};
globalThis.__aeonSiteScript = state;
const report = (error) => {
  state.failed = true;
  chrome.runtime.sendMessage({kind:'aeon.script.report', scriptId, revision,
    error:String(error?.message || error).slice(0,1000)}).catch(() => {});
};
const guarded = (fn) => {try {Promise.resolve(fn()).catch(report);} catch(error) {report(error);}};
const style = (text) => {
  const element = document.createElement('style');
  element.textContent = text; (document.head || document.documentElement).append(element);
  cleanups.push(() => element.remove()); return element;
};
const aeon = Object.freeze({signal:controller.signal, style,
  cleanup: (fn) => {if(typeof fn !== 'function') throw Error('cleanup needs a function'); cleanups.push(fn);},
  hide: (selector) => style(selector + '{display:none!important}'),
  onChange: (fn) => {
    let timer;
    const observer = new MutationObserver(() => {
      if(timer || controller.signal.aborted) return;
      timer = setTimeout(() => {timer = undefined; guarded(fn);}, 120);
    });
    observer.observe(document.documentElement,{subtree:true,childList:true});
    cleanups.push(() => {observer.disconnect(); clearTimeout(timer);}); guarded(fn);
  },
  onRoute: (fn) => {
    let url = location.href;
    const timer = setInterval(() => {if(location.href !== url){url = location.href; guarded(fn);}}, 500);
    cleanups.push(() => clearInterval(timer)); guarded(fn);
  },
});
if(css) style(css);
`;
export function siteScriptSource(script: SiteScriptDefinition): string {
  return `(async () => {
const scriptId = ${JSON.stringify(script.scriptId)}, revision = ${script.revision}, css = ${JSON.stringify(script.css)};
${bootstrap}
try {
  const value = await (async () => {${script.code}\n})();
  return {applied:true, revision, value: typeof value === 'undefined' ? null : value};
} catch(error) {report(error); state.dispose(); return {applied:false, error:String(error?.message || error).slice(0,1000)};}
})()`;
}
export const siteScriptCleanup = "globalThis.__aeonSiteScript?.dispose(); ({removed:true})";
