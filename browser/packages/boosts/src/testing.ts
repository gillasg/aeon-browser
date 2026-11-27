// What the unit tests import: the pure parts of the extension.
export * from "./shared/match.js";
export * from "./shared/userscript.js";
export * from "./shared/css.js";
export * from "./shared/network.js";
export * from "./shared/diff.js";
export * from "./shared/review.js";
export * from "./shared/bundle.js";
export * from "./shared/ai.js";
export * from "./shared/health.js";
export { mayConnect } from "./background/xhr.js";
export { Widgets, WIDGET_ATTRIBUTE } from "./content/widgets.js";
export {
  MAX_SOCKETS,
  MAX_TOTAL_SOCKETS,
  KEEP_ALIVE_MS,
  socketHub,
  socketRefusal,
} from "./background/ws.js";
export * from "./shared/checks.js";
export { webSocket } from "./runtime/ws.js";
