import { setInterval } from "node:timers";
setInterval(() => globalThis.gc(), 10).unref();
