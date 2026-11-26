import assert from "node:assert/strict";
import test from "node:test";
import { operationEffect } from "../dist/effect.js";

test("a POST classified as a read gets the read effect", () => {
  const op = { method: "POST", id: "discover_web", path: "/api/discover/1/discover_web" };
  assert.equal(operationEffect({ ...op, kind: "read" }), "read");
  assert.equal(operationEffect({ ...op, role: "read" }), "read");
  assert.equal(operationEffect(op), "write");
});

test("genuine POST mutations stay writes", () => {
  assert.equal(operationEffect({ method: "POST", path: "/api/cart" }), "write");
  assert.equal(operationEffect({ method: "POST", path: "/api/cart", kind: "write" }), "write");
  // Irreversible text still wins over a read classification.
  assert.equal(
    operationEffect({ method: "POST", path: "/api/messages/send", kind: "read" }),
    "irreversible",
  );
  assert.equal(operationEffect({ method: "POST", path: "/api/messages/send" }), "irreversible");
});
