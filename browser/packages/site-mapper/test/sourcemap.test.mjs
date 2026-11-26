import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  decodeMap,
  decodeVlq,
  discoverMapUrl,
  mapUrlRefusal,
  originalPosition,
} from "../dist/sourcemap.js";
import { sourceMaps } from "../dist/sourcemap-read.js";

test("VLQ decodes signed values and continuation digits", () => {
  assert.deepEqual(decodeVlq("AAAA"), [0, 0, 0, 0]);
  assert.deepEqual(decodeVlq("AACA"), [0, 0, 1, 0]);
  assert.deepEqual(decodeVlq("D"), [-1]);
  assert.deepEqual(decodeVlq("gB"), [16]);
  assert.deepEqual(decodeVlq("6rB"), [701]);
  assert.throws(() => decodeVlq("!"));
});

const MAP = {
  version: 3,
  sourceRoot: "webpack://",
  sources: ["src/a.ts", "src/b.ts"],
  names: ["loadUser", "render"],
  // line 1: col 0 → a.ts 1:0 (loadUser); col 10 → a.ts 3:4. line 2: col 5 → b.ts 9:6 (render)
  mappings: "AAAAA,UAEI;KCMEC",
  sourcesContent: ["export const a = 1;", null],
};

test("generated positions map back to the original file, line and name", () => {
  const map = decodeMap(MAP);
  assert.deepEqual(map.sources, ["webpack://src/a.ts", "webpack://src/b.ts"]);
  assert.deepEqual(originalPosition(map, { line: 1, col: 0 }), {
    source: map.sources[0],
    line: 1,
    col: 0,
    name: "loadUser",
  });
  assert.deepEqual(originalPosition(map, { line: 1, col: 14 }), {
    source: map.sources[0],
    line: 3,
    col: 4,
  });
  assert.deepEqual(originalPosition(map, { line: 2, col: 9 }), {
    source: map.sources[1],
    line: 9,
    col: 6,
    name: "render",
  });
  assert.equal(originalPosition(map, { line: 9, col: 0 }), undefined);
});

test("the SourceMap header wins over X-SourceMap and the trailing comment", () => {
  const text = "a();\n//# sourceMappingURL=from-comment.js.map";
  const file = "https://s.test/js/app.js";
  assert.equal(
    discoverMapUrl(file, text, { SourceMap: "/maps/h.map", "X-SourceMap": "x.map" }),
    "https://s.test/maps/h.map",
  );
  assert.equal(discoverMapUrl(file, text, { "x-sourcemap": "x.map" }), "https://s.test/js/x.map");
  assert.equal(discoverMapUrl(file, text), "https://s.test/js/from-comment.js.map");
  assert.equal(
    discoverMapUrl(file, "//# sourceMappingURL=data:application/json;base64,e30="),
    undefined,
  );
});

test("map URLs that are not http(s), or point into a private network, are refused", () => {
  const page = "https://s.test/";
  assert.match(mapUrlRefusal("file:///etc/passwd", page), /file:/);
  assert.match(mapUrlRefusal("chrome-extension://abc/x.map", page), /chrome-extension:/);
  assert.match(mapUrlRefusal("http://169.254.169.254/latest/meta-data", page), /private/);
  assert.match(mapUrlRefusal("http://10.0.0.5/app.js.map", page), /private/);
  assert.equal(mapUrlRefusal("https://cdn.s.test/app.js.map", page), undefined);
  assert.equal(
    mapUrlRefusal("http://127.0.0.1:3000/app.js.map", "http://127.0.0.1:3000/"),
    undefined,
    "a local dev page may read its own maps",
  );
});

test("sourceMaps reads a script, follows its SourceMap header and maps positions", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/app.js") {
      response.writeHead(200, { "content-type": "text/javascript", SourceMap: "/maps/app.map" });
      return response.end("a();b();\nc();");
    }
    if (request.url === "/maps/app.map") return response.end(JSON.stringify(MAP));
    if (request.url === "/evil.js") {
      response.writeHead(200, { "x-sourcemap": "file:///etc/passwd" });
      return response.end("x();");
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await sourceMaps(`${base}/app.js`, {
      positions: [{ line: 2, col: 6 }],
      contentChars: 100,
    });
    assert.equal(result.map, `${base}/maps/app.map`);
    assert.equal(result.hasContent, true);
    assert.equal(result.positions[0].original.line, 9);
    assert.equal(result.positions[0].original.name, "render");
    assert.equal(Object.values(result.content)[0], "export const a = 1;");
    const evil = await sourceMaps(`${base}/evil.js`);
    assert.match(evil.refused, /file:/);
    const none = await sourceMaps(`${base}/missing.js`);
    assert.ok(none.note);
  } finally {
    server.close();
  }
});
