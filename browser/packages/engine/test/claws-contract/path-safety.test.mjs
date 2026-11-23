// Layer 1 contract: cross-OS path safety. A name a page supplies (a download attribute, a file
// name) becomes a file name with no directory in it, whatever the separator the page used, so
// the same input is safe on Linux, macOS and Windows.
import assert from "node:assert/strict";
import test from "node:test";
import { reissueFilename } from "../../dist/evidence/download-reissue.js";

const traversal = [
  ["../../etc/passwd", "passwd"],
  ["..\\..\\Windows\\win.ini", "win.ini"],
  ["C:\\Users\\shared\\invoice.pdf", "invoice.pdf"],
  ["D:/exports/report.csv", "report.csv"],
  ["/absolute/path/notes.txt", "notes.txt"],
  ["mixed/dir\\file.zip", "file.zip"],
  ["  padded.png  ", "padded.png"],
];

for (const [input, expected] of traversal) {
  test(`a page name ${JSON.stringify(input)} is saved as its base name only`, () => {
    assert.equal(reissueFilename(input), expected);
  });
}

test("names that resolve to a directory are refused", () => {
  for (const input of ["", "   ", ".", "..", "dir/..", "dir\\.", "trailing/"])
    assert.equal(reissueFilename(input), undefined, JSON.stringify(input));
});

test("a long name is capped, so it stays under common filesystem limits", () => {
  const long = `${"a".repeat(300)}.pdf`;
  const name = reissueFilename(long);
  assert.ok(name !== undefined);
  assert.equal(name.length, 180);
});

test("no output ever contains a path separator, for any input", () => {
  const samples = [
    "a/b/c",
    "a\\b\\c",
    "..\\/..\\/x",
    "x/..\\y",
    "\\\\server\\share\\doc.docx",
    "/////",
  ];
  for (const input of samples) {
    const name = reissueFilename(input);
    if (name === undefined) continue;
    assert.equal(/[\\/]/.test(name), false, `${input} produced ${name}`);
  }
});

test("the same name always maps to the same file name", () => {
  const input = "..\\drop\\Ticket #42 (final).pdf";
  assert.equal(reissueFilename(input), reissueFilename(input));
  assert.equal(reissueFilename(input), "Ticket #42 (final).pdf");
});
