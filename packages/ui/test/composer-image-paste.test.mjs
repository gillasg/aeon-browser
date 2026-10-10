import test from "node:test";
import assert from "node:assert/strict";
import { imagePasteHandler } from "../dist/composer-image-paste.js";

test("pasted images use the existing attachment callback and are not inserted into the prompt", () => {
  const image = { name: "image.png", type: "image/png" },
    received = [];
  let prevented = false;
  imagePasteHandler((files) => received.push(...files))({
    clipboardData: {
      items: [{ kind: "file", type: "image/png", getAsFile: () => image }],
      files: [image],
    },
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.deepEqual(received, [image]);
});
test("ordinary text paste keeps the browser's default text behavior", () => {
  const handler = imagePasteHandler(() => assert.fail("Text is not an attachment"));
  handler({
    clipboardData: { items: [{ kind: "string", type: "text/plain" }], files: [] },
    preventDefault: () => assert.fail("Text paste must remain unchanged"),
  });
  assert.equal(imagePasteHandler(), undefined);
});
test("clipboard files fallback supports multiple images and ignores non-image files", () => {
  const images = [{ type: "image/jpeg" }, { type: "image/webp" }];
  let received;
  imagePasteHandler((files) => {
    received = files;
  })({
    clipboardData: { items: [], files: [...images, { type: "text/plain" }] },
    preventDefault() {},
  });
  assert.deepEqual(received, images);
});
