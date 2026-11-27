// Full-page capture plans a stitch from the main inner scroller. No Chrome: the fixture declares
// the measurements a scroll-jacked page would report (document fixed, #scroller overflow hidden).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  pageScrollerProbe,
  planFullPage,
  scrollsForShot,
  stitchOffsets,
} from "../dist/full-page-shot.js";

const html = readFileSync(new URL("./fixtures/inner-scroller.html", import.meta.url), "utf8");

function declared(name) {
  const match = new RegExp(`data-${name}="(\\d+)"`).exec(html);
  assert.ok(match, `fixture declares data-${name}`);
  return Number(match[1]);
}

test("the inner-scroller fixture is stitched and a scrolling document is not", () => {
  assert.match(html, /overflow:\s*hidden/);
  assert.match(html, /id="scroller"/);
  assert.match(html, /data-overflow-y="hidden"/);
  assert.equal(scrollsForShot("hidden"), true);
  assert.equal(scrollsForShot("auto"), true);
  assert.equal(scrollsForShot("visible"), false);
  assert.match(pageScrollerProbe.toString(), /overflowY === "visible"/);
  assert.match(pageScrollerProbe.toString(), /data-graft-shot/);

  const scrollHeight = declared("scroll-height");
  const clientHeight = declared("client-height");
  const documentScrolls = declared("doc-scroll") - declared("doc-client") > 80;
  assert.equal(documentScrolls, false);
  const probe = {
    documentScrolls,
    viewportWidth: 1280,
    viewportHeight: clientHeight,
    scrollers: [
      {
        selector: '[data-graft-shot="0"]',
        scrollHeight,
        clientHeight,
        top: 0,
        left: 0,
        width: 400,
        height: clientHeight,
        overflow: 200,
      },
      {
        selector: '[data-graft-shot="1"]',
        scrollHeight,
        clientHeight,
        top: 0,
        left: 0,
        width: 1280,
        height: clientHeight,
        overflow: scrollHeight - clientHeight,
      },
    ],
  };
  const plan = planFullPage(probe);
  assert.equal(plan.mode, "inner");
  assert.equal(plan.selector, '[data-graft-shot="1"]');
  assert.deepEqual(plan.offsets, [0, 600, 1200, 1800]);
  assert.deepEqual(stitchOffsets(2500, 600), [0, 600, 1200, 1800, 1900]);

  const document = planFullPage({ ...probe, documentScrolls: true });
  assert.equal(document.mode, "document");
  assert.deepEqual(document.offsets, []);
});

test("the screenshot surface stitches an inner scroller and still captures a scrolling document", async () => {
  const { browserSurfaceApi } = await import("../dist/code-api-surface.js");
  assert.match(browserSurfaceApi, /__stitchFullPage/);
  assert.match(browserSurfaceApi, /__sequenceStep/);
  assert.match(browserSurfaceApi, /data === previous/);
  assert.match(browserSurfaceApi, /captureBeyondViewport/);
  assert.match(browserSurfaceApi, /__shotPaths/);
  const { HELP_TOPICS } = await import("../dist/code-api-help.js");
  assert.match(HELP_TOPICS.screenshot, /overflow hidden/);
});
