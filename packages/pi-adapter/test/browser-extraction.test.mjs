import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { BrowserCodeRuntime } from "../dist/browser-code-runtime.js";
import { browserDocumentApi } from "../dist/browser-document-api.js";
import { BrowserElementTargetSchema } from "@pippin/protocol";

test("read-only inspection avoids observations while mutations still observe", async () => {
  const runtime = new BrowserCodeRuntime(),
    calls = [];
  const target = { tabId: 1 };
  const call = async (step) => {
    calls.push(step);
    return step.op === "observe"
      ? { kind: "semantic", target, nodes: [], url: "https://example.test" }
      : { kind: "page", data: { value: "extracted" } };
  };
  try {
    const result = await runtime.execute(
      `const p=browser.page(${JSON.stringify(target)}); await p.inspect(()=>document.title)`,
      call,
    );
    assert.equal(result.value, "extracted");
    assert.deepEqual(
      calls.map((s) => s.op),
      ["evaluate"],
    );
    calls.length = 0;
    await runtime.execute("await p.evaluate(()=>document.body.click())", call);
    assert.deepEqual(
      calls.map((s) => s.op),
      ["evaluate", "observe"],
    );
  } finally {
    runtime.close();
  }
});

test("common click shorthand is normalized to valid targets", async () => {
  const runtime = new BrowserCodeRuntime(),
    elements = [];
  const call = async (step) => {
    if (step.element) {
      elements.push(BrowserElementTargetSchema.parse(step.element));
    }
    return { kind: "semantic", target: { tabId: 1 }, nodes: [], url: "https://example.test" };
  };
  try {
    await runtime.execute(
      "const p=browser.page({tabId:1}); await p.click({text:'Chapter'}); await p.click({ref:'e1',snapshotId:'00000000-0000-4000-8000-000000000000'})",
      call,
    );
    assert.deepEqual(
      elements.map((e) => e.kind),
      ["query", "ref"],
    );
    await assert.rejects(runtime.execute("await p.click({unknown:true})", call), /INVALID_ELEMENT/);
  } finally {
    runtime.close();
  }
});

function viewer(texts, legacy = false) {
  const pdf = {
    numPages: texts.length,
    getPage: async (i) => ({
      getTextContent: async () => ({ items: [{ str: texts[i - 1], hasEOL: true }] }),
    }),
  };
  const child = {
    location: { href: "https://example.test/viewer" },
    document: { querySelectorAll: () => [] },
    ...(legacy
      ? { PDFVar: { _transport: { loadingTask: { promise: Promise.resolve(pdf) } } } }
      : { PDFViewerApplication: { pdfDocument: pdf } }),
  };
  const root = {
    document: {
      querySelectorAll: (selector) =>
        selector === "iframe,frame" ? [{ contentWindow: child }] : [],
      querySelector: () => ({ contentWindow: child }),
    },
  };
  return { window: root, document: root.document };
}

test("PDF extraction reads every page from standard and embedded legacy viewers", async () => {
  for (const legacy of [false, true]) {
    const result = await runInNewContext(
      browserDocumentApi + "; __readPdfText({})",
      viewer(["First question", "Second question"], legacy),
    );
    assert.equal(result.totalPages, 2);
    assert.equal(result.partial, false);
    assert.equal(result.pages[1].text, "Second question");
  }
});

test("PDF extraction reports truncation, ranges and image-only pages honestly", async () => {
  const clipped = await runInNewContext(
    browserDocumentApi + "; __readPdfText({maxChars:1000})",
    viewer(["a".repeat(1500), "last"]),
  );
  assert.equal(clipped.partial, true);
  assert.equal(clipped.pages[0].truncated, true);
  const ranged = await runInNewContext(
    browserDocumentApi + "; __readPdfText({from:2,to:2})",
    viewer(["first", "second"]),
  );
  assert.equal(ranged.partial, true);
  assert.equal(ranged.pages[0].page, 2);
  const scanned = await runInNewContext(browserDocumentApi + "; __readPdfText({})", viewer([""]));
  assert.match(scanned.warning, /image-only/);
});

test("nested extracted strings are preserved before output journaling", async () => {
  const runtime = new BrowserCodeRuntime();
  try {
    const result = await runtime.execute(
      "console.log({pages:['a'.repeat(10000)+'END-OF-QUESTION']})",
      async () => assert.fail("Unexpected browser call"),
    );
    assert.match(result.output, /END-OF-QUESTION/);
    assert.doesNotMatch(result.output, /more characters/);
  } finally {
    runtime.close();
  }
});
