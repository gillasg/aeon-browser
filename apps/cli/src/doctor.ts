import { has, type Args } from "browserkit/dist/args.js";
import type { Command } from "browserkit/dist/usage.js";
import { doctorChecks, formatDoctor, type DoctorFacts } from "./doctor-checks.js";
import { stealthChecks } from "./doctor-stealth-checks.js";
import { liveDoctorIo, type DoctorIo } from "./doctor-io.js";
import type { DaemonHost } from "./host.js";

export function doctorCommand(host: DaemonHost): Command {
  return {
    name: "doctor",
    group: "Graft",
    summary: "check that Graft can run",
    help: `Usage: graft doctor [--json] [--stealth]

Checks the daemon health ping, protocol versions, the extension and engine, a normal Chrome
launch (extra Chrome flags are optional), a signed-in model, the login task, and that data
folders are writable. Each line is ok or fail with the one fix. --json prints the same checks.

--stealth instead opens one hidden tab and reports WebRTC leaks, exit IP vs time zone and
languages, and page tells, one line per check with the exact environment fix. It never spoofs.`,
    run: (args: Args) => runDoctor(has(args, "json"), liveDoctorIo(host), has(args, "stealth")),
  };
}

export async function runDoctor(json: boolean, io: DoctorIo, stealth = false): Promise<number> {
  const checks = stealth
    ? stealthChecks(
        io.stealthFacts
          ? await io.stealthFacts()
          : { error: "Stealth probing is not available in this context." },
      )
    : doctorChecks(await loadFacts(io));
  process.stdout.write(formatDoctor(checks, json));
  return checks.some((check) => check.status === "fail") ? 1 : 0;
}

async function loadFacts(io: DoctorIo): Promise<DoctorFacts> {
  const [daemon, chromeCommandLines, modelSignedIn, loginTask, dirs] = await Promise.all([
    io.daemon(),
    io.chromeCommandLines(),
    io.modelSignedIn(),
    io.loginTask(),
    io.dataDirs(),
  ]);
  const startError = io.startFailure ? await io.startFailure() : undefined;
  const mcpUsesClientModel = io.mcpUsesClientModel ? await io.mcpUsesClientModel() : false;
  return {
    daemon,
    chromeCommandLines,
    modelSignedIn,
    loginTask,
    dirs,
    ...(startError ? { startError } : {}),
    ...(mcpUsesClientModel ? { mcpUsesClientModel } : {}),
  };
}
