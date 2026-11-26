import assert from "node:assert/strict";
import test from "node:test";

globalThis.chrome = {
  debugger: {
    sendCommand: async () => ({}),
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  },
  tabs: { get: async () => ({}), onRemoved: { addListener() {} } },
  runtime: { onInstalled: { addListener() {} }, id: "x" },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
  },
};

const wire = await import("../dist/wire-decode.js");
const { networkRecorderForTest } = await import("../dist/native-browser-network.js");
const { wireBodyOf } = await import("../dist/native-browser-network-wire.js");

// field 1 varint 150, field 2 "hi", field 3 {field 1: 1}, field 4 repeated 1 and 2,
// field 5 fixed32 1, field 6 fixed64 2.
const PROTO = Uint8Array.from([
  0x08, 0x96, 0x01, 0x12, 0x02, 0x68, 0x69, 0x1a, 0x02, 0x08, 0x01, 0x20, 0x01, 0x20, 0x02, 0x2d,
  0x01, 0x00, 0x00, 0x00, 0x31, 0x02, 0, 0, 0, 0, 0, 0, 0,
]);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

test("schemaless protobuf: varint, string, nested message, repeated, fixed32/64", () => {
  const result = wire.decodeWireBytes(PROTO, { mime: "application/x-protobuf" });
  assert.equal(result.format, "protobuf");
  assert.equal(result.truncated, false);
  assert.equal(result.bytes, PROTO.length);
  assert.deepEqual(result.value, [
    { field: 1, wire: "varint", value: 150 },
    { field: 2, wire: "string", value: "hi" },
    { field: 3, wire: "message", children: [{ field: 1, wire: "varint", value: 1 }] },
    { field: 4, wire: "varint", value: 1 },
    { field: 4, wire: "varint", value: 2 },
    { field: 5, wire: "fixed32", value: 1 },
    { field: 6, wire: "fixed64", value: 2 },
  ]);
});

test("protobuf caps depth and nodes, and rejects corrupt bytes without throwing", () => {
  let nested = Uint8Array.from([0x08, 0x01]);
  for (let level = 0; level < 12; level++)
    nested = Uint8Array.from([0x0a, nested.length, ...nested]);
  const deep = wire.decodeProtobuf(nested);
  assert.equal(deep.truncated, true);
  const many = new Uint8Array(6000).map((_, index) => (index % 2 ? 0x01 : 0x08));
  const wide = wire.decodeProtobuf(many);
  assert.equal(wide.truncated, true);
  assert.equal(wide.value.length, 2000);
  assert.equal(wire.decodeProtobuf(Uint8Array.from([0x0f, 0x01])), undefined); // wire type 7
  assert.equal(wire.decodeProtobuf(Uint8Array.from([0x0a, 0x10, 0x01])), undefined); // overrun
  assert.equal(wire.decodeProtobuf(Uint8Array.from([0x08, 0xff, 0xff])), undefined); // cut varint
  const garbage = wire.decodeWireBytes(Uint8Array.from([0xff, 0xfe, 0x00, 0x07]), {
    mime: "application/x-protobuf",
  });
  assert.equal(garbage.format, "bytes");
  assert.equal(garbage.value, b64([0xff, 0xfe, 0x00, 0x07]));
});

test("JSPB behind the XSSI prefix", () => {
  const result = wire.decodeWireText(')]}\'\n[["wrb.fr",null,"[1,2]"],[1]]', {
    mime: "application/json+protobuf",
  });
  assert.equal(result.format, "jspb");
  assert.deepEqual(result.value, [["wrb.fr", null, "[1,2]"], [1]]);
});

test("a 3-line RSC flight payload", () => {
  const text =
    '0:["$","div",null,{"children":"hi"}]\n1:I["chunk.js",["a"],"Page"]\n2:HL["/x.css","style"]\n';
  const result = wire.decodeWireText(text, { mime: "text/x-component" });
  assert.equal(result.format, "rsc");
  assert.deepEqual(result.value, [
    { id: "0", kind: "model", value: ["$", "div", null, { children: "hi" }] },
    { id: "1", kind: "I", value: ["chunk.js", ["a"], "Page"] },
    { id: "2", kind: "HL", value: ["/x.css", "style"] },
  ]);
  assert.equal(wire.decodeWireText("x", { url: "https://a.test/p?_rsc=1" }).format, "text");
});

