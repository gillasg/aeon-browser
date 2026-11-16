/**
 * Makes machine paths in a measured prompt portable. `JSON.stringify` escapes backslashes, so a
 * Windows checkout path appears doubled inside tools JSON; replacing only the raw form leaves the
 * absolute path in the byte count and makes the footprint depend on the machine.
 */
export function createPortable(roots) {
  const replacements = roots.flatMap(([from, to]) => [
    [from, to],
    [jsonEscaped(from), to],
  ]);
  return (text) => replacements.reduce((out, [from, to]) => out.replaceAll(from, to), text);
}

function jsonEscaped(value) {
  return JSON.stringify(value).slice(1, -1);
}
