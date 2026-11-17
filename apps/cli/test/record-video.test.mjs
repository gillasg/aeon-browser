// `aeon record start|stop` on a fake ffmpeg, and `aeon video kit` copying plain template files.
// No display and no real encoder are needed: the fake writes a few frames and answers signals.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const repo = fileURLToPath(new URL("../../..", import.meta.url));

function fakeFfmpeg(dir) {
  const file = join(dir, "fake-ffmpeg");
  writeFileSync(
    file,
    `#!/bin/sh
last=""
for a in "$@"; do last="$a"; done
case "$last" in
  *.mp4) : > "$last"; exit 0 ;;
  *%06d.jpg)
    d=$(dirname "$last"); mkdir -p "$d"
    i=1; while [ $i -le 3 ]; do printf '\\377\\330\\377\\340\\000\\020JFIF\\000\\001\\001\\000\\000\\001\\000\\001\\000\\000' > "$d/$(printf '%06d' $i).jpg"; i=$((i+1)); done
    trap 'exit 0' INT TERM
    while :; do sleep 1; done ;;
esac
exit 0
`,
  );
  chmodSync(file, 0o755);
  const probe = join(dir, "fake-ffprobe");
  writeFileSync(probe, "#!/bin/sh\necho 1280,800\n");
  chmodSync(probe, 0o755);
  return { ffmpeg: file, ffprobe: probe };
}

async function aeon(home, args, env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      env: { ...process.env, AEON_DATA_DIR: join(home, "data"), ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("aeon record start/stop writes frames, a clip and an honest events.json on a fake ffmpeg", async () => {
  const home = await mkdtemp(join(tmpdir(), "aeon-record-"));
  try {
    const { ffmpeg, ffprobe } = fakeFfmpeg(home);
    const folder = join(home, "recording");
    const env = { AEON_FFMPEG: ffmpeg, AEON_FFPROBE: ffprobe };
    const start = await aeon(
      home,
      ["record", "start", "--screen", "--out", folder, "--fps", "30"],
      env,
    );
    assert.equal(start.code, 0, start.stderr);
    assert.match(start.stdout, /Recording screen/);
    const initial = JSON.parse(readFileSync(join(folder, "events.json"), "utf8"));
    assert.equal(initial.clip.source, "screen");
    assert.ok(initial.note, "an in-progress log says so");

    const stopped = await aeon(home, ["record", "stop", "--out", folder], env);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.match(stopped.stdout, /Stopped/);
    const events = JSON.parse(readFileSync(join(folder, "events.json"), "utf8"));
    assert.equal(events.version, 1);
    assert.equal(events.recorder, "aeon");
    assert.equal(events.clock, "clip");
    assert.equal(events.clip.fps, 30);
    assert.equal(events.clip.width, 1280);
    assert.equal(events.clip.height, 800);
    assert.ok(events.clip.startedAt > 0);
    assert.ok(events.clip.frames >= 1);
    assert.ok(Array.isArray(events.events));
    assert.ok((await readdir(join(folder, "frames"))).some((f) => f.endsWith(".jpg")));
    assert.ok(existsSync(join(folder, "clip.mp4")));
    assert.equal(
      existsSync(join(folder, ".recording.json")),
      false,
      "stop clears the active marker",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("aeon video kit copies the Remotion starter kit without adding a dependency to Aeon", async () => {
  const home = await mkdtemp(join(tmpdir(), "aeon-kit-"));
  try {
    const target = join(home, "my-video");
    const result = await aeon(home, ["video", "kit", target]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Starter kit copied/);
    for (const file of [
      "package.json",
      "README.md",
      "EVENTS.md",
      "src/Root.tsx",
      "src/ChromeFrame.tsx",
      "src/Scene.tsx",
      "src/zooms-from-events.ts",
      "public/frames/000001.jpg",
    ])
      assert.ok(existsSync(join(target, file)), `${file} was copied`);
    const readme = readFileSync(join(target, "README.md"), "utf8");
    assert.match(readme, /events\.json/);
    assert.match(readme, /9:16/);
    const aeonPackage = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    assert.ok(
      !aeonPackage.dependencies?.remotion && !aeonPackage.devDependencies?.remotion,
      "Aeon has no Remotion dependency",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
