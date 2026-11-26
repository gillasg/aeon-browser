// The host's validateUpload answer must be the resolved path list; an {error} object from a host
// with no workspace is named instead of reaching the upload step as its files.
import assert from "node:assert/strict";
import test from "node:test";
import { uploadPaths } from "../dist/code-upload-paths.js";

test("validateUpload answers pass through as path lists", () => {
  assert.deepEqual(uploadPaths(["/w/a.txt"]), ["/w/a.txt"]);
  assert.deepEqual(uploadPaths([]), []);
});

test("an object answer is a named error, not the step's files", () => {
  assert.throws(
    () => uploadPaths({ error: "UNSUPPORTED" }),
    /UNSUPPORTED: .*upload files \(UNSUPPORTED\)/,
  );
  assert.throws(() => uploadPaths({ files: ["/w/a.txt"] }), /UNSUPPORTED/);
  assert.throws(() => uploadPaths([1]), /UNSUPPORTED/);
});
