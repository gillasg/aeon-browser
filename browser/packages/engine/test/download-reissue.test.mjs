import assert from "node:assert/strict";
import test from "node:test";
import { reissueFilename, shouldReissueDownload } from "../dist/evidence/download-reissue.js";

// Chrome drops the first renderer download in a document after the navigate event and
// before the request. The receipt reissues that attempt. A download that already arrived
// is not sent again.

test("a download attempt with no download event is reissued", () => {
  const attempt = { href: "http://127.0.0.1:9/file", name: "receipt.txt", at: 1_000 };
  assert.deepEqual(
    shouldReissueDownload(attempt, { startedAt: 900, hasDownload: false }, 1_100),
    attempt,
  );
});

test("a download that already arrived is not sent twice", () => {
  const attempt = { href: "http://127.0.0.1:9/file", name: "receipt.txt", at: 1_000 };
  assert.equal(
    shouldReissueDownload(attempt, { startedAt: 900, hasDownload: true }, 1_100),
    undefined,
  );
});

test("an attempt from an earlier action is not reissued onto this one", () => {
  const attempt = { href: "https://example.test/file", name: "a.txt", at: 500 };
  assert.equal(
    shouldReissueDownload(attempt, { startedAt: 900, hasDownload: false }, 1_000),
    undefined,
  );
});

test("a stale attempt and a non-download url are left alone", () => {
  assert.equal(
    shouldReissueDownload(
      { href: "http://127.0.0.1:9/file", name: "a.txt", at: 1_000 },
      { startedAt: 900, hasDownload: false },
      1_000 + 501,
    ),
    undefined,
  );
  assert.equal(
    shouldReissueDownload(
      { href: "javascript:alert(1)", name: "a.txt", at: 1_000 },
      { startedAt: 900, hasDownload: false },
      1_050,
    ),
    undefined,
  );
  assert.equal(reissueFilename("../receipt.txt"), "receipt.txt");
  assert.equal(reissueFilename("  "), undefined);
});
