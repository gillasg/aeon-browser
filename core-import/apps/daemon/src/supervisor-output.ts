/** SDK/extensions may log to stdout; keep those logs out of the supervisor's replies. */
export function reserveSupervisorOutput(): typeof process.stdout.write {
  const reply = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr);
  return reply;
}
