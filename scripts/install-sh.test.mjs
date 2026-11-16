import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installScript = fileURLToPath(new URL("../install.sh", import.meta.url));

function sandbox(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "aeon-install-sh-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const checkout = join(root, "checkout");
  for (const folder of [home, bin, join(checkout, ".git")]) mkdirSync(folder, { recursive: true });
  writeFakes(bin);
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    AEON_DIR: checkout,
    SANDBOX: root,
  };
  delete env.XDG_DATA_HOME;
  delete env.AEON_DATA_HOME;
  delete env.AEON_DATA_DIR;
  Object.assign(env, options.env);
  return {
    root,
    home,
    checkout,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeFakes(bin) {
  writeScript(
    bin,
    "node",
    'if [ "$1" = "--version" ]; then echo v22.0.0; exit 0; fi\nprintf ran > "$SANDBOX/setup-ran"\nexit 0\n',
  );
  writeScript(bin, "git", 'printf "%s\\n" "$*" >> "$SANDBOX/git-args"\nexit 0\n');
  writeScript(bin, "npm", npmScript());
}

function npmScript() {
  return [
    'printf "%s\\n" "$*" >> "$SANDBOX/npm-args"',
    'prefix=""',
    'silent=""',
    'previous=""',
    'for arg in "$@"; do',
    '  if [ "$previous" = "--prefix" ]; then prefix="$arg"; fi',
    '  if [ "$arg" = "--silent" ]; then silent=1; fi',
    '  previous="$arg"',
    "done",
    'if [ "${FAIL_NPM:-}" = "1" ]; then',
    '  if [ -z "$silent" ]; then',
    '    echo "npm ERR! code EACCES" >&2',
    '    echo "npm ERR! path /usr/lib/node_modules/pnpm" >&2',
    "  fi",
    "  exit 1",
    "fi",
    'if [ -z "$prefix" ]; then',
    '  echo "npm ERR! code EACCES" >&2',
    '  echo "npm ERR! path /usr/lib/node_modules/pnpm" >&2',
    "  exit 1",
    "fi",
    'mkdir -p "$prefix/bin"',
    'printf "#!/bin/sh\\nexit 0\\n" > "$prefix/bin/pnpm"',
    'chmod +x "$prefix/bin/pnpm"',
    "exit 0",
  ].join("\n");
}

function writeScript(folder, name, body) {
  const path = join(folder, name);
  writeFileSync(path, "#!/bin/sh\nset -e\n" + body);
  chmodSync(path, 0o755);
}

function install(env) {
  return spawnSync("/bin/sh", [installScript], {
    cwd: dirname(installScript),
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

test("pnpm is installed into the user prefix, not npm's root-owned global prefix", () => {
  const box = sandbox();
  try {
    const result = install(box.env);
    assert.equal(result.status, 0, result.stderr);
    const args = readFileSync(join(box.root, "npm-args"), "utf8").trim();
    assert.match(args, /--global/);
    assert.match(args, /--prefix /);
    assert.match(args, new RegExp(box.home + "/\\.local"));
    assert.match(args, /pnpm@11\.4\.0/);
    assert.equal(args.includes("--silent"), false);
    assert.equal(existsSync(join(box.home, ".local", "bin", "pnpm")), true);
    assert.equal(existsSync(join(box.root, "setup-ran")), true);
  } finally {
    box.cleanup();
  }
});

test("a failed pnpm install says why and stops", () => {
  const box = sandbox({ env: { FAIL_NPM: "1" } });
  try {
    const result = install(box.env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EACCES|npm ERR!/);
    assert.match(result.stderr, /pnpm/);
    assert.match(result.stderr, /Aeon:/);
    assert.equal(existsSync(join(box.root, "setup-ran")), false);
  } finally {
    box.cleanup();
  }
});
