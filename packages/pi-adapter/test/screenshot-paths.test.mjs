import assert from "node:assert/strict";
import test from "node:test";
import { screenshotPaths } from "../dist/browser-code-tool.js";

test("screenshot paths are the absolute images the cell saved or returned", () => {
  const paths = screenshotPaths({
    screenshots: ["/work/screens/1.png", "screens/relative.png", "/work/notes.txt"],
    value: { saved: "/work/screens/2.jpg", nested: { path: "/work/screens/3.webp" } },
  });
  assert.deepEqual(paths, ["/work/screens/1.png", "/work/screens/2.jpg", "/work/screens/3.webp"]);
});
