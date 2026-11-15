import assert from "node:assert/strict";
import test from "node:test";
import {
  formatFinding,
  lintPublicAbility,
  publicAbility,
  publishErrors,
} from "../dist/ability-publish.js";
import { parseReview } from "../dist/ability-review.js";

function ability(overrides = {}) {
  const now = new Date().toISOString();
  return {
    name: "search",
    site: "example.com",
    description: "Find a product",
    kind: "read",
    inputs: { type: "object", properties: { q: { type: "string", description: "What to find" } } },
    outputs: { type: "object", properties: { title: { type: "string" } } },
    ways: [{ kind: "script", runtime: "node", code: "void inputs.q; return { title: 'tea' };" }],
    tests: [{ inputs: { q: "tea" }, expect: { title: "tea" } }],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const codes = (findings) => findings.map((finding) => finding.code);

test("the public definition keeps the contract and drops the code", () => {
  const definition = publicAbility(ability());
  assert.equal(definition.effect, "read");
  assert.deepEqual(definition.ways, ["script"]);
  assert.equal("code" in definition, false);
  assert.equal(JSON.stringify(definition).includes("void inputs.q"), false);
  assert.equal(definition.digest.length, 16);
  assert.equal(publicAbility(ability()).digest, definition.digest);
  assert.match(publicAbility(ability({ description: "Other" })).digest, /^[a-f0-9]{16}$/);
});

test("a clean ability has no publish findings", () => {
  assert.deepEqual(lintPublicAbility(ability()), []);
  assert.deepEqual(publishErrors(lintPublicAbility(ability())), []);
});

test("an email in a test input or a credential in code is an error, without echoing it", () => {
  const personal = lintPublicAbility(
    ability({ tests: [{ inputs: { q: "me@example.com" }, expect: { title: "tea" } }] }),
  );
  assert.equal(codes(personal).includes("personal_data"), true);
  assert.equal(JSON.stringify(personal).includes("me@example.com"), false);

  const code = "void inputs.q; const k = 'sk-" + "abcdefghijklmnopqrstuvwxyz" + "'; return k;";
  const secret = lintPublicAbility(ability({ ways: [{ kind: "script", runtime: "node", code }] }));
  assert.equal(codes(secret).includes("secret"), true);
  assert.equal(JSON.stringify(secret).includes("abcdefghijklmnop"), false);
});

test("an account id, a single-value enum and the recorded value are flagged", () => {
  const account = ability({
    inputs: {
      type: "object",
      properties: {
        q: { type: "string" },
        accountId: { type: "string", default: "acct-42" },
      },
    },
    ways: [
      { kind: "script", runtime: "node", code: "void inputs.q; void inputs.accountId; return 1;" },
    ],
  });
  const findings = lintPublicAbility(account);
  const accountFinding = findings.find((finding) => finding.code === "account_id");
  assert.equal(accountFinding.path, "inputs.properties.accountId.default");

  const pinned = lintPublicAbility(
    ability({
      inputs: {
        type: "object",
        properties: {
          q: { type: "string", default: "tea" },
          status: { type: "string", enum: ["open"] },
        },
      },
      ways: [
        { kind: "script", runtime: "node", code: "void inputs.q; void inputs.status; return 1;" },
      ],
    }),
  );
  assert.equal(codes(pinned).includes("input_single_value"), true);
  assert.equal(codes(pinned).includes("input_recorded_value"), true);
});

test("an output no test expects is a notice; undeclared inputs are errors", () => {
  const output = lintPublicAbility(
    ability({ outputs: { type: "object", properties: { title: { type: "string" }, price: {} } } }),
  );
  const notice = output.find((finding) => finding.code === "output_untested");
  assert.equal(notice.severity, "notice");
  assert.match(notice.message, /price/);

  const undeclared = lintPublicAbility(
    ability({ ways: [{ kind: "script", runtime: "node", code: "return inputs.missing;" }] }),
  );
  assert.equal(codes(undeclared).includes("input_undeclared"), true);
});

test("a write without a read-back, or a description that claims the wrong effect, is refused", () => {
  const write = ability({
    kind: "write",
    description: "Delete the old order",
    inputs: {},
    ways: [{ kind: "api", operation: "order" }],
    tests: undefined,
  });
  const findings = lintPublicAbility(write);
  assert.equal(codes(findings).includes("write_no_readback"), true);

  const claim = lintPublicAbility(ability({ description: "List the orders" }));
  assert.equal(claim.length, 0, "a read described as reading is fine");
  const mismatch = lintPublicAbility(ability({ description: "Delete the order" }));
  assert.equal(codes(mismatch).includes("claim_mismatch"), true);
  const hinted = lintPublicAbility(
    ability({ kind: "write", description: "View the order", postcondition: { ability: "search" } }),
  );
  assert.equal(codes(hinted).includes("claim_mismatch"), true);
});

test("a finding formats with its severity, code and path", () => {
  const line = formatFinding({
    severity: "error",
    code: "secret",
    path: "ways.0.code",
    message: "x",
  });
  assert.equal(line, "error secret ways.0.code: x");
});

test("the review reply must be the agreed JSON shape", () => {
  assert.deepEqual(
    parseReview(
      '```json\n{"verdict":"deny","findings":[{"path":"inputs.q","note":"pinned"}]}\n```',
    ),
    {
      verdict: "deny",
      findings: [{ path: "inputs.q", note: "pinned" }],
    },
  );
  assert.deepEqual(parseReview('{"verdict":"allow","findings":["fine"]}'), {
    verdict: "allow",
    findings: [{ note: "fine" }],
  });
  assert.throws(() => parseReview("looks fine to me"), /ABILITY_REVIEW_UNPARSABLE/);
  assert.throws(() => parseReview('{"verdict":"maybe"}'), /verdict must be allow or deny/);
});

test("the public definition carries the writes inventory", () => {
  const writes = [
    {
      id: "steps:0:0",
      kind: "suspected",
      what: "Sign out",
      via: "steps",
      step: 0,
      method: "GET",
      path: "/logout",
    },
  ];
  const definition = publicAbility(ability({ writes }));
  assert.deepEqual(definition.writes, writes);
  assert.deepEqual(lintPublicAbility(ability({ writes })), []);
});
