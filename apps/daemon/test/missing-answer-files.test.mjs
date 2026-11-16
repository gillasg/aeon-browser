import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { missingAnswerFiles, missingFileLine } from "../dist/missing-answer-files.js";
import { buildRunCard } from "../dist/run-card.js";
import { RouteRecorder } from "../dist/route-recorder.js";

test("a missing link is named once and an existing file is not", () => {
  const workspace = mkdtempSync(join(tmpdir(), "aeon-missing-"));
  mkdirSync(join(workspace, "downloads"));
  writeFileSync(join(workspace, "report.md"), "# ok\n");
  writeFileSync(join(workspace, "downloads", "orders.csv"), "id\n");
  const roots = [workspace, join(workspace, "downloads")];
  const answer = [
    "Saved [report](report.md) and [orders](orders.csv).",
    "Also `missing.csv` and [site](https://example.com/gone.csv).",
    "```",
    "`not-a-claim.txt`",
    "```",
  ].join("\n");
  assert.deepEqual(missingAnswerFiles(answer, roots), ["missing.csv"]);
  assert.deepEqual(missingAnswerFiles("See [report](report.md).", roots), []);
  const line = missingFileLine(["missing.csv"]);
  assert.match(line, /missing\.csv/);
  assert.ok(line.length <= 200);
});

test("the run card shows one notice for a missing file and none when the list is empty", () => {
  const base = { chatId: "chat", runId: "run", site: "shop.test", task: "orders" };
  const card = buildRunCard({
    ...base,
    durationMs: 1200,
    path: "first time",
    missingFiles: ["missing.csv"],
  });
  const notices = card.items.filter(
    (item) => item.kind === "notice" && /Missing file/.test(item.text),
  );
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /missing\.csv/);
  assert.ok(notices[0].text.length <= 200);
  const clear = buildRunCard({ ...base, durationMs: 1200, path: "first time" });
  assert.equal(
    clear.items.some((item) => item.kind === "notice" && /Missing file/.test(item.text)),
    false,
  );
});

test("a finished run names a file that is not in the workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aeon-card-"));
  writeFileSync(join(workspace, "report.md"), "# ok\n");
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = mkdtempSync(join(tmpdir(), "aeon-routes-"));
  const cards = [];
  const recorder = new RouteRecorder(
    { publish: (_chat, event) => cards.push(event) },
    60_000,
    () => workspace,
  );
  try {
    await recorder.prepare("chat", "orders for 2024");
    await recorder.observe("chat", { kind: "run-state", state: "running-unconfirmed" });
    await recorder.observe("chat", step("shop.test"));
    await recorder.observe("chat", {
      kind: "message-end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Saved [report](report.md) and `missing.csv`." }],
      },
    });
    await recorder.observe("chat", { kind: "run-state", state: "idle" });
    const notices = cards[0].card.items.filter(
      (item) => item.kind === "notice" && /Missing file/.test(item.text),
    );
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /missing\.csv/);
    assert.equal(notices[0].text.includes("report.md"), false);
  } finally {
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
    recorder.close();
  }
});

function step(site) {
  return {
    kind: "tool-update",
    toolCallId: "t",
    toolName: "browser_code",
    arguments: {},
    partialResult: "",
    steps: [
      {
        id: "open",
        cellId: "c",
        chatId: "chat",
        tabId: 1,
        at: 1,
        ms: 20,
        kind: "click",
        label: "Orders",
        site,
        write: false,
        effect: "confirmed",
        target: { role: "link", name: "Orders" },
        evidence: {
          navigated: `https://${site}/orders`,
          request: { method: "GET", path: "/orders", status: 200 },
        },
      },
    ],
  };
}
