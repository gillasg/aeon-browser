// The supervisor kills a daemon that leaves a bootstrap unanswered for 15 s, which ends every
// running chat. A blocked event loop is the usual cause, so:
// - every block of a second or more is logged (to the supervisor log) once it ends, and
// - a watchdog thread pauses the main thread while it is still blocked (3 s in) and logs its stack,
//   so a block that never ends (the supervisor kills it first) still names its code.
import { Worker } from "node:worker_threads";

const TICK_MS = 250;
const REPORT_MS = 1000;
const STACK_AFTER_MS = 3000;

export function watchStalls(
  log: (message: string) => void = (message) => process.stderr.write(message + "\n"),
  now: () => number = () => Date.now(),
  options: { stacks?: boolean } = {},
): () => void {
  const beat = new Int32Array(new SharedArrayBuffer(4));
  let last = now();
  const timer = setInterval(() => {
    const at = now();
    const late = at - last - TICK_MS;
    last = at;
    Atomics.add(beat, 0, 1);
    if (late >= REPORT_MS)
      log(
        `Aeon daemon: event loop blocked ${late} ms (heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB)`,
      );
  }, TICK_MS);
  timer.unref();
  const worker = options.stacks === false ? undefined : startWatchdog(beat, log);
  return () => {
    clearInterval(timer);
    void worker?.terminate();
  };
}

function startWatchdog(beat: Int32Array, log: (message: string) => void): Worker | undefined {
  try {
    const worker = new Worker(WATCHDOG, {
      eval: true,
      workerData: { beat, tick: TICK_MS, after: STACK_AFTER_MS },
    });
    worker.on("message", (line: string) => log(line));
    worker.on("error", () => undefined);
    worker.unref();
    return worker;
  } catch {
    return undefined;
  }
}

// Runs in the worker: when the main thread's heartbeat stops for STACK_AFTER_MS, pause it through
// the inspector and report where it is, once per block.
const WATCHDOG = `
const { workerData, parentPort } = require("node:worker_threads");
const inspector = require("node:inspector");
const { beat, tick, after } = workerData;
const session = new inspector.Session();
session.connectToMainThread();
let seen = Atomics.load(beat, 0), since = Date.now(), reported = false;
session.on("Debugger.paused", (event) => {
  const frames = event.params.callFrames.slice(0, 14).map((frame) => {
    const url = (frame.url || "").replace(/^.*[\\\\/]node_modules[\\\\/]/, "nm/").replace(/^.*[\\\\/](apps|packages|browser)[\\\\/]/, "$1/");
    return "  at " + (frame.functionName || "(anonymous)") + " " + url + ":" + (frame.location.lineNumber + 1);
  });
  parentPort.postMessage("Aeon daemon: event loop blocked for " + (Date.now() - since) + " ms so far, main thread is at:\\n" + frames.join("\\n"));
  session.post("Debugger.resume");
  session.post("Debugger.disable");
});
setInterval(() => {
  const now = Atomics.load(beat, 0);
  if (now !== seen) { seen = now; since = Date.now(); reported = false; return; }
  if (reported || Date.now() - since < after) return;
  reported = true;
  session.post("Debugger.enable", () => session.post("Debugger.pause"));
}, tick);
`;