test("&&&-framed streaming JSON, NDJSON and length-prefixed chunks", () => {
  const amazon = wire.decodeWireText('{"a":1}&&&{"b":2}&&&', {
    mime: "application/amazonui-streaming-json",
  });
  assert.equal(amazon.format, "json-seq");
  assert.deepEqual(amazon.value, [{ a: 1 }, { b: 2 }]);
  const ndjson = wire.decodeWireText('{"a":1}\n{"a":2}\n');
  assert.equal(ndjson.format, "json-seq");
  assert.deepEqual(ndjson.value, [{ a: 1 }, { a: 2 }]);
  const framed = wire.decodeWireText(')]}\'\n\n5\n[1,2]7\n["abc"]');
  assert.deepEqual(framed.value, [[1, 2], ["abc"]]);
});

test("JSON served as binary/octet-stream is sniffed as JSON", () => {
  const bytes = new TextEncoder().encode('  {"segments":[{"text":"hello"}]}');
  const result = wire.decodeWireBytes(bytes, { mime: "binary/octet-stream" });
  assert.equal(result.format, "json");
  assert.deepEqual(result.value, { segments: [{ text: "hello" }] });
  assert.equal(wire.decodeWireText("plain words").format, "text");
});

function recorded(net, id, url, mimeType, extra = {}) {
  net.event("Network.requestWillBeSent", {
    requestId: id,
    type: "Fetch",
    request: { url, method: "GET", headers: {} },
  });
  net.event("Network.responseReceived", {
    requestId: id,
    type: "Fetch",
    response: { url, status: 200, mimeType, headers: { "content-type": mimeType } },
  });
  net.event("Network.loadingFinished", { requestId: id, encodedDataLength: 29 });
  return Object.assign(
    net.entries().find((entry) => entry.id === id),
    extra,
  );
}

test("body(id, {as: 'base64'}) returns bounded raw base64", () => {
  const net = networkRecorderForTest();
  const entry = recorded(net, "r1", "https://a.test/x.bin", "application/x-protobuf", {
    bodyBase64: true,
    rawBody: b64(PROTO),
  });
  assert.deepEqual(wireBodyOf(entry, { as: "base64" }), {
    base64: b64(PROTO),
    bytes: PROTO.length,
    mime: "application/x-protobuf",
    truncated: false,
  });
});

test("get(id).request.decoded decodes a Steam-style input_protobuf_encoded param", () => {
  const net = networkRecorderForTest();
  const param = encodeURIComponent(b64(PROTO));
  recorded(net, "r2", "https://store.test/GetItems/v1?input_protobuf_encoded=" + param, "x");
  const detail = net.get("r2");
  const decoded = detail.request.decoded.query.input_protobuf_encoded;
  assert.equal(decoded.format, "protobuf");
  assert.equal(decoded.value[0].value, 150);
  recorded(net, "r3", "https://store.test/plain?q=hello", "x");
  assert.equal(net.get("r3").request, undefined);
});

test("recorder end to end: binary bodies are kept and decoded, the default is unchanged", async () => {
  const json = Buffer.from('{"ok":true}').toString("base64");
  const bodies = { p1: b64(PROTO), p2: json };
  globalThis.chrome.debugger.sendCommand = async (_target, method, params) =>
    method === "Network.getResponseBody"
      ? { body: bodies[params.requestId], base64Encoded: true }
      : {};
  const net = networkRecorderForTest();
  recorded(net, "p1", "https://a.test/api.pb", "application/x-protobuf");
  recorded(net, "p2", "https://a.test/transcription.json", "binary/octet-stream");
  assert.deepEqual(await net.body("p1"), { binary: true, bytes: 29 });
  const proto = await net.body("p1", { decode: "auto" });
  assert.equal(proto.format, "protobuf");
  assert.equal(proto.value[2].children[0].value, 1);
  const sniffed = await net.body("p2", { decode: "auto" });
  assert.deepEqual([sniffed.format, sniffed.value], ["json", { ok: true }]);
  assert.equal((await net.body("p1", { as: "base64" })).base64, b64(PROTO));
  assert.equal(net.get("p1").rawBody, undefined);
});
