import assert from "node:assert/strict";
import test from "node:test";
import { AuthBroker, base32Decode, totp, totpFromKey } from "../dist/native-browser-auth-broker.js";

// RFC 6238 appendix B: 8-digit codes for the ASCII keys "12345678901234567890" (and longer).
const sha1 = new TextEncoder().encode("12345678901234567890");
const sha256 = new TextEncoder().encode("12345678901234567890123456789012");
const sha512 = new TextEncoder().encode(
  "1234567890123456789012345678901234567890123456789012345678901234",
);
const vectors = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

test("RFC 6238 test vectors", async () => {
  for (const [seconds, one, two, five] of vectors) {
    const time = seconds * 1000;
    assert.equal(await totpFromKey(sha1, { time, digits: 8 }), one);
    assert.equal(await totpFromKey(sha256, { time, digits: 8, algorithm: "SHA-256" }), two);
    assert.equal(await totpFromKey(sha512, { time, digits: 8, algorithm: "SHA-512" }), five);
  }
});

test("base32 seeds decode", async () => {
  assert.deepEqual(
    [...base32Decode("GEZDGNBVGY3TQOJQ")],
    [...new TextEncoder().encode("1234567890")],
  );
  assert.equal(
    await totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", { time: 59_000, digits: 8 }),
    "94287082",
  );
  assert.throws(() => base32Decode("not!base32"), /TOTP_SEED/);
});

test("fillOtp types the code and returns no seed or digits", async () => {
  const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  let typed = "";
  const broker = new AuthBroker({
    localEntries: async () => [
      { id: "x", optedIn: true, seed },
      { id: "y", optedIn: false, seed },
    ],
    fill: async (code) => void (typed = code),
    now: () => 59_000,
  });
  const outcome = await broker.fillOtp("https://example.com", "x");
  assert.deepEqual(outcome, { filled: true, source: "local", digits: 6, validForSeconds: 1 });
  assert.equal(typed, "287082");
  const text = JSON.stringify(outcome);
  assert.equal(text.includes(typed) || text.includes(seed), false);
  assert.equal(broker.redact(`code ${typed} seed ${seed}`), "code [redacted] seed [redacted]");
  assert.deepEqual(await broker.fillOtp("https://example.com", "y"), {
    filled: false,
    source: "none",
  });
});

test("the password manager's code wins and stays out of results", async () => {
  const broker = new AuthBroker({ managerTotp: async () => "445566", fill: async () => undefined });
  const outcome = await broker.fillOtp("https://example.com", "id");
  assert.equal(outcome.source, "manager");
  assert.equal(JSON.stringify(outcome).includes("445566"), false);
  assert.equal(broker.redact("got 445566"), "got [redacted]");
});

test("WebAuthn is enabled only when asked, and passkey material is redacted", async () => {
  const sent = [];
  const send = async (method) => {
    sent.push(method);
    if (method === "WebAuthn.addVirtualAuthenticator") return { authenticatorId: "auth-1" };
    if (method === "WebAuthn.getCredentials")
      return { credentials: [{ credentialId: "cred-abc", privateKey: "PRIVATEKEYBYTES" }] };
    return {};
  };
  const broker = new AuthBroker();
  await broker.fillOtp("https://example.com", "none");
  assert.equal(await broker.passkeyCount(), 0);
  assert.deepEqual(sent, [], "zero idle overhead: no WebAuthn command before enablePasskeys");
  assert.deepEqual(await broker.enablePasskeys(send), { enabled: true, reused: false });
  assert.deepEqual(await broker.enablePasskeys(send), { enabled: true, reused: true });
  assert.equal(await broker.passkeyCount(), 1);
  assert.equal(broker.redact("cred-abc PRIVATEKEYBYTES"), "[redacted] [redacted]");
  assert.deepEqual(await broker.disablePasskeys(), { disabled: true });
  assert.deepEqual(sent, [
    "WebAuthn.enable",
    "WebAuthn.addVirtualAuthenticator",
    "WebAuthn.getCredentials",
    "WebAuthn.removeVirtualAuthenticator",
    "WebAuthn.disable",
  ]);
  assert.equal(broker.passkeysEnabled, false);
});
