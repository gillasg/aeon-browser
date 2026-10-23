import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { encodeImageAsset, decodeImageAsset, MAX_IMAGE_ASSET_BYTES } from "../dist/image-asset.js";

test("binary image assets have closed metadata and exact bounded lengths", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const header = {
    kind: "image.asset",
    requestId: "00000000-0000-4000-8000-000000000001",
    mimeType: "image/png",
    byteLength: bytes.length,
    checksum: createHash("sha256").update(bytes).digest("hex"),
  };
  const packet = encodeImageAsset(header, bytes);
  assert.deepEqual(decodeImageAsset(packet), { header, bytes });
  assert.throws(() => decodeImageAsset(packet.slice(0, -1)), /Incomplete/);
  assert.throws(() =>
    encodeImageAsset({ ...header, byteLength: MAX_IMAGE_ASSET_BYTES + 1 }, bytes),
  );
  assert.throws(() => encodeImageAsset({ ...header, accessToken: "never accepted" }, bytes));
  assert.throws(() => decodeImageAsset(new Uint8Array([255, 255, 255, 255, 1])));
});
