import { has, type Args } from "browserkit/dist/args.js";
import type { Command } from "browserkit/dist/usage.js";
import { doctorChecks, formatDoctor, type DoctorFacts } from "./doctor-checks.js";
import { liveDoctorIo, type DoctorIo } from "./doctor-io.js";
import type { DaemonHost } from "./host.js";

export function doctorCommand(host: DaemonHost): Command {
  return {
    name: "doctor",
    group: "Aeon",
    summary: "check that Aeon can run",
    help: `Usage: aeon doctor [--json]

Checks the daemon health ping, protocol versions, the extension and engine, Chrome's flags,
a signed-in model, the Aeon-Core-Login task, and that data folders are writable. Each line is
ok or fail with the one fix. --json prints the same checks.`,
    run: (args: Args) => runDoctor(has(args, "json"), liveDoctorIo(host)),
  };
}

export async function runDoctor(json: boolean, io: DoctorIo): Promise<number> {
  const checks = doctorChecks(await loadFacts(io));
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
  return { daemon, chromeCommandLines, modelSignedIn, loginTask, dirs };
}
